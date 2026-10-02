import type { FmObject, LayoutObjectInfo, ObjectDetail } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, child, collectText, isElementKey, isRecord, textAttr } from "../xmlUtils";
import { FILE_DEFAULT_MENU_SET } from "../sentinels";
import { objectUid } from "../uid";
import { scanRefs } from "../refs/scanRefs";
import { addTextDerivedRefs } from "../refs/textRefs";
import { makeObject, newObject, placeInCatalog } from "./catalogItems";
import { stripOuterQuotes } from "./common";
import { addDeferredLayoutRefs } from "./deferredLayouts";
import { layoutDetail, type LayoutDetail, type LayoutObjectSources } from "./layoutDetail";

/** What emitting one layout's objects needs: each object's own XML element (to
 * scan it), and the uid each element ends up with (for the FM 22 deferred
 * button targets, which name the element). */
interface LayoutObjectsContext {
  fp: FileParse;
  sources: LayoutObjectSources;
  uidOfElement: Map<Record<string, unknown>, string>;
}

/**
 * One layout from LayoutCatalog (structured like ScriptCatalog: a flat
 * document-ordered list with folder markers and separator items), with its
 * layout objects, references, and text-derived references. The layout's full
 * text (collectText of every object on it — by far the largest thing in a big
 * model) is only needed for those text passes, so the layout is stored with a
 * compact term list instead as soon as they're done (compactLayoutText).
 */
export function processOneLayout(fp: FileParse, layout: unknown, folder: string, order: number): void {
  const base = makeObject(fp, layout, "layout");
  if (!base) return;
  const objStart = fp.objects.length;
  const refStart = fp.references.length;
  const full = buildLayout(fp, layout, placeInCatalog(base, order, folder));
  const batch = [...fp.objects.slice(objStart), full];
  addTextDerivedRefs(fp, batch, refStart);
  for (const obj of batch) fp.activeText.delete(obj.uid);
  fp.objects.push(full.detail?.kind === "layout" ? { ...full, text: compactLayoutText(full, full.detail) } : full);
}

/** The layout object (full text), after its layout objects and references. */
function buildLayout(fp: FileParse, layout: unknown, placed: FmObject): FmObject {
  if (placed.isSeparator) return placed;
  const annotated = annotateLayout(layout, placed);
  const extracted = layoutDetail(layout, fp.index.stepTextByHash);
  const cx: LayoutObjectsContext = { fp, sources: extracted?.sources ?? new Map(), uidOfElement: new Map() };
  const obj = extracted ? { ...annotated, detail: addLayoutObjects(cx, extracted.detail, annotated) } : annotated;
  // The layout lists everything on it, too: its own settings and every object's.
  scanRefs(fp, layout, obj);
  addDeferredLayoutRefs(fp, layout, obj, cx.uidOfElement);
  return obj;
}

/** Surface the table occurrence a layout shows records from (a nested
 * <TableOccurrenceReference name=…>), whether it appears in the layout menu, its
 * client type, and the custom menu set it uses. */
function annotateLayout(node: unknown, obj: FmObject): FmObject {
  if (!isRecord(node)) return obj;
  const a: Record<string, string> = {};
  const toName = textAttr(child(node, "TableOccurrenceReference"), "name");
  if (toName) a.tableOccurrence = toName;
  // hidden="True" leaves the layout out of the layout (menu) pop-up.
  if (attr(child(node, "Options"), "hidden") === "True") a.includeInLayoutMenus = "No";
  const clientType = collectText(node["ClientType"]).trim();
  if (clientType && clientType !== "0") a.clientType = clientType;
  const menuSet = textAttr(child(child(node, "MenuSet"), "CustomMenuSetReference"), "name");
  if (menuSet && menuSet !== FILE_DEFAULT_MENU_SET) a.menuSet = menuSet;
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}

/** Emit the layout's objects (and their references), returning its detail with
 * each object's uid filled in. Every part's objects come first, then the
 * off-layout ones — the order the duplicate-uid suffixes are counted in. */
function addLayoutObjects(cx: LayoutObjectsContext, detail: LayoutDetail, layout: FmObject): LayoutDetail {
  const parts = detail.parts.map((part) => ({ ...part, objects: addLayoutObjectTree(cx, part.objects, layout.uid, layout.id) }));
  const offLayout = addLayoutObjectTree(cx, detail.offLayout, layout.uid, layout.id);
  return { ...detail, parts, offLayout };
}

/** Emit layout objects as FmObjects, recursively. `idChain` is the dot-joined
 * `id` of every ancestor from the owning layout down to (but not including)
 * these objects — e.g. `"120.2970"` for objects nested one level inside layout
 * 120's object with id 2970. */
