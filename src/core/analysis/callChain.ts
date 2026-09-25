import type { FmReference, SolutionModel } from "@/types/ddr";

export interface CallNode {
  uid: string;
  name: string;
  /** True when this script step targets a missing script (broken). */
  broken: boolean;
  /** True when the target script lives in another file that isn't loaded — it
   * cannot be expanded here, but it is not missing. */
  external: boolean;
  /** True when expanding here would revisit an ancestor (recursion guard). */
  cyclic: boolean;
  children: CallNode[];
}

/**
 * Build the outbound call chain for a script: which scripts it performs,
 * transitively. Cycles are detected and truncated rather than recursed into.
 */
export function buildCallChain(model: SolutionModel, rootUid: string): CallNode | null {
  const root = model.byUid.get(rootUid);
  if (!root || root.type !== "script") return null;
  return expand(model, rootUid, new Set<string>());
}

function expand(model: SolutionModel, uid: string, ancestors: Set<string>): CallNode {
  const obj = model.byUid.get(uid);
  const node: CallNode = {
    uid,
    name: obj?.name ?? "(unknown)",
    broken: false,
    external: false,
    cyclic: false,
    children: [],
  };

  const performEdges = (model.outbound.get(uid) ?? []).filter((r) => r.kind === "performScript");
  const nextAncestors = new Set(ancestors).add(uid);

  for (const edge of performEdges) {
    if (edge.broken) {
      // Genuinely missing: a deleted script, or an external one whose file IS
      // loaded but no longer holds it.
      node.children.push({
        uid: edge.toUid ?? `missing:${edge.toId}`,
        name: edge.toName || `(missing script ${edge.toId})`,
        broken: true,
        external: false,
        cyclic: false,
        children: [],
      });
      continue;
    }
    if (!edge.toUid) {
      // A script in another file that isn't loaded — unresolved here, but not
      // missing; show it as an external leaf rather than flagging it broken.
      // When the target script id is unknown (the file was closed at DDR export,
      // so FileMaker recorded only "<unknown> from file: X"), toName holds the
      // file name — label it "‹unknown› — File" to distinguish it from a named
      // script whose file merely isn't loaded.
      const name = edge.toId
        ? edge.toName || `(script ${edge.toId})`
        : `‹unknown› — ${edge.toName}`;
      node.children.push({
        uid: `external:${edge.toId}`,
        name,
        broken: false,
        external: true,
        cyclic: false,
        children: [],
      });
      continue;
    }
    if (nextAncestors.has(edge.toUid)) {
      const target = model.byUid.get(edge.toUid);
      node.children.push({
        uid: edge.toUid,
        name: target?.name ?? edge.toName,
        broken: false,
        external: false,
        cyclic: true,
        children: [],
      });
      continue;
    }
    node.children.push(expand(model, edge.toUid, nextAncestors));
  }
  return node;
}

/** Scripts that perform the given script (inbound call edges). */
export function callers(model: SolutionModel, uid: string): FmReference[] {
  return (model.inbound.get(uid) ?? []).filter((r) => r.kind === "performScript");
}
