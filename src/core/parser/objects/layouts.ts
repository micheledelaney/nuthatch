import type { FmObject, LayoutObjectInfo, ObjectDetail } from "@/types/ddr";
import type { FileParse, TextScan } from "../context";
import { asArray, attr, cdataText, child, displayText, isElementKey, isRecord, textAttr } from "../xmlUtils";
import { FILE_DEFAULT_MENU_SET } from "../sentinels";
import { objectUid } from "../uid";
import { scanRefs } from "../refs/scanRefs";
import { addMergeVariableRefs } from "../refs/globalVariables";
import { addTextDerivedRefs } from "../refs/textRefs";
import { makeObject, newObject, placeInCatalog } from "./catalogItems";
import { stripOuterQuotes } from "./common";
import { addDeferredLayoutRefs } from "./deferredLayouts";
import { layoutDetail, type LayoutDetail, type LayoutNodes, type LayoutObjectNode } from "./layoutDetail";

/** What emitting one layout's objects needs: the elements of the objects that
 * are listed on their own (which every other element's own scan leaves out),
 * and the uid each element ends up with (for the FM 22 deferred button
 * targets, which name the element) — and collects the objects' text for the
 * text-based passes, in emission order. */
interface LayoutObjectsContext {
  fp: FileParse;
  listedElements: ReadonlySet<unknown>;
  uidOfElement: Map<Record<string, unknown>, string>;
  /** The layout's own uid counts (see FileParse.layoutObjectUidCounts), added
   * to the file's once the layout is read, so a layout that fails to read
   * leaves the file's counts as they were. */
  uidCounts: Map<string, number>;
  scans: TextScan[];
}

/**
 * One layout from LayoutCatalog (structured like ScriptCatalog: a flat
 * document-ordered list with folder markers and separator items), with its
 * layout objects, references, and text-derived references; false when it has
 * no id. Each object reports what its own element uses, and the layout what
 * the rest of its element does — and, since a layout lists everything on it,
 * a copy of every one of its objects' references, made once they're complete.
 * The layout is stored with a compact term list as its text
 * (compactLayoutText), not the full text of every object on it. Nothing is
 * added to the file until the whole layout is read, so one that fails to read
 * leaves the file as it was.
 */
export function processOneLayout(fp: FileParse, layout: unknown, folder: string, order: number): boolean {
  // Its text is set at the end: the full text of a layout with parts would
  // only be replaced by its compact text.
  const base = makeObject(fp, layout, "layout", undefined, undefined, "");
  if (!base) return false;
  recordThemeBase(fp, layout);
  // The layout's own objects and references, added to the file's at the end.
  const lp: FileParse = { ...fp, objects: [], references: [] };
  const uidCounts = new Map<string, number>();
  const { layout: full, scans } = buildLayout(lp, layout, placeInCatalog(base, order, folder), uidCounts);
  addTextDerivedRefs(lp, scans);
  // After the text passes, so the layout's placeholder check weighs only its own references.
  addObjectRefsToLayout(lp, full.uid);
  lp.objects.push({ ...full, text: full.detail?.kind === "layout" ? compactLayoutText(full, full.detail) : displayText(layout) });
  for (const obj of lp.objects) fp.objects.push(obj);
  for (const ref of lp.references) fp.references.push(ref);
  for (const [uid, count] of uidCounts) fp.layoutObjectUidCounts.set(uid, count);
  return true;
}

/** The base theme the layout's theme reference names, for its theme (see
 * FileParse.themeBases). */
function recordThemeBase(fp: FileParse, layout: unknown): void {
  const ref = child(layout, "LayoutThemeReference");
  const id = attr(ref, "id");
  const base = textAttr(ref, "Base");
  if (id != null && base && !fp.themeBases.has(id)) fp.themeBases.set(id, base);
}

/** The layout object, after its layout objects and its own references, with
 * the batch the text-based passes read: its objects, then itself. */
