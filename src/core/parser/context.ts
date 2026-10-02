import type { FmFile, FmObject, RawReference } from "@/types/ddr";
import { asArray, attr, child, children, isElementKey, isRecord } from "./xmlUtils";
import { decodeEntities } from "./entities";
import { makeNameIndex, type NameIndex } from "./calcText";
import { collectCatalogItems } from "./objects/catalogItems";
import { occurrenceSource } from "./objects/tableOccurrences";
import type { DeferredButton } from "./objects/deferredLayouts";

/**
 * Everything one file's parse reads and writes. Each file gets its own, so the
 * scanners take their inputs explicitly instead of from module state, and a
 * file that fails to parse leaves nothing half-added behind.
 */
export interface FileParse {
  readonly file: FmFile;
  readonly fileObject: FmObject;
  readonly chunks: ChunkContext;
  /** Button layout targets recorded only in FM 22's <ModifyAction>, by layout id. */
  readonly deferredLayoutTargets: ReadonlyMap<string, DeferredButton[]>;
  /** Field uid → the text of its in-effect calcs, for a field whose XML still
   * carries disabled auto-enter / validation calcs. The text-based passes scan
   * this instead of `obj.text`, as the element scan skips those calcs too. */
  readonly activeText: Map<string, string>;
  /** How many times each layout-object uid has been assigned. FileMaker can
   * clone a whole layout-object subtree without regenerating any identifier in
   * it, so id, the ancestor chain, and even UUID can all collide; the first
   * occurrence keeps its clean uid and every later one gets a stable `#N`
   * suffix, so distinct exported objects never collapse onto one uid. */
  readonly layoutObjectUidCounts: Map<string, number>;
  readonly objects: FmObject[];
  readonly references: RawReference[];
  /** Shared with the whole parse: problems worth telling the user about. */
  readonly errors: string[];
}

/** The lookups a file's reference scan resolves against. The name indexes come
 * straight from the catalogs because field calcs are scanned before the
 * occurrence catalog becomes objects. */
export interface ChunkContext {
  /** pointer → the `<_HASH>` block node (which contains a <ChunkList>). */
  lists: Map<string, unknown>;
  /** custom-function name → id, for resolving CustomFunctionRef chunks (which
   * carry only the name). */
  cfByName: Map<string, string>;
  /** Longest-match index over the custom-function names (text fallback). */
  cfIndex: NameIndex;
  /** StepText hash → FileMaker's rendered step text, for steps whose target is
   * only identifiable from that text (a deleted script shows as `<unknown>`). */
  stepTextByHash: Map<string, string>;
  /** Table occurrences by name (text fallback resolves `TO::Field` through it). */
  toByName: Map<string, OccurrenceInfo>;
  /** Table occurrences by id (a calc's context occurrence → its base table). */
  toById: Map<string, OccurrenceInfo>;
  /** Occurrence names, for longest-match before a `::`. */
  toNames: string[];
  /** Local base-table id → its fields (name → id), plus a longest-match index. */
  fieldsByTable: Map<string, { idByName: Map<string, string>; index: NameIndex }>;
  /** The file's defined external data sources, so an occurrence pointing at one
   * that no longer exists reads as broken rather than merely unresolved. */
  dataSourceIds: ReadonlySet<string>;
}

export interface OccurrenceInfo {
  id: string;
  /** Local base-table id; undefined for external occurrences (their base table
   * lives in another file) and for broken ones. */
  localBaseTableId?: string;
  external: boolean;
  /** External, with its base table recorded: its file was open at export. */
  fileOpenAtExport?: boolean;
  /** External, and its file wasn't available at export (see occurrenceSource). */
  unresolved: boolean;
}

/** FileMaker's rendered text for a step, looked up by the hash on its
 * `<DDRREF kind="StepText">` pointer (entities intact). */
export function renderedStepText(stepTextByHash: ReadonlyMap<string, string>, step: Record<string, unknown>): string | undefined {
  for (const ref of asArray(step["DDRREF"])) {
    if (!isRecord(ref) || attr(ref, "kind") !== "StepText") continue;
    const hash = attr(ref, "hash");
    if (hash != null) return stepTextByHash.get(hash);
  }
  return undefined;
}

/** Build the reference-resolution lookups for a file: every chunk-list pointer's
 * block (the blocks live in the sibling <DDR_INFO>, not in the catalogs), the
 * rendered step texts, and the custom-function, occurrence, field, and data
 * source indexes. */
export function buildChunkContext(containerNode: Record<string, unknown>, ddrInfo: unknown): ChunkContext {
  const dataSourceIds = new Set<string>();
  for (const source of collectCatalogItems(containerNode["ExternalDataSourceCatalog"], "ExternalDataSource")) {
    const id = attr(source, "id");
    if (id != null) dataSourceIds.add(id);
  }
  const cfByName = customFunctionIds(containerNode);
  const { toByName, toById } = occurrenceIndex(containerNode, dataSourceIds);
  return {
    lists: chunkListBlocks(ddrInfo),
    cfByName,
    cfIndex: makeNameIndex(cfByName.keys()),
    stepTextByHash: stepTextByHash(ddrInfo),
    toByName,
    toById,
    toNames: [...toByName.keys()],
    fieldsByTable: fieldIndex(containerNode),
    dataSourceIds,
  };
}

