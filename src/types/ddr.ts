/**
 * Domain model for a parsed FileMaker solution.
 *
 * A "solution" is the aggregation of one or more FMSaveAsXML documents. Every object
 * (table, field, script, …) is identified by a globally unique `uid` so that
 * objects from different files never collide.
 */

export type ObjectType =
  | "file"
  | "table"
  | "field"
  | "tableOccurrence"
  | "relationship"
  | "layout"
  | "layoutObject"
  | "script"
  | "valueList"
  | "customFunction"
  | "account"
  | "privilegeSet"
  | "extendedPrivilege"
  | "fileAccess"
  | "externalDataSource"
  | "customMenuSet"
  | "customMenu"
  | "customMenuItem"
  | "theme"
  | "globalVariable";

/** Display metadata for each object type. Order drives the navigator grouping. */
export const OBJECT_TYPE_META: Record<ObjectType, { label: string; plural: string }> = {
  file: { label: "File", plural: "Files" },
  table: { label: "Table", plural: "Tables" },
  field: { label: "Field", plural: "Fields" },
  tableOccurrence: { label: "Table Occurrence", plural: "Table Occurrences" },
  relationship: { label: "Relationship", plural: "Relationships" },
  layout: { label: "Layout", plural: "Layouts" },
  layoutObject: { label: "Layout Object", plural: "Layout Objects" },
  script: { label: "Script", plural: "Scripts" },
  valueList: { label: "Value List", plural: "Value Lists" },
  customFunction: { label: "Custom Function", plural: "Custom Functions" },
  account: { label: "Account", plural: "Accounts" },
  privilegeSet: { label: "Privilege Set", plural: "Privilege Sets" },
  extendedPrivilege: { label: "Extended Privilege", plural: "Extended Privileges" },
  fileAccess: { label: "File Access", plural: "File Access" },
  externalDataSource: { label: "External Data Source", plural: "External Data Sources" },
  customMenuSet: { label: "Custom Menu Set", plural: "Custom Menu Sets" },
  customMenu: { label: "Custom Menu", plural: "Custom Menus" },
  customMenuItem: { label: "Custom Menu Item", plural: "Custom Menu Items" },
  theme: { label: "Theme", plural: "Themes" },
  globalVariable: { label: "Global Variable", plural: "Global Variables" },
};

/**
 * Object types for which "unreferenced" is meaningful — something is expected
 * to reference them. Shared by the report card count and the navigator's
 * Unreferenced filter so the two always agree. Types nothing ever references
 * (accounts, relationships, …) are excluded so they don't all show as orphans.
 * Fields are included but best-effort: their references resolve through
 * occurrence context, so a field read only through an external/unloaded
 * occurrence may show as a false orphan.
 */
export const ORPHAN_CANDIDATE_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "script",
  "layout",
  "customFunction",
  "valueList",
  "table",
  "tableOccurrence",
  "field",
  "theme",
  "privilegeSet", // referenced by the accounts granted it
]);

export interface FmFile {
  /** Globally unique id for the file (e.g. "F0"). */
  uid: string;
  /** FileMaker file name from the export. */
  name: string;
  /** Source document the file was parsed from. */
  source: string;
  /** FileMaker application version that produced the export (e.g. "21.1.1"). */
  version?: string;
}

