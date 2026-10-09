import { Fragment, useState } from "react";
import {
  OBJECT_TYPE_META,
  objectLabel,
  isBrokenTableOccurrence,
  layoutOf,
  type ChartInfo,
  type FmObject,
  type LayoutBounds,
  type LayoutObjectInfo,
  type LayoutTriggerInfo,
  type ObjectDetail,
  type ObjectType,
  type PrivilegeSetObjectAccess,
  type PrivilegeSetTableAccess,
  type SolutionModel,
  type SortField,
} from "@/types/ddr";
import { type DependencyEdge } from "@/core/analysis/dependencies";
import type { CallNode } from "@/core/analysis/callChain";
import { BROKEN_PLACEHOLDER_RE } from "@/core/identifiers";
import { findMissingFieldOccurrences } from "@/core/model/refResolution";
import { ownFieldRef, ownScriptRef, refLabel, refStatus } from "@/core/model/refStatus";
import { brokenSourcesFor } from "./browseA/refStats";
import { RelationshipERD } from "./RelationshipERD";
import { CodeBox } from "./CodeBox";
import { ScriptWorkspace, stepColorClass } from "./ScriptWorkspace";
import { useScriptFind } from "./ScriptFind";
import { LinkedCode } from "./Highlight";
import { FieldRefLink, ObjLink, RefStatusChip } from "./FieldRefLink";
import { TypePill } from "./TypePill";
import { pressable } from "./a11y";

/** How many rows a References / Referenced By widget shows before "Show more". */
const DETAIL_REF_PREVIEW_LIMIT = 10;

/** A referencing field in a Used by list as `Table::field`, by the table it
 * belongs to; null for all other types. (The reference's own occurrence,
 * viaUid, is the one the listed object is read through, not the field's.) */
function sourceFieldLabel(edge: DependencyEdge, byUid: Map<string, FmObject>): string | null {
  const obj = edge.target;
  if (obj?.type !== "field") return null;
  const table = obj.parentUid ? byUid.get(obj.parentUid) : undefined;
  return table ? `${table.name}::${obj.name}` : obj.name;
}

/** Attributes rendered explicitly below (or internal markers) — kept out of the
 * generic "everything else" list so they aren't shown twice. */
const RENDERED_ATTRS = new Set([
  "id",
  "name",
  "unstored",
  "isFolder",
  "isSeparatorItem",
  "uuid",
  "lastModifiedBy",
  "lastModifiedAccount",
  "lastModifiedAt",
  "modifications",
  // Opaque/internal values surfaced more readably elsewhere (or just noise).
  "baseTableId", // internal id — shown as the resolved "Base table" name instead
  "baseTableUuid", // internal — matches an external occurrence to its loaded file
  "calcContextToId", // internal occurrence id used only to resolve calc field refs
  "height", // table-occurrence ERD box height in pixels
  // Relationship-graph drawing internals for a table occurrence — not meaningful
  // in the inspector.
  "graphView",
  "graphRect",
  "View",
  "kind", // account kind enum (e.g. "0")
  "enable", // raw True/False — shown more readably as "Status: Active/Inactive"
  "portalFilter", // a portal's filter — shown as code in its own Filter section
  "hideWhen", // an object's hide condition — shown as code in its own Hide condition section
]);

/** Friendly labels for raw FileMaker attribute keys; unlisted keys fall back to
 * the key itself. */
const ATTR_LABELS: Record<string, string> = {
  dataType: "Data type",
  datatype: "Data type",
  fieldType: "Field type",
  fieldtype: "Field type",
  comment: "Comment",
  type: "Kind",
  View: "View",
  externalDataSource: "External data source",
  access: "Access",
  hidden: "Hidden",
  enable: "Enabled",
  privilegeSet: "Privilege set",
  status: "Status",
  password: "Password",
  description: "Description",
  hash: "Hash",
  baseTable: "Base table",
  baseTableUnresolved: "Base table",
  tableOccurrence: "Shows records from",
  source: "Source",
  repetitions: "Repetitions",
  autoEnter: "Auto-enter",
  global: "Global storage",
  containerStorage: "Container storage",
  containerFolder: "Container folder",
  width: "Width",
  runsWithFullAccess: "Runs with full access",
  recordsAccess: "Records",
  layoutsAccess: "Layouts",
  valueListsAccess: "Value lists",
  scriptsAccess: "Scripts",
  path: "Path",
  menu: "Menu",
  occurrences: "Occurrences",
  colorScheme: "Color scheme",
  baseFontSize: "Base font size",
  palette: "Palette",
  accessType: "Access",
  selfAuthorized: "This file itself",
  authorizedBy: "Authorized by",
  authorizedOn: "Authorized on",
  basedOn: "Based on",
  installsIn: "Installs in",
  itemType: "Item type",
  shortcut: "Shortcut",
  menus: "Menus",
  Group: "Family",
  defaultTheme: "Default theme",
  locale: "Locale",
  // Field validation, indexing, and auto-enter behavior.
  validation: "Validation",
  validateWhen: "Validate when",
  validationOverride: "Override",
  validationCalculation: "Validation calculation",
  validationMessage: "Validation message",
  validateOnlyIfModified: "Validate only if modified",
  indexing: "Indexing",
  autoIndex: "Auto-index",
  indexLanguage: "Index language",
  autoEnterOptions: "Auto-enter options",
  serialIncrement: "Serial increment",
  serialGenerate: "Serial generates",
  serialNextValue: "Next serial value",
  // Privilege-set extended privileges.
  otherPrivileges: "Other privileges",
  menuCommands: "Available menu commands",
  passwordChange: "Password change",
  defaultPrivilegeSet: "Default",
  // Script options.
  includeInMenu: "Include in scripts menu",
  scriptAccess: "Script access",
  compatibility: "Compatibility",
  siriShortcut: "Siri shortcut",
  // Layout object properties.
  loType: "Object type",
  objectName: "Object name",
  position: "Position",
  label: "Label",
  scriptParameter: "Script parameter",
  tooltip: "Tooltip",
  placeholder: "Placeholder text",
  hideWhen: "Hide object when",
  conditionalFormats: "Conditional formatting",
  popoverTitle: "Popover title",
  chartType: "Chart type",
  portalOccurrence: "Table occurrence",
  portalRows: "Portal rows",
  portalInitialRow: "Initial row",
  // Layout options.
  includeInLayoutMenus: "Include in layout menus",
  clientType: "Client type",
  menuSet: "Menu set",
  // Table-occurrence graph box.
  graphPosition: "Graph position",
  color: "Color",
  // Custom menu / menu item.
  installCondition: "Install when",
  menuTitle: "Menu title",
  overrides: "Overrides",
  sourceUuid: "Source UUID",
  // File options.
  autoLogin: "Auto-login",
  encryption: "Encryption",
  minimumVersion: "Minimum version",
  defaultMenuSet: "Default menu set",
  allowStoredCredentials: "Allow stored credentials",
  requirePasscode: "Require iOS/iPadOS passcode",
  showSignInFields: "Show sign-in fields with OAuth/AD FS",
  hiddenInLaunchCenter: "Hidden in Launch Center",
  hiddenOnWebDirectHomepage: "Hidden on WebDirect homepage",
  requireFileAuthorization: "Require full access to reference file",
  authorizedFilesSameHost: "Authorized files on same host only",
  useDefaultFields: "Default fields in new tables",
  pageSetup: "Page setup",
  containerBaseDirectories: "Container base directories",
  containerThumbnails: "Container thumbnails",
  // Manage-dialog ordering (FM 26).
  customOrder: "Custom order position",
  fieldsListedBy: "Fields listed by",
  tablesListedBy: "Tables listed by",
  tableOccurrencesListedBy: "Table occurrences listed by",
  valueListsListedBy: "Value lists listed by",
  customFunctionsListedBy: "Custom functions listed by",
  privilegeSetsListedBy: "Privilege sets listed by",
  dataSourcesListedBy: "Data sources listed by",
  customMenusListedBy: "Custom menus listed by",
  menuSetsListedBy: "Menu sets listed by",
  // Theme.
  baseName: "Based on theme",
};

/** A single color value (e.g. a table occurrence's graph box) as a swatch + hex. */
function ColorSwatch({ value }: { value: string }) {
  return (
    <span className="palette-swatches">
      <span className="swatch" style={{ background: value }} title={value} />
      {value}
    </span>
  );
}

/** A theme's palette is stored as space-separated hex swatches; render them as
 * color chips rather than raw text. */
function PaletteSwatches({ value }: { value: string }) {
  const colors = value.split(/\s+/).filter(Boolean);
  return (
    <span className="palette-swatches">
      {colors.map((c, i) => (
        <span key={i} className="swatch" style={{ background: c }} title={c} />
      ))}
    </span>
  );
}

/** A name→object resolver built from one object's outbound references, so names
 * shown inline in the detail (a base table, a relationship's fields, a script
 * step's target) can be made clickable. Resolves by type+name first, then
 * loosely by name. `byStep` groups resolved targets by originating script step. */
export interface RefIndex {
  resolve: (name: string, type?: ObjectType) => FmObject | null;
  byStep: Map<number, FmObject[]>;
  /** Every unique resolved target, for matching names inline in free text. */
  targets: FmObject[];
  /** Global variable targets with no step association — available in every step. */
  scriptGlobals: FmObject[];
}

