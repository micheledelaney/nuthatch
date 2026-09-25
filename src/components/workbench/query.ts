import { OBJECT_TYPE_META, isBrokenTableOccurrence, objectLabel, type FmObject, type ObjectType, type SolutionModel } from "@/types/ddr";
import { isUnreferenced, matchesFieldFilter } from "@/components/browseA/filters";
import { brokenSourcesFor, refStatsFor } from "@/components/browseA/refStats";
import { ancestorsOf } from "./objectInfo";

/**
 * The command palette's query language: free text (fuzzy-matched against
 * object names) mixed with typed filter tokens:
 *   type:script   table:Invoices   table:"Line Items"   is:broken
 *   is:unreferenced  is:calc  is:unstored  is:global   refs>20  refs<1  refs=0
 * Several type: tokens OR together; everything else ANDs.
 */

export type IsFlag = "broken" | "unreferenced" | "calc" | "unstored" | "global";
export type RefsOp = ">" | "<" | ">=" | "<=" | "=";

export type Token =
  | { kind: "type"; type: ObjectType; raw: string }
  | { kind: "table"; value: string; raw: string }
  | { kind: "is"; flag: IsFlag; raw: string }
  | { kind: "refs"; op: RefsOp; n: number; raw: string };

const IS_FLAGS: ReadonlySet<string> = new Set<IsFlag>(["broken", "unreferenced", "calc", "unstored", "global"]);
/** Older spellings still accepted in queries. */
const IS_FLAG_ALIASES: Record<string, IsFlag> = { unused: "unreferenced" };

/** Short aliases on top of each type's key / label / plural. */
const EXTRA_TYPE_ALIASES: Record<string, ObjectType> = {
  s: "script",
  l: "layout",
  to: "tableOccurrence",
  tos: "tableOccurrence",
  occ: "tableOccurrence",
  occurrence: "tableOccurrence",
  cf: "customFunction",
  cfs: "customFunction",
  function: "customFunction",
  vl: "valueList",
  vls: "valueList",
  fld: "field",
  t: "table",
  bt: "table",
  rel: "relationship",
  rels: "relationship",
  acct: "account",
  ps: "privilegeSet",
  privset: "privilegeSet",
  xp: "extendedPrivilege",
  eds: "externalDataSource",
  cms: "customMenuSet",
  cm: "customMenu",
  menu: "customMenu",
  cmi: "customMenuItem",
  thm: "theme",
  gv: "globalVariable",
  var: "globalVariable",
  $$: "globalVariable",
  lo: "layoutObject",
  obj: "layoutObject",
};

const TYPE_ALIASES: ReadonlyMap<string, ObjectType> = (() => {
  const map = new Map<string, ObjectType>();
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  for (const [key, meta] of Object.entries(OBJECT_TYPE_META) as [ObjectType, { label: string; plural: string }][]) {
    map.set(key.toLowerCase(), key);
    map.set(`${key.toLowerCase()}s`, key);
    map.set(squash(meta.label), key);
    map.set(squash(meta.plural), key);
  }
  for (const [alias, type] of Object.entries(EXTRA_TYPE_ALIASES)) map.set(alias, type);
  return map;
})();

const REFS_RE = /^refs(>=|<=|>|<|=)(\d+)$/i;
const KV_RE = /^([a-z]+):(.+)$/i;
/** A word, or key:"quoted value" (quote must be closed to count as one word). */
const WORD_RE = /[a-z]+:"[^"]*"|\S+/gi;

/** Parse one word as a filter token, or null when it's plain search text. */
export function parseToken(word: string): Token | null {
  const refs = REFS_RE.exec(word);
  if (refs) return { kind: "refs", op: refs[1] as RefsOp, n: Number(refs[2]), raw: word };
  const kv = KV_RE.exec(word);
  if (!kv) return null;
  const key = kv[1]!.toLowerCase();
  let value = kv[2]!;
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return null;
    value = value.slice(1, -1);
  }
  if (!value) return null;
  if (key === "type") {
    const type = TYPE_ALIASES.get(value.toLowerCase());
    return type ? { kind: "type", type, raw: word } : null;
  }
  if (key === "table") return { kind: "table", value, raw: word };
  const flag = IS_FLAG_ALIASES[value.toLowerCase()] ?? value.toLowerCase();
  if (key === "is" && IS_FLAGS.has(flag)) {
    return { kind: "is", flag: flag as IsFlag, raw: word };
  }
  return null;
}

/** Split text into recognised tokens and the remaining free search text. When
 * `completedOnly`, only words followed by whitespace become tokens (so a
 * half-typed token stays editable in the input). */