export interface FmObject {
  /** Globally unique id: `${fileUid}:${type}:${id}`. */
  uid: string;
  type: ObjectType;
  /** FileMaker numeric id, as a string (unique per type within a file). */
  id: string;
  name: string;
  /** Owning file uid. */
  fileUid: string;
  fileName: string;
  /** uid of the containing object: a field's table, a layout object's layout
   * (or the portal, panel or group it's in), a menu item's menu. */
  parentUid?: string;
  /** Raw attributes lifted from the source element. */
  attributes: Record<string, string>;
  /**
   * Concatenated searchable text for this object. The full-text search index
   * and the global-variable scanner both consume this directly, so the shape
   * must be human-readable with real delimiters (`;`, `[`, `]`, `::`, …) — a
   * raw XML walk would emit a delimiter-free word soup and over-match.
   *
   * Source by type:
   *   • script        → `name params` per step, one step per line
   *   • field         → the calc body (also stored in `detail`)
   *   • customFunction→ signature + calc body
   *   • everything else → `displayText(node)` from the source XML (decoded
   *     like every other string in the model; CDATA verbatim)
   */
  text: string;
  /** Type-specific structured detail for rich display in the inspector. */
  detail?: ObjectDetail;
  /** For calculation fields: how far through the relationship graph the field's
   * references reach — the max number of relationship hops from the field's
   * context occurrence to any occurrence it reads a field through. 0/undefined
   * means it stays in its own table; 1 = a directly related table; 2 = a child's
   * child; etc. Surfaced to flag calculations that traverse deep relationships. */
  relationshipDepth?: number;
  /** Position within its catalog (document order = Script Workspace order). */
  order?: number;
  /** Folder path the object lives in (e.g. "Startup / Migration"), if any. */
  folder?: string;
  /** A separator item — a visual divider in the Script Workspace, not a script. */
  isSeparator?: boolean;
}

