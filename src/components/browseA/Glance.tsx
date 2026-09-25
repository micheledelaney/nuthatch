import type React from "react";
import { isBrokenTableOccurrence, objectLabel, type FmObject, type ObjectType, type SolutionModel } from "@/types/ddr";
import { decodeEntities } from "@/core/parser/entities";
import { FieldRefLink, ObjLink } from "../FieldRefLink";
import { TypePill } from "../TypePill";
import { renderWithBrokenPlaceholders } from "../ObjectColumn";
import type { Fact } from "./facts";

type OnGo = (uid: string, rowKey: string) => void;

interface GlanceRow {
  label: string;
  value: React.ReactNode;
}

const FIELD_KIND_LABEL: Record<string, string> = { Normal: "Normal", Calculated: "Calculation", Summary: "Summary" };
const DATA_TYPE_LABEL: Record<string, string> = { Binary: "Container" };

/** An object in the same file by type + FileMaker id, if it's loaded. */
function byId(model: SolutionModel, fileUid: string, type: ObjectType, id: string | undefined): FmObject | null {
  return id ? model.byUid.get(`${fileUid}:${type}:${id}`) ?? null : null;
}

/** An object in the same file by type + name, if it's loaded. */
function byName(model: SolutionModel, fileUid: string, type: ObjectType, name: string | undefined): FmObject | null {
  if (!name) return null;
  return model.objects.find((o) => o.type === type && o.fileUid === fileUid && o.name === name) ?? null;
}

/** The nearest layout above a layout object (its parent may be a portal, tab, …). */
function ancestorLayout(model: SolutionModel, obj: FmObject): FmObject | null {
  let uid = obj.parentUid;
  while (uid) {
    const up = model.byUid.get(uid);
    if (!up) return null;
    if (up.type === "layout") return up;
    uid = up.parentUid;
  }
  return null;
}

/** The base table behind a table occurrence. */
function baseTableOf(model: SolutionModel, to: FmObject | null): FmObject | null {
  return to ? byId(model, to.fileUid, "table", to.attributes.baseTableId) : null;
}

/** A linked object with its short type pill, or the fallback text when it isn't loaded. */
function linkOrText(obj: FmObject | null, fallback: string | undefined, onGo: OnGo): React.ReactNode {
  if (obj) {
    return (
      <>
        <TypePill type={obj.type} short />
        <ObjLink obj={obj} onGo={onGo}>
          {objectLabel(obj)}
        </ObjLink>
      </>
    );
  }
  return fallback ? renderWithBrokenPlaceholders(decodeEntities(fallback)) : null;
}

/** How a field keeps its value: global, unstored (unstored calcs and every
 * summary field), a container's location, or stored (with its index level). */
function fieldStorage(a: Record<string, string>): string {
  if (a.global === "true") return "Global";
  if (a.unstored === "true" || a.fieldtype === "Summary") return "Unstored";
  if (a.containerStorage) return a.containerStorage;
  return a.indexing ? `Stored · ${a.indexing} index` : "Stored";
}

/** A field's third row, by kind: a calc's context, what a summary summarizes,
 * or how an ordinary field fills itself in. */
function fieldThirdRow(obj: FmObject, model: SolutionModel, onGo: OnGo): GlanceRow {
  const a = obj.attributes;
  const d = obj.detail;
  if (a.fieldtype === "Calculated") {
    return { label: "Context", value: linkOrText(byId(model, obj.fileUid, "tableOccurrence", a.calcContextToId), undefined, onGo) };
  }
  if (d?.kind === "summary") return { label: "Summarizes", value: `${d.operation} ${d.fields.join(", ")}` };
  if (d?.kind === "lookup") {
    return { label: "Looks up", value: <FieldRefLink qualified={d.source} model={model} fileUid={obj.fileUid} onGo={onGo} /> };
  }
  return { label: "Auto-enter", value: a.autoEnter ?? "None" };
}

/** The subtype shown after the type pill: a field's kind and data type, a
 * layout object's kind, an occurrence's or data source's kind. */
