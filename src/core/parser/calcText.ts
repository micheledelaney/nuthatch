import { asArray, attr, isRecord } from "./xmlUtils";
import { decodeEntities } from "./entities";

/**
 * Helpers for a calculation's own text, used when its DDR_INFO chunk list can't
 * be trusted:
 *
 *   • FileMaker writes an EMPTY chunk list for any calc that mentions a
 *     `<Field Missing>` / `<Table Missing>` — dropping every other (valid)
 *     reference in that calc along with the dead one.
 *   • Chunk-list pointers are `_<owner UUID>_<suffix>`. Objects without a UUID
 *     (common on layout objects and in older exports) all produce the same
 *     pointer (`__0`, `__Condition_1`, …), and DDR_INFO keeps one block per
 *     pointer — so every sharer after the first would pick up someone else's
 *     references.
 *
 * `chunkListMatchesText` detects both cases; `scanCalcText` then recovers the
 * references from the formula text itself (a best-effort scan against the
 * file's known occurrence, field, and custom-function names).
 */

/** Characters that continue a name: a known name only matches when the chars
 * just outside it are not one of these (so `xName` never matches `Name`). */
const WORD_CHAR_RE = /[\p{L}\p{N}_.~]/u;

export function isWordChar(c: string | undefined): boolean {
  return c != null && WORD_CHAR_RE.test(c);
}