/** Rich, type-specific content rendered in an object's inspector column. */
export type ObjectDetail =
  | { kind: "script"; steps: ScriptStep[] }
  | { kind: "calculation"; signature: string; body: string }
  | {
      /** A summary field: the aggregate it computes and the field(s) it acts on. */
      kind: "summary";
      /** Friendly operation label, e.g. "Total of", "Maximum of", "List of". */
      operation: string;
      /** Names of the summarized field(s). */
      fields: string[];
      /** "Restart summary for each sorted group" ("Subtotaled" for a fraction
       * of total). */
      restartsEachGroup?: boolean;
      /** The field the summary restarts (or is subtotaled) by when sorted, as
       * "TableOccurrence::Field". */
      sortedBy?: string;
      /** A weighted average's weight field, as "TableOccurrence::Field". */
      weightedBy?: string;
      /** How repeating fields are summarized: "All together" or "Individually". */
      repetitions?: string;
    }
  | {
      kind: "relationship";
      leftTable: string;
      rightTable: string;
      /** Occurrence ids of the two endpoints (unique per file), so the
       * relationship graph resolves its edges by id rather than by name.
       * Undefined when an endpoint is a `<Table Missing>` placeholder. */
      leftToId?: string;
      rightToId?: string;
      predicates: JoinPredicate[];
      /** Per-side cascade/sort settings; undefined on older parses. */
      left?: RelationshipSide;
      right?: RelationshipSide;
    }
  | { kind: "valueList"; source: string; customValues: string[]; field?: ValueListFieldSource }
  | {
      /** A "looked-up value" auto-enter field: the source it copies from. */
      kind: "lookup";
      /** The source field, as "TableOccurrence::Field". */
      source: string;
      /** The occurrence the lookup starts from ("Starting with table"). */
      startingFrom?: string;
      /** "Don't copy contents if empty". */
      skipEmpty?: boolean;
      /** What's copied when no record matches ("If no exact match, then"). */
      ifNoMatch?: string;
    }
  | {
      /** An individual object placed on a layout (field, button, portal, …). */
      kind: "layoutObject";
      /** The FileMaker object type, e.g. "Field", "Button", "Portal", "Text". */
      loType: string;
      /** Extra readable content: button label, web-viewer URL, text content, etc. */
      info?: string;
      /** Field binding: "TO::FieldName". */
      fieldRef?: string;
      /** Script called by a button or grouped button. */
      scriptRef?: { id?: string; name: string; uuid?: string };
      /** Script parameter calculation the button passes to its script. */
      scriptParameter?: string;
      /** Value list attached to a field object's format. */
      valueListRef?: { id?: string; name: string };
      /** Single-step action for buttons that don't call a script. */
      actionStep?: { name: string; params: string };
      /** Object-level script triggers. */
      triggers?: LayoutTriggerInfo[];
      /** Tooltip calculation text. */
      tooltip?: string;
      /** "Hide object when" calculation text. */
      hideWhen?: string;
      /** The hide condition also applies in Find mode. */
      hideInFind?: boolean;
      /** Conditional-formatting condition calculations, in evaluation order. */
      conditionalFormats?: string[];
      /** The formatting each condition applies (normalized like `style`), by
       * position in conditionalFormats; "" for a condition with none. */
      conditionalFormatStyles?: string[];
      /** Placeholder text calculation of a field object. */
      placeholder?: string;
      /** The placeholder also shows in Find mode. */
      placeholderInFind?: boolean;
      /** Popover title calculation (on its popover button). */
      popoverTitle?: string;
      /** A chart's setup. */
      chart?: ChartInfo;
      /** Absolute position on the layout. */
      bounds?: LayoutBounds;
      /** Normalized per-object styling from `<LocalCSS>` (fill/text/border colors,
       * font family & size, shadows, …), one declaration per line for readable
       * display and line-oriented diffing. */
      style?: string;
      /** Portal: table occurrence name. */
      portalTable?: string;
      /** Portal: visible row count. */
      portalRows?: number;
      /** Portal: the fields its records are sorted by. */
      portalSort?: SortField[];
      /** Portal: the filter calculation ("Filter portal records"). */
      portalFilter?: string;
      /** Portal: the first related record it shows ("Initial row"). */
      portalInitialRow?: number;
    }
  | {
      kind: "layout";
      /** Declared layout box (its real right/bottom edge), for the drawn map. */
      width: number;
      height: number;
      /** Layout-level script triggers, e.g. OnLayoutEnter or OnRecordLoad. */
      triggers: LayoutTriggerInfo[];
      parts: LayoutPart[];
      /** Objects parked entirely to the right of the layout (off the drawn area). */
      offLayout: LayoutObjectInfo[];
      /** The columns of its Table View setup (FM 26), in order. */
      tableView?: TableViewColumn[];
    }
  | {
      /** A file's own options. Scalar options (auto-login, encryption, …) live in
       * the object's `attributes`; the triggers are here for the rich row UI. */
      kind: "file";
      /** File-level script triggers (File Options ▸ Script Triggers), e.g.
       * OnFirstWindowOpen, OnLastWindowClose. */
      triggers: LayoutTriggerInfo[];
    }
  | {
      /** A privilege set with at least one category set to FileMaker's "Custom
       * privileges" option. Records (`<Records Custom="True">`): one row per
       * table plus (when that table's field access is itself Custom) a
       * per-field breakdown; empty when record access isn't Custom. Layouts,
       * scripts, value lists: one row per object, present only when that
       * category is Custom. */
      kind: "privilegeSet";
      tables: PrivilegeSetTableAccess[];
      layouts?: PrivilegeSetObjectAccess[];
      scripts?: PrivilegeSetObjectAccess[];
      valueLists?: PrivilegeSetObjectAccess[];
    };

/** One layout's, script's or value list's custom access within a privilege set. */
export interface PrivilegeSetObjectAccess {
  /** Object name, or "(new layouts)" / "(new scripts)" / "(new value lists)"
   * for the default applied to objects created after this privilege set was
   * defined. */
  name: string;
  /** "Modifiable" | "View only" (layouts, value lists) / "Executable only"
   * (scripts) | "No access". */
  access: string;
  /** Layouts only: access to records viewed through the layout. */
  records?: string;
}

/** One table's custom record/field access within a privilege set. */
export interface PrivilegeSetTableAccess {
  /** Base table name, or "(new tables)" for the default FileMaker applies to
   * tables created after this privilege set was defined. */
  table: string;
  view: string;
  edit: string;
  create: string;
  delete: string;
  /** The calculation formula behind a "Limited" grant, when View/Edit/Delete
   * access is gated by a condition rather than a flat yes/no. Create can't
   * take a calculated condition, so there's no createCondition. */
  viewCondition?: string;
  editCondition?: string;
  deleteCondition?: string;
  /** "All" | "View only" | "None" | "Custom". */
  fieldsAccess: string;
  /** Per-field access, present only when fieldsAccess is "Custom". */
  fields?: PrivilegeSetFieldAccess[];
}