function subtype(obj: FmObject): string | undefined {
  const a = obj.attributes;
  switch (obj.type) {
    case "field":
      return [
        a.fieldtype && (FIELD_KIND_LABEL[a.fieldtype] ?? a.fieldtype),
        a.datatype && (DATA_TYPE_LABEL[a.datatype] ?? a.datatype),
      ]
        .filter(Boolean)
        .join(" · ");
    case "layoutObject":
      return a.loType;
    case "tableOccurrence":
    case "externalDataSource":
      return a.type;
    default:
      return undefined;
  }
}

/** Count of objects in the model matching `test`. */
function countWhere(model: SolutionModel, test: (o: FmObject) => boolean): number {
  let n = 0;
  for (const o of model.objects) if (test(o)) n++;
  return n;
}

/** What a layout object is wired to: its field, script, portal or value list. */
function boundTo(obj: FmObject, model: SolutionModel, onGo: OnGo): React.ReactNode {
  const lo = obj.detail?.kind === "layoutObject" ? obj.detail : undefined;
  const f = obj.fileUid;
  if (!lo) return null;
  if (lo.fieldRef) return <FieldRefLink qualified={lo.fieldRef} model={model} fileUid={f} onGo={onGo} />;
  if (lo.scriptRef) {
    const script = byId(model, f, "script", lo.scriptRef.id) ?? byName(model, f, "script", lo.scriptRef.name);
    return linkOrText(script, lo.scriptRef.name, onGo);
  }
  if (lo.portalTable) return linkOrText(byName(model, f, "tableOccurrence", lo.portalTable), lo.portalTable, onGo);
  if (lo.valueListRef) {
    const vl = byId(model, f, "valueList", lo.valueListRef.id) ?? byName(model, f, "valueList", lo.valueListRef.name);
    return linkOrText(vl, lo.valueListRef.name, onGo);
  }
  if (lo.actionStep) return lo.actionStep.name;
  return null;
}

/** The three developer-relevant rows for an object, below its Type row: what
 * it's based on, how it's set up, and the one setting that most shapes its
 * behavior. Every type has exactly three; a missing value shows as "—". */
