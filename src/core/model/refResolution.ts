/**
 * One resolver for FileMaker's qualified `Occurrence::Field` references.
 *
 * The same lookup logic was previously duplicated in three places:
 * `ObjectColumn.resolveFieldRef` (UI render), `addMissingCalcFieldRefs.findVia`
 * (parser), and the `<Field Missing>` regex inside `refIndexFor`. They each
 * disagreed on edge cases (multi-word names, external data sources, missing
 * fields). This module owns the truth.
 *
 * Distinguishes four outcomes via a discriminated union, so the caller can
 * style each one consistently — broken (red), external (dim + chip), resolved
 * (link).
 */
import { isUnresolvedTableOccurrence, type FmObject, type SolutionModel } from "@/types/ddr";
import { occurrencesBeforeMissingField } from "@/core/identifiers";
import { buildDataSourceIndex, type DataSourceIndex } from "./dataSources";

/** The model's data-source → file mapping, built once per model (the same one
 * buildModel resolves references with). */
const sourceIndexCache = new WeakMap<SolutionModel, DataSourceIndex>();
function dataSourceIndexFor(model: SolutionModel): DataSourceIndex {
  let index = sourceIndexCache.get(model);
  if (!index) {
    index = buildDataSourceIndex(model.objects, model.files);
    sourceIndexCache.set(model, index);
  }
  return index;
}

/** Per-file occurrence index, lazily memoised on the model. Several call sites
 * iterate occurrences in the same file repeatedly (resolveQualifiedRef,
 * findMissingFieldOccurrences, refIndexFor, search's qualified-name matching) —
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

export type RefResolution =
  | { kind: "resolved"; to: FmObject; field: FmObject }
  | { kind: "external"; to: FmObject; fieldName: string } // TO is external; data-source file isn't loaded
  | { kind: "field-missing"; to: FmObject; fieldName: string } // TO known, field gone or unknown
  | { kind: "to-missing"; toName: string; fieldName: string }; // TO not in this file at all

/** Resolve a "TO::Field" label against the model, scoped to the file the
 * caller is rendering inside. Returns a discriminated union — see
 * RefResolution. */
export function resolveQualifiedRef(
  ref: string,
  model: SolutionModel,
  fileUid: string,
): RefResolution | null {
  const sep = ref.indexOf("::");
  if (sep < 0) return null;
  const toName = ref.slice(0, sep);
  const fieldName = ref.slice(sep + 2);
  const to = findOccurrenceByName(model, fileUid, toName);
  if (!to) return { kind: "to-missing", toName, fieldName };

  // An occurrence FileMaker couldn't resolve at export time can't be checked:
  // show it as external (not missing), like one whose file isn't loaded.
  if (isUnresolvedTableOccurrence(to)) return { kind: "external", to, fieldName };

  // External TO: the base table lives in the data-source file (found by
  // base-table UUID, path, or name). If that file isn't loaded we can't resolve
  // the field — but the TO itself is local and navigable, so callers can still
  // link it.
  let targetFileUid = fileUid;
  if (to.attributes.type === "External" || to.attributes.externalDataSource != null) {
    const match = dataSourceIndexFor(model).fileForOccurrence(to);
    if (!match) return { kind: "external", to, fieldName };
    targetFileUid = match;
  }

  const tableUid = `${targetFileUid}:table:${to.attributes.baseTableId}`;
  const field = model.objects.find(
    (o) => o.type === "field" && o.name === fieldName && o.parentUid === tableUid,
  );
  if (!field) return { kind: "field-missing", to, fieldName };
  return { kind: "resolved", to, field };
}

/** Find a TO in a given file by name. Backed by `occurrencesByFile` so repeat
 * lookups don't re-scan model.objects. */
function findOccurrenceByName(
  model: SolutionModel,
  fileUid: string,
  name: string,
): FmObject | null {
  for (const o of occurrencesByFile(model, fileUid)) {
    if (o.name === name) return o;
  }
  return null;
}


/**
 * For a calc body or step-params string that mentions a deleted field
 * (`Occ::<Field Missing>`), pull out the LONGEST real TO name from this file
 * whose name ends exactly at the `::` — handles multi-word names like
 * `Lager_aktuell neue Sorte` that a regex with `\s` in its exclude set would
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