export interface PrivilegeSetFieldAccess {
  /** Field name, or "(new fields)" for the default applied to fields added
   * to the table after this privilege set was defined. */
  field: string;
  access: string;
}

/**
 * Human-friendly display name for an object. A relationship has no real name
 * (only an id), so show the two joined table occurrences as "Left → Right";
 * everything else uses its own name.
 */
export function objectLabel(o: FmObject): string {
  if (o.type === "relationship" && o.detail?.kind === "relationship") {
    const { leftTable, rightTable } = o.detail;
    if (leftTable || rightTable) return `${leftTable || "?"} → ${rightTable || "?"}`;
  }
  return o.name;
}

/**
 * A broken table occurrence: it has no base table, and the export shows why —
 * a local occurrence whose base table was deleted, or an external one whose data
 * source is gone (an `<unknown>` placeholder, or an id missing from the file's
 * External Data Sources). Either way it reads from a table that no longer exists.
 *
 * An external occurrence whose base table merely couldn't be resolved *when the
 * file was exported* (source file not available, or a variable path) is not
 * broken — see isUnresolvedTableOccurrence.
 */
export function isBrokenTableOccurrence(o: FmObject): boolean {
  return o.type === "tableOccurrence" && o.attributes.baseTableId == null && o.attributes.baseTableUnresolved == null;
}

/**
 * An external table occurrence FileMaker couldn't resolve at export time: the
 * data source is valid (or not recorded at all), but its file wasn't available,
 * so the export carries no base table. References through it can't be
 * verified — they're neither resolved nor counted as broken.
 */
export function isUnresolvedTableOccurrence(o: FmObject): boolean {
  return o.type === "tableOccurrence" && o.attributes.baseTableId == null && o.attributes.baseTableUnresolved != null;
}

/** One table-occurrence side of a relationship: its record-cascade and sort
 * settings (the checkboxes beside each table in the Edit Relationship dialog). */
export interface RelationshipSide {
  /** "Allow creation of records in this table via this relationship". */
  cascadeCreate: boolean;
  /** "Delete related records in this table when a record is deleted". */
  cascadeDelete: boolean;
  /** "Sort records" is enabled for this side. */
  sorted: boolean;
  /** The fields it sorts by, when sorted. */
  sortFields?: SortField[];
}

/** One field of a sort order (a relationship's or a portal's), as the Sort
 * dialog lists it. */
export interface SortField {
  /** "TableOccurrence::Field" (see qualifiedField). */
  field: string;
  /** "Ascending", "Descending", or "Custom" (in a value list's order). */
  order: string;
  /** A custom order's value list. */
  valueList?: string;
  /** "Reorder based on summary field": the summary field, as "TableOccurrence::Field". */
  summaryField?: string;
}

/** A layout part (Body, Header, …) and the objects placed on it. */
export interface LayoutPart {
  /** Part kind, e.g. "Body", "Header", "Footer". */
  type: string;
  /** Top edge of the part in layout points (absolute, for the proportional map). */
  top: number;
  /** Height of the part in layout points. */
  height: number;
  /** A sub-summary part's break field ("when sorted by"), as "TableOccurrence::Field". */
  breakField?: string;
  objects: LayoutObjectInfo[];
}

/** One column of a layout's Table View setup. */
export interface TableViewColumn {
  /** The field it shows, as "TableOccurrence::Field". */
  field: string;
  /** Width in points. */
  width: number;
  hidden: boolean;
}

/** A chart object's setup: its type, where its data comes from, and the
 * formulas behind its titles and data series. */
