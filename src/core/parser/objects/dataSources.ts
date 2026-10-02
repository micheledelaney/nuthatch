import type { FmObject } from "@/types/ddr";
import { collectText, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";

/** Surface an external data source's path(s) (nested <File><UniversalPathList>). */
export function annotateExternalDataSource(node: Record<string, unknown>, obj: FmObject): FmObject {
  const path = collectText(isRecord(node["File"]) ? node["File"]["UniversalPathList"] : undefined).trim();
  return path ? { ...obj, attributes: { ...obj.attributes, path: decodeEntities(path) } } : obj;
}