function buildLayout(
  fp: FileParse,
  layout: unknown,
  placed: FmObject,
  uidCounts: Map<string, number>,
): { layout: FmObject; scans: TextScan[] } {
  if (placed.isSeparator) return { layout: placed, scans: [{ obj: placed, text: cdataText(layout), source: layout }] };
  const annotated = annotateLayout(layout, placed);
  const extracted = layoutDetail(layout, fp.index);
  const listedElements = extracted ? listedElementsOf(extracted) : new Set<unknown>();
  const cx: LayoutObjectsContext = { fp, listedElements, uidOfElement: new Map(), uidCounts, scans: [] };
  const obj = extracted ? { ...annotated, detail: addLayoutObjects(cx, extracted, annotated) } : annotated;
  // Its own settings, triggers and parts, and any object not listed on its own.
  const own = ownElement(layout, listedElements);
  cx.scans.push({ obj, text: scanOwnElement(fp, own, obj), source: own });
  addDeferredLayoutRefs(fp, layout, obj, cx.uidOfElement);
  return { layout: obj, scans: cx.scans };
}

/** Copy every reference the layout's objects (`lp.objects`, so far) recorded
 * onto the layout itself — without the step it came from: that's a step of
 * one button's action, which the object's own reference keeps, and on the
 * layout it would keep a use apart from the same use by another object. */
function addObjectRefsToLayout(lp: FileParse, layoutUid: string): void {
  const objectUids = new Set(lp.objects.map((o) => o.uid));
  const end = lp.references.length;
  for (let i = 0; i < end; i++) {
    const ref = lp.references[i]!;
    if (!objectUids.has(ref.fromUid)) continue;
    const { fromStep: _fromStep, ...use } = ref;
    lp.references.push({ ...use, fromUid: layoutUid });
  }
}

/** Record what an element holds for `owner` — its references and the globals
 * merged into its text — and return the text the placeholder pass reads for
 * it: after `missingBinding`, the placeholder of a layout object's field
 * binding whose field is gone, which shows nowhere in its element (see
 * layoutDetail's missingBinding). */
function scanOwnElement(fp: FileParse, own: unknown, owner: FmObject, missingBinding?: string): string {
  scanRefs(fp, own, owner);
  const literal = cdataText(own);
  addMergeVariableRefs(fp, owner.uid, literal);
  return missingBinding ? `${missingBinding}\n${literal}` : literal;
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
  const clientType = displayText(node["ClientType"]);
  if (clientType && clientType !== "0") a.clientType = clientType;
  const menuSet = textAttr(child(child(node, "MenuSet"), "CustomMenuSetReference"), "name");
  if (menuSet && menuSet !== FILE_DEFAULT_MENU_SET) a.menuSet = menuSet;
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}

/** Emit the layout's objects (and their references), returning its detail with
 * each object's uid filled in. Every part's objects come first, then the
 * off-layout ones — the order the duplicate-uid suffixes are counted in. */
function addLayoutObjects(cx: LayoutObjectsContext, detail: LayoutNodes, layout: FmObject): LayoutDetail {
  const parts = detail.parts.map((part) => ({ ...part, objects: addLayoutObjectTree(cx, part.objects, layout.uid, layout.id) }));
  const offLayout = addLayoutObjectTree(cx, detail.offLayout, layout.uid, layout.id);
  return { ...detail, parts, offLayout };
}

/** The elements of a layout's objects that are listed on their own (see
 * isListed), at any depth. */
function listedElementsOf(detail: LayoutNodes): Set<unknown> {
  const listed = new Set<unknown>();
  const walk = (nodes: readonly LayoutObjectNode[]): void => {
    for (const node of nodes) {
      if (isListed(node.info)) listed.add(node.element);
      walk(node.children);
    }
  };
  for (const part of detail.parts) walk(part.objects);
  walk(detail.offLayout);
  return listed;
}

/** Emit layout objects as FmObjects, recursively (see addLayoutObject),
 * returning their detail with each uid filled in. */