function detailRows(obj: FmObject, model: SolutionModel, onGo: OnGo): GlanceRow[] {
  const a = obj.attributes;
  const d = obj.detail;
  const f = obj.fileUid;
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  switch (obj.type) {
    case "field":
      return [
        { label: "Table", value: linkOrText(obj.parentUid ? model.byUid.get(obj.parentUid) ?? null : null, undefined, onGo) },
        { label: "Storage", value: fieldStorage(a) },
        fieldThirdRow(obj, model, onGo),
      ];
    case "layout": {
      const to = byName(model, f, "tableOccurrence", decodeEntities(a.tableOccurrence ?? ""));
      return [
        { label: "Occurrence", value: linkOrText(to, a.tableOccurrence, onGo) },
        { label: "Base table", value: linkOrText(baseTableOf(model, to), to?.attributes.baseTable, onGo) },
        { label: "Menu set", value: a.menuSet ?? "File default" },
      ];
    }
    case "layoutObject":
      return [
        { label: "Layout", value: linkOrText(ancestorLayout(model, obj), undefined, onGo) },
        { label: "Bound to", value: boundTo(obj, model, onGo) },
        { label: "Position", value: a.position },
      ];
    case "tableOccurrence": {
      const source = a.externalDataSource ? decodeEntities(a.externalDataSource) : undefined;
      return [
        { label: "Base table", value: linkOrText(baseTableOf(model, obj), a.baseTable, onGo) },
        {
          label: "Data source",
          value: !source ? (
            "This file"
          ) : isBrokenTableOccurrence(obj) ? (
            <span className="broken-value">{source}</span>
          ) : (
            linkOrText(byName(model, f, "externalDataSource", source), source, onGo)
          ),
        },
        {
          label: "Relationships",
          value: countWhere(
            model,
            (o) => o.fileUid === f && o.detail?.kind === "relationship" && (o.detail.leftToId === obj.id || o.detail.rightToId === obj.id),
          ).toLocaleString(),
        },
      ];
    }
    case "table":
      return [
        { label: "Fields", value: countWhere(model, (o) => o.parentUid === obj.uid && o.type === "field").toLocaleString() },
        {
          label: "Occurrences",
          // Local occurrences point at the table by id; occurrences in other
          // loaded files match it by UUID.
          value: countWhere(
            model,
            (o) =>
              o.type === "tableOccurrence" &&
              ((o.fileUid === f && o.attributes.baseTableId === obj.id) ||
                (o.fileUid !== f && !!a.uuid && o.attributes.baseTableUuid === a.uuid)),
          ).toLocaleString(),
        },
        { label: "Comment", value: a.comment },
      ];
    case "relationship":
      if (d?.kind !== "relationship") break;
      return [
        { label: "Left", value: linkOrText(byId(model, f, "tableOccurrence", d.leftToId), d.leftTable, onGo) },
        { label: "Right", value: linkOrText(byId(model, f, "tableOccurrence", d.rightToId), d.rightTable, onGo) },
        { label: "Match", value: d.predicates.map((p) => `${p.leftField} ${p.operator} ${p.rightField}`).join(", ") },
      ];
    case "script":
      return [
        { label: "Folder", value: obj.folder ?? "Top level" },
        { label: "Full access", value: a.runsWithFullAccess ?? "No" },
        { label: "In menu", value: a.includeInMenu ?? "Yes" },
      ];
    case "valueList": {
      const field = d?.kind === "valueList" ? d.field : undefined;
      const custom = d?.kind === "valueList" ? d.customValues.length : 0;
      return [
        { label: "Source", value: a.source },
        {
          label: "Values",
          value: field ? (
            <FieldRefLink qualified={field.primaryField} model={model} fileUid={f} onGo={onGo} />
          ) : (
            plural(custom, "custom value")
          ),
        },
        { label: "Related from", value: field?.showRelatedFrom ?? (field ? "All values" : undefined) },
      ];
    }
    case "customFunction":
      return [
        { label: "Signature", value: d?.kind === "calculation" ? <code>{d.signature}</code> : null },
        { label: "Access", value: a.access },
        { label: "Length", value: d?.kind === "calculation" ? plural(d.body.split("\n").length, "line") : null },
      ];
    case "account":
      return [
        { label: "Privilege set", value: linkOrText(byName(model, f, "privilegeSet", a.privilegeSet), a.privilegeSet, onGo) },
        { label: "Status", value: a.status },
        { label: "Auth", value: [a.type, a.password && `password: ${a.password}`].filter(Boolean).join(" · ") },
      ];
    case "privilegeSet":
      return [
        { label: "Records", value: a.recordsAccess },
        { label: "Layouts", value: a.layoutsAccess },
        { label: "Scripts", value: a.scriptsAccess },
      ];
    case "extendedPrivilege": {
      const sets = (model.inbound.get(obj.uid) ?? []).filter((r) => r.kind === "extendedPrivilege").length;
      return [
        { label: "Keyword", value: obj.name },
        { label: "Description", value: a.description },
        { label: "Granted by", value: plural(sets, "privilege set") },
      ];
    }
    case "fileAccess":
      return [
        { label: "Authorized by", value: a.authorizedBy },
        { label: "Authorized on", value: a.authorizedOn },
        { label: "Description", value: a.description },
      ];
    case "externalDataSource": {
      const occurrences = countWhere(
        model,
        (o) => o.fileUid === f && o.type === "tableOccurrence" && decodeEntities(o.attributes.externalDataSource ?? "") === obj.name,
      );
      // The file a path points at, e.g. "file:Invoices.fmp12" -> "Invoices".
      const target = (a.path ?? "").split(/[:/\n]/).filter(Boolean).pop()?.replace(/\.fmp12$/i, "");
      const loaded = !!target && model.files.some((file) => file.name.replace(/\.fmp12$/i, "") === target);
      return [
        { label: "Path", value: a.path },
        { label: "Occurrences", value: occurrences.toLocaleString() },
        { label: "File loaded", value: target ? (loaded ? "Yes" : "No") : null },
      ];
    }
    case "customMenuSet":
      return [
        { label: "Menus", value: a.menus },
        { label: "Used by", value: plural(countWhere(model, (o) => o.fileUid === f && o.type === "layout" && decodeEntities(o.attributes.menuSet ?? "") === obj.name), "layout") },
        { label: "Comment", value: a.comment },
      ];
    case "customMenu":
      return [
        { label: "Based on", value: a.basedOn },
        { label: "Installs in", value: a.installsIn },
        { label: "Install when", value: a.installCondition ?? "Always" },
      ];
    case "customMenuItem":
      return [
        { label: "Menu", value: a.menu },
        { label: "Item type", value: a.itemType },
        { label: "Shortcut", value: a.shortcut },
      ];
    case "theme":
      return [
        { label: "Family", value: a.Group },
        { label: "Color scheme", value: a.colorScheme },
        { label: "Base font size", value: a.baseFontSize },
      ];
    case "file":
      return [
        { label: "Version", value: model.files.find((file) => file.uid === f)?.version },
        { label: "Encryption", value: a.encryption },
        { label: "Auto-login", value: a.autoLogin },
      ];
    case "globalVariable": {
      const users = new Set((model.inbound.get(obj.uid) ?? []).map((r) => r.fromUid));
      const byType = (t: ObjectType) => [...users].filter((uid) => model.byUid.get(uid)?.type === t).length;
      return [
        { label: "Used by", value: plural(users.size, "object") },
        { label: "Scripts", value: byType("script").toLocaleString() },
        { label: "Fields", value: byType("field").toLocaleString() },
      ];
    }
  }
  return [];
}