export interface ChartInfo {
  /** Chart type, e.g. "Column", "Line", "Pie". */
  type?: string;
  /** The records it charts, e.g. "Current Found Set". */
  dataSource?: string;
  /** "Show data from record groups when sorted" (found-set charts). */
  groupsWhenSorted?: boolean;
  title?: string;
  xAxisTitle?: string;
  yAxisTitle?: string;
  /** The series with a value or title formula, in X, Y, W, Z list order. */
  series: ChartSeries[];
}

export interface ChartSeries {
  /** The series list it's in: "X", "Y", "W" or "Z". */
  axis: string;
  /** The data formula, when FileMaker exported one. */
  value?: string;
  title?: string;
}

/** A single object placed on a layout (field, button, web viewer, …). */
export interface LayoutObjectInfo {
  /** Object kind FileMaker records, e.g. "Field", "Button", "Web Viewer". */
  type: string;
  /** The object's name, "" when unnamed. */
  name: string;
  /** FileMaker's numeric object id from the DDR, when present. */
  id?: string;
  /** FileMaker's UUID for the object, when present. */
  uuid?: string;
  /** FileMaker's content hash for the object, when present. Embeds UUIDs so it
   * can differ between environments even for functionally identical objects. */
  hash?: string;
  /** Globally unique model uid: `${fileUid}:layoutObject:${layoutId}.${id}`, namespaced
   * by the owning layout the way a field's uid is namespaced by its table (falls back
   * to `${fileUid}:layoutObject:${uuid}` on the rare object with no `id`). Set during
   * FmObject emission. */
  uid?: string;
  /** Absolute position in layout points, if known. */
  bounds?: LayoutBounds;
  /** Extra readable content: a web-viewer URL, a button label + action, etc. */
  info?: string;
  /** Portal: table occurrence name displayed by this portal. */
  portalTable?: string;
  /** Portal: number of rows visible (<Options show="N">). */
  portalRows?: number;
  /** Portal: the fields its records are sorted by (Portal Setup ▸ Sort portal records). */
  portalSort?: SortField[];
  /** Portal: the filter calculation (Portal Setup ▸ Filter portal records). */
  portalFilter?: string;
  /** Portal: the first related record it shows (Portal Setup ▸ Initial row). */
  portalInitialRow?: number;
  /** Nested objects: portal fields, tab/slide panel contents, group members. */
  children?: LayoutObjectInfo[];
  /** Field binding: "TO::FieldName" for field-type objects. */
  fieldRef?: string;
  /** Script called by a button or grouped button — enables navigation to the script. */
  scriptRef?: { id?: string; name: string; uuid?: string };
  /** Script parameter calculation the button passes to its script — kept when
   * the script itself was deleted, as FileMaker keeps it. */
  scriptParameter?: string;
  /** Value list attached to a field object's format (drop-down, checkbox set, …). */
  valueListRef?: { id?: string; name: string };
  /** Single-step action for buttons that don't call a script. */
  actionStep?: { name: string; params: string };
  /** Object-level script triggers (distinct from layout-level triggers). */
  triggers?: LayoutTriggerInfo[];
  /** Tooltip calculation text. */
  tooltip?: string;
  /** "Hide object when" calculation text. */
  hideWhen?: string;
  /** The hide condition also applies in Find mode. */
  hideInFind?: boolean;
  /** Conditional-formatting condition calculations, in evaluation order. */
  conditionalFormats?: string[];
  /** The formatting each condition applies (normalized like `style`), by
   * position in conditionalFormats; "" for a condition with none. */
  conditionalFormatStyles?: string[];
  /** Placeholder text calculation of a field object (Inspector ▸ Data). */
  placeholder?: string;
  /** The placeholder also shows in Find mode. */
  placeholderInFind?: boolean;
  /** Popover title calculation, read from its panel onto the popover button. */
  popoverTitle?: string;
  /** A chart's setup. */
  chart?: ChartInfo;
  /** Normalized per-object styling from `<LocalCSS>` (colors, fonts, borders, …),
   * one declaration per line. */
  style?: string;
}

