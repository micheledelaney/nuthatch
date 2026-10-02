import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, collectText } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { scanRefs } from "../refs/scanRefs";
import { blocksByOwner, collectCatalogItems } from "./catalogItems";
import { calculationText } from "./common";

/** FM 21 / 22 keep a custom function's formula in CalcsForCustomFunctions
 * (keyed back to the function by reference, like StepsForScripts); FM 26
 * inlines it on the catalog entry. */
export function customFunctionCalcs(containerNode: Record<string, unknown>): Map<string, Record<string, unknown>[]> {
  return blocksByOwner(collectCatalogItems(containerNode["CalcsForCustomFunctions"], "CustomFunctionCalc"), "CustomFunctionReference");
}

/** A custom function's signature and formula, as calculation detail. */
export function annotateCustomFunction(
  item: Record<string, unknown>,
  obj: FmObject,
  calcs: Map<string, Record<string, unknown>[]>,
): FmObject {
  const signature = decodeEntities(collectText(item["Display"]).trim() || (attr(item, "name") ?? ""));
  let annotated: FmObject = { ...obj, detail: { kind: "calculation", signature, body: calculationText(item["Calculation"]) } };
  for (const block of calcs.get(obj.id) ?? []) {
    const body = calculationText(block["Calculation"]);
    annotated = {
      ...annotated,
      detail: { kind: "calculation", signature, body },
      ...(body ? { text: annotated.text ? `${annotated.text}\n${body}` : body } : {}),
    };
  }
  return annotated;
}

/** The references in a separately stored formula (see customFunctionCalcs). */
export function addCustomFunctionCalcRefs(fp: FileParse, obj: FmObject, calcs: Map<string, Record<string, unknown>[]>): void {
  for (const block of calcs.get(obj.id) ?? []) scanRefs(fp, block["Calculation"], obj);
}
