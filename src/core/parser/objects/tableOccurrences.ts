import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { UNKNOWN_TARGET } from "../sentinels";

/** Where a table occurrence's records come from. */
export interface OccurrenceSource {
  external: boolean;
  baseTableId?: string;
  baseTableName?: string;
  /** The base table's own UUID, which identifies it across files whatever the
   * data source is named (buildModel matches external occurrences on it). */
  baseTableUuid?: string;
  /** External only: the data source (file) it reads through. */
  dataSourceName?: string;
  /** External, with no base table, and its data source still exists: the
   * source file simply wasn't available when this file was exported (or its
   * path is a variable), so nothing behind it can be verified. */
  unresolved: boolean;
}

/**
 * Read a table occurrence's base table and — for an external occurrence — its
 * data source. Both live inside a <BaseTableSourceReference> wrapper, not
 * directly on the occurrence. An external occurrence without a base table is
 * broken only when the export shows the data source itself is gone (named
 * `<unknown>`, or an id missing from the file's data-source catalog).
 */
export function occurrenceSource(node: unknown, dataSourceIds: ReadonlySet<string>): OccurrenceSource {
  const sourceRef = child(node, "BaseTableSourceReference");
  const baseTableRef = child(sourceRef, "BaseTableReference");
  const baseTableId = attr(baseTableRef, "id");
  const baseTableName = attr(baseTableRef, "name");
  const baseTableUuid = attr(baseTableRef, "UUID");
  const base = {
    ...(baseTableId != null ? { baseTableId } : {}),
    ...(baseTableName != null ? { baseTableName: decodeEntities(baseTableName) } : {}),
    ...(baseTableUuid ? { baseTableUuid } : {}),
  };
  if (attr(node, "type") !== "External") return { external: false, ...base, unresolved: false };

  const dataSourceRef = child(sourceRef, "DataSourceReference");
  const rawName = attr(dataSourceRef, "name");
  const dataSourceName = rawName != null ? decodeEntities(rawName) : undefined;
  const dataSourceId = attr(dataSourceRef, "id");
  const sourceDeleted =
    dataSourceName != null && (dataSourceName === UNKNOWN_TARGET || (dataSourceId != null && !dataSourceIds.has(dataSourceId)));
  return {
    external: true,
    ...base,
    ...(dataSourceName != null ? { dataSourceName } : {}),
    unresolved: baseTableId == null && !sourceDeleted,
  };
}

/**
 * Capture a table occurrence's base table and — for an external occurrence —
 * the data source (file) name it reads from. buildModel uses these to resolve
 * references that read through the occurrence, including references that cross
 * into another file when that file is also loaded. Also its box on the
 * relationship graph.
 */
export function annotateTableOccurrence(node: Record<string, unknown>, obj: FmObject, fp: FileParse): FmObject {
  const source = occurrenceSource(node, fp.chunks.dataSourceIds);
  const a: Record<string, string> = {};
  if (source.baseTableId != null) a.baseTableId = source.baseTableId;
  // The readable base-table name (the raw id is internal and hidden from view).
  if (source.baseTableName != null) a.baseTable = source.baseTableName;
  if (source.baseTableUuid) a.baseTableUuid = source.baseTableUuid;
  if (source.dataSourceName != null) a.externalDataSource = source.dataSourceName;
  if (source.unresolved) a.baseTableUnresolved = "Couldn't be resolved — its file wasn't available when this file was exported";
  return { ...obj, attributes: { ...obj.attributes, ...a, ...graphBox(node) } };
}

/** The occurrence's box on the relationship graph: its position, full rectangle
 * ("left,top,right,bottom", for re-drawing FileMaker's own layout faithfully),
 * color, and how it's shown. */
function graphBox(node: Record<string, unknown>): Record<string, string> {
  const a: Record<string, string> = {};
  const coord = child(node, "CoordRect");
  const left = attr(coord, "left");
  const top = attr(coord, "top");
  const right = attr(coord, "right");
  const bottom = attr(coord, "bottom");
  if (left != null && top != null) a.graphPosition = `${left}, ${top}`;
  if (left != null && top != null && right != null && bottom != null) a.graphRect = `${left},${top},${right},${bottom}`;
  const color = rgbHex(child(node, "Color"));
  if (color) a.color = color;
  // "Collapse" draws only the title bar, so its CoordRect (the expanded bounds)
  // overstates its drawn height.
  const view = attr(node, "View");
  if (view) a.graphView = view;
  return a;
}

/** A FileMaker <Color red green blue> (0–255 channels) as a #RRGGBB string. */
function rgbHex(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const channels = ["red", "green", "blue"].map((c) => Number(attr(node, c)));
  if (!channels.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return undefined;
  return "#" + channels.map((n) => n.toString(16).padStart(2, "0")).join("");
}
