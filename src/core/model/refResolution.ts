/**
 * Occurrence lookups: the base table an occurrence reads from, and, by name for
 * text that names them, the occurrences a formula's `Occ::<Field Missing>`
 * mentions and a file's occurrences for search. Whether a reference is found,
 * deleted or external is the model's call
 * (core/model/refStatus), not this module's.
 */
import type { FmObject, SolutionModel } from "@/types/ddr";
import { occurrencesBeforeMissingField } from "@/core/identifiers";

/** The base table an occurrence reads from, as the model resolved it — in
 * another loaded file for an external occurrence. Null when that table isn't
 * loaded or no longer exists. (Its `baseTableId` is an id in the data
 * source's file, so it can't be looked up in the occurrence's own file.) */
export function occurrenceBaseTable(model: SolutionModel, occurrence: FmObject): FmObject | null {
  const ref = model.outbound.get(occurrence.uid)?.find((r) => r.toType === "table");
  return ref?.toUid ? model.byUid.get(ref.toUid) ?? null : null;
}

/** Per-file occurrence index, lazily memoised on the model. Several call sites
 * iterate occurrences in the same file repeatedly (findMissingFieldOccurrences,
 * refIndexFor, search's qualified-name matching) —
 * sharing this map across them avoids re-scanning model.objects each time. */
const occIndexCache = new WeakMap<SolutionModel, Map<string, FmObject[]>>();
export function occurrencesByFile(model: SolutionModel, fileUid: string): FmObject[] {
  let byFile = occIndexCache.get(model);
  if (!byFile) {
    byFile = new Map();
    for (const o of model.objects) {
      if (o.type !== "tableOccurrence") continue;
      const list = byFile.get(o.fileUid);
      if (list) list.push(o);
      else byFile.set(o.fileUid, [o]);
    }
    occIndexCache.set(model, byFile);
  }
  return byFile.get(fileUid) ?? [];
}

/**
 * For a calc body or step-params string that mentions a deleted field
 * (`Occ::<Field Missing>`), pull out the LONGEST real TO name from this file
 * whose name ends exactly at the `::` — handles multi-word names like
 * `Stock_current new Item` that a regex with `\s` in its exclude set would
 * truncate at the first space. Returns every distinct TO mentioned this way,
 * in document order.
 */
export function findMissingFieldOccurrences(
  text: string,
  model: SolutionModel,
  fileUid: string,
): FmObject[] {
  const fileTOs = occurrencesByFile(model, fileUid);
  if (fileTOs.length === 0) return [];
  const byName = new Map<string, FmObject>();
  for (const occ of fileTOs) if (!byName.has(occ.name)) byName.set(occ.name, occ);
  const seen = new Set<string>();
  const out: FmObject[] = [];
  for (const name of occurrencesBeforeMissingField(text, byName.keys())) {
    const occ = byName.get(name);
    if (occ && !seen.has(occ.uid)) {
      seen.add(occ.uid);
      out.push(occ);
    }
  }
  return out;
}
