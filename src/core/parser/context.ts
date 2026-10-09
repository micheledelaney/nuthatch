import type { FmFile, FmObject, ObjectType, RawReference, StepIr } from "@/types/ddr";
import { asArray, attr, child, isElementKey, isRecord, textAttr } from "./xmlUtils";
import { makeNameIndex, type NameIndex } from "./calcText";
import { collectCatalogItems, fieldCatalogs } from "./catalogWalk";
import { occurrenceSource, type OccurrenceSource } from "./occurrences";
import type { DeferredButton } from "./objects/deferredLayouts";

/**
 * Everything one file's parse reads and writes. Each file gets its own, so the
 * scanners take their inputs explicitly instead of from module state, and a
 * file that fails to parse leaves nothing half-added behind.
 */
export interface FileParse {
  readonly file: FmFile;
  readonly fileObject: FmObject;
  readonly index: FileIndex;
  /** Button layout targets recorded only in FM 22's <ModifyAction>, by layout id. */
  readonly deferredLayoutTargets: ReadonlyMap<string, DeferredButton[]>;
  /** How many times each layout-object uid has been assigned. FileMaker can
   * clone a whole layout-object subtree without regenerating any identifier in
   * it, so id, the ancestor chain, and even UUID can all collide; the first
   * occurrence keeps its clean uid and every later one gets a stable `#N`
   * suffix, so distinct exported objects never collapse onto one uid. */
  readonly layoutObjectUidCounts: Map<string, number>;
  /** How many catalog items of each type had no `id`, so became no object
   * (see makeObject); reported once the file is read. */
  readonly withoutId: Map<ObjectType, number>;
  /** Theme id → the base theme its layouts' <LayoutThemeReference Base> names,
   * for a theme that doesn't name its own (see addThemeBases). */
  readonly themeBases: Map<string, string>;
  readonly objects: FmObject[];
  readonly references: RawReference[];
  /** Each script's typed steps, by script uid. */
  readonly scriptSteps: Record<string, StepIr[]>;
  /** Shared with the whole parse: problems worth telling the user about. */
  readonly errors: string[];
}

/** An object of a batch the text-based passes read (see addTextDerivedRefs),
 * with the text they read for it: the CDATA of what its element scan read — a
 * field without its switched-off auto-enter / validation calcs, a catalog
 * item's scanned part, a layout's or layout object's own element (what each
 * shows and uses itself) after the placeholder of a layout object's field
 * binding whose field is gone (read from the XML, see missingBinding) — plus,
 * for a button or a custom menu item, its step's rendered text, as a script's
 * steps are read. Not its search `text`, which can be empty (an unlabeled
 * button) or hold decoded attribute values, nor any other text built for
 * display. */
export interface TextScan {
  obj: FmObject;
  text: string;
  /** The XML the text was read from (a script's: its steps), whose formulas'
   * string literals and comments the placeholder passes leave out. */
  source?: unknown;
  /** A script's steps as FileMaker rendered them, by position: what the
   * placeholder passes read of each step — not the step list's display
   * parameters, which add typed text (Insert Text's). */
  renderedSteps?: readonly string[];
}

/** The lookups a file's reference scan resolves against. The name indexes come
 * straight from the catalogs because field calcs are scanned before the
 * occurrence catalog becomes objects. */
export interface FileIndex {
  /** pointer → the `<_HASH>` block node (which contains a <ChunkList>). */
  lists: Map<string, unknown>;
  /** custom-function name → id, for resolving CustomFunctionRef chunks (which
   * carry only the name). */
  cfByName: Map<string, string>;
  /** Longest-match index over the custom-function names (text fallback). */
  cfIndex: NameIndex;
  /** FileMaker's rendered step texts, for steps whose target is only
   * identifiable from that text (a deleted script shows as `<unknown>`). */
  stepTexts: StepTexts;
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

/** A table occurrence of the file: its id and where its records come from. */
export interface OccurrenceInfo extends OccurrenceSource {
  id: string;
}

/** FileMaker's rendered text for each script step (see stepTextIndex). */
export interface StepTexts {
  /** pointer → the entries it names, in document order: one per step, or
   * several for steps that share a pointer (steps without a UUID, FM 22). */
  byPointer: ReadonlyMap<string, readonly { hash: string; text: string }[]>;
  /** hash → the text of the last entry with it, for a pointer with no entry. */
  byHash: ReadonlyMap<string, string>;
}

/** Build the reference-resolution lookups for a file: every chunk-list pointer's
 * block (the blocks live in the sibling <DDR_INFO>, not in the catalogs), the
 * rendered step texts, and the custom-function, occurrence, field, and data
 * source indexes. */
export function buildFileIndex(containerNode: Record<string, unknown>, ddrInfo: unknown): FileIndex {
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
    stepTexts: stepTextIndex(ddrInfo),
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
      for (const el of asArray(v)) {
        // Chunk-list block tags are the pointer the DDRREF names them by, and are
        // the only underscore-prefixed elements in DDR_INFO. The shape varies by
        // FileMaker version — `_<hash>` (older) and `_<UUID>_<suffix>` like
        // `_…_0` / `_…_Condition_1` (newer) — so match on the `_` prefix and let
        // the `ChunkList` child be the real filter. (A version-specific regex here
        // silently dropped every newer-format calc/condition reference.) A
        // block's chunks hold no further blocks, so it isn't descended into.
        if (k.startsWith("_") && isRecord(el) && el["ChunkList"] != null) {
          if (!lists.has(k)) lists.set(k, el);
        } else {
          visit(el);
        }
      }
    }
  };
  visit(ddrInfo);
  return lists;
}