export function tokenize(text: string, completedOnly = false): { tokens: Token[]; free: string } {
  const tokens: Token[] = [];
  const freeWords: string[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    const end = (m.index ?? 0) + word.length;
    const completed = end < text.length;
    const token = !completedOnly || completed ? parseToken(word) : null;
    if (token) tokens.push(token);
    else freeWords.push(word);
  }
  return { tokens, free: freeWords.join(" ") };
}

/** Human-readable chip text for a token. */
export function tokenLabel(t: Token): string {
  switch (t.kind) {
    case "type":
      return `type: ${OBJECT_TYPE_META[t.type].plural}`;
    case "table":
      return `table: ${t.value}`;
    case "is":
      return `is: ${t.flag}`;
    case "refs":
      return `refs ${t.op} ${t.n}`;
  }
}

function compareRefs(count: number, op: RefsOp, n: number): boolean {
  switch (op) {
    case ">":
      return count > n;
    case "<":
      return count < n;
    case ">=":
      return count >= n;
    case "<=":
      return count <= n;
    case "=":
      return count === n;
  }
}

function matchesTable(model: SolutionModel, o: FmObject, value: string): boolean {
  const needle = value.toLowerCase();
  const names = ancestorsOf(model, o).map((a) => a.name);
  if (o.attributes.baseTable) names.push(o.attributes.baseTable);
  if (o.attributes.tableOccurrence) names.push(o.attributes.tableOccurrence);
  return names.some((n) => n.toLowerCase().includes(needle));
}

/** `is:` flags, reusing the navigator's own health / field-kind tests so the
 * palette and the filter chips always agree. */
function matchesIs(model: SolutionModel, o: FmObject, flag: IsFlag): boolean {
  switch (flag) {
    case "broken":
      return brokenSourcesFor(model).has(o.uid) || isBrokenTableOccurrence(o);
    case "unreferenced":
      return isUnreferenced(model, o);
    case "calc":
      return o.type === "field" && matchesFieldFilter(o, "calculation");
    case "unstored":
      return o.type === "field" && matchesFieldFilter(o, "unstored");
    case "global":
      return (o.type === "field" && matchesFieldFilter(o, "global")) || o.type === "globalVariable";
  }
}

function matchesTokens(model: SolutionModel, o: FmObject, tokens: Token[], types: ReadonlySet<ObjectType>): boolean {
  if (types.size > 0 && !types.has(o.type)) return false;
  for (const t of tokens) {
    if (t.kind === "table" && !matchesTable(model, o, t.value)) return false;
    if (t.kind === "is" && !matchesIs(model, o, t.flag)) return false;
    if (t.kind === "refs" && !compareRefs(refStatsFor(model, o.uid).inbound, t.op, t.n)) return false;
  }
  return true;
}

/** Fuzzy score of `query` (lowercase) against `name`: contiguous substring
 * matches rank highest (earlier and on a word boundary is better), then
 * in-order subsequence matches with fewer gaps. -1 means no match. */
export function fuzzyScore(name: string, query: string): number {
  if (!query) return 0;
  const hay = name.toLowerCase();
  const idx = hay.indexOf(query);
  if (idx >= 0) {
    const boundary = idx === 0 || /[\s_\-.:/]/.test(hay[idx - 1] ?? "");
    return 1000 - idx * 2 - (hay.length - query.length) * 0.5 + (idx === 0 ? 200 : 0) + (boundary ? 100 : 0);
  }
  let gaps = 0;
  let last = -1;
  for (const ch of query) {
    if (ch === " ") continue;
    const next = hay.indexOf(ch, last + 1);
    if (next < 0) return -1;
    if (last >= 0) gaps += next - last - 1;
    last = next;
  }
  return 500 - gaps * 3 - (hay.length - query.length) * 0.5;
}

export interface PaletteResult {
  obj: FmObject;
  score: number;
}

/** Run a palette query: filter by tokens, fuzzy-rank by free text. */
export function runQuery(model: SolutionModel, tokens: Token[], free: string, limit: number): { results: PaletteResult[]; total: number } {
  const q = free.trim().toLowerCase();
  const types = new Set(tokens.flatMap((t) => (t.kind === "type" ? [t.type] : [])));
  const hits: PaletteResult[] = [];
  for (const o of model.objects) {
    if (o.isSeparator) continue;
    if (!matchesTokens(model, o, tokens, types)) continue;
    const score = fuzzyScore(objectLabel(o), q);
    if (score < 0) continue;
    hits.push({ obj: o, score });
  }
  hits.sort((a, b) => b.score - a.score || a.obj.name.localeCompare(b.obj.name));
  return { results: hits.slice(0, limit), total: hits.length };
}
