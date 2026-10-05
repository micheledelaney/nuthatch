import type React from "react";
import { isBrokenTableOccurrence, objectLabel, type FmObject, type ObjectType, type SolutionModel } from "@/types/ddr";
import { chainTops } from "@/core/analysis/unusedChains";
import { USAGE_REASON_LABELS } from "@/core/analysis/usageMarks";
import { FieldRefLink, ObjLink } from "../FieldRefLink";
import { TypePill } from "../TypePill";
import { renderWithBrokenPlaceholders, Section } from "../ObjectColumn";
import { brokenSourcesFor } from "./refStats";
import type { Fact } from "./facts";
import { isInUnusedChain } from "./filters";
import { fieldKindAndType } from "./fieldSummary";

type OnGo = (uid: string, rowKey: string) => void;

interface GlanceRow {
  label: string;
  value: React.ReactNode;
}

/** Objects named in the Used only by row before "and N more". */
const USED_ONLY_BY_SHOWN = 3;

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
  return fallback ? renderWithBrokenPlaceholders(fallback) : null;
}

/** How a field keeps its value: global, unstored (unstored calcs and every
 * summary field), a container's location, or stored (with its index level). */
function fieldStorage(a: Record<string, string>): string {
  if (a.global === "Yes") return "Global";
  if (a.unstored === "Yes" || a.fieldtype === "Summary") return "Unstored";
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
    return { label: "Looks up", value: <FieldRefLink qualified={d.source} model={model} owner={obj.uid} onGo={onGo} /> };
  }
  return { label: "Auto-enter", value: a.autoEnter ?? "None" };
}

/** The subtype shown after the type pill: a field's kind and data type, a
 * layout object's kind, an occurrence's or data source's kind. */
function subtype(obj: FmObject): string | undefined {
  const a = obj.attributes;
  switch (obj.type) {
    case "field":
      return fieldKindAndType(a);
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
  if (lo.fieldRef) return <FieldRefLink qualified={lo.fieldRef} model={model} owner={obj.uid} onGo={onGo} />;
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
      const to = byName(model, f, "tableOccurrence", a.tableOccurrence ?? "");
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
      const source = a.externalDataSource || undefined;
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
            <FieldRefLink qualified={field.primaryField} model={model} owner={obj.uid} onGo={onGo} />
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
        (o) => o.fileUid === f && o.type === "tableOccurrence" && (o.attributes.externalDataSource ?? "") === obj.name,
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
        { label: "Used by", value: plural(countWhere(model, (o) => o.fileUid === f && o.type === "layout" && (o.attributes.menuSet ?? "") === obj.name), "layout") },
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
  const chainRow = isInUnusedChain(model, obj) ? usedOnlyByRow(obj, model, onGo) : null;
  const mark = model.usageMarks.get(obj.uid);
  const markRow: GlanceRow | null = mark
    ? {
        label: "Marked as used",
        value: (
          <span className="op-glance-list">
            <span>{USAGE_REASON_LABELS[mark.reason]}</span>
            {mark.note && <span className="op-glance-note">{mark.note}</span>}
          </span>
        ),
      }
    : null;
  return [typeRow, ...detailRows(obj, model, onGo), ...(chainRow ? [chainRow] : []), ...(markRow ? [markRow] : [])];
}

/** For an object in an unused chain: the unreferenced objects it hangs from —
 * check those, and the rest follows — or the loop it's part of. */
function usedOnlyByRow(obj: FmObject, model: SolutionModel, onGo: OnGo): GlanceRow | null {
  const { tops, loop } = chainTops(model, obj.uid);
  const users = tops.length > 0 ? tops : loop;
  if (users.length === 0) return null;
  const shown = users.slice(0, USED_ONLY_BY_SHOWN);
  const more = users.length - shown.length;
  return {
    label: "Used only by",
    value: (
      <span className="op-glance-list">
        {shown.map((u) => (
          <span key={u.uid} className="op-glance-list-item">
            {linkOrText(u, undefined, onGo)}
          </span>
        ))}
        {more > 0 && <span>and {more.toLocaleString()} more</span>}
        <span className="op-glance-note">{tops.length > 0 ? "(unreferenced)" : "(an unused loop)"}</span>
      </span>
    ),
  };
}

/**
 * The top of an object page: the object's name and its flags, which stay
 * above the tabs so they're visible on every tab. The key attributes are the
 * At a glance section on the Details tab (see GlanceSection).
 */
export function Glance({
  obj,
  model,
  facts,
  actions,
}: {
  obj: FmObject;
  /** Whether a placeholder in the name reads as broken is the model's call. */
  model: SolutionModel;
  facts: Fact[];
  /** Extra buttons for the name row (e.g. "Show in graph"). */
  actions?: React.ReactNode;
}) {
  return (
    <div className="op-glance-head">
      <h1 className="op-glance-name" title={objectLabel(obj)}>
        {renderWithBrokenPlaceholders(objectLabel(obj), brokenSourcesFor(model).has(obj.uid))}
      </h1>
      {facts.length > 0 && (
        <div className="op-facts">
          {facts.map((fact, i) => (
            <span key={`${i}-${fact.label}`} className={`tag op-fact${fact.tone ? ` tone-${fact.tone}` : ""}`} title={fact.title}>
              {fact.label}
            </span>
          ))}
        </div>
      )}
      {actions}
    </div>
  );
}

/** The At a glance section on the Details tab: a Type row, then three
 * developer-relevant rows (what it's based on, how it's set up). */
export function GlanceSection({ obj, model, onGo }: { obj: FmObject; model: SolutionModel; onGo: OnGo }) {
  const rows = glanceRows(obj, model, onGo);
  return (
    <Section title="At a glance">
      <dl className="op-glance-kv">
        {rows.map((r) => (
          <div key={r.label} className="op-glance-row">
            <dt>{r.label}</dt>
            <dd>{r.value == null || r.value === "" ? <span className="op-glance-empty">—</span> : r.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
