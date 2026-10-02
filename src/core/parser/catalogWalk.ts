/**
 * Walking FileMaker's catalog lists: their leaf items, the folder markers that
 * organize them, and the blocks stored apart from the items they belong to.
 */
import { asArray, attr, child, children, isRecord } from "./xmlUtils";
import { decodeEntities } from "./entities";

/** What a catalog entry's `isFolder` flag makes it: "True" opens a folder and
 * "Marker" closes it — both organizational, not objects. Anything else is an
 * item. */
function folderMarker(flag: string | undefined): "open" | "close" | undefined {
  if (flag === "True") return "open";
  if (flag === "Marker") return "close";
  return undefined;
}

/**
 * Track the open folders of a catalog read in document order: a folder marker
 * opens (push) or closes (pop) a folder and returns true; an item returns
 * false. `rawName` is the marker's `name` attribute as written.
 */
export function applyFolderMarker(stack: string[], flag: string | undefined, rawName: string): boolean {
  const marker = folderMarker(flag);
  if (marker === "open") stack.push(decodeEntities(rawName.trim()));
  else if (marker === "close") stack.pop();
  return marker != null;
}

/** The folder path of the currently open folders, e.g. "MIGRATION / HISTORY". */
export function folderPath(stack: readonly string[]): string {
  return stack.join(" / ");
}

/**
 * Collect leaf catalog items, descending through <Group> and <ObjectList>.
 * Folder markers (see applyFolderMarker) and containers are organizational and
 * are not returned as objects themselves.
 */
export function collectCatalogItems(catalogNode: unknown, itemTag: string, out: unknown[] = []): unknown[] {
  if (!isRecord(catalogNode)) return out;
  for (const el of asArray(catalogNode[itemTag])) {
    if (folderMarker(attr(el, "isFolder")) == null) out.push(el);
  }
  for (const container of [...asArray(catalogNode["Group"]), ...asArray(catalogNode["ObjectList"])]) {
    collectCatalogItems(container, itemTag, out);
  }
  return out;
}

/**
 * Collect catalog items in document order (= FileMaker workspace order),
 * reconstructing the full folder tree. The catalog is a flat pre-order list of
 * `itemTag` elements with paired folder markers (see applyFolderMarker); an
 * item's folder is the path of all currently-open folders.
 */
export function collectOrderedWithFolders(
  node: unknown,
  itemTag: string,
  out: { node: unknown; folder: string }[] = [],
  stack: string[] = [],
): { node: unknown; folder: string }[] {
  if (!isRecord(node)) return out;
  for (const el of asArray(node[itemTag])) {
    if (!applyFolderMarker(stack, attr(el, "isFolder"), attr(el, "name") ?? "")) out.push({ node: el, folder: folderPath(stack) });
  }
  for (const container of [...asArray(node["Group"]), ...asArray(node["ObjectList"])]) {
    collectOrderedWithFolders(container, itemTag, out, stack);
  }
  return out;
}

/** The block that belongs to each catalog object defined elsewhere (a script's
 * steps, a custom function's formula, a value list's contents), by the id in
 * its leading `ownerRefTag` reference. FileMaker writes one block per owner;
 * the first one wins. */
export function firstBlockByOwner(blocks: readonly unknown[], ownerRefTag: string): Map<string, Record<string, unknown>> {
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const ownerId = attr(child(block, ownerRefTag), "id");
    if (ownerId != null && !byOwner.has(ownerId)) byOwner.set(ownerId, block);
  }
  return byOwner;
}

/** Each <FieldsForTables><FieldCatalog>, keyed back to its base table by a
 * leading <BaseTableReference>. */
export function fieldCatalogs(containerNode: Record<string, unknown>): { tableId: string; node: unknown }[] {
  const out: { tableId: string; node: unknown }[] = [];
  for (const node of children(containerNode["FieldsForTables"], "FieldCatalog")) {
    const tableId = attr(child(node, "BaseTableReference"), "id");
    if (tableId != null) out.push({ tableId, node });
  }
  return out;
}