function addLayoutObjectTree(cx: LayoutObjectsContext, infos: LayoutObjectInfo[], parentUid: string, idChain: string): LayoutObjectInfo[] {
  const { fp } = cx;
  return infos.map((lo) => {
    // `uuid` is only populated once FileMaker has stamped this specific object with
    // a per-edit UUID — an object never touched since it was placed has none, which
    // is the common case, not an edge case. Only skip when there's truly nothing to
    // build a uid from (below, `id` is preferred and `uuid` is just the fallback).
    if (!lo.id && !lo.uuid) {
      // Nothing to list it by — but the objects inside it are still objects.
      return lo.children?.length ? { ...lo, children: addLayoutObjectTree(cx, lo.children, parentUid, idChain) } : lo;
    }
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
    const obj = layoutObjectFmObject(fp, withUid, uid, parentUid);
    fp.objects.push(obj);
    const element = cx.sources.get(lo);
    if (element) {
      cx.uidOfElement.set(element, uid);
      // Everything the object itself uses — its field, script, value list,
      // triggers, and the calcs behind its label, tooltip, hide condition,
      // conditional formatting, web viewer, and button action — but not what
      // the objects inside it use: each of those reports its own.
      const own = withoutNestedObjects(element);
      scanRefs(fp, own, obj);
      // The placeholder passes read the same element: its listed terms miss the
      // calcs only the element holds (a portal filter, a button step, a trigger
      // parameter).
      fp.activeText.set(uid, `${obj.text}\n${collectText(own)}`);
    }
    if (!lo.children || lo.children.length === 0) return withUid;
    return { ...withUid, children: addLayoutObjectTree(cx, lo.children, uid, chain ?? idChain) };
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
  return newObject(fp.file, {
    uid,
    type: "layoutObject",
    id: lo.id ?? "",
    name: nameForLayoutObj(lo),
    parentUid,
    attributes: layoutObjectAttributes(lo),
    text: layoutObjectTerms(lo).join(" "),
    detail: layoutObjectDetail(lo),
  });
}

/** Everything the layout object shows, minus what identifies it (kept on the
 * FmObject itself) and the objects nested in it (objects of their own). */
function layoutObjectDetail(lo: LayoutObjectInfo): ObjectDetail {
  const { type, name: _name, id: _id, uuid: _uuid, hash: _hash, uid: _uid, children: _children, ...shown } = lo;
  return { kind: "layoutObject", loType: type, ...shown };
}

function layoutObjectAttributes(lo: LayoutObjectInfo): Record<string, string> {
  const a: Record<string, string> = { loType: lo.type };
  // The object's own name (Inspector ▸ Position ▸ Name), which the display
  // name replaces with the object's text or field when it has one.
  if (lo.name.trim()) a.objectName = lo.name;
  if (lo.hash) a.hash = lo.hash;
  if (lo.bounds) a.position = `${lo.bounds.left}, ${lo.bounds.top} → ${lo.bounds.right}, ${lo.bounds.bottom}`;
  if (lo.info && lo.type !== "Web Viewer" && lo.type !== "Text") {
    const bare = stripOuterQuotes(lo.info);
    if (bare) a.label = bare;
  }
  if (lo.tooltip) a.tooltip = lo.tooltip;
  if (lo.hideWhen) a.hideWhen = lo.hideInFind ? `${lo.hideWhen} (also in Find mode)` : lo.hideWhen;
  if (lo.conditionalFormats) a.conditionalFormats = lo.conditionalFormats.join("\n");
  if (lo.portalTable) a.portalOccurrence = lo.portalTable;
  if (lo.portalRows != null) a.portalRows = String(lo.portalRows);
  return a;
}

/** A layout object's element without the layout objects nested in it — except
 * a popover's panel, which isn't an object of its own (its contents hang off
 * the popover button; see childObjects). */
function withoutNestedObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNestedObjects);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "LayoutObject") {
      const panels = asArray(value).filter((lo) => attr(lo, "type") === "PopoverPanel");
      if (panels.length > 0) out[key] = panels.map(withoutNestedObjects);
    } else {
      out[key] = isElementKey(key) ? withoutNestedObjects(value) : value;
    }
  }
  return out;
}

/** How much of a text object's content its name shows. */
const TEXT_NAME_MAX_LENGTH = 60;

/** A human-readable name for a layout object used as its FmObject.name. */
function nameForLayoutObj(lo: LayoutObjectInfo): string {
  if (lo.type === "Text" && lo.info) {
    const s = lo.info.trim();
    return s.length > TEXT_NAME_MAX_LENGTH ? s.slice(0, TEXT_NAME_MAX_LENGTH) + "…" : s;
  }
  if (lo.fieldRef) return lo.fieldRef;
  if (lo.type === "Portal" && lo.portalTable) return `Portal (${lo.portalTable})`;
  if (lo.info) {
    const bare = stripOuterQuotes(lo.info);
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
