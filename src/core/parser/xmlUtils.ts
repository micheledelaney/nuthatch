/** Helpers for navigating the loosely-typed object tree from fast-xml-parser. */

import { decodeEntities } from "./entities";

export const ATTR_PREFIX = "@_";

/** Where the parser puts an element's CDATA content (kept apart from its other
 * character data, `#text`, so CDATA can be read verbatim and only the rest
 * entity-decoded). */
export const CDATA_KEY = "#cdata";

/** Coerce a fast-xml-parser node (single | array | undefined) into an array. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read an attribute (prefixed by ATTR_PREFIX) as a string, or undefined. */
export function attr(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) return undefined;
  const raw = node[ATTR_PREFIX + name];
  return raw == null ? undefined : String(raw);
}

/** Read an attribute that holds text for people — a name, label, file name —
 * entity-decoded (the parser runs with entity expansion off), or undefined.
 * Ids, flags and other machine values are read with `attr`. */
export function textAttr(node: unknown, name: string): string | undefined {
  const raw = attr(node, name);
  return raw == null ? undefined : decodeEntities(raw);
}

/** Collect every attribute on a node into a plain string map, entity-decoded
 * (the parser runs with entity expansion off). */
export function attributes(node: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith(ATTR_PREFIX) && v != null) {
      out[k.slice(ATTR_PREFIX.length)] = decodeEntities(String(v).trim());
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object-tree key names a child element — not an attribute or the
 * node's own text or CDATA. */
export function isElementKey(key: string): boolean {
  return !key.startsWith(ATTR_PREFIX) && key !== "#text" && key !== CDATA_KEY;
}

/** A node's own text — its CDATA and character data, not its children's —
 * verbatim, "" when it has none. */
export function ownText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!isRecord(node)) return "";
  return [cdataText(node[CDATA_KEY]), node["#text"] == null ? "" : String(node["#text"])].join("");
}

/** The content of a CDATA value: a node with several CDATA sections gets them
 * as an array, which read as one run of text. */
function cdataText(value: unknown): string {
  if (value == null) return "";
  return Array.isArray(value) ? value.join("") : String(value);
}

/** The first `key` child element of a node (fast-xml-parser gives a single
 * child as a value and several as an array), or undefined. */
export function child(node: unknown, key: string): unknown {
  return isRecord(node) ? asArray(node[key])[0] : undefined;
}

/** Every `key` child element of a node. */
export function children(node: unknown, key: string): unknown[] {
  return isRecord(node) ? asArray(node[key]) : [];
}

/** The text of a node's <UUID> child, "" when there's none. FileMaker writes
 * it bare (`<UUID>guid</UUID>`, on steps and layout objects) or carrying
 * modification attributes (`<UUID userName … >guid</UUID>`). */
export function uuidText(node: unknown): string {
  const uuid = child(node, "UUID");
  const text = isRecord(uuid) ? uuid["#text"] : uuid;
  return text == null ? "" : String(text).trim();
}

/** A copy of `node` without its `key` child. */
export function withoutKey<V>(node: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _omitted, ...rest } = node;
  return rest;
}

/** The first `tag` element anywhere under `node` (that `accept` takes, when
 * given), depth-first, checking a node's own children before descending. */
export function findElement(node: unknown, tag: string, accept?: (el: unknown) => boolean): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, tag, accept);
      if (found != null) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  const own = accept ? asArray(node[tag]).find(accept) : asArray(node[tag])[0];
  if (own != null) return own;
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    const found = findElement(value, tag, accept);
    if (found != null) return found;
  }
  return undefined;
}

/** Every `tag` element anywhere under `node`. */
export function collectElements(node: unknown, tag: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, tag, out);
    return out;
  }
  if (!isRecord(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    if (key === tag) {
      for (const el of asArray(value)) if (isRecord(el)) out.push(el);
    }
    collectElements(value, tag, out);
  }
  return out;
}

/** The labels of the `[attribute, label]` pairs whose attribute is "True" on
 * `node`, in list order. */
export function enabledLabels(node: unknown, pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.filter(([name]) => attr(node, name) === "True").map(([, label]) => label);
}

/**
 * Recursively gather all human-readable text from a node: text nodes and the
 * values of `name`/calculation-bearing attributes. Used to build the full-text
 * search index and to detect global variables.
 */
export function collectText(node: unknown): string {
  const out: string[] = [];
  gatherText(node, out, false);
  return out.join(" ");
}

/** The text under a node for display — a description, comment, label — gathered
 * like collectText but entity-decoded (the parser runs with entity expansion
 * off) and trimmed. CDATA stays verbatim: its content is literal text, so
 * decoding it would turn a typed `&amp;` into `&`. */
export function displayText(node: unknown): string {
  const out: string[] = [];
  gatherText(node, out, true);
  return out.join(" ").trim();
}

/** Recursive accumulator for collectText / displayText. Pushes fragments into
 * `out` and joins only once — joining at every recursive call (as an earlier
 * version did) is O(n²) and, on the largest layouts, allocates gigabytes of
 * discarded intermediate strings. */
function gatherText(node: unknown, out: string[], decode: boolean): void {
  if (node == null) return;
  if (typeof node === "string" || typeof node === "number") {
    pushText(out, String(node), decode);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) gatherText(item, out, decode);
    return;
  }
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      // A DDRREF is an internal content-chunk pointer (e.g. `_77C7BC7B…`) that
      // FileMaker regenerates on every export — not human content. Skipping it
      // keeps it out of the search index and out of diffs (where an otherwise
      // identical object would otherwise show as "changed" on the hash alone).
      if (key === "DDRREF") continue;
      // The per-object <UUID modifications userName accountName timestamp>guid</UUID>
      // wrapper is identity/modification-tracking metadata, not content — makeObject's
      // uuidMeta already lifts it onto obj.attributes (uuid, lastModifiedBy/
      // Account/At, modifications), where it's excluded from diffs unless opted in.
      // Left in here, its raw guid text leaks into obj.text uncontrolled by that
      // option: an object modified on only one side (i.e. one side's <UUID> has no
      // text, the other does) would otherwise diff as "changed" on whitespace alone
      // once the stray guid is stripped back out downstream.
      if (key === "UUID") continue;
      if (key === CDATA_KEY) {
        pushText(out, cdataText(value), false);
      } else if (key === ATTR_PREFIX + "name" || key === "#text") {
        pushText(out, String(value), decode);
      } else if (!key.startsWith(ATTR_PREFIX)) {
        gatherText(value, out, decode);
      }
    }
  }
}

function pushText(out: string[], raw: string, decode: boolean): void {
  // Whitespace-only fragments are XML pretty-print indentation, not content —
  // and untrimmed edges (e.g. a trailing space or CR on a name/text value)
  // would otherwise make two visually-identical objects diff as "changed".
  const text = raw.trim();
  if (text) out.push(decode ? decodeEntities(text) : text);
}
