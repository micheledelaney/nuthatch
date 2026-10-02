import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { displayText, textAttr } from "../xmlUtils";
import { collectCatalogItems, firstBlockByOwner } from "../catalogWalk";
import { scanRefs } from "../refs/scanRefs";
import { calculationText } from "./common";

type CalcBlocks = ReadonlyMap<string, Record<string, unknown>>;

/** FM 21 / 22 keep a custom function's formula in CalcsForCustomFunctions
 * (keyed back to the function by reference, like StepsForScripts); FM 26
 * inlines it on the catalog entry. */
export function customFunctionCalcs(containerNode: Record<string, unknown>): CalcBlocks {
  return firstBlockByOwner(collectCatalogItems(containerNode["CalcsForCustomFunctions"], "CustomFunctionCalc"), "CustomFunctionReference");
}

/** A custom function's signature and formula, as calculation detail. A
 * separately stored formula is also appended to its searchable text. */
export function annotateCustomFunction(item: Record<string, unknown>, obj: FmObject, calcs: CalcBlocks): FmObject {
  const signature = displayText(item["Display"]) || (textAttr(item, "name") ?? "");
  const block = calcs.get(obj.id);
  const separateBody = block ? calculationText(block["Calculation"]) : undefined;
  return {
    ...obj,
    detail: { kind: "calculation", signature, body: separateBody ?? calculationText(item["Calculation"]) },
    ...(separateBody ? { text: obj.text ? `${obj.text}\n${separateBody}` : separateBody } : {}),
  };
}

/** The references in a separately stored formula (see customFunctionCalcs). */
export function addCustomFunctionCalcRefs(fp: FileParse, obj: FmObject, calcs: CalcBlocks): void {
  const block = calcs.get(obj.id);
  if (block) scanRefs(fp, block["Calculation"], obj);
}
