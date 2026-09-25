import { Fragment, useState } from "react";
import {
  OBJECT_TYPE_META,
  objectLabel,
  isBrokenTableOccurrence,
  type FmObject,
  type LayoutBounds,
  type LayoutObjectInfo,
  type LayoutTriggerInfo,
  type ObjectDetail,
  type ObjectType,
  type PrivilegeSetTableAccess,
  type SolutionModel,
} from "@/types/ddr";
import { buildDependencyView, type DependencyEdge } from "@/core/analysis/dependencies";
import type { CallNode } from "@/core/analysis/callChain";
import { BROKEN_PLACEHOLDER_RE } from "@/core/identifiers";
import {
  findMissingFieldOccurrences,
  resolveQualifiedRef,
  type RefResolution,
} from "@/core/model/refResolution";
import { RelationshipERD } from "./RelationshipERD";
import { ScriptWorkspace } from "./ScriptWorkspace";
import { Highlight, LinkedCode, decodeEntities } from "./Highlight";
import { FieldRefLink, ObjLink, RefStatusChip } from "./FieldRefLink";
import { TypePill } from "./TypePill";

/** How many rows a References / Referenced By widget shows before "Show more". */
const DETAIL_REF_PREVIEW_LIMIT = 10;

/** For field references, return `OCCURRENCE::field`; null for all other types.
 * Prefers the named occurrence from viaUid; falls back to the field's parent
 * base table when the reference has no occurrence context (e.g. summary fields
 * resolved via viaBaseTableId). */
function fieldRefLabel(edge: DependencyEdge, byUid: Map<string, FmObject>): string | null {
  const type = edge.target?.type ?? edge.ref.toType;
  if (type !== "field") return null;
  const occ = edge.ref.viaUid ? byUid.get(edge.ref.viaUid) : undefined;
  const parentTable = edge.target?.parentUid ? byUid.get(edge.target.parentUid) : undefined;
  const occName = occ?.name ?? parentTable?.name;
  const fieldName = edge.target?.name ?? edge.ref.toName;
  if (!fieldName || /Missing>$/.test(fieldName)) return null;
  return occName ? `${occName}::${fieldName}` : fieldName;
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
  position: "Position",
  label: "Label",
  tooltip: "Tooltip",
  portalOccurrence: "Table occurrence",
  portalRows: "Portal rows",
  // Layout options.
  includeInLayoutMenus: "Include in layout menus",
  clientType: "Client type",
  menuSet: "Menu set",
  // Table-occurrence graph box.
  graphPosition: "Graph position",
  color: "Color",
  // Custom menu / menu item.
  installCondition: "Install when",
  overrides: "Overrides",
  sourceUuid: "Source UUID",
  // File options.
  autoLogin: "Auto-login",
  encryption: "Encryption",
  minimumVersion: "Minimum version",
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
  const decoded = decodeEntities(value);
  const target = refIndex.resolve(decoded);
  if (target) return <ObjLink obj={target} onGo={onGo} />;
  return <>{renderWithBrokenPlaceholders(decoded)}</>;
}

/** The CSS class an inline-resolved `TO::Field` should wear in a property
 * sheet row, given the resolver's verdict. `external` dims + chips, `broken`
 * goes red, `resolved` / null clears the class. */
