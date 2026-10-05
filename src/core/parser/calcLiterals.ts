/** A formula's typed text — its string literals and comments — as opposed to
 * its code. No imports, so xmlUtils can use it too (via passwords.ts). */

/** Where the string literal ("…", with \" escapes) or comment (/* … *\/, or //
 * to the end of the line) that starts at `i` ends — the end of the text when
 * it isn't closed; `i` when none starts there. */
export function inertEnd(text: string, i: number): number {
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, text.length);
  }
  if (text[i] === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (text[i] === "/" && text[i + 1] === "/") {
    let j = i;
    while (j < text.length && text[j] !== "\r" && text[j] !== "\n") j++;
    return j;
  }
  return i;
}

/** A formula's string literals and comments, as written. */
export function inertSpans(formula: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < formula.length; ) {
    const end = inertEnd(formula, i);
    if (end === i) {
      i++;
      continue;
    }
    out.push(formula.slice(i, end));
    i = end;
  }
  return out;
}
