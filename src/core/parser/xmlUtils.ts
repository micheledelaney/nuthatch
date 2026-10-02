/** Helpers for navigating the loosely-typed object tree from fast-xml-parser. */

import { decodeEntities } from "./entities";

export const ATTR_PREFIX = "@_";

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
 * node's own text. */
export function isElementKey(key: string): boolean {
  return !key.startsWith(ATTR_PREFIX) && key !== "#text";
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

/** A copy of `node` without its `key` child. */
export function withoutKey<V>(node: Record<string, V>, key: string): Record<string, V> {
  const { [key]: _omitted, ...rest } = node;
  return rest;
}

/** The first `tag` element anywhere under `node`, depth-first, checking a node's
 * own children before descending. */
export function findElement(node: unknown, tag: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, tag);
      if (found != null) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  if (node[tag] != null) return asArray(node[tag])[0];
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    const found = findElement(value, tag);
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
export function collectText(node: unknown, out: string[] = []): string {
  gatherText(node, out);
  return out.join(" ");
}

/** Recursive accumulator for collectText. Pushes fragments into `out` and joins
 * only once, in collectText — joining at every recursive call (as an earlier
 * version did) is O(n²) and, on the largest layouts, allocates gigabytes of
 * discarded intermediate strings. */
function gatherText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string" || typeof node === "number") {
    // Whitespace-only fragments are XML pretty-print indentation, not content —
    // and untrimmed edges (e.g. a trailing space or CR on a name/text value)
    // would otherwise make two visually-identical objects diff as "changed".
    const text = String(node).trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) gatherText(item, out);
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
      // liftUuidMeta already lifts it onto obj.attributes (uuid, lastModifiedBy/
      // Account/At, modifications), where it's excluded from diffs unless opted in.
      // Left in here, its raw guid text leaks into obj.text uncontrolled by that
      // option: an object modified on only one side (i.e. one side's <UUID> has no
      // text, the other does) would otherwise diff as "changed" on whitespace alone
      // once the stray guid is stripped back out downstream.
      if (key === "UUID") continue;
      if (key === ATTR_PREFIX + "name" || key === "#text") {
        const text = String(value).trim();
        if (text) out.push(text);
      } else if (!key.startsWith(ATTR_PREFIX)) {
        gatherText(value, out);
      }
    }
  }
}
