import type { FmObject, ObjectType } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, attributes, child, collectText, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { objectUid } from "../uid";

/**
 * The generic object for a catalog item: its attributes, its searchable text,
 * and the <UUID> modification metadata. Null when the item has no `id`.
 * `idNamespace` prefixes the id where ids only repeat per parent (a field's
 * table), keeping uids globally unique.
 */
export function makeObject(
  node: unknown,
  type: ObjectType,
  fp: FileParse,
  parentUid?: string,
  idNamespace?: string,
): FmObject | null {
  const id = attr(node, "id");
  if (id == null) return null;
  return {
    uid: objectUid(fp.file.uid, type, idNamespace ? `${idNamespace}.${id}` : id),
    type,
    id,
    name: decodeEntities(attr(node, "name") ?? `(${type} ${id})`),
    fileUid: fp.file.uid,
    fileName: fp.file.name,
    attributes: { ...attributes(node), ...uuidMeta(node) },
    text: collectText(node),
    ...(parentUid ? { parentUid } : {}),
  };
}

/**
 * The per-object <UUID modifications userName accountName timestamp>guid</UUID>
 * metadata FileMaker records, as attributes, so the inspector can show its UUID
 * and who last changed it (and how many times).
 */
function uuidMeta(node: unknown): Record<string, string> {
  const uuidNode = child(node, "UUID");
  if (!isRecord(uuidNode)) return {};
  const meta: Record<string, string> = {};
  const text = uuidNode["#text"];
  if (text != null) meta.uuid = String(text);
  const user = attr(uuidNode, "userName");
  if (user != null) meta.lastModifiedBy = decodeEntities(user);
  const account = attr(uuidNode, "accountName");
  if (account != null) meta.lastModifiedAccount = decodeEntities(account);
  const timestamp = attr(uuidNode, "timestamp");
  if (timestamp != null) meta.lastModifiedAt = timestamp;
  const mods = attr(uuidNode, "modifications");
  if (mods != null) meta.modifications = mods;
  return meta;
}

/**
 * Collect leaf catalog items, descending through <Group>, <ObjectList>, and
 * folder items (isFolder="True"). Folders/containers are organizational and are
 * not returned as objects themselves.
 */
export function collectCatalogItems(catalogNode: unknown, itemTag: string, out: unknown[] = []): unknown[] {
  if (!isRecord(catalogNode)) return out;
  for (const el of asArray(catalogNode[itemTag])) {
    if (isFolder(el)) collectCatalogItems(el, itemTag, out);
    else out.push(el);
  }
  for (const container of [...asArray(catalogNode["Group"]), ...asArray(catalogNode["ObjectList"])]) {
    collectCatalogItems(container, itemTag, out);
  }
  return out;
}

function isFolder(node: unknown): boolean {
  // "True" opens a folder, "Marker" closes one — both are organizational
  // markers, not real objects, so neither should become an object.
  const flag = attr(node, "isFolder");
  return flag != null && /^(true|marker)$/i.test(flag);
}

/** A folder marker's display name, from its raw `name` attribute. */
export function folderName(rawName: string): string {
  return decodeEntities(rawName.trim());
}

/**
 * Collect catalog items in document order (= FileMaker workspace order),
 * reconstructing the full folder tree. The catalog is a flat pre-order list of
 * `itemTag` elements with paired markers: `isFolder="True"` opens a folder
 * (push), and `isFolder="Marker"` closes it (pop). An item's folder is the path
 * of all currently-open folders, e.g. "MIGRATION / HISTORY".
 */
export function collectOrderedWithFolders(
  node: unknown,
  itemTag: string,
  out: { node: unknown; folder: string }[] = [],
  stack: string[] = [],
): { node: unknown; folder: string }[] {
  if (!isRecord(node)) return out;
  for (const el of asArray(node[itemTag])) {
    const flag = attr(el, "isFolder");
    if (flag === "True") {
      stack.push(folderName(attr(el, "name") ?? ""));
    } else if (flag === "Marker") {
      stack.pop();
    } else {
      out.push({ node: el, folder: stack.join(" / ") });
    }
  }
  for (const container of [...asArray(node["Group"]), ...asArray(node["ObjectList"])]) {
    collectOrderedWithFolders(container, itemTag, out, stack);
  }
  return out;
}

/** Catalog workspace order and folder for an object built from a catalog list,
 * plus the separator flag: separator items are dividers the developer uses to
 * organize the list — kept (in order), but not real objects. */
export function placeInCatalog(obj: FmObject, order: number, folder: string): FmObject {
  return {
    ...obj,
    order,
    ...(folder ? { folder } : {}),
    ...(obj.attributes.isSeparatorItem === "True" ? { isSeparator: true } : {}),
  };
}

/** Blocks that belong to catalog objects defined elsewhere (a script's steps, a
 * custom function's formula), by the id in their leading `ownerRefTag`
 * reference, in document order. */
export function blocksByOwner(blocks: readonly unknown[], ownerRefTag: string): Map<string, Record<string, unknown>[]> {
  const byOwner = new Map<string, Record<string, unknown>[]>();
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const ownerId = attr(child(block, ownerRefTag), "id");
    if (ownerId == null) continue;
    const list = byOwner.get(ownerId);
    if (list) list.push(block);
    else byOwner.set(ownerId, [block]);
  }
  return byOwner;
}
