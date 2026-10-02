import type { FmObject } from "@/types/ddr";
import { child, displayText, isRecord } from "../xmlUtils";

/** Surface an external data source's path(s) (nested <File><UniversalPathList>). */
export function annotateExternalDataSource(node: Record<string, unknown>, obj: FmObject): FmObject {
  const file = child(node, "File");
  const path = displayText(isRecord(file) ? file["UniversalPathList"] : undefined);
  return path ? { ...obj, attributes: { ...obj.attributes, path } } : obj;
}