/** Type row first (pill + subtype), then the type's three detail rows. */
function glanceRows(obj: FmObject, model: SolutionModel, onGo: OnGo): GlanceRow[] {
  const sub = subtype(obj);
  const typeRow: GlanceRow = {
    label: "Type",
    value: (
      <>
        <TypePill
          type={obj.type}
          label={obj.isSeparator ? "Separator" : undefined}
          color={obj.isSeparator ? "var(--type-separator)" : undefined}
        />
        {sub}
      </>
    ),
  };
  return [typeRow, ...detailRows(obj, model, onGo)];
}

/**
 * The At a glance block at the top of an object page: the object's name, a
 * Type row, three developer-relevant rows (what it's based on, how it's set
 * up), and its flags. Stays above the tabs so it's visible on every tab.
 */
export function Glance({
  obj,
  model,
  facts,
  onGo,
  actions,
}: {
  obj: FmObject;
  model: SolutionModel;
  facts: Fact[];
  onGo: OnGo;
  /** Extra buttons for the name row (e.g. "Show in graph"). */
  actions?: React.ReactNode;
}) {
  const rows = glanceRows(obj, model, onGo);
  return (
    <section className="op-glance" aria-label="At a glance">
      <div className="op-glance-head">
        <h1 className="op-glance-name" title={objectLabel(obj)}>
          {renderWithBrokenPlaceholders(objectLabel(obj))}
        </h1>
        {actions}
      </div>
      <dl className="op-glance-kv">
        {rows.map((r) => (
          <div key={r.label} className="op-glance-row">
            <dt>{r.label}</dt>
            <dd>{r.value == null || r.value === "" ? <span className="op-glance-empty">—</span> : r.value}</dd>
          </div>
        ))}
      </dl>
      {facts.length > 0 && (
        <div className="op-facts">
          {facts.map((fact, i) => (
            <span key={`${i}-${fact.label}`} className={`op-fact${fact.tone ? ` tone-${fact.tone}` : ""}`} title={fact.title}>
              {fact.label}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
