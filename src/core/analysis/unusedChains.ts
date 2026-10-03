import { ORPHAN_CANDIDATE_TYPES, type FmObject, type FmReference, type SolutionModel } from "@/types/ddr";

/**
 * Unused chains: objects that something references, but only things that are
 * themselves unused — the scripts an unreferenced script calls, the fields on
 * an unreferenced layout, a table whose only occurrence nothing uses, and loops
 * of objects that only use each other.
 *
 * Found by walking forward from everything that runs or is used without a
 * reference — every type that's never flagged unreferenced (files, accounts,
 * relationships, custom menus, …) plus layouts and scripts people can open
 * from FileMaker's menus — through enabled references, and from a container
 * into the objects inside it (a layout's buttons only run while the layout is
 * in use). A candidate that walk never reaches is unused; the ones that aren't
 * already unreferenced make up the chains.
 *
 * An object referenced by anything in use is never flagged, whatever its
 * container: a chain only ever adds objects whose every use is unused.
 */

/** Layouts and scripts people can open or run straight from FileMaker's menus
 * are in use even with nothing referencing them, so they never start a chain. */
export function isChainEntryPoint(obj: FmObject): boolean {
  if (obj.type === "layout") return obj.attributes.includeInLayoutMenus !== "No";
  if (obj.type === "script") return obj.attributes.includeInMenu !== "No";
  return false;
}

/** Objects the unreferenced check applies to: the ones a chain can contain. */
function isCandidate(obj: FmObject): boolean {
  return !obj.isSeparator && ORPHAN_CANDIDATE_TYPES.has(obj.type);
}

/** In use without needing a reference to it (subject to its container). */
function isStart(obj: FmObject): boolean {
  return !isCandidate(obj) || isChainEntryPoint(obj);
}

/** The objects in unused chains — never including the unreferenced ones they hang from. */
export function findUnusedChains(
  objects: FmObject[],
  outbound: Map<string, FmReference[]>,
  byUid: Map<string, FmObject>,
  unreferenced: FmObject[],
): FmObject[] {
  const live = findLive(objects, outbound, byUid);
  const unref = new Set(unreferenced.map((o) => o.uid));
  return objects.filter((o) => isCandidate(o) && !live.has(o.uid) && !unref.has(o.uid));
}

/** Every object reachable from the start objects. */
function findLive(objects: FmObject[], outbound: Map<string, FmReference[]>, byUid: Map<string, FmObject>): Set<string> {
  const children = new Map<string, FmObject[]>();
  for (const o of objects) {
    if (!o.parentUid) continue;
    const list = children.get(o.parentUid);
    if (list) list.push(o);
    else children.set(o.parentUid, [o]);
  }

  const live = new Set<string>();
  const queue: string[] = [];
  const mark = (o: FmObject) => {
    if (live.has(o.uid)) return;
    live.add(o.uid);
    queue.push(o.uid);
  };
  // Top-level starts; contained ones are reached through their container below.
  for (const o of objects) {
    if (isStart(o) && (!o.parentUid || !byUid.has(o.parentUid))) mark(o);
  }
  while (queue.length > 0) {
    const uid = queue.pop()!;
    for (const ref of outbound.get(uid) ?? []) {
      // A disabled step never runs, so it keeps nothing in use.
      const target = ref.toUid && !ref.disabled ? byUid.get(ref.toUid) : undefined;
      if (target) mark(target);
    }
    for (const child of children.get(uid) ?? []) {
      if (isStart(child)) mark(child);
    }
  }
  return live;
}

const deadCache = new WeakMap<SolutionModel, Set<string>>();

/** Candidates nothing in use reaches: the unused chains plus the unreferenced
 * objects that aren't entry points. */
function deadSetFor(model: SolutionModel): Set<string> {
  let set = deadCache.get(model);
  if (!set) {
    set = new Set(model.unusedChain.map((o) => o.uid));
    for (const o of model.unreferenced) if (!isChainEntryPoint(o)) set.add(o.uid);
    deadCache.set(model, set);
  }
  return set;
}

/** The object that uses something on another's behalf: a layout object counts
 * as its layout, the way the unreferenced check treats a layout's own buttons. */
function usingObject(model: SolutionModel, uid: string): FmObject | undefined {
  let obj = model.byUid.get(uid);
  for (let hops = 0; obj && !isCandidate(obj) && obj.parentUid && hops < 64; hops++) {
    obj = model.byUid.get(obj.parentUid);
  }
  return obj;
}

/** Whether nothing in use reaches this object — or, for a layout object, its
 * layout. Unreferenced layouts and scripts in FileMaker's menus don't count. */
export function isUnusedSource(model: SolutionModel, uid: string): boolean {
  const obj = usingObject(model, uid);
  return obj != null && deadSetFor(model).has(obj.uid);
}

export interface ChainTops {
  /** The unreferenced objects the chain hangs from: if they're really unused,
   * so is everything below them. */
  tops: FmObject[];
  /** When the chain reaches no unreferenced object, it's a loop: the other
   * objects in it, which only use each other. Empty otherwise. */
  loop: FmObject[];
}

/** Why an object is in an unused chain: walk back through its unused users. */
export function chainTops(model: SolutionModel, uid: string): ChainTops {
  const dead = deadSetFor(model);
  const unref = new Set(model.unreferenced.map((o) => o.uid));
  const tops: FmObject[] = [];
  const loop: FmObject[] = [];
  const seen = new Set([uid]);
  const queue = [uid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const ref of model.inbound.get(current) ?? []) {
      if (ref.disabled) continue;
      const user = usingObject(model, ref.fromUid);
      if (!user || seen.has(user.uid) || !dead.has(user.uid)) continue;
      seen.add(user.uid);
      if (unref.has(user.uid)) {
        tops.push(user);
      } else {
        loop.push(user);
        queue.push(user.uid);
      }
    }
  }
  return { tops, loop: tops.length > 0 ? [] : loop };
}
