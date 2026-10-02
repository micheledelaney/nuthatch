import type { FmObject, LayoutObjectInfo } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, collectText, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { FILE_DEFAULT_MENU_SET, MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { objectUid } from "../uid";
import { scanRefs } from "../refs/scanRefs";
import { brokenRef } from "../refs/refBuilders";
import { addPlaceholderRefs } from "../refs/placeholderRefs";
import { addTextGlobalRefs } from "../refs/globalVariables";
import { isPerformScriptStep, namesDeletedScript } from "../refs/stepTargets";
import { makeObject, placeInCatalog } from "./catalogItems";
import { addDeferredLayoutRefs } from "./deferredLayouts";
import { layoutDetail, type LayoutDetail } from "./layoutDetail";

/**
 * One layout from LayoutCatalog (structured like ScriptCatalog: a flat
 * document-ordered list with folder markers and separator items), with its
 * layout objects, references, and text-derived references. The layout's full
 * text (collectText of every object on it — by far the largest thing in a big
 * model) is only needed for those text passes, so the layout is stored with a
 * compact term list instead as soon as they're done (compactLayoutText).
 */
export function processOneLayout(layout: unknown, folder: string, order: number, fp: FileParse): void {
  const base = makeObject(layout, "layout", fp);
  if (!base) return;
  const objStart = fp.objects.length;
  const refStart = fp.references.length;
  const full = buildLayout(fp, layout, placeInCatalog(base, order, folder));
  const batch = [...fp.objects.slice(objStart), full];
  addPlaceholderRefs(fp, batch, refStart);
  addTextGlobalRefs(fp, batch);
  fp.objects.push(full.detail?.kind === "layout" ? { ...full, text: compactLayoutText(full, full.detail) } : full);
}

/** The layout object (full text), after its layout objects and references. */
function buildLayout(fp: FileParse, layout: unknown, placed: FmObject): FmObject {
  if (placed.isSeparator) return placed;
  const annotated = annotateLayout(layout, placed);
  const detail = layoutDetail(layout, fp.chunks.stepTextByHash);
  const obj = detail ? { ...annotated, detail: addLayoutObjects(fp, detail, annotated) } : annotated;
  scanRefs(fp, layout, obj);
  addDeferredLayoutRefs(fp, layout, obj);
  return obj;
}

/** Surface the table occurrence a layout shows records from (a nested
 * <TableOccurrenceReference name=…>), whether it appears in the layout menu, its
 * client type, and the custom menu set it uses. */
function annotateLayout(node: unknown, obj: FmObject): FmObject {
  if (!isRecord(node)) return obj;
  const a: Record<string, string> = {};
  const toName = attr(child(node, "TableOccurrenceReference"), "name");
  if (toName) a.tableOccurrence = decodeEntities(toName);
  // hidden="True" leaves the layout out of the layout (menu) pop-up.
  if (attr(child(node, "Options"), "hidden") === "True") a.includeInLayoutMenus = "No";
  const clientType = collectText(node["ClientType"]).trim();
  if (clientType && clientType !== "0") a.clientType = clientType;
  const menuSet = attr(child(child(node, "MenuSet"), "CustomMenuSetReference"), "name");
  if (menuSet && menuSet !== FILE_DEFAULT_MENU_SET) a.menuSet = decodeEntities(menuSet);
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}

/** Emit the layout's objects (and their references), returning its detail with
 * each object's uid filled in. Every part's objects come first, then the
 * off-layout ones — the order the duplicate-uid suffixes are counted in. */
function addLayoutObjects(fp: FileParse, detail: LayoutDetail, layout: FmObject): LayoutDetail {
  const parts = detail.parts.map((part) => ({ ...part, objects: addLayoutObjectTree(fp, part.objects, layout.uid, layout.id) }));
  const offLayout = addLayoutObjectTree(fp, detail.offLayout, layout.uid, layout.id);
  return { ...detail, parts, offLayout };
}

/** Emit layout objects as FmObjects, recursively. `idChain` is the dot-joined
 * `id` of every ancestor from the owning layout down to (but not including)
 * these objects — e.g. `"120.2970"` for objects nested one level inside layout
 * 120's object with id 2970. */
function addLayoutObjectTree(fp: FileParse, infos: LayoutObjectInfo[], parentUid: string, idChain: string): LayoutObjectInfo[] {
  return infos.map((lo) => {
    // `uuid` is only populated once FileMaker has stamped this specific object with
    // a per-edit UUID — an object never touched since it was placed has none, which
    // is the common case, not an edge case. Only skip when there's truly nothing to
    // build a uid from (below, `id` is preferred and `uuid` is just the fallback).
    if (!lo.id && !lo.uuid) return lo;
    // FileMaker's numeric `id` is unique among siblings under the same parent — like
    // a field's id is unique within its table — so namespace by the full ancestor
    // chain the same way fields are namespaced by table. A single level (layout + own
    // id) isn't enough: two different parents on the same layout (e.g. two Grouped
    // Buttons) can each wrap a child that reuses the same id. `UUID` looks globally
    // unique but isn't reliably so either — duplicating a compound object can leave a
    // child's UUID identical to its sibling's.
    const chain = lo.id ? `${idChain}.${lo.id}` : undefined;
    const withUid: LayoutObjectInfo = { ...lo, uid: uniqueLayoutObjectUid(fp, chain ?? lo.uuid!) };
    const uid = withUid.uid!;
    fp.objects.push(layoutObjectFmObject(fp, withUid, uid, parentUid));
    addLayoutObjectRefs(fp, withUid, uid);
    if (!lo.children || lo.children.length === 0) return withUid;
    return { ...withUid, children: addLayoutObjectTree(fp, lo.children, uid, chain ?? idChain) };
  });
}

/** The object's uid, with a stable `#N` suffix on every repeat (see
 * FileParse.layoutObjectUidCounts). */
function uniqueLayoutObjectUid(fp: FileParse, idPart: string): string {
  const uid = objectUid(fp.file.uid, "layoutObject", idPart);
  const seen = fp.layoutObjectUidCounts.get(uid) ?? 0;
  fp.layoutObjectUidCounts.set(uid, seen + 1);
  return seen > 0 ? `${uid}#${seen}` : uid;
}

function layoutObjectFmObject(fp: FileParse, lo: LayoutObjectInfo, uid: string, parentUid: string): FmObject {
  return {
    uid,
    type: "layoutObject",
    id: lo.id ?? "",
    name: nameForLayoutObj(lo),
    fileUid: fp.file.uid,
    fileName: fp.file.name,
    parentUid,
    attributes: layoutObjectAttributes(lo),
    text: layoutObjectTerms(lo).join(" "),
    detail: {
      kind: "layoutObject",
      loType: lo.type,
      info: lo.info,
      fieldRef: lo.fieldRef,
      scriptRef: lo.scriptRef,
      valueListRef: lo.valueListRef,
      actionStep: lo.actionStep,
      triggers: lo.triggers,
      tooltip: lo.tooltip,
      hideWhen: lo.hideWhen,
      hideInFind: lo.hideInFind,
      conditionalFormats: lo.conditionalFormats,
      bounds: lo.bounds,
      style: lo.style,
      portalTable: lo.portalTable,
      portalRows: lo.portalRows,
    },
  };
}

function layoutObjectAttributes(lo: LayoutObjectInfo): Record<string, string> {
  const a: Record<string, string> = { loType: lo.type };
  // The object's own name (Inspector ▸ Position ▸ Name), which the display
  // name replaces with the object's text or field when it has one.
  if (lo.name.trim()) a.objectName = lo.name;
  if (lo.hash) a.hash = lo.hash;
  if (lo.bounds) a.position = `${lo.bounds.left}, ${lo.bounds.top} → ${lo.bounds.right}, ${lo.bounds.bottom}`;
  if (lo.info && lo.type !== "Web Viewer" && lo.type !== "Text") {
    const bare = lo.info.replace(/^"|"$/g, "");
    if (bare) a.label = bare;
  }
  if (lo.tooltip) a.tooltip = lo.tooltip;
  if (lo.hideWhen) a.hideWhen = lo.hideInFind ? `${lo.hideWhen} (also in Find mode)` : lo.hideWhen;
  if (lo.conditionalFormats) a.conditionalFormats = lo.conditionalFormats.join("\n");
  if (lo.portalTable) a.portalOccurrence = lo.portalTable;
  if (lo.portalRows != null) a.portalRows = String(lo.portalRows);
  return a;
}

/** The references a layout object's bindings record: its field, the script it
 * performs, its value list, and its triggers' scripts. */
function addLayoutObjectRefs(fp: FileParse, lo: LayoutObjectInfo, uid: string): void {
  const out = fp.references;
  // A field object with <FieldReference id="0" name=""> has no field at all
  // (FileMaker shows it as <Field Missing>); the placeholder pass flags it from
  // its label, so no structural edge to a non-existent id 0.
  if (lo.fieldToId && lo.fieldToId !== "0") {
    // The label reads "<Field Missing>" for a deleted field; the reference keeps
    // the blank name like every other structural reference to it (which is what
    // stops the placeholder pass from counting the same binding twice).
    const fieldName = lo.fieldRef?.split("::")[1] ?? lo.fieldRef ?? "";
    out.push({
      fromUid: uid,
      toType: "field",
      toId: lo.fieldToId,
      toName: fieldName === MISSING_FIELD_TOKEN ? "" : fieldName,
      kind: "field",
      ...(lo.fieldViaToId ? { viaToId: lo.fieldViaToId } : {}),
    });
  }
  if (lo.scriptRef?.id) {
    out.push({ fromUid: uid, toType: "script", toId: lo.scriptRef.id, toName: lo.scriptRef.name, kind: "script" });
  } else if (lo.actionStep && isPerformScriptStep(lo.actionStep.name) && namesDeletedScript(lo.actionStep.params)) {
    // A button whose script was deleted: FileMaker keeps the Perform Script
    // action but not its <ScriptReference>.
    out.push(brokenRef(uid, "script", UNKNOWN_TARGET, "script"));
  }
  if (lo.valueListRef?.id) {
    out.push({ fromUid: uid, toType: "valueList", toId: lo.valueListRef.id, toName: lo.valueListRef.name, kind: "valueList" });
  }
  for (const t of lo.triggers ?? []) {
    out.push(
      t.scriptId
        ? { fromUid: uid, toType: "script", toId: t.scriptId, toName: t.scriptName, kind: "trigger" }
        : // The trigger's script was deleted: the event stays, its <ScriptReference> doesn't.
          brokenRef(uid, "script", UNKNOWN_TARGET, "trigger"),
    );
  }
}

/** A human-readable name for a layout object used as its FmObject.name. */
function nameForLayoutObj(lo: LayoutObjectInfo): string {
  if (lo.type === "Text" && lo.info) {
    const s = lo.info.trim();
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }
  if (lo.fieldRef) return lo.fieldRef;
  if (lo.type === "Portal" && lo.portalTable) return `Portal (${lo.portalTable})`;
  if (lo.info) {
    const bare = lo.info.replace(/^"|"$/g, "");
    if (bare) return `${lo.type} (${bare})`;
  }
  if (lo.name.trim()) return lo.name;
  return lo.type;
}

/** The searchable text fragments of a single layout object — its name, field
 * binding, portal/script references, label/url info, tooltip, and trigger
 * scripts. Shared by the per-object search index and the layout's own compacted
 * text (compactLayoutText). */
function layoutObjectTerms(lo: LayoutObjectInfo): string[] {
  return [
    lo.name,
    lo.fieldRef,
    lo.portalTable,
    lo.scriptRef?.name,
    lo.valueListRef?.name,
    lo.info,
    lo.tooltip,
    lo.hideWhen,
    ...(lo.conditionalFormats ?? []),
    ...(lo.triggers ?? []).map((t) => t.scriptName),
  ].filter((s): s is string => !!s);
}

/**
 * A layout's searchable text as a compact, deduped set of its genuinely
 * searchable terms (layout name, anchor occurrence, and every layout object's
 * field/script/label text), replacing the full styled text of every object on
 * the layout — tens of MB for a dense data-entry layout. The diff never reads it
 * (layouts diff via their structured detail) and per-object search is already
 * served by each layout object's own text, so the only thing lost is free-text
 * search over the raw styled text inside a layout.
 */
function compactLayoutText(layout: FmObject, detail: LayoutDetail): string {
  const terms = new Set<string>();
  terms.add(layout.name);
  if (layout.attributes.tableOccurrence) terms.add(layout.attributes.tableOccurrence);
  const walk = (infos: LayoutObjectInfo[]): void => {
    for (const lo of infos) {
      for (const term of layoutObjectTerms(lo)) terms.add(term);
      if (lo.children) walk(lo.children);
    }
  };
  for (const part of detail.parts) walk(part.objects);
  walk(detail.offLayout);
  return [...terms].join(" ");
}
