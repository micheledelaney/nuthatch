import type { SolutionModel } from "@/types/ddr";

/**
 * FileMaker's own relationship graph, reconstructed from the DDR. Each file in a
 * solution has one graph: table occurrences placed at the exact coordinates and
 * colors you arranged in Manage ▸ Database ▸ Relationships, connected by the
 * relationships between them. This is a faithful re-draw — no layout is computed.
 */

export interface GraphNode {
  /** Table-occurrence uid (opens the occurrence when clicked). */
  uid: string;
  name: string;
  /** Box rectangle in FileMaker graph coordinates. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The occurrence's color (#RRGGBB), if it was given one. */
  color?: string;
  /** Base-table name the occurrence reads from (for display). */
  baseTable?: string;
  /** Stable identity of the underlying base table (its id, scoped by data
   * source/file) — what "same base table" should match on, not the name. */
  baseKey?: string;
  /** The fields this occurrence uses in relationships, in base-table order.
   * Shown when the box is expanded (boxes start collapsed). */
  fields: string[];
}

/** An undirected link between two occurrences (one relationship), carrying the
 * cascade/sort settings of either side (for the optional cascade coloring). */
export interface GraphEdge {
  /** The relationship object's uid (for navigating to its detail view). */
  uid: string;
  a: string; // TO uid
  b: string; // TO uid
  /** "Allow creation of records…" is set on either side. */
  create: boolean;
  /** "Delete related records…" is set on either side. */
  del: boolean;
  /** "Sort records" is set on either side. */
  sort: boolean;
}

export interface FileGraph {
  fileUid: string;
  fileName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Parse a "left,top,right,bottom" rect string into numbers, or null. */
function parseRect(s: string | undefined): [number, number, number, number] | null {
  if (!s) return null;
  const parts = s.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts as [number, number, number, number];
}

/**
 * Build one {@link FileGraph} per file that has placed table occurrences, in the
 * solution's file order. Occurrences without graph coordinates (rare) are
 * skipped; relationships are resolved to occurrence uids within their own file.
 */
export function buildRelationshipGraph(model: SolutionModel): FileGraph[] {
  // Base-table fields, in catalog order, for drawing expanded boxes.
  const fieldsByTable = new Map<string, { name: string; order: number }[]>();
  for (const obj of model.objects) {
    if (obj.type !== "field" || !obj.parentUid) continue;
    (fieldsByTable.get(obj.parentUid) ?? fieldsByTable.set(obj.parentUid, []).get(obj.parentUid)!).push({
      name: obj.name,
      order: obj.order ?? Number.MAX_SAFE_INTEGER,
    });
  }
  for (const list of fieldsByTable.values()) list.sort((a, b) => a.order - b.order);

  // Per occurrence (keyed by its uid), the fields it uses in any relationship —
  // what a "Related" box shows. Endpoints are resolved by occurrence id, scoped
  // to the relationship's own file (occurrence ids are unique only per file),
  // never by name.
  const relFields = new Map<string, Set<string>>();
  const addRelField = (occUid: string | undefined, field: string) => {
    if (!occUid) return;
    (relFields.get(occUid) ?? relFields.set(occUid, new Set()).get(occUid)!).add(field);
  };
  for (const obj of model.objects) {
    if (obj.type !== "relationship" || obj.detail?.kind !== "relationship") continue;
    const { leftToId, rightToId } = obj.detail;
    const leftUid = leftToId != null ? `${obj.fileUid}:tableOccurrence:${leftToId}` : undefined;
    const rightUid = rightToId != null ? `${obj.fileUid}:tableOccurrence:${rightToId}` : undefined;
    for (const p of obj.detail.predicates) {
      addRelField(leftUid, p.leftField);
      addRelField(rightUid, p.rightField);
    }
  }

  // Per file: occurrence nodes; plus the set of occurrence uids that have a drawn
  // node, so an edge is only kept between two placed occurrences.
  const nodesByFile = new Map<string, GraphNode[]>();
  const placed = new Set<string>();

  for (const obj of model.objects) {
    if (obj.type !== "tableOccurrence") continue;
    const rect = parseRect(obj.attributes.graphRect);
    if (!rect) continue;
    const [left, top, right, bottom] = rect;
    const baseTableId = obj.attributes.baseTableId;
    const baseUid = baseTableId ? `${obj.fileUid}:table:${baseTableId}` : "";
    // Identity of the base table, scoped by external data source (or this file)
    // so same-named tables from different sources never group together.
    const baseKey = baseTableId
      ? `${obj.attributes.externalDataSource ?? obj.fileUid}:${baseTableId}`
      : undefined;
    // Fields this occurrence uses in any relationship, in base-table order.
    const used = relFields.get(obj.uid);
    const allFields = fieldsByTable.get(baseUid) ?? [];
    let fields: string[] = [];
    if (used) {
      fields = allFields.filter((f) => used.has(f.name)).map((f) => f.name);
      if (fields.length === 0) fields = [...used];
    }
    const node: GraphNode = {
      uid: obj.uid,
      name: obj.name,
      left,
      top,
      right,
      bottom,
      color: obj.attributes.color,
      baseTable: obj.attributes.baseTable,
      baseKey,
      fields,
    };
    (nodesByFile.get(obj.fileUid) ?? nodesByFile.set(obj.fileUid, []).get(obj.fileUid)!).push(node);
    placed.add(obj.uid);
  }

  const edgesByFile = new Map<string, GraphEdge[]>();
  for (const obj of model.objects) {
    if (obj.type !== "relationship" || obj.detail?.kind !== "relationship") continue;
    const { leftToId, rightToId } = obj.detail;
    // Endpoints resolve by occurrence id within the relationship's own file; an
    // edge is drawn only when both endpoints are placed occurrences.
    const a = leftToId != null ? `${obj.fileUid}:tableOccurrence:${leftToId}` : undefined;
    const b = rightToId != null ? `${obj.fileUid}:tableOccurrence:${rightToId}` : undefined;
    if (!a || !b || !placed.has(a) || !placed.has(b)) continue;
    const { left: l, right: r } = obj.detail;
    (edgesByFile.get(obj.fileUid) ?? edgesByFile.set(obj.fileUid, []).get(obj.fileUid)!).push({
      uid: obj.uid,
      a,
      b,
      create: !!(l?.cascadeCreate || r?.cascadeCreate),
      del: !!(l?.cascadeDelete || r?.cascadeDelete),
      sort: !!(l?.sorted || r?.sorted),
    });
  }

  const graphs: FileGraph[] = [];
  for (const file of model.files) {
    const nodes = nodesByFile.get(file.uid);
    if (!nodes || nodes.length === 0) continue;
    graphs.push({
      fileUid: file.uid,
      fileName: file.name,
      nodes,
      edges: edgesByFile.get(file.uid) ?? [],
    });
  }
  return graphs;
}
