import type { FmReference, SolutionModel } from "@/types/ddr";

/** Per-object reference counts, de-duplicated the same way the object page
 * lists them (see buildDependencyView): one per target/source + edge kind. */
export interface RefStats {
  inbound: number;
  outbound: number;
  broken: number;
}

const EMPTY: RefStats = { inbound: 0, outbound: 0, broken: 0 };

const statsCache = new WeakMap<SolutionModel, Map<string, RefStats>>();
const brokenCache = new WeakMap<SolutionModel, Set<string>>();

function dedupedCount(refs: FmReference[], keyOf: (r: FmReference) => string | null): number {
  const seen = new Set<string>();
  for (const r of refs) seen.add(`${keyOf(r) ?? `missing:${r.toType}:${r.toId}`}|${r.kind}`);
  return seen.size;
}

function buildStats(model: SolutionModel): Map<string, RefStats> {
  const stats = new Map<string, RefStats>();
  const get = (uid: string): RefStats => {
    const existing = stats.get(uid);
    if (existing) return existing;
    const fresh = { inbound: 0, outbound: 0, broken: 0 };
    stats.set(uid, fresh);
    return fresh;
  };
  for (const [uid, refs] of model.outbound) {
    // Menu -> item containment is shown as the menu's children, not as a reference.
    const real = refs.filter((r) => r.kind !== "menuItem");
    const s = get(uid);
    s.outbound = dedupedCount(real, (r) => r.toUid);
    s.broken = dedupedCount(real.filter((r) => r.broken), (r) => r.toUid);
  }
  for (const [uid, refs] of model.inbound) {
    get(uid).inbound = dedupedCount(refs, (r) => r.fromUid);
  }
  return stats;
}

/** Reference counts for one object (cached per model). */
export function refStatsFor(model: SolutionModel, uid: string): RefStats {
  let stats = statsCache.get(model);
  if (!stats) {
    stats = buildStats(model);
    statsCache.set(model, stats);
  }
  return stats.get(uid) ?? EMPTY;
}

/** Uids of every object that is the source of at least one broken reference. */
export function brokenSourcesFor(model: SolutionModel): Set<string> {
  let set = brokenCache.get(model);
  if (!set) {
    set = new Set(model.brokenReferences.map((r) => r.fromUid));
    brokenCache.set(model, set);
  }
  return set;
}