function addLayoutObjectTree(cx: LayoutObjectsContext, nodes: readonly LayoutObjectNode[], parentUid: string, idChain: string): LayoutObjectInfo[] {
  return nodes.map((node) => addLayoutObject(cx, node, parentUid, idChain));
}

/** Emit a layout object — and the objects inside it — as FmObjects with their
 * references, returning its detail with its uid filled in. `idChain` is the
 * dot-joined `id` of every ancestor from the owning layout down to (but not
 * including) this object — e.g. `"120.2970"` for an object nested one level
 * inside layout 120's object with id 2970. */
function addLayoutObject(cx: LayoutObjectsContext, node: LayoutObjectNode, parentUid: string, idChain: string): LayoutObjectInfo {
  const { fp } = cx;
  const { info: lo, element, children } = node;
  if (!isListed(lo)) {
    // Nothing to list it by — but the objects inside it are still objects.
    return children.length ? { ...lo, children: addLayoutObjectTree(cx, children, parentUid, idChain) } : lo;
  }
  // FileMaker's numeric `id` is unique among siblings under the same parent — like
  // a field's id is unique within its table — so namespace by the full ancestor
  // chain the same way fields are namespaced by table. A single level (layout + own
  // id) isn't enough: two different parents on the same layout (e.g. two Grouped
  // Buttons) can each wrap a child that reuses the same id. `UUID` looks globally
  // unique but isn't reliably so either — duplicating a compound object can leave a
  // child's UUID identical to its sibling's.
  const chain = lo.id ? `${idChain}.${lo.id}` : undefined;
  const withUid: LayoutObjectInfo = { ...lo, uid: uniqueLayoutObjectUid(cx, chain ?? lo.uuid!) };
  const uid = withUid.uid!;
  const obj = layoutObjectFmObject(fp, withUid, uid, parentUid);
  fp.objects.push(obj);
  cx.uidOfElement.set(element, uid);
  // Everything the object itself uses — its field, script, value list,
  // triggers, and the calcs behind its label, tooltip, hide condition,
  // conditional formatting, web viewer, and button action — but not what
  // the listed objects inside it use: each of those reports its own. The
  // placeholder pass reads the same element, after the placeholder of a field
  // binding whose field is gone, which the element doesn't show — then its
  // button step's rendered text, where, as in a script's step, a target
  // FileMaker blanked to `<FieldReference id="0">` still shows as a
  // placeholder. Not its search text or labels: what it's found by or shown
  // as isn't what it uses.
  const own = ownElement(element, cx.listedElements);
  const text = scanOwnElement(fp, own, obj, node.missingBinding);
  cx.scans.push({ obj, text: node.actionText ? `${text}\n${node.actionText}` : text, source: own });
  return children.length ? { ...withUid, children: addLayoutObjectTree(cx, children, uid, chain ?? idChain) } : withUid;
}

/** Whether a layout object is listed as an object of its own. `uuid` is only
 * populated once FileMaker has stamped this specific object with a per-edit
 * UUID — an object never touched since it was placed has none, which is the
 * common case — so only an object with neither has nothing to build a uid from
 * (`id` is preferred and `uuid` is just the fallback). */
function isListed(lo: LayoutObjectInfo): boolean {
  return Boolean(lo.id || lo.uuid);
}

/** The object's uid, with a stable `#N` suffix on every repeat (see
 * FileParse.layoutObjectUidCounts). */
