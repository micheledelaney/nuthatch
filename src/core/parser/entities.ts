const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode XML/HTML entities for display. FileMaker stores `&` as `&amp;`, emoji
 * as numeric references (e.g. &#128512;), etc., and we parse with entity
 * expansion disabled. Control characters (CR/LF/Tab) become spaces so inline
 * text doesn't break apart — except CR and LF with `keepLineBreaks`, which
 * become newlines (rendered step text).
 *
 * **Policy.** Decode once, at the boundary between parsed XML and stored
 * model: the parser decodes every name, label, and attribute value — and the
 * rendered script-step text (stepParams, which keeps `&#13;` as newlines) —
 * before writing it into `FmObject.name`, `attributes`, or `detail`. Read
 * them through `textAttr` (an attribute) and `displayText` (an element's
 * text), the two decoding readers. UI components treat strings off the model
 * as already-decoded and never call decodeEntities a second time: a second
 * pass turns a literal `&amp;` in a name into `&`. That includes
 * `FmObject.text`, the search index (`displayText` of the object's XML), which
 * search shows snippets of. The text-based reference passes read `cdataText`
 * instead — CDATA only, where placeholders and merge fields appear as written.
 *
 * CDATA is never decoded: its content is literal text. The XML parser keeps it
 * under its own key (CDATA_KEY), so `displayText` decodes only character data.
 * Calculation formulas are always CDATA, so calculationText returns them
 * verbatim (`detail.body`, and calc-valued attributes such as
 * `validationCalculation`, `installCondition`, `hideWhen`, `tooltip`), as are
 * layout text and labels (`<Data>`). Decoding one would corrupt a formula that
 * builds HTML or XML (`"&amp;"` would read as `"&"`).
 */
export function decodeEntities(input: string, keepLineBreaks = false): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return whole;
      return charForCode(code, keepLineBreaks) ?? whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The text for a character code: a control character is a space, or with
 * `keepLineBreaks` CR and LF are a newline; undefined for a code that names no
 * character. */
export function charForCode(code: number, keepLineBreaks: boolean): string | undefined {
  if (keepLineBreaks && (code === 13 || code === 10)) return "\n";
  if (code < 0x20) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}
