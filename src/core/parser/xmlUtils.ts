/** Helpers for navigating the loosely-typed object tree from fast-xml-parser. */

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

/** Collect every `key`-prefixed attribute on a node into a plain string map. */
export function attributes(node: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith(ATTR_PREFIX) && v != null) {
      out[k.slice(ATTR_PREFIX.length)] = String(v).trim();
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      // wrapper is identity/modification-tracking metadata, not content — parseDdr's
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
