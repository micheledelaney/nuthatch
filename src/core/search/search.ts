import type { FmObject, ObjectType, SolutionModel } from "@/types/ddr";
import { occurrencesByFile } from "@/core/model/refResolution";

export interface SearchHit {
  object: FmObject;
  /** Where the query matched: the object name or its body text. */
  matchedIn: "name" | "text";
  /** A short excerpt around the match (for text matches). */
  snippet: string;
}

const SNIPPET_RADIUS = 40;

/**
 * Full-text search across object names and bodies. Name matches rank
 * above body matches. Results are not capped here — callers narrow further
 * (e.g. the navigator's reference/type filters) and the navigator's per-group
 * render limits keep display bounded; capping here would truncate matches
 * before those filters run and silently drop valid results.
 *
 * A query containing `::` is additionally tried as a fully-qualified
 * FileMaker field name (`TableOccurrence::FieldName`) against field objects —
 * field objects only store their bare name, so a plain substring match can't
 * disambiguate same-named fields across table occurrences.
 */
export function search(
  model: SolutionModel,
  query: string,
  typeFilter?: ObjectType | "all",
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const sep = q.indexOf("::");
  const toQuery = sep >= 0 ? q.slice(0, sep) : null;
  const fieldQuery = sep >= 0 ? q.slice(sep + 2) : null;

  const nameHits: SearchHit[] = [];
  const textHits: SearchHit[] = [];

  for (const obj of model.objects) {
    if (obj.isSeparator) continue;
    if (typeFilter && typeFilter !== "all" && obj.type !== typeFilter) continue;

    if (toQuery !== null && obj.type === "field" && matchesQualifiedName(model, obj, toQuery, fieldQuery ?? "")) {
      nameHits.push({ object: obj, matchedIn: "name", snippet: obj.name });
      continue;
    }

    const nameIdx = obj.name.toLowerCase().indexOf(q);
    if (nameIdx >= 0) {
      nameHits.push({ object: obj, matchedIn: "name", snippet: obj.name });
      continue;
    }
    const textIdx = obj.text.toLowerCase().indexOf(q);
    if (textIdx >= 0) {
      textHits.push({ object: obj, matchedIn: "text", snippet: excerpt(obj.text, textIdx, q.length) });
    }
  }

  return [...nameHits, ...textHits];
}

/** True if `field` is exposed under a table occurrence whose name contains
 * `toQuery` and the field's own name contains `fieldQuery` (case-insensitive
 * substrings, matching the plain-search behavior above). Scoped to
 * occurrences in the field's own file, same as `resolveQualifiedRef`. */
function matchesQualifiedName(model: SolutionModel, field: FmObject, toQuery: string, fieldQuery: string): boolean {
  if (!field.name.toLowerCase().includes(fieldQuery)) return false;
  const table = field.parentUid ? model.byUid.get(field.parentUid) : undefined;
  if (!table) return false;
  return occurrencesByFile(model, table.fileUid).some(
    (occ) => occ.attributes.baseTableId === table.id && occ.name.toLowerCase().includes(toQuery),
  );
}

function excerpt(text: string, idx: number, matchLen: number): string {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + matchLen + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).trim() + suffix;
}
