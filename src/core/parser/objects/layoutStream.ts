import type { FileParse } from "../context";
import { xmlParser } from "../xmlParser";
import { asArray, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { folderName } from "./catalogItems";
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

/** The start/end char positions of <Structure>'s own <LayoutCatalog>…</LayoutCatalog>
 * (the one in its <AddAction>), or null when there's none to stream. FM 22's
 * <ModifyAction> repeats a small LayoutCatalog of button targets; that one is
 * left to the main parse. */
function findLayoutCatalogBounds(xml: string): { start: number; end: number } | null {
  const structure = xml.indexOf("<Structure");
  const start = structure === -1 ? -1 : xml.indexOf("<LayoutCatalog", structure);
  if (start === -1) return null;
  const modifyAction = xml.indexOf("<ModifyAction", structure);
  if (modifyAction !== -1 && modifyAction < start) return null;
  const openEnd = xml.indexOf(">", start);
  if (openEnd === -1 || xml[openEnd - 1] === "/") return null; // <LayoutCatalog/>: no layouts
  const close = "</LayoutCatalog>";
  const end = xml.indexOf(close, openEnd);
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
    const lt = xml.indexOf(TAG, pos);
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
 */
export function parseLayoutsStreaming(catalogXml: string, fp: FileParse): void {
  let order = 0;
  const folderStack: string[] = [];
  const closeTag = "</Layout>";
  let pos = 0;

  while (pos < catalogXml.length) {
    const lt = nextLayoutElement(catalogXml, pos);
    if (lt === -1) break;
    const gt = catalogXml.indexOf(">", lt);
    if (gt === -1) break;
    const openTag = catalogXml.slice(lt, gt + 1);
    if (openTag.endsWith("/>")) {
      pos = gt + 1;
      continue;
    }
    const closePos = catalogXml.indexOf(closeTag, gt + 1);
    if (closePos === -1) break;
    const endPos = closePos + closeTag.length;
    pos = endPos;

    // Folder markers: manage the stack but do not emit an object.
    const folderMatch = /\bisFolder="(True|Marker)"/.exec(openTag);
    if (folderMatch) {
      if (folderMatch[1] === "True") {
        const nameMatch = / name="([^"]*)"/.exec(openTag);
        folderStack.push(folderName(nameMatch?.[1] ?? ""));
      } else {
        folderStack.pop();
      }
      continue;
    }

    // Real layout: parse the single element and process it immediately so the
    // parsed object-tree can be GC'd before the next layout is parsed.
    const layoutNode = parseLayoutElement(catalogXml.slice(lt, endPos), openTag, fp);
    if (layoutNode === null) {
      order++;
      continue;
    }
    const folder = folderStack.join(" / ");
    for (const node of asArray(layoutNode)) processOneLayout(node, folder, order++, fp);
  }
}

/** One <Layout> element's object tree, or null (and an error for the user)
 * when it doesn't parse — skipping it silently would hide the layout and every
 * reference on it. */
function parseLayoutElement(layoutXml: string, openTag: string, fp: FileParse): unknown {
  try {
    const wrapper = (xmlParser.parse(`<_L>${layoutXml}</_L>`) as Record<string, unknown>)["_L"];
    return isRecord(wrapper) ? wrapper["Layout"] : undefined;
  } catch (err) {
    const layoutName = / name="([^"]*)"/.exec(openTag)?.[1];
    fp.errors.push(
      `${fp.file.name}: layout ${layoutName != null ? `“${decodeEntities(layoutName)}” ` : ""}could not be parsed and was skipped — ${(err as Error).message}`,
    );
    return null;
  }
}
