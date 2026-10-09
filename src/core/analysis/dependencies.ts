import { OBJECT_TYPE_META, type FmObject, type FmReference, type ObjectType, type SolutionModel } from "@/types/ddr";

/** Canonical type order (matches the navigator), used to group reference lists. */
const TYPE_ORDER = Object.keys(OBJECT_TYPE_META) as ObjectType[];

export interface DependencyEdge {
  ref: FmReference;
  /** Resolved target object, or null when the reference is broken/external. */
  target: FmObject | null;
  /** Inbound only: every reference in the row comes from a disabled step, so
   * it doesn't count as a use of the object (FileMaker never runs it). */
  disabled?: boolean;
}

export interface DependencyView {
  object: FmObject;
  /** Objects this one depends on (outbound). */
  outbound: DependencyEdge[];
  /** Objects that depend on this one (inbound). */
  inbound: DependencyEdge[];
}

/**
 * Build the inbound/outbound dependency view for an object, de-duplicated
 * by target so the same object isn't listed many times for repeated references.
 */
export function buildDependencyView(model: SolutionModel, uid: string): DependencyView | null {
  const object = model.byUid.get(uid);
  if (!object) return null;

  return {
    object,
    outbound: dedupe(model.outbound.get(uid) ?? [], model, (r) => r.toUid),
    inbound: dedupe(model.inbound.get(uid) ?? [], model, (r) => r.fromUid, true),
  };
}

/** One edge per row, sorted. For an inbound list, each row says whether every
 * reference in it comes from a disabled step. */
function dedupe(
  refs: FmReference[],
  model: SolutionModel,
  keyOf: (r: FmReference) => string | null,
  inbound = false,
): DependencyEdge[] {
  const enabledRows = inbound ? new Set(refs.filter((r) => !r.disabled).map((r) => rowKey(r, keyOf, model.byUid))) : null;
  const edges = distinctRefs(refs, keyOf, model.byUid).map((ref): DependencyEdge => {
    const targetUid = keyOf(ref);
    const target = targetUid ? model.byUid.get(targetUid) ?? null : null;
    return enabledRows && !enabledRows.has(rowKey(ref, keyOf, model.byUid)) ? { ref, target, disabled: true } : { ref, target };
  });
  return sortByType(edges);
}

/** Whether an inbound reference means its target is actually used. It doesn't
 * when it comes from a disabled script step (FileMaker never runs it), or from
 * the target itself or something inside it — a recursive script or custom
 * function, or a button on a layout that goes to that same layout. */
export function countsAsUse(ref: FmReference, targetUid: string, byUid: ReadonlyMap<string, FmObject>): boolean {
  return !ref.disabled && !isWithin(ref.fromUid, targetUid, byUid);
}

/** Whether `uid` is `containerUid` or inside it, up the containment chain
 * (layout object → … → layout, field → table); the hop cap only guards
 * against a malformed cycle. */
function isWithin(uid: string, containerUid: string, byUid: ReadonlyMap<string, FmObject>): boolean {
  let current: string | undefined = uid;
  for (let hops = 0; current != null && hops < 64; hops++) {
    if (current === containerUid) return true;
    current = byUid.get(current)?.parentUid;
  }
  return false;
}

/** The references a list shows: the first of each row. A list has one row per
 * object and kind. A target that wasn't found has no uid, so its row goes by
 * FileMaker's id for it and the table that id is in (see tableOf): the id is
 * only unique within its table, so field 14 of one table isn't field 14 of
 * another, while two occurrences of one table reach the same field. */
export function distinctRefs(
  refs: readonly FmReference[],
  keyOf: (r: FmReference) => string | null,
  byUid: ReadonlyMap<string, FmObject>,
): FmReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = rowKey(ref, keyOf, byUid);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowKey(ref: FmReference, keyOf: (r: FmReference) => string | null, byUid: ReadonlyMap<string, FmObject>): string {
  return `${keyOf(ref) ?? `missing:${ref.toType}:${tableOf(ref, byUid)}:${ref.toId}`}|${ref.kind}`;
}

/** The table a reference that wasn't found points into, as far as the export
 * tells: its occurrence's base table, or the occurrence itself when its base
 * table is unknown (its file wasn't available at export). */
function tableOf(ref: FmReference, byUid: ReadonlyMap<string, FmObject>): string {
  const via = ref.viaUid ? byUid.get(ref.viaUid) : undefined;
  if (!via) return "";
  const table = via.attributes.baseTableId;
  return table == null ? via.uid : `${via.fileUid}|${via.attributes.externalDataSource ?? ""}|${table}`;
}

/** An object's References list, unsorted: its outbound references, one per
 * row, without menu -> item containment (shown as the menu's children). The
 * object's badge, the navigator's dot, the Broken filter and the report card
 * all count the broken rows of this list. */
export function outboundRows(refs: readonly FmReference[], byUid: ReadonlyMap<string, FmObject>): FmReference[] {
  return distinctRefs(
    refs.filter((r) => r.kind !== "menuItem"),
    (r) => r.toUid,
    byUid,
  );
}

/** Every object with a broken row in its References list (see outboundRows).
 * Only an object with a broken reference can have one. */
export function brokenSources(model: Pick<SolutionModel, "outbound" | "brokenReferences" | "byUid">): Set<string> {
  const sources = new Set<string>();
  for (const uid of new Set(model.brokenReferences.map((r) => r.fromUid))) {
    if (outboundRows(model.outbound.get(uid) ?? [], model.byUid).some((r) => r.broken)) sources.add(uid);
  }
  return sources;
}

/** Group edges by object type (in canonical order), then alphabetically by the
 * displayed name within each type. */
function sortByType(edges: DependencyEdge[]): DependencyEdge[] {
  return [...edges].sort((a, b) => {
    const ta = TYPE_ORDER.indexOf(a.target?.type ?? a.ref.toType);
    const tb = TYPE_ORDER.indexOf(b.target?.type ?? b.ref.toType);
    if (ta !== tb) return ta - tb;
    const na = a.target?.name ?? a.ref.toName;
    const nb = b.target?.name ?? b.ref.toName;
    return na.localeCompare(nb);
  });
}
