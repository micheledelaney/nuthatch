import type { FmObject } from "@/types/ddr";
import { attr, child, isRecord } from "../xmlUtils";
import type { OccurrenceSource } from "../occurrences";

/**
 * Capture a table occurrence's base table and — for an external occurrence —
 * the data source (file) name it reads from (`source`, read once for the
 * file's index; see occurrenceSource). buildModel uses these to resolve
 * references that read through the occurrence, including references that cross
 * into another file when that file is also loaded. Also its box on the
 * relationship graph.
 */
export function annotateTableOccurrence(node: Record<string, unknown>, obj: FmObject, source: OccurrenceSource): FmObject {
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
