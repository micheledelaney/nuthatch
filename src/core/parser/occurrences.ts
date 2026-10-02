import { attr, child, textAttr } from "./xmlUtils";
import { UNKNOWN_TARGET } from "./sentinels";

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
  const baseTableName = textAttr(baseTableRef, "name");
  const baseTableUuid = attr(baseTableRef, "UUID");
  const base = {
    ...(baseTableId != null ? { baseTableId } : {}),
    ...(baseTableName != null ? { baseTableName } : {}),
    ...(baseTableUuid ? { baseTableUuid } : {}),
  };
  if (attr(node, "type") !== "External") return { external: false, ...base, unresolved: false };

  const dataSourceRef = child(sourceRef, "DataSourceReference");
  const dataSourceName = textAttr(dataSourceRef, "name");
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
