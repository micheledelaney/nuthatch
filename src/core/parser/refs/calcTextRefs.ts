import type { RawReference } from "@/types/ddr";
import type { ChunkContext } from "../context";
import { attr, child } from "../xmlUtils";
import { edgeKind } from "../refTags";
import {
  fieldNameCandidate,
  globalVariablesInText,
  isWordChar,
  longestNameAt,
  longestNameEndingAt,
  quotedGlobalVariables,
  skipWhitespace,
  stripLiteralsAndComments,
  type NameIndex,
} from "../calcText";
import { globalVariableRef, pushRef, type RefOwner, type ScanCtx } from "./refBuilders";

/**
 * Best-effort references from a formula's own text, for a calc whose chunk list
 * is unusable. String literals and comments are blanked first, and names are
 * matched whole against what the file defines:
 *   • `TO::Field` — the occurrence by the longest name before the `::`; for a
 *     local occurrence the field by the longest name after it, for an external
 *     one the field is resolved by name later (its table lives in another file).
 *   • Unqualified field names — only in a field's own calcs, where FileMaker
 *     writes same-table fields bare — against the calc's context table.
 *   • Custom-function calls and $$global variables.
 * Nothing found this way is ever reported broken: a name that doesn't match
 * simply isn't a reference.
 */
export function scanCalcTextRefs(
  chunks: ChunkContext,
  rawText: string,
  calc: Record<string, unknown>,
  owner: RefOwner,
  ctx: ScanCtx,
  out: RawReference[],
): void {
  const fromUid = owner.uid;
  const text = stripLiteralsAndComments(rawText);

  for (let pos = text.indexOf("::"); pos !== -1; pos = text.indexOf("::", pos + 2)) {
    const toName = longestNameEndingAt(text, pos, chunks.toNames);
    if (toName == null) continue;
    const to = chunks.toByName.get(toName);
    if (!to) continue;
    // As with a chunk list's field chunk, the occurrence is referenced too.
    pushRef(out, { fromUid, toType: "tableOccurrence", toId: to.id, toName, kind: edgeKind("tableOccurrence", ctx.stepName) }, ctx);
    if (to.localBaseTableId != null) {
      const fields = chunks.fieldsByTable.get(to.localBaseTableId);
      const field = fields ? longestNameAt(text, pos + 2, fields.index) : undefined;
      const fieldId = field != null ? fields?.idByName.get(field) : undefined;
      if (field != null && fieldId != null) {
        pushRef(out, { fromUid, toType: "field", toId: fieldId, toName: field, kind: "field", viaToId: to.id }, ctx);
      }
    } else if (to.external) {
      const candidate = fieldNameCandidate(text, pos + 2);
      if (candidate && !candidate.startsWith("<")) {
        pushRef(out, { fromUid, toType: "field", toId: "", toName: candidate, kind: "field", viaToId: to.id, byName: true }, ctx);
      }
    }
  }

  if (owner.type === "field") {
    const contextToId = attr(child(calc, "TableOccurrenceReference"), "id");
    const to = contextToId != null ? chunks.toById.get(contextToId) : undefined;
    const fields = to?.localBaseTableId != null ? chunks.fieldsByTable.get(to.localBaseTableId) : undefined;
    if (to && fields) {
      forEachBareName(text, fields.index, true, (name) => {
        const fieldId = fields.idByName.get(name);
        if (fieldId != null) pushRef(out, { fromUid, toType: "field", toId: fieldId, toName: name, kind: "field", viaToId: to.id }, ctx);
      });
    }
  }

  forEachBareName(text, chunks.cfIndex, false, (name) => {
    const cfId = chunks.cfByName.get(name);
    if (cfId != null) pushRef(out, { fromUid, toType: "customFunction", toId: cfId, toName: name, kind: "customFunction" }, ctx);
  });

  for (const name of [...globalVariablesInText(text), ...quotedGlobalVariables(rawText)]) {
    pushRef(out, globalVariableRef(fromUid, name), ctx);
  }
}

/** Every whole, unqualified occurrence of an indexed name in `text`: not part of
 * a longer word, not the field half of `TO::Field`, not a `$variable`, and not
 * itself an occurrence name (followed by `::`). With `notCall`, a name followed
 * by `(` is skipped too (that's a function, not a field). */
function forEachBareName(text: string, index: NameIndex, notCall: boolean, emit: (name: string) => void): void {
  for (let p = 0; p < text.length; p++) {
    if (!index.byFirst.has(text[p]!) || isWordChar(text[p - 1])) continue;
    if (text[p - 1] === "$" || text.startsWith("::", p - 2)) continue;
    const name = longestNameAt(text, p, index);
    if (name == null) continue;
    const after = skipWhitespace(text, p + name.length);
    if (!text.startsWith("::", after) && !(notCall && text.startsWith("(", after))) emit(name);
    p += name.length - 1;
  }
}
