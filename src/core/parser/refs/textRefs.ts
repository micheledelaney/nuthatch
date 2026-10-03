import type { FileParse, TextScan } from "../context";
import { addDataSourcePathGlobalRefs } from "./globalVariables";
import { addPlaceholderRefs } from "./placeholderRefs";

/** The references that show only in a batch's text — placeholders where a
 * target was deleted, and the globals a data source's path names — after the
 * batch's element scan, whose references are all of `fp.references`. A batch
 * is a file's catalog objects (in the file's parse), or one layout with its
 * objects (in the layout's own, see processOneLayout), each with the text these
 * passes read for it. */
export function addTextDerivedRefs(fp: FileParse, batch: readonly TextScan[]): void {
  addPlaceholderRefs(fp, batch);
  addDataSourcePathGlobalRefs(fp, batch);
}
