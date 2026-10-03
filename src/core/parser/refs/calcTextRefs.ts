import type { FileParse } from "../context";
import { attr, child } from "../xmlUtils";
import {
  fieldNameCandidate,
  globalVariablesInText,
  longestNameAt,
  quotedGlobalVariables,
  skipWhitespace,
  stripComments,
  stripLiteralsAndComments,
  type NameIndex,
} from "../calcText";
import { isNameChar, longestNameEndingAt } from "@/core/identifiers";
import { localBaseTableId } from "../occurrences";
import { customFunctionRef, globalVariableRef, pushRef, type RefOwner, type ScanContext } from "./refBuilders";

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
export function scanCalcTextRefs(fp: FileParse, rawText: string, calc: Record<string, unknown>, owner: RefOwner, ctx: ScanContext): void {
  const text = stripLiteralsAndComments(rawText);
  addQualifiedFieldRefs(fp, text, owner, ctx);
  if (owner.type === "field") addBareFieldRefs(fp, text, calc, owner, ctx);
  forEachBareName(text, fp.index.cfIndex, false, (name) => {
    const cfId = fp.index.cfByName.get(name);
    if (cfId != null) pushRef(fp.references, customFunctionRef(owner.uid, cfId, name), ctx);
  });
  // A name passed as a string literal counts, but not one in a comment: the
  // chunk list makes a comment a chunk of its own, never scanned for globals.
  for (const name of [...globalVariablesInText(text), ...quotedGlobalVariables(stripComments(rawText))]) {
    pushRef(fp.references, globalVariableRef(owner.uid, name), ctx);
  }
}

/** Every `TO::Field` in the (literal-free) text: the occurrence, and the field
 * it reads (by id for a local occurrence, by name for an external one). */
function addQualifiedFieldRefs(fp: FileParse, text: string, owner: RefOwner, ctx: ScanContext): void {
  const { index, references: out } = fp;
  const fromUid = owner.uid;
  for (let pos = text.indexOf("::"); pos !== -1; pos = text.indexOf("::", pos + 2)) {
    const toName = longestNameEndingAt(text, pos, index.toNames);
    if (toName == null) continue;
    const to = index.toByName.get(toName);
    if (!to) continue;
    // As with a chunk list's field chunk, the occurrence is referenced too.
    pushRef(out, { fromUid, toType: "tableOccurrence", toId: to.id, toName, kind: "tableOccurrence" }, ctx);
    const baseTableId = localBaseTableId(to);
    if (baseTableId != null) {
      const fields = index.fieldsByTable.get(baseTableId);
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
}

/** A field calc's unqualified same-table field names, against the calc's
 * context occurrence's base table. */
function addBareFieldRefs(fp: FileParse, text: string, calc: Record<string, unknown>, owner: RefOwner, ctx: ScanContext): void {
  const contextToId = attr(child(calc, "TableOccurrenceReference"), "id");
  const to = contextToId != null ? fp.index.toById.get(contextToId) : undefined;
  const baseTableId = to ? localBaseTableId(to) : undefined;
  const fields = baseTableId != null ? fp.index.fieldsByTable.get(baseTableId) : undefined;
  if (!to || !fields) return;
  forEachBareName(text, fields.index, true, (name) => {
    const fieldId = fields.idByName.get(name);
    if (fieldId != null) pushRef(fp.references, { fromUid: owner.uid, toType: "field", toId: fieldId, toName: name, kind: "field", viaToId: to.id }, ctx);
  });
}

/** Every whole, unqualified occurrence of an indexed name in `text`: not part of
 * a longer word, not the field half of `TO::Field`, not a `$variable`, and not
 * itself an occurrence name (followed by `::`). With `notCall`, a name followed
 * by `(` is skipped too (that's a function, not a field). */
function forEachBareName(text: string, index: NameIndex, notCall: boolean, emit: (name: string) => void): void {
  for (let p = 0; p < text.length; p++) {
    if (!index.byFirst.has(text[p]!) || isNameChar(text[p - 1])) continue;
    if (text[p - 1] === "$" || text.startsWith("::", p - 2)) continue;
    const name = longestNameAt(text, p, index);
    if (name == null) continue;
    const after = skipWhitespace(text, p + name.length);
    if (!text.startsWith("::", after) && !(notCall && text.startsWith("(", after))) emit(name);
    p += name.length - 1;
  }
}
