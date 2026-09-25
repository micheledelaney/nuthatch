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
  /** uid of the containing object (e.g. a field's table, a TO's base table). */
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
   *   • everything else → `collectText(node)` from the source XML
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
      /** Value list attached to a field object's format. */
      valueListRef?: { id?: string; name: string };
      /** Single-step action for buttons that don't call a script. */
      actionStep?: { name: string; params: string };
      /** Object-level script triggers. */
      triggers?: LayoutTriggerInfo[];
      /** Tooltip calculation text. */
      tooltip?: string;
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
      /** A privilege set whose record access is `<Records Custom="True">` —
       * FileMaker's "Custom privileges" option, one row per table plus (when
       * that table's field access is itself Custom) a per-field breakdown. */
      kind: "privilegeSet";
      tables: PrivilegeSetTableAccess[];
    };

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
}

/** A layout part (Body, Header, …) and the objects placed on it. */
export interface LayoutPart {
  /** Part kind, e.g. "Body", "Header", "Footer". */
  type: string;
  /** Top edge of the part in layout points (absolute, for the proportional map). */
  top: number;
  /** Height of the part in layout points. */
  height: number;
  objects: LayoutObjectInfo[];
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
  /** Nested objects: portal fields, tab/slide panel contents, group members. */
  children?: LayoutObjectInfo[];
  /** Field binding: "TO::FieldName" for field-type objects. */
  fieldRef?: string;
  /** Raw field numeric id — used to emit a RawReference, not rendered. */
  fieldToId?: string;
  /** Raw table occurrence numeric id for the field binding — used for viaToId. */
  fieldViaToId?: string;
  /** Script called by a button or grouped button — enables navigation to the script. */
  scriptRef?: { id?: string; name: string; uuid?: string };
  /** Value list attached to a field object's format (drop-down, checkbox set, …). */
  valueListRef?: { id?: string; name: string };
  /** Single-step action for buttons that don't call a script. */
  actionStep?: { name: string; params: string };
  /** Object-level script triggers (distinct from layout-level triggers). */
  triggers?: LayoutTriggerInfo[];
  /** Tooltip calculation text. */
  tooltip?: string;
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
  /** When set, only related values are shown, anchored from this occurrence. */
  showRelatedFrom?: string;
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

/** A directed dependency edge between two objects. */
export interface FmReference {
  fromUid: string;
  /** Resolved target uid, or null if the target could not be found (broken). */
  toUid: string | null;
  toType: ObjectType;
  toId: string;
  toName: string;
  /** Human-readable edge kind, e.g. "performScript", "goToLayout", "field". */
  kind: string;
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
  unstoredCalculationCount: number;
  /** Unstored calculation fields whose relationship depth is >= 2 (multi-hop). */
  deepCalcCount: number;
  globalVariableCount: number;
  globalFieldCount: number;
  /** Active FileMaker-auth accounts with no stored password (security risk). */
  accountsNoPasswordCount: number;
  riskFlags: RiskFlag[];
}

export interface RiskFlag {
  severity: "info" | "warn" | "high";
  message: string;
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
  reportCard: ReportCard;
  parseErrors: string[];
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
  kind: string;
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
