import type { FmFile, FmObject, ObjectType } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, attributes, child, displayText, textAttr, uuidText } from "../xmlUtils";
import { objectUid } from "../uid";

/**
 * The generic object for a catalog item: its attributes, its searchable text,
 * and the <UUID> modification metadata. Null when the item has no `id`.
 * `idNamespace` prefixes the id where ids only repeat per parent (a field's
 * table), keeping uids globally unique.
 */
export function makeObject(
  fp: FileParse,
  node: unknown,
  type: ObjectType,
  parentUid?: string,
  idNamespace?: string,
): FmObject | null {
  const id = attr(node, "id");
  if (id == null) return null;
  const uid = objectUid(fp.file.uid, type, idNamespace ? `${idNamespace}.${id}` : id);
  return newObject(fp.file, {
    uid,
    type,
    id,
    name: textAttr(node, "name") ?? `(${type} ${id})`,
    attributes: { ...attributes(node), ...uuidMeta(node) },
    text: displayText(node),
    ...(parentUid ? { parentUid } : {}),
  });
}

/** An object of `file`: `fields` plus the file it belongs to. */
export function newObject(file: FmFile, fields: Omit<FmObject, "fileUid" | "fileName">): FmObject {
  return { ...fields, fileUid: file.uid, fileName: file.name };
}

/**
 * The per-object <UUID modifications userName accountName timestamp>guid</UUID>
 * metadata FileMaker records, as attributes, so the inspector can show its UUID
 * and who last changed it (and how many times).
 */
function uuidMeta(node: unknown): Record<string, string> {
  const uuidNode = child(node, "UUID");
  const uuid = uuidText(node);
  const user = textAttr(uuidNode, "userName");
  const account = textAttr(uuidNode, "accountName");
  const timestamp = attr(uuidNode, "timestamp");
  const mods = attr(uuidNode, "modifications");
  return {
    ...(uuid ? { uuid } : {}),
    ...(user != null ? { lastModifiedBy: user } : {}),
    ...(account != null ? { lastModifiedAccount: account } : {}),
    ...(timestamp != null ? { lastModifiedAt: timestamp } : {}),
    ...(mods != null ? { modifications: mods } : {}),
  };
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
