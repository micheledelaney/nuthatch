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
 * text doesn't break apart.
 *
 * **Policy.** Decode once, at the boundary between parsed XML and stored
 * model: the parser decodes every name, label, and attribute value — and the
 * rendered script-step text (stepParams, which keeps `&#13;` as newlines) —
 * before writing it into `FmObject.attributes`, `text`, or `detail`. UI
 * components should treat strings off the model as already-decoded and not
 * call decodeEntities a second time: a second pass turns a literal `&amp;` in
 * a name into `&`.
 *
 * Calculation formulas are the exception that needs no decoding at all: every
 * export writes them as CDATA, so calculationText returns them verbatim
 * (`detail.body`, and calc-valued attributes such as `validationCalculation`,
 * `installCondition`, `hideWhen`, `tooltip`). Decoding one would corrupt a
 * formula that builds HTML or XML (`"&amp;"` would read as `"&"`).
 */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return whole;
      if (code < 0x20) return " ";
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