export function refIndexFor(model: SolutionModel, uid: string): RefIndex {
  const byName = new Map<string, FmObject>();
  const byTypeName = new Map<string, FmObject>();
  const byStep = new Map<number, FmObject[]>();
  const targets = new Map<string, FmObject>();
  const scriptGlobals: FmObject[] = [];
  for (const r of model.outbound.get(uid) ?? []) {
    if (!r.toUid) {
      // Broken field ref: the field is gone but the table occurrence is still navigable
      if (r.viaUid) {
        const via = model.byUid.get(r.viaUid);
        if (via) {
          if (!byName.has(via.name)) byName.set(via.name, via);
          byTypeName.set(`${via.type}:${via.name}`, via);
          targets.set(via.uid, via);
          // Per-step refs need the via too, so a broken Occ::<Field Missing>
          // inside a script step links the TO inline (not just in the side panel).
          if (r.fromStep != null) {
            const list = byStep.get(r.fromStep) ?? [];
            if (!list.some((o) => o.uid === via.uid)) list.push(via);
            byStep.set(r.fromStep, list);
          }
        }
      }
      continue;
    }
    const target = model.byUid.get(r.toUid);
    if (!target) continue;
    if (!byName.has(target.name)) byName.set(target.name, target);
    byTypeName.set(`${target.type}:${target.name}`, target);
    targets.set(target.uid, target);
    if (r.fromStep != null) {
      const list = byStep.get(r.fromStep) ?? [];
      if (!list.some((o) => o.uid === target.uid)) list.push(target);
      // A resolved field ref is read THROUGH an occurrence — make the TO
      // clickable inline next to the field, not just the field itself.
      if (r.viaUid) {
        const via = model.byUid.get(r.viaUid);
        if (via && !list.some((o) => o.uid === via.uid)) {
          list.push(via);
          if (!byName.has(via.name)) byName.set(via.name, via);
          byTypeName.set(`${via.type}:${via.name}`, via);
          targets.set(via.uid, via);
        }
      }
      byStep.set(r.fromStep, list);
    } else if (target.type === "globalVariable") {
      scriptGlobals.push(target);
    }
  }
  // Calc fields: `<Field Missing>` placeholders inside the body don't emit
  // structural FieldReferences, so the broken-edge path can't always populate
  // a viaUid. Pull every distinct `OccName::<Field Missing>` out of the body
  // and register the TO as a link candidate so LinkedCode finds it inline.
  const obj = model.byUid.get(uid);
  const body = obj?.detail?.kind === "calculation" ? obj.detail.body : undefined;
  if (body?.includes("<Field Missing>")) {
    const fileUid = uid.split(":")[0] ?? "";
    for (const occ of findMissingFieldOccurrences(body, model, fileUid)) {
      if (byName.has(occ.name)) continue;
      byName.set(occ.name, occ);
      byTypeName.set(`${occ.type}:${occ.name}`, occ);
      targets.set(occ.uid, occ);
    }
  }
  return {
    resolve: (name, type) =>
      (type ? byTypeName.get(`${type}:${name}`) : undefined) ?? byName.get(name) ?? null,
    byStep,
    targets: [...targets.values()],
    scriptGlobals,
  };
}

/** Render a property value as a link when it names one of this object's
 * referenced objects, otherwise as plain text — with FileMaker's missing/
 * unresolved placeholders highlighted as broken. */