function resolutionToClass(res: RefResolution | null): string {
  if (!res || res.kind === "resolved") return "";
  if (res.kind === "external") return "external";
  return "broken";
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
 * `broken-value` span so it reads as broken everywhere it shows up (titles,
 * attribute rows, layout-object names), instead of mixing in with normal
 * text. The placeholder pattern itself lives in @/core/identifiers. */
export function renderWithBrokenPlaceholders(text: string): React.ReactNode {
  if (!text.includes("<")) return text;
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

  // For layout objects, walk up to find the ancestor layout (the immediate
  // parent may be a portal, tab, or other container, not the layout itself).
  const ancestorLayout = obj.type === "layoutObject" ? (() => {
    let uid = obj.parentUid;
    while (uid) {
      const ancestor = model.byUid.get(uid);
      if (!ancestor) break;
      if (ancestor.type === "layout") return ancestor;
      uid = ancestor.parentUid;
    }
    return null;
  })() : null;

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

        {a.unstored === "true" && (
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
                <span className="broken-value">{decodeEntities(value)}</span>
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

/** A collapsible section with a header, count, and chevron — rendered as a
 * bordered "widget" card, matching the report card's metric-tile look. */
export function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="detail-widget">
      <div className="detail-widget-header clickable" onClick={() => setOpen((v) => !v)}>
        <span className={`fchevron${open ? " open" : ""}`}>›</span> {title}
        {count != null && ` · ${count}`}
      </div>
      {open && <div className="detail-widget-body">{children}</div>}
    </div>
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
    return (
      <Section title="Script steps" count={detail.steps.length}>
        {detail.steps.length === 0 ? (
          <div className="subtle indent">No steps.</div>
        ) : (
          <ScriptWorkspace
            steps={detail.steps}
            brokenSteps={brokenSteps}
            scrollToStep={scrollToStep}
            stepRefs={refIndex.byStep}
            scriptGlobals={refIndex.scriptGlobals}
            model={model}
            fileUid={owner.fileUid}
            onGo={onGo}
          />
        )}
      </Section>
    );
  }

  if (detail.kind === "calculation") {
    return (
      <Section title="Definition">
        {detail.signature && <div className="signature">{detail.signature}</div>}
        <pre className="code">
          {detail.body ? (
            <LinkedCode text={detail.body} objects={refIndex.targets} onGo={onGo} model={model} fileUid={owner.fileUid} />
          ) : (
            "(empty)"
          )}
        </pre>
      </Section>
    );
  }

  if (detail.kind === "summary") {
    const text = `${detail.operation} ${detail.fields.join(", ")}`;
    const fieldObjs = detail.fields
      .map((name) => refIndex.resolve(name, "field"))
      .filter((o): o is FmObject => o != null);
    return (
      <Section title="Definition">
        <pre className="code">
          <LinkedCode text={text} objects={fieldObjs} onGo={onGo} model={model} fileUid={owner.fileUid} />
        </pre>
      </Section>
    );
  }

  if (detail.kind === "lookup") {
    return (
      <Section title="Definition">
        <dl className="kv compact">
          <dt>Looked up from</dt>
          <dd>
            <FieldRefLink qualified={detail.source} model={model} fileUid={owner.fileUid} onGo={onGo} />
          </dd>
        </dl>
      </Section>
    );
  }

  if (detail.kind === "relationship") {
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
    return <PrivilegeSetDetail detail={detail} />;
  }

  return <ValueListDetail detail={detail} refIndex={refIndex} model={model} fileUid={owner.fileUid} onGo={onGo} />;
}

/** A privilege set's custom per-table record access — one row per table, with
 * an expandable per-field breakdown for any table whose field access is
 * itself Custom (potentially hundreds of fields, so it starts collapsed). */
function PrivilegeSetDetail({ detail }: { detail: Extract<ObjectDetail, { kind: "privilegeSet" }> }) {
  return (
    <Section title="Table & field access" count={detail.tables.length}>
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
          {detail.tables.map((t, i) => (
            <tr key={i}>
              <td>{t.table}</td>
              <td>
                <PrivilegeConditionCell label={t.view} condition={t.viewCondition} />
              </td>
              <td>
                <PrivilegeConditionCell label={t.edit} condition={t.editCondition} />
              </td>
              <td>{t.create}</td>
              <td>
                <PrivilegeConditionCell label={t.delete} condition={t.deleteCondition} />
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

/** A "Limited" View/Edit/Delete grant — click to expand the calculation
 * formula behind it, syntax-highlighted the same way a calc field's body is. */
function PrivilegeConditionCell({ label, condition }: { label: string; condition?: string }) {
  const [open, setOpen] = useState(false);
  if (!condition) return <>{label}</>;
  return (
    <>
      <button type="button" className="privilege-fields-toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`fchevron${open ? " open" : ""}`}>›</span> {label}
      </button>
      {open && (
        <pre className="code privilege-condition">
          <Highlight text={condition} />
        </pre>
      )}
    </>
  );
}

function PrivilegeFieldsCell({ table }: { table: PrivilegeSetTableAccess }) {
  const [open, setOpen] = useState(false);
  if (!table.fields || table.fields.length === 0) return <>{table.fieldsAccess}</>;
  return (
    <>
      <button type="button" className="privilege-fields-toggle" onClick={() => setOpen((v) => !v)}>
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
                className={`layout-type-chip${typeFilter === null ? " active" : ""}`}
                onClick={() => setTypeFilter(null)}
              >
                All
              </button>
              {filterChips.map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  className={`layout-type-chip${typeFilter === type ? " active" : ""}`}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                >
                  {type} <span className="count">{count}</span>
                </button>
              ))}
              {triggerCount > 0 && (
                <button
                  type="button"
                  className={`layout-type-chip${typeFilter === "Has Triggers" ? " active" : ""}`}
                  onClick={() => setTypeFilter(typeFilter === "Has Triggers" ? null : "Has Triggers")}
                >
                  Has Triggers <span className="count">{triggerCount}</span>
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
                <div className="lo-part-divider clickable" onClick={() => togglePart(i)}>
                  <span className={`fchevron${open ? " open" : ""}`}>›</span>
                  {part.type} · {objects.length}
                </div>
                {open && objects.map((obj, j) => (
                  <LayoutObjectTree
                    key={j}
                    obj={obj}
                    depth={0}
                    model={model}
                    fileUid={owner.fileUid}
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
                <div className="lo-part-divider clickable" onClick={() => setOffLayoutOpen((v) => !v)}>
                  <span className={`fchevron${offLayoutOpen ? " open" : ""}`}>›</span>
                  Off-layout · {objects.length}
                </div>
                {offLayoutOpen && objects.map((obj, j) => (
                  <LayoutObjectTree
                    key={j}
                    obj={obj}
                    depth={0}
                    model={model}
                    fileUid={owner.fileUid}
                    onGo={onGo}
                  />
                ))}
              </div>
            );
          })()}
        </div>
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
  const outbound = buildDependencyView(model, owner.uid)?.outbound.filter((e) => e.ref.kind !== "menuItem") ?? [];
  const targets = refIndexFor(model, owner.uid).targets;
  return (
    <Section title={title} count={triggers.length}>
      {triggers.length === 0 ? (
        <div className="subtle indent">No {title.toLowerCase()}.</div>
      ) : (
        <dl className="kv compact layout-triggers">
          {triggers.map((trigger, i) => (
            <LayoutTriggerRow
              trigger={trigger}
              owner={owner}
              model={model}
              outbound={outbound}
              targets={targets}
              onGo={onGo}
              key={`${trigger.id ?? trigger.action}:${i}`}
            />
          ))}
        </dl>
      )}
    </Section>
  );
}

function LayoutTriggerRow({
  trigger,
  owner,
  model,
  outbound,
  targets,
  onGo,
}: {
  trigger: LayoutTriggerInfo;
  owner: FmObject;
  model: SolutionModel;
  outbound: DependencyEdge[];
  targets: FmObject[];
  onGo: (uid: string, rowKey: string) => void;
}) {
  const script = trigger.scriptName || (trigger.scriptId ? `Script ${trigger.scriptId}` : "(missing script)");
  const target = trigger.scriptId ? model.byUid.get(`${owner.fileUid}:script:${trigger.scriptId}`) ?? null : null;
  const rowKey = target ? layoutTriggerRowKey(owner.uid, trigger, target, outbound) : "";
  const title = [trigger.scriptUuid ? `UUID: ${trigger.scriptUuid}` : "", trigger.id ? `Trigger id: ${trigger.id}` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <Fragment>
      <dt>{trigger.action}</dt>
      <dd title={title || undefined}>
        <div className="layout-obj-row">
          {target ? (
            <button className="layout-obj-name layout-trigger-link" type="button" onClick={() => onGo(target.uid, rowKey)}>
              {script}
            </button>
          ) : (
            <span className="layout-obj-name">{script}</span>
          )}
          {trigger.modes.map((mode) => (
            <span className="layout-obj-type" key={mode}>
              {mode}
            </span>
          ))}
        </div>
        {trigger.parameterFieldName && (
          <div className="layout-trigger-info">
            Parameter field: <LinkedCode text={trigger.parameterFieldName} objects={targets} onGo={onGo} model={model} fileUid={owner.fileUid} />
          </div>
        )}
        {trigger.parameter && (
          <div className="layout-trigger-info">
            Parameter: <LinkedCode text={trigger.parameter} objects={targets} onGo={onGo} model={model} fileUid={owner.fileUid} />
          </div>
        )}
      </dd>
    </Fragment>
  );
}

function layoutTriggerRowKey(
  ownerUid: string,
  trigger: LayoutTriggerInfo,
  target: FmObject,
  outbound: DependencyEdge[],
): string {
  const refIndex = outbound.findIndex(
    (edge) =>
      edge.target?.uid === target.uid &&
      edge.ref.toType === "script" &&
      (trigger.scriptId == null || edge.ref.toId === trigger.scriptId),
  );
  if (refIndex >= 0) {
    const edge = outbound[refIndex];
    if (edge) return `${edge.ref.fromUid}-${edge.ref.toId}-${refIndex}`;
  }
  return `layout-trigger:${ownerUid}:${trigger.id ?? trigger.action}:${target.uid}`;
}

/** Try to resolve a "TO::FieldName" field reference to an FmObject in the model. */

const ACTION_STEP_COLLAPSE_THRESHOLD = 120;

function ActionStepSection({ name, params }: { name: string; params: string }) {
  const long = params.length > ACTION_STEP_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long);
  const display = long && !expanded ? params.slice(0, ACTION_STEP_COLLAPSE_THRESHOLD) + "…" : params;
  return (
    <Section title="Step">
      <div className="sw">
        <div className="sw-line">
          {long ? (
            <button type="button" className="lo-chevron" onClick={() => setExpanded((v) => !v)}>
              <span className={`fchevron${expanded ? " open" : ""}`}>›</span>
            </button>
          ) : (
            <span className="lo-chevron-space" />
          )}
          <span className="sw-ln">1</span>
          <span className="sw-step">
            <span className="sw-name">{name}</span>
            {params && (
              <span className="sw-params"> {display}</span>
            )}
          </span>
        </div>
      </div>
    </Section>
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

  function scriptTarget(id: string | undefined): FmObject | null {
    if (!id) return null;
    return model.byUid.get(`${fileUid}:script:${id}`) ?? null;
  }

  const fieldResolution = detail.fieldRef ? resolveQualifiedRef(detail.fieldRef, model, fileUid) : null;
  const fieldClassName = resolutionToClass(fieldResolution);
  const scriptObj = detail.scriptRef ? scriptTarget(detail.scriptRef.id) : null;
  const scriptName = detail.scriptRef?.name || (detail.scriptRef?.id ? `Script ${detail.scriptRef.id}` : "");
  const valueListObj = detail.valueListRef?.id
    ? model.byUid.get(`${fileUid}:valueList:${detail.valueListRef.id}`) ?? null
    : null;
  const valueListName =
    detail.valueListRef?.name || (detail.valueListRef?.id ? `Value list ${detail.valueListRef.id}` : "");

  function ancestorLayout(): FmObject | null {
    let uid = owner.parentUid;
    while (uid) {
      const obj = model.byUid.get(uid);
      if (!obj) return null;
      if (obj.type === "layout") return obj;
      uid = obj.parentUid;
    }
    return null;
  }
  const parentLayout = ancestorLayout();
  const layoutDetail = parentLayout?.detail?.kind === "layout" ? parentLayout.detail : null;

  const children = model.objects.filter((o) => o.parentUid === owner.uid);

  return (
    <>
      {detail.loType === "Text" && detail.info && (
        <Section title="Definition">
          <pre className="lo-text-content">{detail.info}</pre>
        </Section>
      )}

      {detail.loType === "Web Viewer" && detail.info && (
        <Section title="Definition">
          <pre className="code">
            <LinkedCode
              text={detail.info.replace(/^URL:\s*/, "")}
              objects={refIndexFor(model, owner.uid).targets}
              onGo={onGo}
            />
          </pre>
        </Section>
      )}

      {detail.fieldRef && (
        <Section title="Field">
          <ul className="ref-list">
            <li title={detail.fieldRef} className={fieldClassName}>
              <TypePill type="field" short />
              <span className="ellipsis">
                <FieldRefLink qualified={detail.fieldRef} model={model} fileUid={fileUid} onGo={onGo} />
              </span>
              {fieldClassName === "external" && <RefStatusChip kind="external" />}
            </li>
          </ul>
        </Section>
      )}

      {detail.actionStep && (
        <ActionStepSection name={detail.actionStep.name} params={detail.actionStep.params} />
      )}

      {scriptName && (
        <Section title="Script">
          <ul className="ref-list">
            <li
              onClick={() => scriptObj && onGo(scriptObj.uid, `lo-script:${scriptObj.uid}`)}
              title={scriptName}
              className={scriptObj ? "" : "external"}
            >
              <TypePill type="script" short />
              <span className="ellipsis">{scriptName}</span>
            </li>
          </ul>
        </Section>
      )}

      {valueListName && (
        <Section title="Value list">
          <ul className="ref-list">
            <li
              onClick={() => valueListObj && onGo(valueListObj.uid, `lo-vl:${valueListObj.uid}`)}
              title={valueListName}
              className={valueListObj ? "" : "external"}
            >
              <TypePill type="valueList" short />
              <span className="ellipsis">{valueListName}</span>
            </li>
          </ul>
        </Section>
      )}

      {detail.triggers && detail.triggers.length > 0 && (
        <Section title="Triggers" count={detail.triggers.length}>
          <dl className="kv compact layout-triggers">
            {detail.triggers.map((t, i) => {
              const target = scriptTarget(t.scriptId);
              const sName = t.scriptName || (t.scriptId ? `Script ${t.scriptId}` : "(missing script)");
              return (
                <Fragment key={i}>
                  <dt>{t.action}</dt>
                  <dd>
                    <div className="layout-obj-row">
                      {target ? (
                        <button
                          className="layout-obj-name layout-trigger-link"
                          type="button"
                          onClick={() => onGo(target.uid, `lo-trig:${target.uid}:${i}`)}
                        >
                          {sName}
                        </button>
                      ) : (
                        <span className="layout-obj-name">{sName}</span>
                      )}
                      {t.modes.map((mode) => (
                        <span className="layout-obj-type" key={mode}>
                          {mode}
                        </span>
                      ))}
                    </div>
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        </Section>
      )}

      {children.length > 0 && (
        <Section title="Contents" count={children.length}>
          <ul className="ref-list">
            {children.map((child) => (
              <li key={child.uid} onClick={() => onGo(child.uid, child.uid)} title={child.name}>
                <TypePill type="layoutObject" short />
                <span className="ellipsis">{child.name}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.style && (
        <Section title="Style" defaultOpen={false}>
          <pre className="code">{detail.style}</pre>
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
  fileUid,
  onGo,
}: {
  obj: LayoutObjectInfo;
  depth: number;
  model?: SolutionModel;
  fileUid?: string;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasChildren = (obj.children?.length ?? 0) > 0;
  const { text, dim } = layoutObjLabel(obj);

  function scriptTarget(id: string | undefined): FmObject | null {
    if (!id || !model || !fileUid) return null;
    return model.byUid.get(`${fileUid}:script:${id}`) ?? null;
  }

  const indent = depth * 14;

  return (
    <>
      <div
        className={`lo-row${obj.uid && onGo ? " navigable" : ""}`}
        style={{ paddingLeft: indent }}
        title={[
          obj.fieldRef,
          obj.tooltip ? `Tooltip: ${obj.tooltip}` : "",
          obj.bounds ? `${obj.bounds.left}, ${obj.bounds.top} → ${obj.bounds.right}, ${obj.bounds.bottom}` : "",
        ]
          .filter(Boolean)
          .join("\n") || undefined}
      >
        {hasChildren ? (
          <button type="button" className="lo-chevron" onClick={() => setOpen((v) => !v)}>
            <span className={`fchevron${open ? " open" : ""}`}>›</span>
          </button>
        ) : (
          <span className="lo-chevron-space" />
        )}
        <span
          className={`lo-label${dim ? " lo-label-dim" : ""}${obj.uid && onGo ? " lo-label-selectable" : ""}`}
          onClick={obj.uid && onGo ? () => onGo(obj.uid!, `lo:${obj.uid}`) : undefined}
        >{renderWithBrokenPlaceholders(text)}</span>
        {obj.scriptRef && (() => {
          const target = scriptTarget(obj.scriptRef.id);
          const sName = obj.scriptRef.name || (obj.scriptRef.id ? `Script ${obj.scriptRef.id}` : "");
          return sName ? (
            <span className="lo-script-ref">
              {target && onGo ? (
                <button
                  type="button"
                  className="layout-trigger-link lo-script-link"
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
          <span className="lo-trigger-badge" title={obj.triggers!.map((t) => t.action).join(", ")}>
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
            fileUid={fileUid}
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
        className="group-header clickable"
        onClick={() => setOpen((v) => !v)}
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
      className={hoverable ? "hoverable" : ""}
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
        <span className="layout-obj-type">{obj.type}</span>
        {(obj.triggers?.length ?? 0) > 0 && (
          <span className="layout-obj-type layout-obj-triggers-chip">
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
      {obj.tooltip && <div className="layout-obj-info layout-obj-tooltip">Tooltip: {obj.tooltip}</div>}
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
  // Labels are authored in layout units; divide by the scale so they stay ~11px
  // on screen at full size. Strokes use non-scaling-stroke instead (see CSS).
  const inv = 1 / scale;

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
              {part.height * scale > 16 && (
                <text x={6 * inv} y={part.top + 16 * inv} className="layout-map-label" fontSize={11 * inv}>
                  {part.type}
                </text>
              )}
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
    </div>
  );
}

/** A value list's full contents: literal custom values, or its field binding. */
function ValueListDetail({
  detail,
  refIndex,
  model,
  fileUid,
  onGo,
}: {
  detail: Extract<ObjectDetail, { kind: "valueList" }>;
  refIndex: RefIndex;
  model: SolutionModel;
  fileUid: string;
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
              <FieldRefLink qualified={field.primaryField} model={model} fileUid={fileUid} onGo={onGo} />
            ) : (
              "(none)"
            )}
          </dd>
          {field.secondaryField && (
            <>
              <dt>Also displays</dt>
              <dd>
                <FieldRefLink qualified={field.secondaryField} model={model} fileUid={fileUid} onGo={onGo} />
              </dd>
            </>
          )}
          <dt>Sorted</dt>
          <dd>{field.sort ? "By this field" : "By field order"}</dd>
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
}: {
  edges: DependencyEdge[];
  side: "from" | "to";
  onGo: (uid: string, rowKey: string) => void;
  byUid: Map<string, FmObject>;
  /** Rows shown before "Show more" (the object page's tabs show more). */
  previewLimit?: number;
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
          <div className="ref-group-label">
            {OBJECT_TYPE_META[group.type].plural} · {totalCountByType.get(group.type) ?? group.edges.length}
          </div>
          <ul className="ref-list">
            {group.edges.map((edge, i) => {
              // edge.target is the SOURCE object for inbound, the TARGET for outbound.
              const obj = edge.target;
              const unresolved = side === "to" && !obj;
              // A deleted object (FileMaker emits "<… Missing>" or an empty name) is
              // broken; so is anything flagged broken in resolution. A target that
              // merely lives in another, unloaded file is "external" — not an error.
              const deleted = unresolved && (edge.ref.toName === "" || /Missing>$/.test(edge.ref.toName));
              const broken = unresolved && (edge.ref.broken || deleted);
              const external = unresolved && !broken;
              const rowKey = `${edge.ref.fromUid}-${edge.ref.toId}-${group.type}-${i}`;
              const type = obj?.type ?? edge.ref.toType;
              const label =
                fieldRefLabel(edge, byUid) ??
                (obj
                  ? objectLabel(obj)
                  : edge.ref.toName
                    ? edge.ref.toName
                    : deleted
                      ? `<${OBJECT_TYPE_META[edge.ref.toType].label} Missing>`
                      : `${OBJECT_TYPE_META[edge.ref.toType].label} ${edge.ref.toId}`);
              const title = broken
                ? `Broken — ${label}`
                : external
                  ? `${label} — in another file (not loaded)`
                  : label;
              return (
                <li
                  key={rowKey}
                  className={broken ? "broken" : external ? "external" : ""}
                  onClick={() => obj && onGo(obj.uid, rowKey)}
                  title={title}
                >
                  <TypePill type={type} short />
                  <span className="ellipsis">{label}</span>
                  {external && <RefStatusChip kind="external" />}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {remaining > 0 && (
        <button type="button" className="ref-show-more" onClick={() => setExpanded(true)}>
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
}: {
  node: CallNode;
  /** Position of this node in the tree, so duplicate scripts get distinct keys. */
  path: string;
  onGo: (uid: string, rowKey: string) => void;
  isRoot?: boolean;
  clickedKey?: string;
}) {
  const rowKey = `call:${path}`;
  const clicked = !isRoot && rowKey === clickedKey;
  const className = `call-node${isRoot ? " root" : ""}${node.broken ? " broken" : ""}${node.external ? " external" : ""}${clicked ? " clicked" : ""}`;
  const clickable = !node.broken && !node.external && !isRoot;
  return (
    <li>
      <span
        className={className}
        onClick={() => clickable && onGo(node.uid, rowKey)}
      >
        <TypePill type="script" short />
        {node.name}
        {node.broken && " — missing"}
        {node.external && <RefStatusChip kind="external" />}
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}
