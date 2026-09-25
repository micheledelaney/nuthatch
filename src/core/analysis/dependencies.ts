import { OBJECT_TYPE_META, type FmObject, type FmReference, type ObjectType, type SolutionModel } from "@/types/ddr";

/** Canonical type order (matches the navigator), used to group reference lists. */
const TYPE_ORDER = Object.keys(OBJECT_TYPE_META) as ObjectType[];

export interface DependencyEdge {
  ref: FmReference;
  /** Resolved target object, or null when the reference is broken/external. */
  target: FmObject | null;
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
    inbound: dedupe(model.inbound.get(uid) ?? [], model, (r) => r.fromUid),
  };
}

function dedupe(
  refs: FmReference[],
  model: SolutionModel,
  keyOf: (r: FmReference) => string | null,
): DependencyEdge[] {
  const seen = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const ref of refs) {
    const key = `${keyOf(ref) ?? `missing:${ref.toType}:${ref.toId}`}|${ref.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const targetUid = keyOf(ref);
    edges.push({ ref, target: targetUid ? model.byUid.get(targetUid) ?? null : null });
  }
  return sortByType(edges);
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