/** A script trigger attached to the layout itself. */
export interface LayoutTriggerInfo {
  /** FileMaker trigger action, e.g. "OnLayoutEnter". */
  action: string;
  /** Trigger id from the DDR, when present. */
  id?: string;
  /** Script invoked by the trigger. */
  scriptName: string;
  /** Script id from the DDR, when present. */
  scriptId?: string;
  /** Script UUID from the DDR, when present. */
  scriptUuid?: string;
  /** Modes where the trigger fires, e.g. Browse, Find, Preview. */
  modes: string[];
  /** Optional script parameter calculation/text. */
  parameter?: string;
  /** Optional field-name parameter used by a few trigger kinds. */
  parameterFieldName?: string;
}

/** An object's rectangle in absolute layout coordinates (points). */
export interface LayoutBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The field binding of a "from field" value list (its values come from a
 * field, optionally with a second display field and a related-records scope). */
export interface ValueListFieldSource {
  /** The field whose values populate the list, as "TableOccurrence::Field". */
  primaryField: string;
  /** Sorted by this field. */
  sort: boolean;
  /** Optional second field shown alongside, as "TableOccurrence::Field". */
  secondaryField?: string;
  /** "Show values only from second field": the list displays the second field's
   * values instead of the primary field's. */
  showOnlySecondary?: boolean;
  /** When set, only related values are shown, anchored from this occurrence. */
  showRelatedFrom?: string;
  /** Sorted by the second field instead of the primary one (FileMaker sorts a
   * field's value list by one or the other). */
  sortBySecondField?: boolean;
}

export interface ScriptStep {
  index: number;
  name: string;
  enabled: boolean;
  /** FileMaker's own rendering of the step's parameters (from <StepText>), with
   * the leading step name removed; carries its own brackets, or "" when none. */
  params: string;
}

export interface JoinPredicate {
  leftField: string;
  /** Comparison symbol: =, ≠, <, ≤, >, ≥, × (cartesian). */
  operator: string;
  rightField: string;
}

/** How a reference uses its target: the target's type for a plain use; what a
 * script step or trigger does with it (performScript, goToLayout, setField,
 * trigger); a menu's item (menuItem); a privilege set granting an extended
 * privilege (extendedPrivilege). */
export type RefKind = ObjectType | "performScript" | "goToLayout" | "setField" | "trigger" | "menuItem" | "extendedPrivilege";

/** A directed dependency edge between two objects. */
export interface FmReference {
  fromUid: string;
  /** Resolved target uid, or null if the target could not be found (broken). */
  toUid: string | null;
  toType: ObjectType;
  toId: string;
  toName: string;
  /** Human-readable edge kind, e.g. "performScript", "goToLayout", "field". */
  kind: RefKind;
  /** True when the target type+id could not be resolved within its file. */
  broken: boolean;
  /** 1-based index of the script step this reference originates from, if any. */
  fromStep?: number;
  /** For field references: the UID of the table occurrence used as context, so
   * the occurrence is still linkable even when the field itself is broken. */
  viaUid?: string;
  /** True when the reference comes from a disabled script step: it's still
   * listed (and still reported if broken), but it doesn't keep its target off
   * the unreferenced list, since FileMaker never runs it. */
  disabled?: boolean;
  /** A field name read from calculation text (RawReference.byName) that names
   * no field of its occurrence's table, although that table's file is loaded. */
  unmatched?: boolean;
}

/** Aggregate metrics for the solution (the report card). */
export interface ReportCard {
  fileCount: number;
  countsByType: Record<ObjectType, number>;
  referenceCount: number;
  /** Objects that are the source of at least one broken reference — the same
   * count as the navigator's Broken filter (not the number of broken refs). */
  brokenReferenceCount: number;
  unreferencedCount: number;
  /** Objects used only by unreferenced objects (or by each other): the unused chains. */
  unusedChainCount: number;
  /** Objects someone marked as used (see UsageMark). */
  markedUsedCount: number;
  unstoredCalculationCount: number;
  /** Unstored calculation fields whose relationship depth is >= 2 (multi-hop). */
  deepCalcCount: number;
  globalVariableCount: number;
  globalFieldCount: number;
  /** Active FileMaker-auth accounts with no stored password (security risk). */
  accountsNoPasswordCount: number;
  riskFlags: RiskFlag[];
}

