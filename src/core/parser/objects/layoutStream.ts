import type { FileParse } from "../context";
import { xmlParser } from "../xmlParser";
import { asArray, detach, isRecord, textAttr } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { applyFolderMarker, collectOrderedWithFolders, folderPath } from "../catalogWalk";
import { processOneLayout } from "./layouts";

/**
 * LayoutCatalog dominates large DDR files (often 80-90% of the XML). To avoid
 * building a massive object-tree for it all at once, the catalog is cut out of
 * the document before the main parse (replaced with an empty stub, so the main
 * parse is cheap) and its layouts are parsed one at a time afterwards.
 */
export function splitLayoutCatalog(xml: string): { rest: string; layoutCatalog?: string } {
  const bounds = findLayoutCatalogBounds(xml);
  if (!bounds) return { rest: xml };
  return {
    rest: xml.slice(0, bounds.start) + "<LayoutCatalog/>" + xml.slice(bounds.end),
    layoutCatalog: xml.slice(bounds.start, bounds.end),
  };
}

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/** The index of the next `needle` at or after `from` that isn't inside a CDATA
 * section, or -1. These scans read the raw XML, where a formula or text object
 * can contain any markup-like text (`"</Layout>"`) — only CDATA can, since
 * everything else is entity-encoded. */
function indexOutsideCdata(xml: string, needle: string, from: number): number {
  let pos = xml.indexOf(needle, from);
  let cdata = xml.indexOf(CDATA_OPEN, from);
  while (pos !== -1 && cdata !== -1 && cdata < pos) {
    const close = xml.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length);
    if (close === -1) return -1;
    const after = close + CDATA_CLOSE.length;
    if (pos < after) pos = xml.indexOf(needle, after);
    cdata = xml.indexOf(CDATA_OPEN, after);
  }
  return pos;
}

/** The start/end char positions of <Structure>'s own <LayoutCatalog>…</LayoutCatalog>
 * (the one in its <AddAction>), or null when there's none to stream. FM 22's
 * <ModifyAction> repeats a small LayoutCatalog of button targets; that one is
 * left to the main parse. */
function findLayoutCatalogBounds(xml: string): { start: number; end: number } | null {
  const structure = indexOutsideCdata(xml, "<Structure", 0);
  const start = structure === -1 ? -1 : indexOutsideCdata(xml, "<LayoutCatalog", structure);
  if (start === -1) return null;
  // Only a <ModifyAction> before the catalog matters, so the search stops there.
  if (indexOutsideCdata(xml.slice(0, start), "<ModifyAction", structure) !== -1) return null;
  const openEnd = xml.indexOf(">", start);
  if (openEnd === -1 || xml[openEnd - 1] === "/") return null; // <LayoutCatalog/>: no layouts
  const close = "</LayoutCatalog>";
  const end = indexOutsideCdata(xml, close, openEnd);
  return end === -1 ? null : { start, end: end + close.length };
}

/** Index of the next real `<Layout` element at or after `from`, or -1. Skips
 * tags that merely share the prefix — most importantly the catalog's own
 * `<LayoutCatalog` opening tag, which `indexOf("<Layout")` would otherwise match
 * at position 0, swallowing the first real entry and corrupting the folder stack
 * — as well as `<LayoutObject`, `<LayoutReference`, etc. A real element is
 * followed by a tag delimiter; a longer tag name has a letter there instead. */
function nextLayoutElement(xml: string, from: number): number {
  const TAG = "<Layout";
  let pos = from;
  for (;;) {
    const lt = indexOutsideCdata(xml, TAG, pos);
    if (lt === -1) return -1;
    const after = xml[lt + TAG.length]; // char immediately after "<Layout"
    if (after === " " || after === "\t" || after === "\n" || after === "\r" || after === ">" || after === "/") {
      return lt;
    }
    pos = lt + TAG.length;
  }
}

/**
 * Parse layouts from a raw LayoutCatalog XML string one element at a time,
 * so the peak object-tree is bounded by the largest single layout rather than
 * the entire catalog (which can be hundreds of MB in large DDR files).
 *
 * Folder markers (isFolder="True" / "Marker") are handled without a full XML
 * parse — the name attribute is read with a simple regex — because folder
 * marker layouts contain no reference-bearing content.
 *
 * Returns the order the next layout takes.
 */