/**
 * Harvest the pre-rendered script-step text FileMaker writes into
 * <DDR_INFO><Script><ObjectList>: one `<_<pointer> hash datatype="StepText">`
 * entry per step, named by the pointer its `<DDRREF kind="StepText">` holds.
 * The hash isn't the step's own: steps whose XML is identical share it though
 * their text differs (a Perform Script into one file or another that wasn't
 * open), so it only tells apart the steps that share a pointer.
 */
function stepTextIndex(ddrInfo: unknown): StepTexts {
  const byPointer = new Map<string, { hash: string; text: string }[]>();
  const byHash = new Map<string, string>();
  const list = child(child(ddrInfo, "Script"), "ObjectList");
  if (!isRecord(list)) return { byPointer, byHash };
  for (const [key, value] of Object.entries(list)) {
    if (!isElementKey(key)) continue;
    for (const el of asArray(value)) {
      if (!isRecord(el) || attr(el, "datatype") !== "StepText") continue;
      const hash = attr(el, "hash") ?? "";
      const raw = el["#text"];
      const entry = { hash, text: typeof raw === "string" ? raw : "" };
      const entries = byPointer.get(key);
      if (entries) entries.push(entry);
      else byPointer.set(key, [entry]);
      if (hash) byHash.set(hash, entry.text);
    }
  }
  return { byPointer, byHash };
}

/** custom-function name → id (first wins). */
function customFunctionIds(containerNode: Record<string, unknown>): Map<string, string> {
  const cfByName = new Map<string, string>();
  for (const item of collectCatalogItems(containerNode["CustomFunctionsCatalog"], "CustomFunction")) {
    const id = attr(item, "id");
    const name = textAttr(item, "name");
    if (id != null && name && !cfByName.has(name)) cfByName.set(name, id);
  }
  return cfByName;
}

function occurrenceIndex(
  containerNode: Record<string, unknown>,
  dataSourceIds: ReadonlySet<string>,
): Pick<FileIndex, "toByName" | "toById"> {
  const toByName = new Map<string, OccurrenceInfo>();
  const toById = new Map<string, OccurrenceInfo>();
  for (const to of collectCatalogItems(containerNode["TableOccurrenceCatalog"], "TableOccurrence")) {
    const id = attr(to, "id");
    if (id == null) continue;
    const info: OccurrenceInfo = { id, ...occurrenceSource(to, dataSourceIds) };
    const name = textAttr(to, "name") ?? "";
    if (name && !toByName.has(name)) toByName.set(name, info);
    if (!toById.has(id)) toById.set(id, info);
  }
  return { toByName, toById };
}

/** Local base-table id → its fields by name (first wins), plus a longest-match index. */
function fieldIndex(containerNode: Record<string, unknown>): FileIndex["fieldsByTable"] {
  const fieldsByTable: FileIndex["fieldsByTable"] = new Map();
  for (const catalog of fieldCatalogs(containerNode)) {
    const idByName = new Map<string, string>();
    for (const field of collectCatalogItems(catalog.node, "Field")) {
      const id = attr(field, "id");
      const name = textAttr(field, "name") ?? "";
      if (id != null && name && !idByName.has(name)) idByName.set(name, id);
    }
    fieldsByTable.set(catalog.tableId, { idByName, index: makeNameIndex(idByName.keys()) });
  }
  return fieldsByTable;
}
