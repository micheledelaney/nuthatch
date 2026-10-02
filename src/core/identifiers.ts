/**
 * One source of truth for "what counts as part of a name" in FileMaker text.
 *
 * Three different rules show up across the parser and the UI:
 *
 *   • Calc identifier character (isNameChar): the chars that can appear inside
 *     a calculation identifier — letters and digits of any script, `_`, `.`,
 *     `~`. Used wherever a known name is matched whole in calc text: by the
 *     parser (calcText, the missing-field pass) and by refResolution, which
 *     must agree on where a multi-word TO or field name begins and ends.
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
 * quote forms) localised to a single edit. The placeholder tokens themselves
 * are the parser's (core/parser/sentinels).
 */

import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "@/core/parser/sentinels";

/** Chars that can appear inside a calculation identifier (calc body / step
 * params). A char NOT in this set is a name boundary — so `Größe` never
 * matches inside `NeueGröße`. */
const CALC_NAME_CHAR_RE = /[\p{L}\p{N}_.~]/u;

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
export const BROKEN_PLACEHOLDER_RE: RegExp = new RegExp(String.raw`<[^<>]*\bMissing\b[^<>]*>|${UNKNOWN_TARGET}`, "g");

/** The longest name in `names` that ends exactly at `end` (e.g. the occurrence
 * before a `::`) and starts at a name boundary. Multi-word names (with spaces,
 * e.g. `Stock_current new Item`) are matched whole, which a delimiter-based
 * regex would truncate. */
export function longestNameEndingAt(text: string, end: number, names: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (best != null && best.length >= name.length) continue;
    if (name.length > end || !text.startsWith(name, end - name.length)) continue;
    if (isNameChar(text[end - name.length - 1])) continue;
    best = name;
  }
  return best;
}

/** The longest name in `names` that is a prefix of `candidate` at a name
 * boundary — how a name-based field reference picks its field. */
export function longestPrefixName(candidate: string, names: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (!name || (best != null && best.length >= name.length)) continue;
    if (candidate.startsWith(name) && !isNameChar(candidate[name.length])) best = name;
  }
  return best;
}

/**
 * For each `<Field Missing>` in `text`, in document order: the longest name in
 * `names` that ends exactly at the `::` before it (see longestNameEndingAt), or
 * undefined when the placeholder is bare or follows a name `names` doesn't hold.
 */
export function* missingFieldOccurrences(text: string, names: readonly string[]): Generator<string | undefined> {
  for (let pos = text.indexOf(MISSING_FIELD_TOKEN); pos !== -1; pos = text.indexOf(MISSING_FIELD_TOKEN, pos + 1)) {
    yield text.endsWith("::", pos) ? longestNameEndingAt(text, pos - 2, names) : undefined;
  }
}

/**
 * For each `Occ::<Field Missing>` position in `text`, yield the longest name in
 * `names` that ends exactly at the `::` (see longestNameEndingAt). Names are
 * yielded one per matching position, in document order; callers map each to an
 * id or object and de-duplicate as needed.
 */
export function* occurrencesBeforeMissingField(text: string, names: Iterable<string>): Generator<string> {
  if (!text.includes(MISSING_FIELD_TOKEN)) return;
  for (const name of missingFieldOccurrences(text, [...names])) if (name != null) yield name;
}
