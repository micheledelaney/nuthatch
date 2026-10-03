import type { ObjectType } from "@/types/ddr";

/**
 * Object uids are `<fileUid>:<type>:<idPart>`. The id part is FileMaker's id,
 * namespaced by the parent where ids only repeat per parent (a field by its
 * table, `3.7`; a menu item by its menu). Saved analyses and usage marks store
 * uids, so the format is fixed.
 */
export function objectUid(fileUid: string, type: ObjectType, idPart: string): string {
  return `${fileUid}:${type}:${idPart}`;
}

/** The uid of the index-th loaded file (load order). */
export function fileUidAt(index: number): string {
  return `F${index}`;
}
