/**
 * One source of truth for "what counts as part of a name" in FileMaker text.
 *
 * Three different rules show up across the parser and the UI:
 *
 *   • Calc identifier character (CALC_NAME_CHAR / isNameChar): the chars that
 *     can appear inside a calculation identifier — letters, digits, `_`, `.`,
 *     `~`. Used to decide where a multi-word TO or field name *ends* when
 *     walking calc text backwards.
 *
 *   • Inline-link token boundary (isWordChar): the chars between which an
 *     object name is matched as a whole token in rendered text (calc bodies,
 *     step params). Looser — letters, digits, etc. — but explicitly excludes
 *     ASCII *and* the curly quotes FileMaker wraps script/layout/file names
 *     in inside DDR_INFO StepText.
 *
 *   • Placeholder pattern (BROKEN_PLACEHOLDER_RE): the literal `<… Missing …>`
 *     / `<unknown>` tokens FileMaker writes wherever a reference was deleted
 *     out from under the export.
 *
 * Importing from one place keeps quirks (new placeholder shapes, additional
 * quote forms) localised to a single edit.
 */

/** Chars that can appear inside a calculation identifier (calc body / step
 * params). A char NOT in this set is a name boundary. */
const CALC_NAME_CHAR_RE = /[A-Za-z0-9_.~]/;

export function isNameChar(c: string | undefined): boolean {
  return c != null && CALC_NAME_CHAR_RE.test(c);
}

/** Chars that are part of an inline-linkable token in rendered display text.
 * Looser than isNameChar — accepts most non-ASCII letters — but explicitly
 * excludes ASCII quotes plus FileMaker's curly quotes (U+201C/D, U+2018/9),
 * which wrap layout/script/file names in DDR_INFO StepText. Used by
 * LinkedCode to test the chars immediately before and after a candidate. */
const INLINE_TOKEN_CHAR_RE = /[^\s"'‘’“”$:=≠≤≥<>+\-*/&;,(){}[\]]/u;

export function isWordChar(c: string | undefined): boolean {
  return c != null && INLINE_TOKEN_CHAR_RE.test(c);
}

/** FileMaker writes literal placeholder tokens like `<Table Missing>`,
 * `<Field Missing>`, or `<unknown>` wherever something was deleted out from
 * under a reference. Use the `g` flag in callers (`new RegExp(BROKEN_PLACEHOLDER_RE.source, "g")`)
 * for global scans, or use the `.test()` form on the source-shared regex. */
export const BROKEN_PLACEHOLDER_RE: RegExp = /<[^<>]*\bMissing\b[^<>]*>|<unknown>/g;

/** The "::<Field Missing>" suffix scanned in calc bodies / step params when
 * the field has been deleted but the occurrence is still nameable. */
export const FIELD_MISSING_QUALIFIED = "::<Field Missing>";

/**
 * For each `Occ::<Field Missing>` position in `text`, yield the LONGEST name in
 * `names` that ends exactly at the `::`. Multi-word TO names (containing spaces,
 * e.g. `Lager_aktuell neue Sorte`) are handled — a regex class excluding `\s`
 * would truncate them — and the char before the candidate is checked so a longer
 * surrounding identifier isn't matched (e.g. `neueSorte` won't match `Sorte`).
 *
 * Names are yielded one per matching position, in document order; callers map
 * each to an id or object and de-duplicate as needed. Shared by the parser
 * (parse time, names from the raw occurrence list) and refResolution (UI time,
 * names from the model), so this scan lives in exactly one place.
 */
export function* occurrencesBeforeMissingField(
  text: string,
  names: Iterable<string>,
): Generator<string> {
  if (!text.includes(FIELD_MISSING_QUALIFIED)) return;
  const list = [...names];
  for (
    let pos = text.indexOf(FIELD_MISSING_QUALIFIED);
    pos !== -1;
    pos = text.indexOf(FIELD_MISSING_QUALIFIED, pos + FIELD_MISSING_QUALIFIED.length)
  ) {
    let best: string | undefined;
    for (const name of list) {
      if (best != null && best.length >= name.length) continue;
      if (name.length > pos) continue;
      if (text.slice(pos - name.length, pos) !== name) continue;
      if (isNameChar(text[pos - name.length - 1])) continue;
      best = name;
    }
    if (best != null) yield best;
  }
}