export function parseLayoutsStreaming(fp: FileParse, catalogXml: string): number {
  let order = 0;
  const folderStack: string[] = [];
  const closeTag = "</Layout>";
  let pos = 0;

  while (pos < catalogXml.length) {
    const lt = nextLayoutElement(catalogXml, pos);
    if (lt === -1) break;
    const gt = catalogXml.indexOf(">", lt);
    if (gt === -1) break;
    // A copy, so the tag and the folder names read from it don't keep the
    // decoded file alive (see detach).
    const openTag = detach(catalogXml.slice(lt, gt + 1));
    // A self-closing <Layout …/> is an element too — a folder's closing marker
    // can be one — read as the tree walk reads it (collectOrderedWithFolders).
    let endPos = gt + 1;
    if (!openTag.endsWith("/>")) {
      const closePos = indexOutsideCdata(catalogXml, closeTag, gt + 1);
      if (closePos === -1) {
        fp.errors.push(`${fp.file.source}: layout ${layoutLabel(openTag)}has no closing </Layout>, so it and everything after it in the layout catalog were left out.`);
        break;
      }
      endPos = closePos + closeTag.length;
    }
    pos = endPos;

    // Folder markers: manage the stack but do not emit an object.
    const flag = /\bisFolder="([^"]*)"/.exec(openTag)?.[1];
    if (applyFolderMarker(folderStack, flag, / name="([^"]*)"/.exec(openTag)?.[1] ?? "")) continue;

    // Real layout: parse the single element and process it immediately so the
    // parsed object-tree can be GC'd before the next layout is parsed.
    // Only an emitted layout takes a place in the order, as in parseScripts.
    const layoutNode = parseLayoutElement(fp, catalogXml.slice(lt, endPos), openTag);
    if (layoutNode == null) continue;
    const folder = folderPath(folderStack);
    for (const node of asArray(layoutNode)) if (readLayout(fp, node, folder, order)) order++;
  }
  return order;
}

/** processOneLayout, or — when reading the layout throws — nothing but an
 * error for the user, so the rest of the file still loads. (processOneLayout
 * adds nothing to the file until it has read the whole layout.) */
function readLayout(fp: FileParse, node: unknown, folder: string, order: number): boolean {
  const name = textAttr(node, "name");
  const label = name != null ? `“${name}” ` : "";
  // FileMaker never nests <Layout>: one inside another means the outer one has
  // no closing tag, and the XML parser read the layouts after it into it.
  if (isRecord(node) && node["Layout"] != null) {
    fp.errors.push(`${fp.file.source}: layout ${label}has no closing </Layout>, so it and the layouts read into it were left out.`);
    return false;
  }
  try {
    return processOneLayout(fp, node, folder, order);
  } catch (err) {
    fp.errors.push(`${fp.file.source}: layout ${label}could not be read and was skipped — ${(err as Error).message}`);
    // The message alone doesn't say where it failed.
    console.error(`${fp.file.source}: layout ${label}could not be read`, err);
    return false;
  }
}

/** Layouts the streaming split left in the parsed tree — a second
 * <LayoutCatalog>, or one it couldn't cut out — read the way scripts are,
 * after the streamed ones. (The streamed catalog leaves an empty stub.) */
export function parseLayoutsInTree(fp: FileParse, catalogs: unknown, firstOrder: number): void {
  let order = firstOrder;
  for (const catalog of asArray(catalogs)) {
    for (const { node, folder } of collectOrderedWithFolders(catalog, "Layout")) {
      if (readLayout(fp, node, folder, order)) order++;
    }
  }
}

/** One <Layout> element's object tree, or null (and an error for the user)
 * when it doesn't parse — skipping it silently would hide the layout and every
 * reference on it. */
function parseLayoutElement(fp: FileParse, layoutXml: string, openTag: string): unknown {
  try {
    const wrapper = (xmlParser.parse(`<_L>${layoutXml}</_L>`) as Record<string, unknown>)["_L"];
    return isRecord(wrapper) ? wrapper["Layout"] : undefined;
  } catch (err) {
    fp.errors.push(`${fp.file.source}: layout ${layoutLabel(openTag)}could not be parsed and was skipped — ${(err as Error).message}`);
    return null;
  }
}

/** A streamed layout's name, quoted and followed by a space, for a message —
 * "" when its open tag has none. */
function layoutLabel(openTag: string): string {
  const name = / name="([^"]*)"/.exec(openTag)?.[1];
  return name != null ? `“${decodeEntities(name)}” ` : "";
}