function LinkedValue({
  value,
  refIndex,
  onGo,
}: {
  value: string;
  refIndex: RefIndex;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const target = refIndex.resolve(value);
  if (target) return <ObjLink obj={target} onGo={onGo} />;
  return <>{renderWithBrokenPlaceholders(value)}</>;
}

/** Small warning icon shown in the detail header when an object is broken or
 * has broken outbound references. */
export function BrokenBadge({ title }: { title: string }) {
  return (
    <span className="broken-badge" title={title}>
      !
    </span>
  );
}

/** Wrap any FileMaker `<… Missing …>` / `<unknown>` placeholder in a
 * `broken-value` span so it reads as broken everywhere it shows up (attribute
 * rows, layout-object names in a layout's tree and a portal's Contents),
 * instead of mixing in with normal text. Not for an object's own name where
 * it heads things (page title, navigator, breadcrumbs, pins): that stays plain.
 * The placeholder pattern itself lives in @/core/identifiers. Pass
 * `broken: false` for an object's name when the model finds nothing
 * broken about it: a text object's merge field can read `<File Missing>`
 * because its file was closed at export. */
export function renderWithBrokenPlaceholders(text: string, broken = true): React.ReactNode {
  if (!broken || !text.includes("<")) return text;
  const re = new RegExp(BROKEN_PLACEHOLDER_RE.source, "g");
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span className="broken-value" key={m.index}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Relationship-depth severity color: 0 stays in its own table (green), 2 hops
 * is worth noticing (orange), 3+ is a deep traversal worth flagging (red); 1 hop
 * is unremarkable (default). */
function depthColor(depth: number): string | undefined {
  if (depth >= 3) return "var(--high)";
  if (depth === 2) return "#e08a3c";
  if (depth === 0) return "var(--ok)";
  return undefined;
}

/** The full property sheet for the focused object: identity, lineage, the XML's
 * modification metadata, then every remaining raw attribute. Values that name a
 * referenced object (base table, privilege set, theme, …) are clickable. */
export function DetailsProps({
  obj,
  model,
  refIndex,
  onGo,
}: {
  obj: FmObject;
  model: SolutionModel;
  refIndex: RefIndex;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const parent = obj.parentUid ? model.byUid.get(obj.parentUid) ?? null : null;
  // Every object except a file itself has an owning file — surface it so any
  // detail card states which file the object lives in.
  const fileObj = obj.type !== "file" ? model.byUid.get(`${obj.fileUid}:file:${obj.fileUid}`) ?? null : null;
  const a = obj.attributes;
  const rest = Object.entries(a).filter(([k, v]) => !RENDERED_ATTRS.has(k) && v !== "");

  const ancestorLayout = obj.type === "layoutObject" ? layoutOf(obj, model.byUid) : null;

  return (
    <Section title="Metadata" defaultOpen={false}>
      <dl className="kv compact">
        <dt>Type</dt>
        <dd>{OBJECT_TYPE_META[obj.type].label}</dd>

        <dt>FileMaker ID</dt>
        <dd>{obj.id}</dd>

        {fileObj && (
          <>
            <dt>File</dt>
            <dd>
              <ObjLink obj={fileObj} onGo={onGo} />
            </dd>
          </>
        )}

        {parent && !(obj.type === "layoutObject" && parent.type === "layout") && (
          <>
            <dt>Belongs to</dt>
            <dd>
              <ObjLink obj={parent} onGo={onGo} />
            </dd>
          </>
        )}

        {ancestorLayout && (
          <>
            <dt>Layout</dt>
            <dd>
              <ObjLink obj={ancestorLayout} onGo={onGo} />
            </dd>
          </>
        )}

        {obj.folder && (
          <>
            <dt>Folder</dt>
            <dd>{obj.folder}</dd>
          </>
        )}

        {a.unstored === "Yes" && (
          <>
            <dt>Storage</dt>
            <dd style={{ color: "var(--warn)" }}>Unstored calculation</dd>
          </>
        )}

        {obj.relationshipDepth != null && (
          <>
            <dt>Relationship depth</dt>
            <dd style={{ color: depthColor(obj.relationshipDepth) }}>
              {obj.relationshipDepth === 0
                ? "Same table"
                : `${obj.relationshipDepth} ${obj.relationshipDepth === 1 ? "hop" : "hops"} through relationships`}
            </dd>
          </>
        )}

        {rest.map(([key, value]) => (
          <Fragment key={key}>
            <dt>{ATTR_LABELS[key] ?? key}</dt>
            <dd>
              {key === "palette" ? (
                <PaletteSwatches value={value} />
              ) : key === "color" ? (
                <ColorSwatch value={value} />
              ) : key === "externalDataSource" && isBrokenTableOccurrence(obj) ? (
                // FileMaker couldn't resolve the source (e.g. "<unknown>") — flag it.
                <span className="broken-value">{value}</span>
              ) : (
                <LinkedValue value={value} refIndex={refIndex} onGo={onGo} />
              )}
            </dd>
          </Fragment>
        ))}

        <dt>UUID</dt>
        <dd>{a.uuid || "—"}</dd>

        <dt>Last modified by</dt>
        <dd>{a.lastModifiedBy || "—"}</dd>

        {a.lastModifiedAccount !== a.lastModifiedBy && (
          <>
            <dt>Account</dt>
            <dd>{a.lastModifiedAccount || "—"}</dd>
          </>
        )}

        <dt>Last modified</dt>
        <dd>{a.lastModifiedAt ? a.lastModifiedAt.replace("T", " ") : "—"}</dd>

        <dt>Modifications</dt>
        <dd>{a.modifications || "0"}</dd>
      </dl>
    </Section>
  );
}

/** Every relationship a table occurrence participates in, each drawn as the same
 * ERD used in a relationship's own definition. */
export function OccurrenceRelationships({
  model,
  toUid,
  onGo,
}: {
  model: SolutionModel;
  toUid: string;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const seen = new Set<string>();
  const relationships: FmObject[] = [];
  for (const ref of model.inbound.get(toUid) ?? []) {
    const src = model.byUid.get(ref.fromUid);
    if (src?.type === "relationship" && src.detail?.kind === "relationship" && !seen.has(src.uid)) {
      seen.add(src.uid);
      relationships.push(src);
    }
  }
  relationships.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Section title="Relationships" count={relationships.length}>
      {relationships.length === 0 && (
        <div className="subtle indent">No relationships for this table occurrence.</div>
      )}
      {relationships.map((rel) => {
        const detail = rel.detail as Extract<ObjectDetail, { kind: "relationship" }>;
        const relIndex = refIndexFor(model, rel.uid);
        return (
          <div key={rel.uid} className="to-rel">
            <div className="rel-name">
              <ObjLink obj={rel} onGo={onGo}>
                {objectLabel(rel)}
              </ObjLink>
            </div>
            <RelationshipERD
              leftTable={detail.leftTable}
              rightTable={detail.rightTable}
              predicates={detail.predicates}
              left={detail.left}
              right={detail.right}
              resolve={relIndex.resolve}
              onGo={onGo}
            />
          </div>
        );
      })}
    </Section>
  );
}

/** How a sort field orders records, in the Sort dialog's words. */
function sortOrderText(f: SortField): string {
  if (f.order === "Custom") return f.valueList ? `custom order of “${f.valueList}”` : "custom order";
  return f.order.toLowerCase();
}

/** A sort order: each field with its direction, and the summary field it's
 * reordered by, if any, as the owner (relationship or portal) references them. */
function SortFieldList({
  fields,
  model,
  owner,
  onGo,
}: {
  fields: SortField[];
  model: SolutionModel;
  owner: string;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const field = (qualified: string) => <FieldRefLink qualified={qualified} model={model} owner={owner} onGo={onGo} />;
  return (
    <ol className="value-list">
      {fields.map((f, i) => (
        <li key={i}>
          {field(f.field)} <span className="subtle">{sortOrderText(f)}</span>
          {f.summaryField && (
            <>
              {" "}
              <span className="subtle">· reordered by</span> {field(f.summaryField)}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A collapsible section with a header, count, and chevron — rendered as a
 * bordered "widget" card, matching the report card's metric-tile look. */
export function Section({
  title,
  count,
  defaultOpen = true,
  flush = false,
  actions,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** Start the content at the section's edge instead of under the title text (script steps). */
  flush?: boolean;
  /** Tools on the right of the title, shown while the section is open (the script's find field). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const head = (
    <div className="head clickable detail-widget-header" {...pressable(() => setOpen((v) => !v), { expanded: open })}>
      <span className={`fchevron${open ? " open" : ""}`}>›</span> {title}
      {count != null && ` · ${count}`}
    </div>
  );
  return (
    <div className={`detail-widget${open ? "" : " collapsed"}`}>
      {actions ? (
        <div className="detail-widget-head-row">
          {head}
          {open && actions}
        </div>
      ) : (
        head
      )}
      {open && <div className={`detail-widget-body${flush ? " flush" : ""}`}>{children}</div>}
    </div>
  );
}

/** A script's steps, with a find field in the section header. */
function ScriptSteps(props: Omit<React.ComponentProps<typeof ScriptWorkspace>, "find">) {
  const { field, find } = useScriptFind();
  return (
    <Section title="Script steps" count={props.steps.length} flush actions={field}>
      <ScriptWorkspace {...props} find={find} />
    </Section>
  );
}

/** Type-specific rich content: script steps, calculation body, or an ERD. */
export function Detail({
  detail,
  owner,
  model,
  onGo,
  brokenSteps,
  scrollToStep,
}: {
  detail: ObjectDetail;
  owner: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
  brokenSteps: Set<number>;
  scrollToStep: number | null;
}) {
  const refIndex = refIndexFor(model, owner.uid);

  if (detail.kind === "script") {
    if (detail.steps.length === 0) {
      return (
        <Section title="Script steps" count={0} flush>
          <div className="subtle indent">No steps.</div>
        </Section>
      );
    }
    return (
      <ScriptSteps
        key={owner.uid}
        steps={detail.steps}
        brokenSteps={brokenSteps}
        scrollToStep={scrollToStep}
        stepRefs={refIndex.byStep}
        scriptGlobals={refIndex.scriptGlobals}
        model={model}
        owner={owner.uid}
        onGo={onGo}
      />
    );
  }

  if (detail.kind === "calculation") {
    return (
      <Section title="Definition">
        {detail.signature && <div className="signature">{detail.signature}</div>}
        <CodeBox text={detail.body}>
          <pre className="code">
            {detail.body ? (
              <LinkedCode text={detail.body} objects={refIndex.targets} onGo={onGo} model={model} owner={owner.uid} />
            ) : (
              "(empty)"
            )}
          </pre>
        </CodeBox>
      </Section>
    );
  }

  if (detail.kind === "summary") {
    const text = `${detail.operation} ${detail.fields.join(", ")}`;
    const fieldObjs = detail.fields
      .map((name) => refIndex.resolve(name, "field"))
      .filter((o): o is FmObject => o != null);
    const field = (qualified: string) => <FieldRefLink qualified={qualified} model={model} owner={owner.uid} onGo={onGo} />;
    return (
      <Section title="Definition">
        <CodeBox text={text}>
          <pre className="code">
            <LinkedCode text={text} objects={fieldObjs} onGo={onGo} model={model} owner={owner.uid} />
          </pre>
        </CodeBox>
        <dl className="kv compact">
          {detail.restartsEachGroup && (
            <>
              <dt>{detail.operation.startsWith("Fraction") ? "Subtotaled" : "Restarts for each sorted group"}</dt>
              <dd>Yes</dd>
            </>
          )}
          {detail.sortedBy && (
            <>
              <dt>When sorted by</dt>
              <dd>{field(detail.sortedBy)}</dd>
            </>
          )}
          {detail.weightedBy && (
            <>
              <dt>Weighted by</dt>
              <dd>{field(detail.weightedBy)}</dd>
            </>
          )}
          {detail.repetitions && (
            <>
              <dt>Summarize repetitions</dt>
              <dd>{detail.repetitions}</dd>
            </>
          )}
        </dl>
      </Section>
    );
  }

  if (detail.kind === "lookup") {
    const startingFrom = detail.startingFrom ? refIndex.resolve(detail.startingFrom, "tableOccurrence") : null;
    return (
      <Section title="Definition">
        <dl className="kv compact">
          <dt>Looked up from</dt>
          <dd>
            <FieldRefLink qualified={detail.source} model={model} owner={owner.uid} onGo={onGo} />
          </dd>
          {detail.startingFrom && (
            <>
              <dt>Starting with</dt>
              <dd>{startingFrom ? <ObjLink obj={startingFrom} onGo={onGo} /> : renderWithBrokenPlaceholders(detail.startingFrom)}</dd>
            </>
          )}
          {detail.ifNoMatch && (
            <>
              <dt>If no exact match</dt>
              <dd>{detail.ifNoMatch}</dd>
            </>
          )}
          {detail.skipEmpty != null && (
            <>
              <dt>Don't copy if empty</dt>
              <dd>{detail.skipEmpty ? "Yes" : "No"}</dd>
            </>
          )}
        </dl>
      </Section>
    );
  }

  if (detail.kind === "relationship") {
    const sides = [
      [detail.leftTable, detail.left?.sortFields],
      [detail.rightTable, detail.right?.sortFields],
    ] as const;
    return (
      <Section title="Relationship">
        <RelationshipERD
          leftTable={detail.leftTable}
          rightTable={detail.rightTable}
          predicates={detail.predicates}
          left={detail.left}
          right={detail.right}
          resolve={refIndex.resolve}
          onGo={onGo}
        />
        {sides.some(([, fields]) => fields) && (
          <dl className="kv compact">
            {sides.map(
              ([table, fields], i) =>
                fields && (
                  <Fragment key={i}>
                    <dt>{table} sorted by</dt>
                    <dd>
                      <SortFieldList fields={fields} model={model} owner={owner.uid} onGo={onGo} />
                    </dd>
                  </Fragment>
                ),
            )}
          </dl>
        )}
      </Section>
    );
  }

  if (detail.kind === "layout") {
    return <LayoutDetail detail={detail} owner={owner} model={model} onGo={onGo} />;
  }

  if (detail.kind === "layoutObject") {
    return <LayoutObjectColumnDetail detail={detail} owner={owner} model={model} onGo={onGo} />;
  }

  if (detail.kind === "file") {
    return <LayoutTriggers triggers={detail.triggers} owner={owner} model={model} onGo={onGo} title="File script triggers" />;
  }

  if (detail.kind === "privilegeSet") {
    return <PrivilegeSetDetail detail={detail} model={model} owner={owner} onGo={onGo} />;
  }

  return <ValueListDetail detail={detail} refIndex={refIndex} model={model} owner={owner.uid} onGo={onGo} />;
}

/** A privilege set's custom privileges: per-table record access (with an
 * expandable per-field breakdown), then per-layout, per-script and
 * per-value-list access for whichever of those categories is Custom. */
function PrivilegeSetDetail({
  detail,
  model,
  owner,
  onGo,
}: {
  detail: Extract<ObjectDetail, { kind: "privilegeSet" }>;
  model: SolutionModel;
  owner: FmObject;
  onGo: (uid: string, rowKey: string) => void;
}) {
  // What the record-access calculations refer to, so their names link.
  const link: CodeLinks = { targets: refIndexFor(model, owner.uid).targets, model, owner: owner.uid, onGo };
  return (
    <>
      {detail.tables.length > 0 && <PrivilegeTableAccess tables={detail.tables} link={link} />}
      {detail.layouts && <PrivilegeObjectAccess title="Layout access" column="Layout" grants={detail.layouts} showRecords />}
      {detail.scripts && <PrivilegeObjectAccess title="Script access" column="Script" grants={detail.scripts} />}
      {detail.valueLists && <PrivilegeObjectAccess title="Value list access" column="Value list" grants={detail.valueLists} />}
    </>
  );
}

/** Custom per-layout / per-script / per-value-list grants, one row per object. */
function PrivilegeObjectAccess({
  title,
  column,
  grants,
  showRecords = false,
}: {
  title: string;
  column: string;
  grants: PrivilegeSetObjectAccess[];
  showRecords?: boolean;
}) {
  return (
    <Section title={title} count={grants.length}>
      <table className="comparison-table privilege-access-table">
        <thead>
          <tr>
            <th>{column}</th>
            <th>Access</th>
            {showRecords && <th>Records</th>}
          </tr>
        </thead>
        <tbody>
          {grants.map((g, i) => (
            <tr key={i}>
              <td>{g.name}</td>
              <td>{g.access}</td>
              {showRecords && <td>{g.records ?? ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Custom per-table record access — one row per table, with an expandable
 * per-field breakdown for any table whose field access is itself Custom
 * (potentially hundreds of fields, so it starts collapsed). */
function PrivilegeTableAccess({ tables, link }: { tables: PrivilegeSetTableAccess[]; link: CodeLinks }) {
  return (
    <Section title="Table & field access" count={tables.length}>
      <table className="comparison-table privilege-access-table">
        <thead>
          <tr>
            <th>Table</th>
            <th>View</th>
            <th>Edit</th>
            <th>Create</th>
            <th>Delete</th>
            <th>Fields</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((t, i) => (
            <tr key={i}>
              <td>{t.table}</td>
              <td>
                <PrivilegeConditionCell label={t.view} condition={t.viewCondition} link={link} />
              </td>
              <td>
                <PrivilegeConditionCell label={t.edit} condition={t.editCondition} link={link} />
              </td>
              <td>{t.create}</td>
              <td>
                <PrivilegeConditionCell label={t.delete} condition={t.deleteCondition} link={link} />
              </td>
              <td>
                <PrivilegeFieldsCell table={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** What code needs to turn names into links: the objects it refers to, plus
 * the model, its owner and the navigation callback. */
interface CodeLinks {
  targets: FmObject[];
  model: SolutionModel;
  owner: string;
  onGo: (uid: string, rowKey: string) => void;
}

/** A "Limited" View/Edit/Delete grant — click to expand the calculation
 * formula behind it, syntax-highlighted the same way a calc field's body is. */
function PrivilegeConditionCell({ label, condition, link }: { label: string; condition?: string; link: CodeLinks }) {
  const [open, setOpen] = useState(false);
  if (!condition) return <>{label}</>;
  return (
    <>
      <button type="button" className="link-btn privilege-fields-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`fchevron${open ? " open" : ""}`}>›</span> {label}
      </button>
      {open && (
        <CodeBox text={condition}>
          <pre className="code privilege-condition">
            <LinkedCode text={condition} objects={link.targets} onGo={link.onGo} model={link.model} owner={link.owner} />
          </pre>
        </CodeBox>
      )}
    </>
  );
}

function PrivilegeFieldsCell({ table }: { table: PrivilegeSetTableAccess }) {
  const [open, setOpen] = useState(false);
  if (!table.fields || table.fields.length === 0) return <>{table.fieldsAccess}</>;
  return (
    <>
      <button type="button" className="link-btn privilege-fields-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`fchevron${open ? " open" : ""}`}>›</span> {table.fieldsAccess} ({table.fields.length})
      </button>
      {open && (
        <dl className="kv compact privilege-fields-list">
          {table.fields.map((f, i) => (
            <Fragment key={i}>
              <dt>{f.field}</dt>
              <dd>{f.access}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </>
  );
}

/** A layout's parts and the objects placed on each — the closest thing the DDR
 * gives us to a visual preview. A proportional map of the parts sits at the top;
 * hovering a part header highlights its band, and hovering an object highlights
 * its rectangle in place on the map. */
function LayoutDetail({
  detail,
  owner,
  model,
  onGo,
}: {
  detail: Extract<ObjectDetail, { kind: "layout" }>;
  owner: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [partOpen, setPartOpen] = useState<boolean[]>(() => detail.parts.map(() => true));
  const [offLayoutOpen, setOffLayoutOpen] = useState(true);
  const triggers = detail.triggers ?? [];
  const togglePart = (i: number) => setPartOpen((prev) => prev.map((v, idx) => (idx === i ? !v : v)));

  const allObjects = [...detail.parts.flatMap((p) => p.objects), ...detail.offLayout];
  const objectCount = allObjects.length;
  const triggerCount = allObjects.filter((o) => (o.triggers?.length ?? 0) > 0).length;

  const typeCounts = new Map<string, number>();
  for (const o of allObjects) typeCounts.set(o.type, (typeCounts.get(o.type) ?? 0) + 1);
  const filterChips = [...typeCounts.entries()];
  const showFilter = filterChips.length >= 2 || triggerCount > 0;

  function matchesFilter(obj: LayoutObjectInfo): boolean {
    if (typeFilter === null) return true;
    if (typeFilter === "Has Triggers") return (obj.triggers?.length ?? 0) > 0;
    return obj.type === typeFilter;
  }

  return (
    <>
      <LayoutTriggers triggers={triggers} owner={owner} model={model} onGo={onGo} />
      {objectCount > 0 && (
        <Section title="Layout contents" count={objectCount} defaultOpen={false}>
        <div className="layout-parts">
          {showFilter && (
            <div className="layout-type-filter">
              <button
                type="button"
                className={`chip${typeFilter === null ? " active" : ""}`}
                aria-pressed={typeFilter === null}
                onClick={() => setTypeFilter(null)}
              >
                All
              </button>
              {filterChips.map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  className={`chip${typeFilter === type ? " active" : ""}`}
                  aria-pressed={typeFilter === type}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                >
                  {type} <span className="chip-count">{count}</span>
                </button>
              ))}
              {triggerCount > 0 && (
                <button
                  type="button"
                  className={`chip${typeFilter === "Has Triggers" ? " active" : ""}`}
                  aria-pressed={typeFilter === "Has Triggers"}
                  onClick={() => setTypeFilter(typeFilter === "Has Triggers" ? null : "Has Triggers")}
                >
                  Has Triggers <span className="chip-count">{triggerCount}</span>
                </button>
              )}
            </div>
          )}
          {detail.parts.map((part, i) => {
            const objects = typeFilter !== null ? part.objects.filter(matchesFilter) : part.objects;
            if (objects.length === 0 && typeFilter !== null) return null;
            const open = partOpen[i] ?? true;
            return (
              <div key={i} className="lo-part-section">
                <div className="head clickable lo-part-divider" {...pressable(() => togglePart(i), { expanded: open })}>
                  <span className={`fchevron${open ? " open" : ""}`}>›</span>
                  {part.type}
                  {part.breakField && <> by {renderWithBrokenPlaceholders(part.breakField)}</>} · {objects.length}
                </div>
                {open && objects.map((obj, j) => (
                  <LayoutObjectTree
                    key={j}
                    obj={obj}
                    depth={0}
                    model={model}
                    onGo={onGo}
                  />
                ))}
              </div>
            );
          })}
          {(() => {
            const objects = typeFilter !== null ? detail.offLayout.filter(matchesFilter) : detail.offLayout;
            if (objects.length === 0) return null;
            return (
              <div className="lo-part-section">
                <div className="head clickable lo-part-divider" {...pressable(() => setOffLayoutOpen((v) => !v), { expanded: offLayoutOpen })}>
                  <span className={`fchevron${offLayoutOpen ? " open" : ""}`}>›</span>
                  Off-layout · {objects.length}
                </div>
                {offLayoutOpen && objects.map((obj, j) => (
                  <LayoutObjectTree
                    key={j}
                    obj={obj}
                    depth={0}
                    model={model}
                    onGo={onGo}
                  />
                ))}
              </div>
            );
          })()}
        </div>
        </Section>
      )}
      {detail.tableView && detail.tableView.length > 0 && (
        <Section title="Table View columns" count={detail.tableView.length} defaultOpen={false}>
          <ol className="value-list">
            {detail.tableView.map((column, i) => (
              <li key={i}>
                <FieldRefLink qualified={column.field} model={model} owner={owner.uid} onGo={onGo} />{" "}
                <span className="subtle">
                  {column.width} pt{column.hidden ? " · hidden" : ""}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </>
  );
}

/** Layout-level script triggers, using the same key/value shape as Details. */
/** Layout-level script triggers, using the same key/value shape as Details. */
function LayoutTriggers({
  triggers,
  owner,
  model,
  onGo,
  title = "Layout triggers",
}: {
  triggers: LayoutTriggerInfo[];
  owner: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
  title?: string;
}) {
  const targets = refIndexFor(model, owner.uid).targets;
  return (
    <Section title={title} count={triggers.length}>
      {triggers.length === 0 ? (
        <div className="subtle indent">No {title.toLowerCase()}.</div>
      ) : (
        <div className="layout-triggers">
          {triggers.map((trigger, i) => (
            <LayoutTriggerRow
              trigger={trigger}
              owner={owner}
              model={model}
              targets={targets}
              onGo={onGo}
              key={`${trigger.id ?? trigger.action}:${i}`}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function LayoutTriggerRow({
  trigger,
  owner,
  model,
  targets,
  onGo,
}: {
  trigger: LayoutTriggerInfo;
  owner: FmObject;
  model: SolutionModel;
  targets: FmObject[];
  onGo: (uid: string, rowKey: string) => void;
}) {
  const script = trigger.scriptName || (trigger.scriptId ? `Script ${trigger.scriptId}` : "(missing script)");
  const target = trigger.scriptId ? model.byUid.get(`${owner.fileUid}:script:${trigger.scriptId}`) ?? null : null;
  const title = [trigger.scriptUuid ? `UUID: ${trigger.scriptUuid}` : "", trigger.id ? `Trigger id: ${trigger.id}` : ""]
    .filter(Boolean)
    .join("\n");
  const params =
    `[ “${script}”` +
    (trigger.parameter ? ` ; Parameter: ${trigger.parameter}` : "") +
    (trigger.parameterFieldName ? ` ; Parameter field: ${trigger.parameterFieldName}` : "") +
    " ]";
  return (
    <div className="layout-trigger" title={title || undefined}>
      <div className="layout-obj-row">
        <span className="layout-obj-name">{trigger.action}</span>
        {trigger.modes.map((mode) => (
          <span className="tag layout-obj-type" key={mode}>
            {mode}
          </span>
        ))}
      </div>
      {/* The trigger's script call, drawn as the Perform Script step it runs:
          a deleted script reads “<unknown>”, red as in a script. */}
      <CodeBox text={`Perform Script ${params}`}>
        <pre className="code">
          <StepName name="Perform Script" />{" "}
          <LinkedCode text={params} objects={performScriptLinks(targets, target)} onGo={onGo} model={model} owner={owner.uid} />
        </pre>
      </CodeBox>
    </div>
  );
}

/** What a Perform Script line links: the objects its parameter can name, and
 * the script it runs, found by id. The script comes last so it wins a name
 * shared with another candidate (LinkedCode keeps one object per name: the
 * last); the owner's other scripts are left out, as they aren't in the line. */
function performScriptLinks(targets: FmObject[], script: FmObject | null): FmObject[] {
  const others = targets.filter((o) => o.type !== "script");
  return script ? [...others, script] : others;
}

/** A step's name in the colour its step group has in a script. */
function StepName({ name }: { name: string }) {
  const color = stepColorClass(name);
  return <span className={color ? `sw-name ${color}` : "sw-name"}>{name}</span>;
}

/** Try to resolve a "TO::FieldName" field reference to an FmObject in the model. */

const ACTION_STEP_COLLAPSE_THRESHOLD = 120;

/** A button's single step, drawn like a script step (see ScriptWorkspace): the
 * code box with its copy button, the number cell with the expand glyph before
 * it. `children` is what follows the step name; `text` is what gets copied. */
function StepBlock({
  name,
  text,
  long,
  expanded,
  onToggle,
  children,
}: {
  name: string;
  text: string;
  long: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Section title="Step" flush>
      <CodeBox text={text}>
        <div className="sw">
          <div className="sw-line">
            <span className="lo-chevron-space" />
            <span className="sw-ln">
              {long && (
                <button type="button" className="glyph-btn lo-chevron" onClick={onToggle} aria-expanded={expanded}>
                  <span className={`fchevron${expanded ? " open" : ""}`}>›</span>
                </button>
              )}
              1
            </span>
            <span className="sw-step">
              <StepName name={name} />
              {children}
            </span>
          </div>
        </div>
      </CodeBox>
    </Section>
  );
}

function ActionStepSection({ name, params, link }: { name: string; params: string; link: CodeLinks }) {
  const long = params.length > ACTION_STEP_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long);
  const display = long && !expanded ? params.slice(0, ACTION_STEP_COLLAPSE_THRESHOLD) + "…" : params;
  return (
    <StepBlock name={name} text={params ? `${name} ${params}` : name} long={long} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
      {params && (
        <span className="sw-params">
          {" "}
          <LinkedCode text={display} objects={link.targets} onGo={link.onGo} model={link.model} owner={link.owner} />
        </span>
      )}
    </StepBlock>
  );
}

/** A button that runs a script, drawn as the Perform Script step it is: the
 * script's name links to the script, and the parameter (if any) follows it. */
function PerformScriptSection({
  scriptName,
  scriptObj,
  parameter,
  targets,
  model,
  owner,
  onGo,
}: {
  scriptName: string;
  scriptObj: FmObject | null;
  parameter?: string;
  /** The objects the button refers to, so names in the parameter link to them. */
  targets: FmObject[];
  model: SolutionModel;
  owner: string;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const long = (parameter?.length ?? 0) > ACTION_STEP_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long);
  const shown = parameter && long && !expanded ? parameter.slice(0, ACTION_STEP_COLLAPSE_THRESHOLD) + "…" : parameter;
  const params = (p: string | undefined) => `[ “${scriptName}”${p ? ` ; Parameter: ${p}` : ""} ]`;
  return (
    <StepBlock name="Perform Script" text={`Perform Script ${params(parameter)}`} long={long} expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
      <span className="sw-params">
        {" "}
        <LinkedCode text={params(shown)} objects={performScriptLinks(targets, scriptObj)} onGo={onGo} model={model} owner={owner} />
      </span>
    </StepBlock>
  );
}

/** Detail column content for a layout object (type = "layoutObject"). Shows the
 * FM-specific type, position, field binding, script reference, and triggers. */
function LayoutObjectColumnDetail({
  detail,
  owner,
  model,
  onGo,
}: {
  detail: Extract<ObjectDetail, { kind: "layoutObject" }>;
  owner: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const fileUid = owner.fileUid;

  const fieldRef = detail.fieldRef ? ownFieldRef(model, owner.uid, detail.fieldRef) : undefined;
  const fieldStatus = fieldRef ? refStatus(fieldRef, model.byUid) : "ok";
  const fieldClassName = fieldStatus === "broken" ? "broken" : fieldStatus === "ok" ? "" : "external";
  // The model's reference knows the script's file (it can be another one's).
  const scriptEdge = detail.scriptRef ? ownScriptRef(model, owner.uid) : undefined;
  const scriptObj = scriptEdge?.toUid ? model.byUid.get(scriptEdge.toUid) ?? null : null;
  const scriptName = detail.scriptRef?.name || (detail.scriptRef?.id ? `Script ${detail.scriptRef.id}` : "");
  const valueListObj = detail.valueListRef?.id
    ? model.byUid.get(`${fileUid}:valueList:${detail.valueListRef.id}`) ?? null
    : null;
  // A deleted value list is written as id -1 with no name: the model calls it
  // broken and FileMaker shows it as <Value List Missing>.
  const valueListEdge = detail.valueListRef
    ? model.outbound.get(owner.uid)?.find((r) => r.toType === "valueList" && r.toId === detail.valueListRef?.id)
    : undefined;
  const isValueListBroken = valueListEdge != null && refStatus(valueListEdge, model.byUid) === "broken";
  const valueListName = isValueListBroken
    ? refLabel(valueListEdge, model.byUid)
    : detail.valueListRef?.name || (detail.valueListRef?.id ? `Value list ${detail.valueListRef.id}` : "");

  const parentLayout = layoutOf(owner, model.byUid);
  const layoutDetail = parentLayout?.detail?.kind === "layout" ? parentLayout.detail : null;

  const children = model.objects.filter((o) => o.parentUid === owner.uid);

  return (
    <>
      {detail.loType === "Text" && detail.info && (
        <Section title="Definition">
          <CodeBox text={detail.info}>
            <pre className="code">{detail.info}</pre>
          </CodeBox>
        </Section>
      )}

      {detail.loType === "Web Viewer" && detail.info && (
        <Section title="Definition">
          <CodeBox text={detail.info.replace(/^URL:\s*/, "")}>
            <pre className="code">
              <LinkedCode
                text={detail.info.replace(/^URL:\s*/, "")}
                objects={refIndexFor(model, owner.uid).targets}
                onGo={onGo}
                model={model}
                owner={owner.uid}
              />
            </pre>
          </CodeBox>
        </Section>
      )}

      {detail.fieldRef && (
        <Section title="Field">
          <ul className="ref-list">
            <li title={detail.fieldRef} className={`row${fieldClassName ? ` ${fieldClassName} inert` : ""}`}>
              <TypePill type="field" short />
              <span className="ellipsis">
                <FieldRefLink qualified={detail.fieldRef} model={model} owner={owner.uid} onGo={onGo} />
              </span>
              {fieldClassName === "external" && <RefStatusChip kind={fieldStatus === "unmatched" ? "unmatched" : "external"} />}
            </li>
          </ul>
        </Section>
      )}

      {detail.portalSort && (
        <Section title="Sort order" count={detail.portalSort.length}>
          <SortFieldList fields={detail.portalSort} model={model} owner={owner.uid} onGo={onGo} />
        </Section>
      )}

      {detail.portalFilter && (
        <Section title="Filter">
          <CodeBox text={detail.portalFilter}>
            <pre className="code">
              <LinkedCode text={detail.portalFilter} objects={refIndexFor(model, owner.uid).targets} onGo={onGo} model={model} owner={owner.uid} />
            </pre>
          </CodeBox>
        </Section>
      )}

      {detail.hideWhen && (
        <Section title="Hide condition">
          <CodeBox text={detail.hideWhen}>
            <pre className="code">
              <LinkedCode text={detail.hideWhen} objects={refIndexFor(model, owner.uid).targets} onGo={onGo} model={model} owner={owner.uid} />
            </pre>
          </CodeBox>
          {detail.hideInFind && <div className="subtle">Also applies in Find mode</div>}
        </Section>
      )}

      {detail.actionStep && (
        <ActionStepSection
          name={detail.actionStep.name}
          params={detail.actionStep.params}
          link={{ targets: refIndexFor(model, owner.uid).targets, model, owner: owner.uid, onGo }}
        />
      )}

      {scriptName && (
        <PerformScriptSection
          scriptName={scriptName}
          scriptObj={scriptObj}
          parameter={detail.scriptParameter}
          targets={refIndexFor(model, owner.uid).targets}
          model={model}
          owner={owner.uid}
          onGo={onGo}
        />
      )}

      {valueListName && (
        <Section title="Value list">
          <ul className="ref-list">
            <li>
              <div
                {...pressable(() => valueListObj && onGo(valueListObj.uid, `lo-vl:${valueListObj.uid}`), { inert: !valueListObj })}
                title={valueListName}
                className={valueListObj ? "row" : isValueListBroken ? "row broken inert" : "row external inert"}
              >
                <TypePill type="valueList" short />
                <span className="ellipsis">{valueListName}</span>
              </div>
            </li>
          </ul>
        </Section>
      )}

      {detail.triggers && detail.triggers.length > 0 && (
        // The same rows as a layout's and a file's triggers: script, modes,
        // parameter and parameter field.
        <LayoutTriggers triggers={detail.triggers} owner={owner} model={model} onGo={onGo} title="Triggers" />
      )}

      {children.length > 0 && (
        <Section title="Contents" count={children.length}>
          <ul className="ref-list">
            {children.map((child) => (
              <li key={child.uid}>
              <div className="row" {...pressable(() => onGo(child.uid, child.uid))} title={child.name}>
                <TypePill type="layoutObject" short />
                <span className="ellipsis">{renderWithBrokenPlaceholders(child.name, brokenSourcesFor(model).has(child.uid))}</span>
              </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.chart && <ChartSection chart={detail.chart} owner={owner} model={model} onGo={onGo} />}

      {detail.conditionalFormats && detail.conditionalFormats.length > 0 && (
        <Section title="Conditional formatting" count={detail.conditionalFormats.length} defaultOpen={false}>
          {detail.conditionalFormats.map((formula, i) => (
            <Fragment key={i}>
              <div className="signature">Condition {i + 1}</div>
              <CodeBox text={formula}>
                <pre className="code">
                  <LinkedCode text={formula} objects={refIndexFor(model, owner.uid).targets} onGo={onGo} model={model} owner={owner.uid} />
                </pre>
              </CodeBox>
              {detail.conditionalFormatStyles?.[i] && (
                <CodeBox text={detail.conditionalFormatStyles[i]!}>
                  <pre className="code">{detail.conditionalFormatStyles[i]}</pre>
                </CodeBox>
              )}
            </Fragment>
          ))}
        </Section>
      )}

      {detail.style && (
        <Section title="Style" defaultOpen={false}>
          <CodeBox text={detail.style}>
            <pre className="code">{detail.style}</pre>
          </CodeBox>
        </Section>
      )}

      {layoutDetail && (
        <Section title="Position on layout" defaultOpen={false}>
          <LayoutMap detail={layoutDetail} hover={detail.bounds ?? null} />
        </Section>
      )}
    </>
  );
}

/** A chart's setup: its type, the records it charts, and the formulas behind
 * its titles and series. */
function ChartSection({
  chart,
  owner,
  model,
  onGo,
}: {
  chart: ChartInfo;
  owner: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const targets = refIndexFor(model, owner.uid).targets;
  const code = (text: string) => <LinkedCode text={text} objects={targets} onGo={onGo} model={model} owner={owner.uid} />;
  return (
    <Section title="Chart">
      <dl className="kv compact">
        {chart.type && (
          <>
            <dt>Type</dt>
            <dd>{chart.type}</dd>
          </>
        )}
        {chart.dataSource && (
          <>
            <dt>Data from</dt>
            <dd>
              {chart.dataSource}
              {chart.groupsWhenSorted ? " · record groups when sorted" : ""}
            </dd>
          </>
        )}
        {chart.title && (
          <>
            <dt>Title</dt>
            <dd>{code(chart.title)}</dd>
          </>
        )}
        {chart.xAxisTitle && (
          <>
            <dt>X-axis title</dt>
            <dd>{code(chart.xAxisTitle)}</dd>
          </>
        )}
        {chart.yAxisTitle && (
          <>
            <dt>Y-axis title</dt>
            <dd>{code(chart.yAxisTitle)}</dd>
          </>
        )}
        {chart.series.map((series, i) => (
          <Fragment key={i}>
            <dt>{series.axis} series</dt>
            <dd>
              {series.title && <div>Title: {code(series.title)}</div>}
              {series.value && <div>Data: {code(series.value)}</div>}
            </dd>
          </Fragment>
        ))}
      </dl>
      {!chart.series.some((series) => series.value) && (
        <div className="subtle indent">The export doesn't include this chart's data series.</div>
      )}
    </Section>
  );
}

/** Compact label for a layout object in tree view: "Type (identifier)" style. */
function layoutObjLabel(obj: LayoutObjectInfo): { text: string; dim: boolean } {
  // Text objects: show content in quotes (like FileMaker does)
  if (obj.type === "Text" && obj.info) {
    const s = obj.info.trim();
    const excerpt = s.length > 58 ? s.slice(0, 58) + "…" : s;
    return { text: `"${excerpt}"`, dim: false };
  }
  // Field-type: Type (TO::FieldName)
  if (obj.fieldRef) return { text: `${obj.type} (${obj.fieldRef})`, dim: false };
  // Portal: Portal (TOname [· rows])
  if (obj.type === "Portal" && obj.portalTable) {
    const rows = obj.portalRows ? ` · ${obj.portalRows}` : "";
    return { text: `Portal (${obj.portalTable}${rows})`, dim: false };
  }
  // Button / Grouped Button / Popover Button with a label (not web viewers — URL shown in Definition)
  if (obj.info && obj.type !== "Web Viewer") {
    const bare = obj.info.replace(/^"|"$/g, "");
    if (bare) return { text: `${obj.type} (${bare})`, dim: false };
  }
  // Tab / Slide panel: show label in quotes
  if (obj.type === "Panel" && obj.name.trim()) return { text: `"${obj.name}"`, dim: false };
  // Named object
  if (obj.name.trim()) return { text: obj.name, dim: false };
  // Fallback: just the type (dimmer)
  return { text: obj.type, dim: true };
}

/** Recursive compact tree row for a layout object. Containers (portals, tab
 * controls, groups, popovers, button bars) get a chevron and expand inline.
 * Object-level script triggers appear as navigable sub-lines directly below. */
function LayoutObjectTree({
  obj,
  depth,
  model,
  onGo,
}: {
  obj: LayoutObjectInfo;
  depth: number;
  model?: SolutionModel;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasChildren = (obj.children?.length ?? 0) > 0;
  const { text, dim } = layoutObjLabel(obj);
  // A placeholder in its label reads as broken only when the model says so.
  const broken = model == null || obj.uid == null || brokenSourcesFor(model).has(obj.uid);

  /** The script the object performs, as the model resolved it (it can be in another file). */
  function scriptTarget(): FmObject | null {
    const ref = model && obj.uid ? ownScriptRef(model, obj.uid) : undefined;
    return ref?.toUid ? model!.byUid.get(ref.toUid) ?? null : null;
  }

  const indent = depth * 14;

  return (
    <>
      <div
        className={`row lo-row${obj.uid && onGo ? " navigable" : " inert"}`}
        style={{ paddingLeft: indent }}
        title={[
          obj.fieldRef,
          obj.scriptParameter ? `Parameter: ${obj.scriptParameter}` : "",
          obj.tooltip ? `Tooltip: ${obj.tooltip}` : "",
          obj.placeholder ? `Placeholder: ${obj.placeholder}` : "",
          obj.hideWhen ? `Hide when: ${obj.hideWhen}` : "",
          obj.portalFilter ? `Filter: ${obj.portalFilter}` : "",
          obj.popoverTitle ? `Popover title: ${obj.popoverTitle}` : "",
          obj.bounds ? `${obj.bounds.left}, ${obj.bounds.top} → ${obj.bounds.right}, ${obj.bounds.bottom}` : "",
        ]
          .filter(Boolean)
          .join("\n") || undefined}
      >
        {hasChildren ? (
          <button type="button" className="glyph-btn lo-chevron" onClick={() => setOpen((v) => !v)}>
            <span className={`fchevron${open ? " open" : ""}`}>›</span>
          </button>
        ) : (
          <span className="lo-chevron-space" />
        )}
        <span
          className={`lo-label${dim ? " lo-label-dim" : ""}${obj.uid && onGo ? " lo-label-selectable" : ""}`}
          {...pressable(() => onGo?.(obj.uid!, `lo:${obj.uid}`), { inert: !(obj.uid && onGo) })}
        >{renderWithBrokenPlaceholders(text, broken)}</span>
        {obj.scriptRef && (() => {
          const target = scriptTarget();
          const sName = obj.scriptRef.name || (obj.scriptRef.id ? `Script ${obj.scriptRef.id}` : "");
          return sName ? (
            <span className="lo-script-ref">
              {target && onGo ? (
                <button
                  type="button"
                  className="link-btn lo-script-link"
                  onClick={() => onGo(target.uid, "")}
                >
                  → {sName}
                </button>
              ) : (
                <span>→ {sName}</span>
              )}
            </span>
          ) : null;
        })()}
        {(obj.triggers?.length ?? 0) > 0 && (
          <span className="tag lo-trigger-badge" title={obj.triggers!.map((t) => t.action).join(", ")}>
            {obj.triggers!.length}T
          </span>
        )}
      </div>
      {hasChildren &&
        open &&
        obj.children!.map((child, i) => (
          <LayoutObjectTree
            key={i}
            obj={child}
            depth={depth + 1}
            model={model}
            onGo={onGo}
          />
        ))}
    </>
  );
}

/** A collapsible group of layout objects, styled like the navigator's section
 * groups. Header and rows optionally drive the map highlight (the off-layout
 * group passes neither, since its objects aren't on the drawn area). */
function LayoutObjectGroup({
  title,
  objects,
  defaultOpen,
  onHeaderEnter,
  onObjectEnter,
  onLeave,
  model,
  fileUid,
  onGo,
}: {
  title: string;
  objects: LayoutObjectInfo[];
  defaultOpen: boolean;
  onHeaderEnter?: () => void;
  onObjectEnter?: (b: LayoutBounds) => void;
  onLeave?: () => void;
  model?: SolutionModel;
  fileUid?: string;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="layout-part">
      <div
        className="head clickable group-header"
        {...pressable(() => setOpen((v) => !v), { expanded: open })}
        onMouseEnter={onHeaderEnter}
        onMouseLeave={onLeave}
      >
        <span className={`fchevron${open ? " open" : ""}`}>›</span>
        {title} · {objects.length}
      </div>
      {open && objects.length > 0 && (
        <ul className="layout-objects">
          {objects.map((obj, j) => (
            <LayoutObjectRow
              key={j}
              obj={obj}
              onEnter={onObjectEnter}
              onLeave={onLeave}
              model={model}
              fileUid={fileUid}
              onGo={onGo}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A single layout-object row: name, a type chip, and any extra info lines.
 * Portals, tab/slide controls, groups, button bars, and popovers render
 * collapsible nested groups for their children. Only hoverable when
 * onEnter + bounds exist. When model + onGo are supplied, script references
 * (triggers, button actions) are rendered as navigable links. */
function LayoutObjectRow({
  obj,
  onEnter,
  onLeave,
  model,
  fileUid,
  onGo,
}: {
  obj: LayoutObjectInfo;
  onEnter?: (b: LayoutBounds) => void;
  onLeave?: () => void;
  model?: SolutionModel;
  fileUid?: string;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const named = obj.name.trim() !== "";
  const hoverable = onEnter != null && obj.bounds != null;
  const isPortal = obj.type === "Portal";
  const isTabControl = obj.type === "Tab Control" || obj.type === "Slide Control";

  function scriptTarget(id: string | undefined): FmObject | null {
    if (!id || !model || !fileUid) return null;
    return model.byUid.get(`${fileUid}:script:${id}`) ?? null;
  }

  return (
    <li
      className={`row inert${hoverable ? " hoverable" : ""}`}
      title={
        obj.bounds
          ? `${obj.bounds.left}, ${obj.bounds.top} → ${obj.bounds.right}, ${obj.bounds.bottom}`
          : undefined
      }
      onMouseEnter={hoverable ? () => onEnter!(obj.bounds!) : undefined}
      onMouseLeave={hoverable ? onLeave : undefined}
    >
      <div className="layout-obj-row">
        <span className={`layout-obj-name${named ? "" : " unnamed"}`}>
          {named ? obj.name : `unnamed ${obj.type.toLowerCase()}`}
        </span>
        <span className="tag layout-obj-type">{obj.type}</span>
        {(obj.triggers?.length ?? 0) > 0 && (
          <span className="tag layout-obj-type layout-obj-triggers-chip">
            {obj.triggers!.length} trigger{obj.triggers!.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {isPortal && obj.portalTable && (
        <div className="layout-portal-meta">
          {obj.portalTable}
          {obj.portalRows ? ` · ${obj.portalRows} rows` : ""}
        </div>
      )}
      {isPortal && obj.portalSort && (
        <div className="layout-obj-info">
          Sorted by{" "}
          {renderWithBrokenPlaceholders(
            obj.portalSort.map((f) => f.field).join(", "),
            model == null || obj.uid == null || brokenSourcesFor(model).has(obj.uid),
          )}
        </div>
      )}
      {obj.fieldRef && <div className="layout-obj-info">{obj.fieldRef}</div>}
      {obj.info && <div className="layout-obj-info">{obj.info}</div>}
      {obj.scriptRef && (() => {
        const target = scriptTarget(obj.scriptRef.id);
        const label = obj.scriptRef.name || (obj.scriptRef.id ? `Script ${obj.scriptRef.id}` : "(missing script)");
        return (
          <div className="layout-obj-info">
            {target && onGo ? (
              <button type="button" className="obj-link" onClick={() => onGo(target.uid, "")}>
                {label}
              </button>
            ) : (
              label
            )}
          </div>
        );
      })()}
      {obj.scriptParameter && <div className="layout-obj-info layout-obj-tooltip">Parameter: {obj.scriptParameter}</div>}
      {obj.tooltip && <div className="layout-obj-info layout-obj-tooltip">Tooltip: {obj.tooltip}</div>}
      {obj.hideWhen && (
        <div className="layout-obj-info layout-obj-tooltip">
          Hide when: {obj.hideWhen}
          {obj.hideInFind ? " (also in Find mode)" : ""}
        </div>
      )}
      {obj.conditionalFormats?.map((c, i) => (
        <div key={i} className="layout-obj-info layout-obj-tooltip">
          Conditional format: {c}
        </div>
      ))}
      {obj.triggers && obj.triggers.length > 0 && (
        <div className="layout-obj-trigger-lines">
          {obj.triggers.map((t, i) => {
            const target = scriptTarget(t.scriptId);
            const label = t.scriptName || (t.scriptId ? `Script ${t.scriptId}` : "(missing script)");
            return (
              <div key={i} className="layout-obj-trigger-line">
                {t.action} →{" "}
                {target && onGo ? (
                  <button type="button" className="obj-link" onClick={() => onGo(target.uid, "")}>
                    {label}
                  </button>
                ) : (
                  label
                )}
              </div>
            );
          })}
        </div>
      )}
      {isPortal && obj.children && obj.children.length > 0 && (
        <div className="layout-obj-children">
          <LayoutObjectGroup
            title="Fields"
            objects={obj.children}
            defaultOpen={false}
            model={model}
            fileUid={fileUid}
            onGo={onGo}
          />
        </div>
      )}
      {isTabControl && obj.children && obj.children.length > 0 && (
        <div className="layout-obj-children">
          {obj.children.map((panel, i) => (
            <LayoutObjectGroup
              key={i}
              title={panel.name || `Tab ${i + 1}`}
              objects={panel.children ?? []}
              defaultOpen={false}
              model={model}
              fileUid={fileUid}
              onGo={onGo}
            />
          ))}
        </div>
      )}
      {!isPortal && !isTabControl && obj.children && obj.children.length > 0 && (
        <div className="layout-obj-children">
          <LayoutObjectGroup
            title={childGroupLabel(obj.type)}
            objects={obj.children}
            defaultOpen={false}
            model={model}
            fileUid={fileUid}
            onGo={onGo}
          />
        </div>
      )}
    </li>
  );
}

function childGroupLabel(type: string): string {
  if (type === "Button Bar") return "Segments";
  if (type === "Popover Button") return "Popover";
  return "Contents";
}

/** A proportional skeleton of the layout: each part as a band (to scale), with an
 * optional highlighted rectangle for the part/object currently hovered. */
function LayoutMap({
  detail,
  hover,
}: {
  detail: Extract<ObjectDetail, { kind: "layout" }>;
  hover: LayoutBounds | null;
}) {
  const { width, height } = detail;
  if (width <= 0 || height <= 0) return null;

  const MAX_W = 420;
  const MAX_H = 560;
  const scale = Math.min(MAX_W / width, MAX_H / height, 1);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  // A part's name sits outside the map, on the right, level with the middle of
  // its band; a band too thin to carry a label on screen goes without one.
  const MIN_LABEL_H = 12;

  return (
    <div className="layout-map">
      <svg width={w} height={h} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Layout map">
        {detail.parts.map((part, i) =>
          part.height > 0 ? (
            <g key={i}>
              <rect
                x={0}
                y={part.top}
                width={width}
                height={part.height}
                className="layout-map-part"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null,
        )}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          className="layout-map-frame"
          vectorEffect="non-scaling-stroke"
        />
        {hover && (
          <rect
            x={hover.left}
            y={hover.top}
            width={Math.max(hover.right - hover.left, 1)}
            height={Math.max(hover.bottom - hover.top, 1)}
            className="layout-map-obj"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="layout-map-labels" style={{ height: h }}>
        {detail.parts.map(
          (part, i) =>
            part.height * scale >= MIN_LABEL_H && (
              <span key={i} className="layout-map-part-name" style={{ top: (part.top + part.height / 2) * scale }}>
                {part.type}
              </span>
            ),
        )}
      </div>
    </div>
  );
}

/** A value list's full contents: literal custom values, or its field binding. */
function ValueListDetail({
  detail,
  refIndex,
  model,
  owner,
  onGo,
}: {
  detail: Extract<ObjectDetail, { kind: "valueList" }>;
  refIndex: RefIndex;
  model: SolutionModel;
  /** The value list's uid: its own field references are shown. */
  owner: string;
  onGo: (uid: string, rowKey: string) => void;
}) {
  const { source, customValues, field } = detail;

  if (field) {
    const related = field.showRelatedFrom ? refIndex.resolve(field.showRelatedFrom, "tableOccurrence") : null;
    return (
      <Section title="Values from field">
        <dl className="kv compact">
          <dt>Field</dt>
          <dd>
            {field.primaryField ? (
              <FieldRefLink qualified={field.primaryField} model={model} owner={owner} onGo={onGo} />
            ) : (
              "(none)"
            )}
          </dd>
          {field.secondaryField && (
            <>
              <dt>{field.showOnlySecondary ? "Displays only" : "Also displays"}</dt>
              <dd>
                <FieldRefLink qualified={field.secondaryField} model={model} owner={owner} onGo={onGo} />
              </dd>
            </>
          )}
          <dt>Sorted</dt>
          <dd>{field.sort ? "By this field" : field.sortBySecondField ? "By second field" : "By field order"}</dd>
          <dt>Scope</dt>
          <dd>
            {field.showRelatedFrom ? (
              <>
                Related values from{" "}
                {related ? <ObjLink obj={related} onGo={onGo} /> : field.showRelatedFrom}
              </>
            ) : (
              "All values"
            )}
          </dd>
        </dl>
      </Section>
    );
  }

  return (
    <Section title="Custom values" count={customValues.length}>
      {customValues.length === 0 ? (
        <div className="subtle indent">
          {source === "Custom"
            ? "No values."
            : source === "External"
              ? "Defined in another file (load it to see the values)."
              : "No contents."}
        </div>
      ) : (
        <ol className="value-list">
          {customValues.map((v, i) => (
            <li key={i}>{v === "" ? <span className="subtle">— divider —</span> : v}</li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/** Split dependency edges into per-type subgroups in the canonical type order.
 * Edges arrive already sorted by type then name (see buildDependencyView), so
 * each subgroup is alphabetical. References are a structured jump menu, not a
 * flat list — grouping is what makes them scannable. */
function groupEdgesByType(edges: DependencyEdge[]): { type: ObjectType; edges: DependencyEdge[] }[] {
  const order = Object.keys(OBJECT_TYPE_META) as ObjectType[];
  const buckets = new Map<ObjectType, DependencyEdge[]>();
  for (const edge of edges) {
    const type = edge.target?.type ?? edge.ref.toType;
    const list = buckets.get(type);
    if (list) list.push(edge);
    else buckets.set(type, [edge]);
  }
  return order.filter((t) => buckets.has(t)).map((t) => ({ type: t, edges: buckets.get(t)! }));
}

/** A grouped reference list: outbound (`side="to"`) or inbound (`side="from"`)
 * edges, bucketed by target type so each type is its own labeled jump group.
 * Clicking any item appends a column. */
export function GroupedRefList({
  edges,
  side,
  onGo,
  byUid,
  previewLimit = DETAIL_REF_PREVIEW_LIMIT,
  isUnused,
}: {
  edges: DependencyEdge[];
  side: "from" | "to";
  onGo: (uid: string, rowKey: string) => void;
  byUid: Map<string, FmObject>;
  /** Rows shown before "Show more" (the object page's tabs show more). */
  previewLimit?: number;
  /** Marks rows whose object is itself unused (see core/analysis/unusedChains). */
  isUnused?: (uid: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (edges.length === 0) return <div className="subtle indent">None.</div>;
  const shown = expanded ? edges : edges.slice(0, previewLimit);
  const remaining = edges.length - shown.length;
  // Group labels always show the true total for that type, even while only a
  // truncated preview of rows is rendered — otherwise "Fields · 3" would lie
  // about how many fields are actually referenced.
  const totalCountByType = new Map(groupEdgesByType(edges).map((g) => [g.type, g.edges.length]));
  return (
    <>
      {groupEdgesByType(shown).map((group) => (
        <div className="ref-group" key={group.type}>
          <div className="head ref-group-label">
            {OBJECT_TYPE_META[group.type].plural} · {totalCountByType.get(group.type) ?? group.edges.length}
          </div>
          <ul className="ref-list">
            {group.edges.map((edge, i) => {
              // edge.target is the SOURCE object for inbound, the TARGET for outbound.
              const obj = edge.target;
              // The target's status and label are the model's (core/model/refStatus):
              // deleted is broken; a field behind a file that wasn't available at
              // export can't be verified; a name from calc text that its loaded
              // file doesn't have is unmatched; one in another, unloaded file is external.
              const status = side === "to" ? refStatus(edge.ref, byUid) : "ok";
              const broken = status === "broken";
              const unverifiable = status === "unverifiable";
              const unmatched = status === "unmatched";
              const external = status === "external" || unverifiable;
              const unused = obj != null && (isUnused?.(obj.uid) ?? false);
              const rowKey = `${edge.ref.fromUid}-${edge.ref.toId}-${group.type}-${i}`;
              const type = obj?.type ?? edge.ref.toType;
              // A using layout object is shown after the layout it's on, which links on its own.
              const layout = side === "from" && obj?.type === "layoutObject" ? layoutOf(obj, byUid) : null;
              const label =
                side === "to"
                  ? refLabel(edge.ref, byUid)
                  : layout && obj
                    ? `${layout.name} › ${objectLabel(obj)}`
                    : (sourceFieldLabel(edge, byUid) ?? (obj ? objectLabel(obj) : edge.ref.fromUid));
              const title = broken
                ? `Broken — ${label}`
                : unverifiable
                  ? `${label} — can't be verified: its file wasn't available when this file was exported`
                  : unmatched
                    ? `${label} — no field by that name in its file (read from calculation text)`
                    : external
                      ? `${label} — in another file (not loaded)`
                      : edge.disabled
                        ? `${label} — in a disabled step, so it doesn't count as a use`
                        : unused
                          ? `${label} — itself unused`
                          : label;
              return (
                <li key={rowKey}>
                  <div
                    className={`row${broken ? " broken inert" : external || unmatched ? " external inert" : ""}`}
                    {...pressable(() => obj && onGo(obj.uid, rowKey), { inert: broken || external || unmatched || !obj })}
                    title={title}
                  >
                    {layout && obj ? (
                      <>
                        <TypePill type="layout" short />
                        <button
                          type="button"
                          className="obj-link ellipsis"
                          title={layout.name}
                          onClick={(e) => {
                            e.stopPropagation();
                            onGo(layout.uid, `${rowKey}-layout`);
                          }}
                        >
                          {layout.name}
                        </button>
                        <span className="ref-sep">›</span>
                        <TypePill type={type} short />
                        <span className="ellipsis">{objectLabel(obj)}</span>
                      </>
                    ) : (
                      <>
                        <TypePill type={type} short />
                        <span className="ellipsis">{label}</span>
                      </>
                    )}
                    {external && <RefStatusChip kind="external" />}
                    {unmatched && <RefStatusChip kind="unmatched" />}
                    {edge.disabled && <RefStatusChip kind="disabled" />}
                    {unused && <RefStatusChip kind="unused" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {remaining > 0 && (
        <button type="button" className="link-btn ref-show-more" onClick={() => setExpanded(true)}>
          Show {remaining} more
        </button>
      )}
    </>
  );
}

export function CallTreeNode({
  node,
  path,
  onGo,
  isRoot,
  clickedKey,
  isUnused,
}: {
  node: CallNode;
  /** Position of this node in the tree, so duplicate scripts get distinct keys. */
  path: string;
  onGo: (uid: string, rowKey: string) => void;
  isRoot?: boolean;
  clickedKey?: string;
  /** Dims the scripts nothing in use reaches: on an unused script's tree, the
   * ones that go with it (see core/analysis/unusedChains). */
  isUnused?: (uid: string) => boolean;
}) {
  const rowKey = `call:${path}`;
  const clicked = !isRoot && rowKey === clickedKey;
  const unused = !isRoot && (isUnused?.(node.uid) ?? false);
  const className = `row call-node${isRoot ? " root" : ""}${node.broken ? " broken" : ""}${node.external ? " external" : ""}${unused ? " unused" : ""}${clicked ? " active" : ""}${isRoot || node.broken || node.external ? " inert" : ""}`;
  const clickable = !node.broken && !node.external && !isRoot;
  return (
    <li>
      <span
        className={className}
        {...pressable(() => onGo(node.uid, rowKey), { inert: !clickable })}
        title={node.disabled ? "Called in a disabled step: FileMaker never runs it" : unused ? "Used only by unused scripts" : undefined}
      >
        {node.name}
        {node.broken && " — missing"}
        {node.external && <RefStatusChip kind="external" />}
        {node.disabled && <RefStatusChip kind="disabled" />}
      </span>
      {node.children.length > 0 && (
        <ul className="tree">
          {node.children.map((child, i) => (
            <CallTreeNode
              key={`${child.uid}-${i}`}
              node={child}
              path={`${path}.${i}`}
              onGo={onGo}
              clickedKey={clickedKey}
              isUnused={isUnused}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
