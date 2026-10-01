/**
 * Turns a test-solution oracle (tests/fixtures/test-solution/expected*.json; its
 * "conventions" block documents the format) into named checks against a parser
 * snapshot. Each check returns its failures as readable strings; an empty list
 * means it passed.
 */
import { readFileSync } from "node:fs";
import { canonicalRelationship, descendants, lookup, type ActualEdge, type Snapshot } from "./snapshot";

interface ExpectedEdge {
  to: string;
  kind?: string;
  via?: string;
  step?: number;
  disabled?: boolean;
}

interface Oracle {
  ignoredTypes?: string[];
  objects: {
    absent: string[];
    present?: string[];
    counts?: Record<string, number>;
    attributes?: Record<string, Record<string, unknown>>;
    folders?: Record<string, string>;
    separators?: Record<string, number>;
    relationshipDepth?: Record<string, number>;
    details?: Record<string, Record<string, unknown>>;
    layoutObjects?: { layout: string; match: Record<string, unknown>; expect: Record<string, unknown> }[];
  };
  sources: Record<string, { exact: boolean; edges: ExpectedEdge[]; undecidedEdges?: ExpectedEdge[] }>;
  absentEdges?: { from: string; to: string; step?: number; why: string }[];
  unreferenced: { exact: string[]; undecided?: string[] };
  brokenSources: { exact: string[] };
  globalVariables: Record<string, string[]>;
  reportCard: Record<string, unknown>;
  mainAlone?: { reportCard?: Record<string, unknown> };
}

export interface Check {
  name: string;
  failures: () => string[];
}

/** Attribute values that differ for one export (e.g. a version without a feature), by ref. */
export type AttributeOverrides = Record<string, Record<string, unknown>>;

export function loadOracle(path: string, overrides: AttributeOverrides = {}): Oracle {
  const oracle = JSON.parse(readFileSync(path, "utf8")) as Oracle;
  const attributes = { ...oracle.objects.attributes };
  for (const [ref, attrs] of Object.entries(overrides)) attributes[ref] = { ...attributes[ref], ...attrs };
  return { ...oracle, objects: { ...oracle.objects, attributes } };
}

// ---- value matching ----------------------------------------------------------

