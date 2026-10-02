import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { addTextGlobalRefs } from "./globalVariables";
import { addPlaceholderRefs } from "./placeholderRefs";

/** The references that show only in a batch's text — placeholders where a
 * target was deleted, and text-only global-variable uses — after the batch's
 * element scan, whose references start at `refStart`. A batch is a file's
 * catalog objects, or one layout with its objects (so the layout's full text
 * can be dropped right after). */
export function addTextDerivedRefs(fp: FileParse, batch: readonly FmObject[], refStart: number): void {
  addPlaceholderRefs(fp, batch, refStart);
  addTextGlobalRefs(fp, batch);
}
