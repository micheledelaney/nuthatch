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
 * model: parser-side annotators decode names / display strings before writing
 * them into `FmObject.attributes`, `text`, or `detail`. UI components should
 * treat strings off the model as already-decoded and not call decodeEntities
 * a second time. The exception is raw chunks the parser routes through with
 * entities intact (e.g. step-text bodies that mix `&#13;` newlines with named
 * entities) — those decode at the rendering site that knows the semantics.
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