/** pointer → its block, for every chunk-list block in DDR_INFO. */
function chunkListBlocks(ddrInfo: unknown): Map<string, unknown> {
  const lists = new Map<string, unknown>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (!isRecord(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (!isElementKey(k)) continue;
      // Chunk-list block tags are the pointer the DDRREF names them by, and are
      // the only underscore-prefixed elements in DDR_INFO. The shape varies by
      // FileMaker version — `_<hash>` (older) and `_<UUID>_<suffix>` like
      // `_…_0` / `_…_Condition_1` (newer) — so match on the `_` prefix and let
      // the `ChunkList` child be the real filter. (A version-specific regex here
      // silently dropped every newer-format calc/condition reference.)
      if (k.startsWith("_")) {
        for (const el of asArray(v)) {
          if (isRecord(el) && el["ChunkList"] != null && !lists.has(k)) lists.set(k, el);
        }
      }
      visit(v);
    }
  };
  visit(ddrInfo);
  return lists;
}

/**
 * Harvest the pre-rendered script-step text FileMaker writes into
 * <DDR_INFO><Script><ObjectList>: each entry carries `datatype="StepText"` and
 * a `hash` attribute that is the lookup key. All entries use `_` as their tag
 * name, so the hash attribute is the only unique identifier.
 */
function stepTextByHash(ddrInfo: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = child(child(ddrInfo, "Script"), "ObjectList");
  if (!isRecord(list)) return out;
  for (const [key, value] of Object.entries(list)) {
    if (!isElementKey(key)) continue;
    for (const el of asArray(value)) {
      if (!isRecord(el)) continue;
      if (attr(el, "datatype") !== "StepText") continue;
      const hash = attr(el, "hash");
      const raw = el["#text"];
      if (hash) out.set(hash, typeof raw === "string" ? raw : "");
    }
  }
  return out;
}

/** custom-function name → id (first wins). */
function customFunctionIds(containerNode: Record<string, unknown>): Map<string, string> {
  const cfByName = new Map<string, string>();
  for (const item of collectCatalogItems(containerNode["CustomFunctionsCatalog"], "CustomFunction")) {
    const id = attr(item, "id");
    const name = attr(item, "name");
    if (id != null && name) {
      const decoded = decodeEntities(name);
      if (!cfByName.has(decoded)) cfByName.set(decoded, id);
    }
  }
  return cfByName;
}

function occurrenceIndex(
  containerNode: Record<string, unknown>,
  dataSourceIds: ReadonlySet<string>,
): { toByName: Map<string, OccurrenceInfo>; toById: Map<string, OccurrenceInfo> } {
  const toByName = new Map<string, OccurrenceInfo>();
  const toById = new Map<string, OccurrenceInfo>();
  for (const to of collectCatalogItems(containerNode["TableOccurrenceCatalog"], "TableOccurrence")) {
    const id = attr(to, "id");
    const name = decodeEntities(attr(to, "name") ?? "");
    if (id == null || !name) continue;
    const source = occurrenceSource(to, dataSourceIds);
    const info: OccurrenceInfo = {
      id,
      external: source.external,
      unresolved: source.unresolved,
      ...(!source.external && source.baseTableId != null ? { localBaseTableId: source.baseTableId } : {}),
      ...(source.external && source.baseTableId != null ? { fileOpenAtExport: true } : {}),
    };
    if (!toByName.has(name)) toByName.set(name, info);
    toById.set(id, info);
  }
  return { toByName, toById };
}

/** Local base-table id → its fields by name (first wins), plus a longest-match index. */
function fieldIndex(containerNode: Record<string, unknown>): ChunkContext["fieldsByTable"] {
  const fieldsByTable: ChunkContext["fieldsByTable"] = new Map();
  for (const catalog of fieldCatalogs(containerNode)) {
    const idByName = new Map<string, string>();
    for (const field of collectCatalogItems(catalog.node, "Field")) {
      const id = attr(field, "id");
      const name = decodeEntities(attr(field, "name") ?? "");
      if (id != null && name && !idByName.has(name)) idByName.set(name, id);
    }
    fieldsByTable.set(catalog.tableId, { idByName, index: makeNameIndex(idByName.keys()) });
  }
  return fieldsByTable;
}

/** Each <FieldsForTables><FieldCatalog>, keyed back to its base table by a
 * leading <BaseTableReference>. */
export function fieldCatalogs(containerNode: Record<string, unknown>): { tableId: string; node: unknown }[] {
  const out: { tableId: string; node: unknown }[] = [];
  for (const node of children(containerNode["FieldsForTables"], "FieldCatalog")) {
    const tableId = attr(child(node, "BaseTableReference"), "id");
    if (tableId != null) out.push({ tableId, node });
  }
  return out;
}