function squash(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** Operator / punctuation characters FileMaker sometimes leaves out of a chunk
 * list (the separator before a comment, the `=` before a plugin function). */
const SKIPPABLE_CHARS = new Set([..."();=&+-*/^,[]≠≤≥<>:¶"]);

/**
 * Whether a chunk list is the tokenization of `calcText`. The chunks concatenate
 * back into the formula — text chunks verbatim, field chunks as `TO::Field` or a
 * bare `Field` — so compare the two with whitespace removed (fast-xml-parser
 * trims chunk text, and CR/LF entities differ between the two encodings) and
 * case folded (chunks carry FileMaker's canonical spelling of a function name,
 * e.g. `CurrentTimestamp`, the text whatever the developer typed). The chunk
 * list isn't quite lossless — the separator before a comment can be missing —
 * so stray punctuation in the text between chunks is tolerated; any word
 * characters that don't line up are a mismatch.
 */
export function chunkListMatchesText(chunkList: unknown, calcText: string): boolean {
  const chunks = asArray(isRecord(chunkList) ? chunkList["Chunk"] : undefined);
  const target = squash(calcText);
  if (chunks.length === 0) return target === "";
  let pos = 0;
  // Advance past skippable characters until `piece` starts at the cursor.
  const consume = (piece: string): boolean => {
    let p = pos;
    while (!target.startsWith(piece, p)) {
      if (p >= target.length || !SKIPPABLE_CHARS.has(target[p]!)) return false;
      p++;
    }
    pos = p + piece.length;
    return true;
  };
  for (const chunk of chunks) {
    if (!isRecord(chunk)) {
      if (!consume(squash(decodeEntities(String(chunk))))) return false;
      continue;
    }
    const fieldRef = asArray(chunk["FieldReference"])[0];
    if (isRecord(fieldRef)) {
      const field = squash(decodeEntities(attr(fieldRef, "name") ?? ""));
      const to = squash(decodeEntities(attr(asArray(fieldRef["TableOccurrenceReference"])[0], "name") ?? ""));
      if (!(to && consume(`${to}::${field}`)) && !consume(field)) return false;
      continue;
    }
    const raw = chunk["#text"];
    if (!consume(squash(decodeEntities(typeof raw === "string" ? raw : "")))) return false;
  }
  for (; pos < target.length; pos++) if (!SKIPPABLE_CHARS.has(target[pos]!)) return false;
  return true;
}

/** Blank out string literals ("…", with \" escapes) and comments (/* … *\/ and
 * // to end of line), keeping every other character at its position, so names
 * inside them are never mistaken for references. */
export function stripLiteralsAndComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += " ".repeat(Math.min(j + 1, text.length) - i);
      i = j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\r" && text[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Candidate names grouped by first character, longest first, for fast
 * longest-match lookups at a position. */
export interface NameIndex {
  byFirst: Map<string, string[]>;
}

export function makeNameIndex(names: Iterable<string>): NameIndex {
  const byFirst = new Map<string, string[]>();
  for (const name of names) {
    if (!name) continue;
    const list = byFirst.get(name[0]!) ?? [];
    list.push(name);
    byFirst.set(name[0]!, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);
  return { byFirst };
}

/** The longest indexed name starting exactly at `pos` and ending at a name
 * boundary, or undefined. */
export function longestNameAt(text: string, pos: number, index: NameIndex): string | undefined {
  for (const name of index.byFirst.get(text[pos] ?? "") ?? []) {
    if (text.startsWith(name, pos) && !isWordChar(text[pos + name.length])) return name;
  }
  return undefined;
}

/** The longest name in `names` that ends exactly at `end` (e.g. the occurrence
 * before a `::`) and starts at a name boundary. Multi-word names (with spaces)
 * are matched whole, which a delimiter-based regex would truncate. */
export function longestNameEndingAt(text: string, end: number, names: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (best != null && best.length >= name.length) continue;
    if (name.length > end) continue;
    if (text.slice(end - name.length, end) !== name) continue;
    if (isWordChar(text[end - name.length - 1])) continue;
    best = name;
  }
  return best;
}

/** Everything after a `::` up to the next operator/delimiter: the raw span a
 * field name must be a prefix of (resolved later against the real field names
 * of an occurrence whose base table lives in another file). */
export function fieldNameCandidate(text: string, start: number): string {
  const m = /^[^;()[\]{}&=≠<>≤≥+\-*/^,¶"\r\n:]*/u.exec(text.slice(start));
  return (m?.[0] ?? "").trim();
}

/** The longest name in `names` that is a prefix of `candidate` at a name
 * boundary — how a name-based field reference picks its field. */
export function longestPrefixName(candidate: string, names: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    if (!name || (best != null && best.length >= name.length)) continue;
    if (candidate.startsWith(name) && !isWordChar(candidate[name.length])) best = name;
  }
  return best;
}

/** `$$names` passed by name as a whole string literal — `Map.Clear ( "$$_CMAP" )`,
 * `Evaluate ( "$$x" )`, the usual way globals are handled dynamically. A string
 * with anything else in it ("$$x is: ") isn't counted, which also means a
 * multi-word name passed this way is missed. */
export function quotedGlobalVariables(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"(\$\$[^\s"¶\\:;,()]+)"/g)) out.push(m[1]!);
  return out;
}

const KEYWORD_RE = /^(?:and|or|xor|not)$/i;

/**
 * `$$global` names in a formula. FileMaker allows spaces inside variable names
 * (`$$_Leitweg ID`), so a following word is part of the name unless it's an
 * operator keyword or begins a function call / qualified field reference.
 * Only used for calcs whose chunk list is unusable — normally the exact
 * `VariableReference` chunks are read instead.
 */
export function globalVariablesInText(text: string): string[] {
  const out: string[] = [];
  const re = /\$\$[^\s"$=≠≤≥<>+\-*/&;,(){}[\]^¶:]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let name = m[0];
    let end = m.index + name.length;
    for (;;) {
      const next = /^ ([^\s"$=≠≤≥<>+\-*/&;,(){}[\]^¶:]+)/u.exec(text.slice(end));
      if (!next) break;
      const word = next[1]!;
      const after = text.slice(end + next[0].length).trimStart();
      if (KEYWORD_RE.test(word) || after.startsWith("(") || after.startsWith("::")) break;
      name += next[0];
      end += next[0].length;
    }
    out.push(name);
    re.lastIndex = end;
  }
  return out;
}