const MATCHER_KEYS = ["absent", "present", "contains", "oneOf"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isMatcher(m: unknown): m is Record<string, unknown> {
  return isObject(m) && Object.keys(m).some((k) => MATCHER_KEYS.includes(k));
}
function fmt(v: unknown): string {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A plain value must be equal; {absent}/{present}/{contains}/{oneOf} as documented in the oracle. */
function matchValue(m: unknown, v: unknown): boolean {
  if (!isMatcher(m)) return equal(m, v);
  if ("absent" in m) return v == null;
  if ("present" in m) return v != null;
  if ("contains" in m) return v != null && (typeof v === "string" ? v : JSON.stringify(v)).includes(String(m.contains));
  if (Array.isArray(m.oneOf)) return m.oneOf.some((o) => equal(o, v));
  return false;
}

/** Partial deep match: listed keys must match (keys starting with "_" are notes);
 * in a list of objects, each expected item must match some actual item. */
function partial(m: unknown, v: unknown, path: string): string[] {
  const mismatch = [`${path}: expected ${fmt(m)}, got ${fmt(v)}`];
  if (isMatcher(m)) return matchValue(m, v) ? [] : mismatch;
  if (isObject(m)) {
    if (!isObject(v)) return [`${path}: expected an object, got ${fmt(v)}`];
    return Object.entries(m)
      .filter(([k]) => !k.startsWith("_"))
      .flatMap(([k, mv]) => partial(mv, v[k], `${path}.${k}`));
  }
  if (Array.isArray(m)) {
    if (!Array.isArray(v)) return [`${path}: expected a list, got ${fmt(v)}`];
    if (m.every((x) => !isObject(x) && !Array.isArray(x))) return equal(m, v) ? [] : mismatch;
    return m.flatMap((mi, i) => (v.some((vi) => partial(mi, vi, "").length === 0) ? [] : [`${path}[${i}]: no item matches ${fmt(mi)}`]));
  }
  return equal(m, v) ? [] : mismatch;
}

// ---- edges -------------------------------------------------------------------

/** With TEST_EXT not loaded, an expected edge into it can only be unresolved. */
function expectedTarget(e: ExpectedEdge, mainAlone: boolean): string {
  return mainAlone && e.to.startsWith("EXT:") ? `unresolved:${e.to.split(":")[1]}` : e.to;
}

function targetMatches(expected: string, actual: string): boolean {
  const special = /^(broken|unresolved):(.+)$/.exec(expected);
  if (special) return actual.startsWith(`${special[1]}:`) && special[2]!.split("|").includes(actual.split(":")[1]!);
  if (expected.includes(":relationship:")) return canonicalRelationship(expected) === canonicalRelationship(actual);
  return expected === actual;
}

function edgeMatches(e: ExpectedEdge, a: ActualEdge, mainAlone: boolean): boolean {
  return (
    targetMatches(expectedTarget(e, mainAlone), a.to) &&
    (e.kind == null || e.kind === a.kind) &&
    (e.via == null || e.via === a.via) &&
    (e.step == null || e.step === a.step) &&
    (!e.disabled || a.disabled)
  );
}

function describeEdge(e: ExpectedEdge, mainAlone: boolean): string {
  const extras = (["kind", "via", "step"] as const).filter((k) => e[k] != null).map((k) => ` ${k}=${e[k]}`);
  return `→ ${expectedTarget(e, mainAlone)}${extras.join("")}`;
}

/** The edges leaving an oracle source: the object itself, or (with "/**") it and everything inside it. */
function edgesOf(snap: Snapshot, src: string): ActualEdge[] | null {
  const uids = lookup(snap, src.replace("/**", ""));
  if (uids.length === 0) return null;
  const scope = src.endsWith("/**") ? descendants(snap, uids) : uids;
  return scope.flatMap((u) => snap.edgesFrom.get(u) ?? []);
}

// ---- checks ------------------------------------------------------------------

function layoutObjectView(snap: Snapshot, uid: string): Record<string, unknown> {
  const o = snap.byUid.get(uid)!;
  const d = (o.detail ?? {}) as Record<string, unknown>;
  const name = (x: unknown) => (isObject(x) ? x.name : undefined);
  const kids = descendants(snap, [uid]).filter((u) => u !== uid).map((u) => snap.byUid.get(u)?.detail);
  return {
    ...d,
    name: o.name,
    objectName: o.attributes.objectName,
    scriptRef: name(d.scriptRef),
    valueListRef: name(d.valueListRef),
    actionStep: name(d.actionStep),
    children: JSON.stringify(kids),
  };
}

function detailFailures(snap: Snapshot, ref: string, spec: Record<string, unknown>): string[] {
  const uid = lookup(snap, ref)[0];
  if (!uid) return [`${ref}: object not found`];
  const d = snap.byUid.get(uid)!.detail as Record<string, unknown> | undefined;
  if (spec._absent) return d == null ? [] : [`${ref}: expected no detail, got ${fmt(d)}`];
  const rest: Record<string, unknown> = { ...spec };
  const failures: string[] = [];
  if ("operators" in rest) {
    const want = rest.operators as string[];
    delete rest.operators;
    const got = ((d?.predicates as { operator: string }[] | undefined) ?? []).map((p) => p.operator);
    if (!equal([...got].sort(), [...want].sort())) failures.push(`${ref}.operators: expected ${fmt(want)}, got ${fmt(got)}`);
  }
  for (const key of Object.keys(rest).filter((k) => k.endsWith(" side"))) {
    const want = rest[key];
    delete rest[key];
    const side = d?.rightTable === key.split(" ")[0] ? d?.right : d?.left;
    failures.push(...partial(want, side, `${ref}.${key}`));
  }
  if ("partCount" in rest) {
    const want = rest.partCount;
    delete rest.partCount;
    const got = ((d?.parts as unknown[] | undefined) ?? []).length;
    if (got !== want) failures.push(`${ref}.partCount: expected ${want}, got ${got}`);
  }
  return [...partial(rest, d, ref), ...failures];
}

/**
 * All checks for one scenario. `mainAlone`: only TEST_MAIN is loaded, so EXT
 * objects don't exist and edges into TEST_EXT can only be unresolved.
 */
export function buildChecks(oracle: Oracle, snapshot: () => Snapshot, mainAlone: boolean): Check[] {
  const skip = (ref: string) => mainAlone && ref.startsWith("EXT:");
  const o = oracle.objects;
  const checks: Check[] = [];
  const add = (name: string, failures: () => string[]) => checks.push({ name, failures });

  add("objects: present", () => (o.present ?? []).filter((r) => !skip(r) && lookup(snapshot(), r).length === 0).map((r) => `missing ${r}`));
  add("objects: absent", () => o.absent.filter((r) => lookup(snapshot(), r).length > 0).map((r) => `should be gone: ${r}`));
  add("objects: counts", () =>
    Object.entries(o.counts ?? {})
      .filter(([key]) => !skip(key))
      .flatMap(([key, n]) => {
        const [file, type] = key.split(":");
        const got = snapshot().objects.filter((x) => snapshot().refOf.get(x.uid)?.startsWith(`${file}:`) && x.type === type).length;
        return got === n ? [] : [`${key}: expected ${n}, got ${got}`];
      }),
  );

  for (const [ref, attrs] of Object.entries(o.attributes ?? {})) {
    if (skip(ref)) continue;
    add(`attributes: ${ref}`, () => {
      const uid = lookup(snapshot(), ref)[0];
      if (!uid) return [`${ref}: object not found`];
      const actual = snapshot().byUid.get(uid)!.attributes;
      return Object.entries(attrs)
        .filter(([k]) => !k.startsWith("_"))
        .filter(([k, m]) => !matchValue(m, actual[k]))
        .map(([k, m]) => `${k}: expected ${fmt(m)}, got ${fmt(actual[k])}`);
    });
  }

  add("objects: folders, separators, relationship depth", () => {
    const snap = snapshot();
    const failures: string[] = [];
    for (const [ref, folder] of Object.entries(o.folders ?? {})) {
      const got = snap.byUid.get(lookup(snap, ref)[0] ?? "")?.folder ?? "";
      if (got !== folder) failures.push(`${ref}: folder expected ${fmt(folder)}, got ${fmt(got)}`);
    }
    for (const [key, n] of Object.entries(o.separators ?? {})) {
      const [file, type] = key.split(":");
      const got = snap.objects.filter((x) => x.isSeparator && x.type === type && snap.refOf.get(x.uid)?.startsWith(`${file}:`)).length;
      if (got !== n) failures.push(`${key}: expected ${n} separator(s), got ${got}`);
    }
    for (const [ref, n] of Object.entries(o.relationshipDepth ?? {})) {
      const got = snap.byUid.get(lookup(snap, ref)[0] ?? "")?.relationshipDepth ?? 0;
      if (got !== n) failures.push(`${ref}: relationship depth expected ${n}, got ${got}`);
    }
    return failures;
  });

  for (const [ref, spec] of Object.entries(o.details ?? {})) {
    if (!skip(ref)) add(`details: ${ref}`, () => detailFailures(snapshot(), ref, spec));
  }

  for (const lo of o.layoutObjects ?? []) {
    add(`layout object: ${lo.layout} ${fmt(lo.match)}`, () => {
      const snap = snapshot();
      const views = descendants(snap, lookup(snap, lo.layout))
        .filter((u) => snap.byUid.get(u)?.type === "layoutObject")
        .map((u) => layoutObjectView(snap, u))
        .filter((v) => partial(lo.match, v, "").length === 0);
      if (views.length === 0) return [`no layout object matches ${fmt(lo.match)}`];
      const results = views.map((v) => partial(lo.expect, v, "object"));
      return results.some((r) => r.length === 0) ? [] : results[0]!;
    });
  }

  for (const [src, spec] of Object.entries(oracle.sources)) {
    if (skip(src)) continue;
    add(`edges: ${src}`, () => {
      const actual = edgesOf(snapshot(), src);
      if (actual == null) return [`source object not found`];
      const missing = spec.edges
        .filter((e) => !actual.some((a) => edgeMatches(e, a, mainAlone)))
        .map((e) => `missing edge ${describeEdge(e, mainAlone)}`);
      if (!spec.exact) return missing;
      const allowed = [...spec.edges, ...(spec.undecidedEdges ?? [])];
      const extra = actual
        .filter((a) => !allowed.some((e) => targetMatches(expectedTarget(e, mainAlone), a.to) && (e.via == null || e.via === a.via)))
        .map((a) => `unexpected edge → ${a.to} kind=${a.kind} via=${a.via ?? "-"} step=${a.step ?? "-"} name=${fmt(a.toName)}`);
      return [...missing, ...extra];
    });
  }

  add("edges: absent", () =>
    (oracle.absentEdges ?? []).flatMap((ab) => {
      const found = (edgesOf(snapshot(), `${ab.from}/**`) ?? []).filter(
        (a) =>
          (ab.to.endsWith("*") ? a.to.startsWith(ab.to.slice(0, -1)) : targetMatches(ab.to, a.to)) &&
          (ab.step == null || a.step === ab.step),
      );
      return found.length ? [`${ab.from} step ${ab.step ?? "-"}: should have no edge → ${ab.to} (${ab.why})`] : [];
    }),
  );

  add("unreferenced", () => {
    const snap = snapshot();
    const expected = new Set(oracle.unreferenced.exact.filter((r) => !skip(r)));
    const undecided = new Set(oracle.unreferenced.undecided ?? []);
    return [
      ...[...expected]
        .filter((r) => !snap.unreferenced.has(r))
        .map((r) => (lookup(snap, r).length ? `expected unreferenced, but it's referenced: ${r}` : `expected unreferenced, but not found: ${r}`)),
      ...[...snap.unreferenced].filter((r) => !expected.has(r) && !undecided.has(r)).map((r) => `unreferenced, but it's used: ${r}`),
    ];
  });

  add("broken sources", () => {
    const snap = snapshot();
    const left = new Set([...snap.edgesFrom].filter(([, es]) => es.some((e) => e.to.startsWith("broken:"))).map(([u]) => u));
    const failures: string[] = [];
    for (const b of oracle.brokenSources.exact) {
      const uids = lookup(snap, b.replace("/**", ""));
      const scope = b.endsWith("/**") ? descendants(snap, uids) : uids;
      if (!scope.some((u) => left.has(u))) failures.push(`expected broken references from ${b}`);
      scope.forEach((u) => left.delete(u));
    }
    return [...failures, ...[...left].map((u) => `unexpected broken reference from ${snap.refOf.get(u)}`)];
  });

  for (const [name, users] of Object.entries(oracle.globalVariables)) {
    add(`global variable: ${name}`, () => {
      const found = snapshot().globalUsers.get(name);
      if (!found) return [`${name} not detected`];
      return users.map((u) => u.replace("/**", "")).filter((u) => !found.has(u)).map((u) => `expected use by ${u}`);
    });
  }
  add("global variables: no unexpected ones", () =>
    [...snapshot().globalUsers.keys()].filter((n) => !(n in oracle.globalVariables)).map((n) => `unexpected global variable ${n}`),
  );

  add("report card", () => {
    const expected = { ...oracle.reportCard, ...(mainAlone ? (oracle.mainAlone?.reportCard ?? {}) : {}) };
    const actual = snapshot().reportCard as unknown as Record<string, unknown>;
    return Object.entries(expected)
      .filter(([k, v]) => !k.startsWith("_") && !equal(actual[k], v))
      .map(([k, v]) => `${k}: expected ${fmt(v)}, got ${fmt(actual[k])}`);
  });
  add("parse errors", () => snapshot().errors);

  return checks;
}

