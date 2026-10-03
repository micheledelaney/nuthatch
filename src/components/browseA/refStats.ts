import type { SolutionModel } from "@/types/ddr";
import { brokenSources, distinctRefs, outboundRows } from "@/core/analysis/dependencies";

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
    const rows = outboundRows(refs, model.byUid);
    const s = get(uid);
    s.outbound = rows.length;
    s.broken = rows.filter((r) => r.broken).length;
  }
  for (const [uid, refs] of model.inbound) {
    get(uid).inbound = distinctRefs(refs, (r) => r.fromUid, model.byUid).length;
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

/** Uids of every object with a broken row in its References list (see
 * brokenSources): the objects whose badge counts a broken reference. */
export function brokenSourcesFor(model: SolutionModel): Set<string> {
  let set = brokenCache.get(model);
  if (!set) {
    set = brokenSources(model);
    brokenCache.set(model, set);
  }
  return set;
}