export type RiskFlagKind =
  | "broken"
  | "noPassword"
  | "unreferenced"
  | "unstored"
  | "unusedChain"
  | "globalVariables";

/** A report-card risk: which check it is, how serious, and how many objects
 * (or, for global variables, names) it covers. The UI owns the wording. */
export interface RiskFlag {
  kind: RiskFlagKind;
  severity: "info" | "warn" | "high";
  count: number;
}

/** The fully-resolved, indexed solution the UI renders. */
export interface SolutionModel {
  files: FmFile[];
  objects: FmObject[];
  byUid: Map<string, FmObject>;
  references: FmReference[];
  /** fromUid -> outbound references. */
  outbound: Map<string, FmReference[]>;
  /** toUid -> inbound references (resolved targets only). */
  inbound: Map<string, FmReference[]>;
  brokenReferences: FmReference[];
  unreferenced: FmObject[];
  /** Objects whose every use is itself unused (see core/analysis/unusedChains). */
  unusedChain: FmObject[];
  /** uid → the usage mark that applies to it; marked objects count as in use. */
  usageMarks: ReadonlyMap<string, UsageMark>;
  reportCard: ReportCard;
  parseErrors: string[];
}

/** Why someone marked an object as used when nothing in the export uses it. */
export type UsageReason = "serverSchedule" | "externalApp" | "otherFile" | "byName" | "keep" | "other";

/**
 * Someone's judgment that an object is in use although nothing in the export
 * references it — run by a server schedule, the Data API, another file, … A
 * marked object counts as in use, and so does everything it reaches. Stored
 * per project and keyed by file name + object, since file uids follow load
 * order while FileMaker's names and ids stay the same across exports.
 */
export interface UsageMark {
  /** FileMaker file name (FmObject.fileName). */
  fileName: string;
  /** The object's uid without its file part, e.g. "script:12" or "field:3.7". */
  ref: string;
  /** The object's name when marked, for reading marks on their own. */
  name: string;
  reason: UsageReason;
  note?: string;
  /** Epoch millis. */
  markedAt: number;
}

/** Serializable payload returned by the parse worker (no Maps). */
export interface ParseResult {
  files: FmFile[];
  objects: FmObject[];
  references: RawReference[];
  errors: string[];
}

/** Unresolved reference produced by the parser (toUid filled in by buildModel). */
export interface RawReference {
  fromUid: string;
  toType: ObjectType;
  toId: string;
  toName: string;
  kind: RefKind;
  /**
   * Name of the external data source (file) this reference targets, when the
   * reference sits beside a <DataSourceReference> (e.g. Perform Script in an
   * external file). buildModel resolves it against that loaded file.
   */
  toFileName?: string;
  /** For field references: the table occurrence the field is read through. */
  viaToId?: string;
  /** For field references that name a base table directly instead of an
   * occurrence (e.g. a summary field summarizing a field in its own table):
   * the base-table id the field is resolved within. */
  viaBaseTableId?: string;
  /** 1-based index of the originating script step, if any. */
  fromStep?: number;
  /** Forces the reference to resolve as broken regardless of target lookup —
   * used when the DDR itself marks the target deleted (e.g. a calculation that
   * names a `<Field Missing>` / `<Table Missing>` placeholder). */
  forceBroken?: boolean;
  /** A field reference recovered from calculation text (when the calc's chunk
   * list was unusable) for an occurrence whose base table is in another file:
   * `toName` holds the text after `::`, and buildModel resolves it to the
   * longest field name of that table it starts with. Never flagged broken. */
  byName?: boolean;
  /** Originates from a disabled script step (see FmReference.disabled). */
  disabled?: boolean;
}