function uniqueLayoutObjectUid(cx: LayoutObjectsContext, idPart: string): string {
  const uid = objectUid(cx.fp.file.uid, "layoutObject", idPart);
  const seen = cx.uidCounts.get(uid) ?? cx.fp.layoutObjectUidCounts.get(uid) ?? 0;
  cx.uidCounts.set(uid, seen + 1);
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
  if (lo.scriptParameter) a.scriptParameter = lo.scriptParameter;
  if (lo.tooltip) a.tooltip = lo.tooltip;
  if (lo.placeholder) a.placeholder = lo.placeholderInFind ? `${lo.placeholder} (also in Find mode)` : lo.placeholder;
  if (lo.hideWhen) a.hideWhen = lo.hideInFind ? `${lo.hideWhen} (also in Find mode)` : lo.hideWhen;
  if (lo.conditionalFormats) a.conditionalFormats = lo.conditionalFormats.join("\n");
  if (lo.popoverTitle) a.popoverTitle = lo.popoverTitle;
  if (lo.chart?.type) a.chartType = lo.chart.type;
  if (lo.portalTable) a.portalOccurrence = lo.portalTable;
  if (lo.portalRows != null) a.portalRows = String(lo.portalRows);
  if (lo.portalInitialRow != null) a.portalInitialRow = String(lo.portalInitialRow);
  if (lo.portalFilter) a.portalFilter = lo.portalFilter;
  return a;
}

/** A layout's or layout object's element without the layout objects nested in
 * it that are listed on their own (`listed`): what it shows and uses itself.
 * A nested object that isn't listed — a popover's panel, whose contents hang
 * off the popover button (see childObjects), or one with neither id nor UUID —
 * stays part of it. */
function ownElement(node: unknown, listed: ReadonlySet<unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => ownElement(n, listed));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "LayoutObject") {
      const kept = asArray(value).filter((lo) => !listed.has(lo));
      if (kept.length > 0) out[key] = kept.map((lo) => ownElement(lo, listed));
    } else {
      out[key] = isElementKey(key) ? ownElement(value, listed) : value;
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
 * binding, portal/script references, script parameter, label/url info,
 * tooltip, placeholder, conditions, portal filter, popover and chart titles,
 * and trigger scripts. Shared by the per-object search index and the
 * layout's own compacted text (compactLayoutText). */
function layoutObjectTerms(lo: LayoutObjectInfo): string[] {
  return [
    lo.name,
    lo.fieldRef,
    lo.portalTable,
    lo.scriptRef?.name,
    lo.scriptParameter,
    lo.valueListRef?.name,
    lo.info,
    lo.tooltip,
    lo.placeholder,
    lo.hideWhen,
    ...(lo.conditionalFormats ?? []),
    lo.portalFilter,
    lo.popoverTitle,
    ...chartTerms(lo.chart),
    ...(lo.triggers ?? []).map((t) => t.scriptName),
  ].filter((s): s is string => !!s);
}

/** A chart's titles and series formulas, for search. */
function chartTerms(chart: LayoutObjectInfo["chart"]): (string | undefined)[] {
  if (!chart) return [];
  return [chart.title, chart.xAxisTitle, chart.yAxisTitle, ...chart.series.flatMap((s) => [s.title, s.value])];
}

/**
 * A layout's searchable text as a compact, deduped set of its genuinely
 * searchable terms (layout name, anchor occurrence, and every layout object's
 * field/script/label text), replacing the full styled text of every object on
 * the layout — tens of MB for a dense data-entry layout. The diff never reads it
 * (layouts diff via their structured detail) and per-object search is already
 * served by each layout object's own text, so the only thing lost is free-text
 * search over the raw styled text inside a layout. A text object's content is
 * left to the object, too: it can run to hundreds of KB.
 */
function compactLayoutText(layout: FmObject, detail: LayoutDetail): string {
  const terms = new Set<string>();
  terms.add(layout.name);
  if (layout.attributes.tableOccurrence) terms.add(layout.attributes.tableOccurrence);
  const walk = (infos: LayoutObjectInfo[]): void => {
    for (const lo of infos) {
      const content = lo.type === "Text" ? lo.info : undefined;
      for (const term of layoutObjectTerms(lo)) if (term !== content) terms.add(term);
      if (lo.children) walk(lo.children);
    }
  };
  for (const part of detail.parts) walk(part.objects);
  walk(detail.offLayout);
  return [...terms].join(" ");
}
