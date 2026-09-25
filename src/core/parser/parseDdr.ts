import { XMLParser } from "fast-xml-parser";
import type {
  FmFile,
  FmObject,
  LayoutObjectInfo,
  LayoutTriggerInfo,
  ObjectType,
  ParseResult,
  RawReference,
} from "@/types/ddr";
import { isBrokenTableOccurrence, isUnresolvedTableOccurrence } from "@/types/ddr";
import { ATTR_PREFIX, asArray, attr, attributes, collectText, isRecord } from "./xmlUtils";
import { FMSAVEAS_REF_TAGS, PSEUDO_MENU_SETS, edgeKind } from "./refTags";
import {
  chunkListMatchesText,
  fieldNameCandidate,
  globalVariablesInText,
  isWordChar,
  longestNameAt,
  longestNameEndingAt,
  makeNameIndex,
  quotedGlobalVariables,
  stripLiteralsAndComments,
  type NameIndex,
} from "./calcText";
import {
  calculationText,
  customFunctionDetail,
  layoutDetail,
  layoutTriggers,
  privilegeSetDetail,
  qualifiedField,
  relationshipDetail,
  scriptSteps,
  valueListDetail,
} from "./extractDetail";
import { decodeEntities } from "./entities";

interface SourceDoc {
  name: string;
  content: string;
}

type RefTags = Readonly<Record<string, ObjectType>>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Large FileMaker exports contain thousands of character entities in calc
  // text; we treat text verbatim, so skip entity expansion (faster, and avoids
  // the parser's billion-laughs guard tripping on legitimate large files).
  processEntities: false,
});

/**
 * Parse one or more FileMaker "Save a Copy as XML" (<FMSaveAsXML>) documents
 * into a flat, serializable model. References are emitted unresolved; buildModel
 * resolves and indexes them.
 */
export function parseDocuments(docs: SourceDoc[]): ParseResult {
  const files: FmFile[] = [];
  const objects: FmObject[] = [];
  const references: RawReference[] = [];
  const errors: string[] = [];

  refTextOverrides = new Map();
  try {
    parseAll(docs, files, objects, references, errors);
  } finally {
    refTextOverrides = null;
  }
  return { files, objects, references: dedupeRefs(references), errors };
}

function parseAll(
  docs: SourceDoc[],
  files: FmFile[],
  objects: FmObject[],
  references: RawReference[],
  errors: string[],
): void {
  let fileIndex = 0;
  for (const doc of docs) {
    // LayoutCatalog dominates large DDR files (often 80-90% of the XML). To avoid
    // building a massive object-tree for it all at once, we extract the catalog
    // before parsing, replace it with an empty stub so the main parse is cheap,
    // then re-parse layouts one at a time inside parseFile.
    const lcBounds = findLayoutCatalogBounds(doc.content);
    const parseContent = lcBounds
      ? doc.content.slice(0, lcBounds.start) + "<LayoutCatalog/>" + doc.content.slice(lcBounds.end)
      : doc.content;
    const layoutCatalogXml = lcBounds ? doc.content.slice(lcBounds.start, lcBounds.end) : undefined;

    let root: unknown;
    try {
      root = xmlParser.parse(parseContent);
    } catch (err) {
      errors.push(`${doc.name}: failed to parse XML — ${(err as Error).message}`);
      continue;
    }

    const containers = locateContainers(root, doc.name);
    if (containers.length === 0) {
      errors.push(
        `${doc.name}: no <FMSaveAsXML> structure found — not a recognized FileMaker "Save a Copy as XML" export.`,
      );
      continue;
    }

    for (const container of containers) {
      // Calculation and step references resolve precisely through the DDR_INFO
      // <ChunkList> blocks. Without DDR_INFO only the best-effort scan of each
      // calc's text is left (and script steps lose their rendered text), so
      // references would be silently incomplete. Surface that.
      if (container.ddrInfo == null) {
        errors.push(
          `${doc.name}: missing <DDR_INFO> — references inside calculations and script steps cannot be resolved. Re-export with "Include details for analysis tools" enabled.`,
        );
      }
      const ctx = makeFileContext(container, fileIndex++);
      files.push(ctx.file);
      objects.push(ctx.fileObject);
      parseFile(container, ctx, objects, references, errors, layoutCatalogXml);
    }
  }

  addMissingCalcFieldRefs(objects, references);
  addMissingCustomFunctionRefs(objects, references);
  addBrokenTableOccurrenceRefs(objects, references);
  addGlobalVariables(objects, references);
  // Must run AFTER the passes above: they scan the full layout text for
  // <<$$merge>> variables and <Field Missing>/<Function Missing> tokens, which
  // compaction discards.
  compactLayoutText(objects);
}

interface ChunkContext {
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
}

interface OccurrenceInfo {
  id: string;
  /** Local base-table id; undefined for external occurrences (their base table
   * lives in another file) and for broken ones. */
  localBaseTableId?: string;
  external: boolean;
}

/**
 * Harvest the pre-rendered script-step text FileMaker writes into
 * <DDR_INFO><Script><ObjectList>: each entry carries `datatype="StepText"` and
 * a `hash` attribute that is the lookup key. All entries use `_` as their tag
 * name, so the hash attribute is the only unique identifier.
 */
function buildStepTextByHash(ddrInfo: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(ddrInfo)) return out;
  const script = asArray(ddrInfo["Script"])[0];
  if (!isRecord(script)) return out;
  const list = asArray(script["ObjectList"])[0];
  if (!isRecord(list)) return out;
  for (const [key, value] of Object.entries(list)) {
    if (key.startsWith(ATTR_PREFIX) || key === "#text") continue;
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

/** Active while parsing one file, so scanRefs can resolve that file's chunk-list
 * pointers and custom-function-call chunks. */
let chunkContext: ChunkContext | null = null;

/** Active while parsing one file's layouts: counts how many times each layoutObject
 * uid has already been assigned. Normally every uid is assigned once — but FileMaker
 * can clone an entire layout-object subtree (e.g. a duplicated panel) without
 * regenerating any identifier anywhere in it, so id, the full ancestor chain, and
 * even UUID can all collide. When that happens, the first occurrence keeps its clean
 * uid and every later one gets a stable `#N` suffix, so distinct exported objects
 * never silently collapse onto the same uid. */
let layoutObjectUidCounts: Map<string, number> | null = null;

/** Build the chunk-resolution context for a file: a map from every chunk-list
 * pointer to its block (the blocks live in the sibling <DDR_INFO>, not in the
 * catalogs), the file's custom-function name→id lookup, and the occurrence /
 * field / function name indexes the calc-text fallback matches against. The
 * indexes come straight from the catalogs because field calcs are scanned
 * before the occurrence catalog becomes objects. */
function buildChunkContext(
  containerNode: Record<string, unknown>,
  ddrInfo: unknown,
  stepTextByHash: Map<string, string>,
): ChunkContext {
  const lists = new Map<string, unknown>();
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (!isRecord(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith(ATTR_PREFIX) || k === "#text") continue;
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

  const cfByName = new Map<string, string>();
  for (const catalogKey of ["CustomFunctionCatalog", "CustomFunctionsCatalog"]) {
    for (const item of collectCatalogItems(containerNode[catalogKey], "CustomFunction")) {
      const id = attr(item, "id");
      const name = attr(item, "name");
      if (id != null && name) {
        const decoded = decodeEntities(name);
        if (!cfByName.has(decoded)) cfByName.set(decoded, id);
      }
    }
  }

  const toByName = new Map<string, OccurrenceInfo>();
  const toById = new Map<string, OccurrenceInfo>();
  for (const to of collectCatalogItems(containerNode["TableOccurrenceCatalog"], "TableOccurrence")) {
    const id = attr(to, "id");
    const name = decodeEntities(attr(to, "name") ?? "");
    if (id == null || !name) continue;
    const external = attr(to, "type") === "External";
    const source = asArray(isRecord(to) ? to["BaseTableSourceReference"] : undefined)[0];
    const baseTableId = attr(asArray(isRecord(source) ? source["BaseTableReference"] : undefined)[0], "id");
    const info: OccurrenceInfo = { id, external, ...(!external && baseTableId != null ? { localBaseTableId: baseTableId } : {}) };
    if (!toByName.has(name)) toByName.set(name, info);
    toById.set(id, info);
  }

  const fieldsByTable = new Map<string, { idByName: Map<string, string>; index: NameIndex }>();
  const fieldsForTables = containerNode["FieldsForTables"];
  for (const catalog of asArray(isRecord(fieldsForTables) ? fieldsForTables["FieldCatalog"] : undefined)) {
    const tableId = attr(isRecord(catalog) ? catalog["BaseTableReference"] : undefined, "id");
    if (tableId == null) continue;
    const idByName = new Map<string, string>();
    for (const field of collectCatalogItems(catalog, "Field")) {
      const id = attr(field, "id");
      const name = decodeEntities(attr(field, "name") ?? "");
      if (id != null && name && !idByName.has(name)) idByName.set(name, id);
    }
    fieldsByTable.set(tableId, { idByName, index: makeNameIndex(idByName.keys()) });
  }

  return {
    lists,
    cfByName,
    cfIndex: makeNameIndex(cfByName.keys()),
    stepTextByHash,
    toByName,
    toById,
    toNames: [...toByName.keys()],
    fieldsByTable,
  };
}

/** Drop exact-duplicate references (same source, target, occurrence context, and
 * originating step). The text-based passes can rediscover an edge another pass
 * already recorded; collapsing them keeps reference counts honest. Distinct step
 * usages (different fromStep) are preserved, since broken-step flagging needs them. */
function dedupeRefs(refs: RawReference[]): RawReference[] {
  const seen = new Set<string>();
  const out: RawReference[] = [];
  for (const r of refs) {
    // Name-based references share an empty toId, so their name is the identity.
    const key = `${r.fromUid}|${r.toType}|${r.toId}|${r.byName ? r.toName : ""}|${r.viaToId ?? ""}|${r.viaBaseTableId ?? ""}|${r.fromStep ?? ""}|${r.toFileName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Global variables ($$name) have no catalog — they exist only where FileMaker
 * reads or sets them. scanRefs records each use as a `globalVariable` edge from
 * exact export data: the `VariableReference` chunks of calculation chunk lists,
 * and the variable a Set Variable (or "Target: $$x") step writes — with a scan of
 * the formula itself only for a calc whose chunk list is unusable. Layout text
 * can also merge a variable (`<<$$name>>`), which no chunk records, so those are
 * picked up here from the full layout text (before compactLayoutText trims it).
 * Each distinct name becomes one navigable object per file (the same $$x in two
 * files is two objects), so a variable lists its users and each script/calc the
 * globals it touches. Best-effort: a variable handled by name is only caught when
 * the whole name is one string literal (`Map.Clear ( "$$_MAP" )`); names built
 * dynamically (e.g. via Evaluate) can't be detected.
 */
const MERGE_VARIABLE_RE = /<<(\$\$[^<>]+)>>/g;

function addGlobalVariables(objects: FmObject[], references: RawReference[]): void {
  for (const obj of objects) {
    if ((obj.type !== "layout" && obj.type !== "layoutObject") || !obj.text.includes("<<$$")) continue;
    const names = new Set<string>();
    for (const m of obj.text.matchAll(MERGE_VARIABLE_RE)) names.add(m[1]!.trim());
    for (const name of names) {
      references.push({ fromUid: obj.uid, toType: "globalVariable", toId: name, toName: name, kind: "globalVariable" });
    }
  }

  // fileUid -> (variable name -> use count); plus the file's display name. The
  // count is taken before dedupeRefs, so a calc that reads $$x twice counts two.
  const fileNames = new Map<string, string>();
  for (const obj of objects) if (obj.type === "file") fileNames.set(obj.fileUid, obj.fileName);
  const byFile = new Map<string, { fileName: string; vars: Map<string, number> }>();
  for (const ref of references) {
    if (ref.toType !== "globalVariable") continue;
    const fileUid = ref.fromUid.slice(0, ref.fromUid.indexOf(":"));
    let entry = byFile.get(fileUid);
    if (!entry) byFile.set(fileUid, (entry = { fileName: fileNames.get(fileUid) ?? "", vars: new Map() }));
    entry.vars.set(ref.toId, (entry.vars.get(ref.toId) ?? 0) + 1);
  }

  for (const [fileUid, { fileName, vars }] of byFile) {
    for (const [name, count] of vars) {
      objects.push({
        uid: `${fileUid}:globalVariable:${name}`,
        type: "globalVariable",
        id: name,
        name,
        fileUid,
        fileName,
        attributes: { occurrences: String(count) },
        text: name,
      });
    }
  }
}

/** Sentinel id for the (non-existent) base table of a broken occurrence. */
const MISSING_TABLE_ID = "<missing>";

/**
 * A local table occurrence whose base table was deleted has no
 * `<BaseTableReference>`, so the element scan emits no base-table edge for it.
 * Record that missing base table as an explicitly broken reference so the
 * occurrence is flagged broken like any other dangling reference.
 *
 * External occurrences are skipped: one whose data source was deleted is
 * already flagged by its own (broken) `<DataSourceReference>` edge, and one that
 * merely couldn't be resolved at export time isn't broken at all
 * (isUnresolvedTableOccurrence).
 */
function addBrokenTableOccurrenceRefs(objects: FmObject[], references: RawReference[]): void {
  for (const obj of objects) {
    if (!isBrokenTableOccurrence(obj) || obj.attributes.externalDataSource != null) continue;
    references.push({
      fromUid: obj.uid,
      toType: "table",
      toId: MISSING_TABLE_ID,
      toName: decodeEntities(obj.attributes.externalDataSource ?? "") || "<unknown>",
      kind: "table",
      forceBroken: true,
    });
  }
}

/** Placeholders FileMaker writes into rendered text when a referenced object was
 * deleted, plus the sentinel id we record for the resulting broken edge. */
const MISSING_FIELD_TOKEN = "<Field Missing>";
const MISSING_FUNCTION_TOKEN = "<Function Missing>";
const MISSING_REF_ID = "<missing>";

/**
 * Invoke `emit` for every object whose reference-bearing text contains `token`.
 * Scripts are scanned per step (so the broken edge carries `fromStep` and the
 * right line lights up); every other object is scanned once. Shared by the
 * missing-field and missing-function passes — the placeholders carry no
 * identity, so it's one edge per step (scripts) or per object, not per distinct
 * missing target. A field is scanned through its *active* calcs only
 * (refTextOverrides), so a disabled auto-enter calc naming a deleted field
 * doesn't flag it.
 */
function forEachPlaceholderUse(
  objects: FmObject[],
  token: string,
  emit: (obj: FmObject, text: string, fromStep?: number, disabled?: boolean) => void,
): void {
  for (const obj of objects) {
    if (obj.type === "file" || !obj.text) continue;
    if (obj.detail?.kind === "script") {
      for (const step of obj.detail.steps) {
        if (step.params.includes(token)) emit(obj, step.params, step.index, !step.enabled);
      }
      continue;
    }
    const text = refTextOverrides?.get(obj.uid) ?? obj.text;
    if (text.includes(token)) emit(obj, text);
  }
}

/** Active while parseDocuments runs: per-object text the placeholder passes scan
 * instead of `obj.text` (a field's active calcs, without disabled auto-enter /
 * validation calcs that still sit in the XML). */
let refTextOverrides: Map<string, string> | null = null;

/**
 * A reference to a deleted field is never recorded structurally: FileMaker
 * omits the `<FieldReference>` (and its chunk entry) and leaves only the
 * literal `<Field Missing>` placeholder in whatever text carries the reference
 * — a calc field's body, a script step's parameter, a custom function's body,
 * a layout trigger's parameter, a relationship predicate, etc. This pass scans
 * every object's searchable text for the placeholder and emits an explicitly
 * broken field edge so the object is flagged like any other dangling reference.
 *
 * FileMaker writes the same placeholder when it simply couldn't resolve a field
 * because the occurrence's file wasn't available at export — so a placeholder
 * behind an occurrence that was unresolved at export (isUnresolvedTableOccurrence)
 * proves nothing and is not counted.
 */
function addMissingCalcFieldRefs(objects: FmObject[], references: RawReference[]): void {
  // Per-file occurrence lookup so the placeholder's preceding "Occ::" can be
  // recovered as a viaToId — the field is gone but the occurrence is still a
  // navigable target (keeps the TO clickable inline, and surfaces the broken
  // ref under its inbound list).
  const occByFile = new Map<string, Map<string, FmObject>>();
  for (const o of objects) {
    if (o.type !== "tableOccurrence") continue;
    let m = occByFile.get(o.fileUid);
    if (!m) occByFile.set(o.fileUid, (m = new Map()));
    if (!m.has(o.name)) m.set(o.name, o);
  }
  const namesByFile = new Map<string, string[]>();
  for (const [fileUid, m] of occByFile) namesByFile.set(fileUid, [...m.keys()]);
  // Classify every placeholder in the text: one qualified by an occurrence that
  // was unresolved at export is unverifiable and skipped; any other (qualified by
  // a real or missing occurrence, or bare) is a deleted field. Returns the
  // occurrence of the first deleted one (the navigable context), or null when
  // every placeholder was unverifiable.
  const deletedFieldVia = (text: string, fileUid: string): { viaToId?: string } | null => {
    const occs = occByFile.get(fileUid);
    const names = namesByFile.get(fileUid) ?? [];
    for (let pos = text.indexOf(MISSING_FIELD_TOKEN); pos !== -1; pos = text.indexOf(MISSING_FIELD_TOKEN, pos + 1)) {
      if (!text.endsWith("::", pos)) return {};
      const name = longestNameEndingAt(text, pos - 2, names);
      const occ = name != null ? occs?.get(name) : undefined;
      if (occ && isUnresolvedTableOccurrence(occ)) continue;
      return occ ? { viaToId: occ.id } : {};
    }
    return null;
  };
  // Sometimes FileMaker leaves the `<FieldReference>` element in place with a
  // blank name/UUID instead of omitting it outright — already scanned
  // structurally (blank toName) — while its rendered text *also* carries the
  // "<Field Missing>" placeholder this pass looks for. Without this check,
  // that single dangling field would be counted and displayed twice. Keyed by
  // step for scripts (one placeholder edge per step) and by object otherwise.
  const alreadyBroken = new Set<string>();
  for (const r of references) {
    if (r.toType === "field" && r.toName === "") alreadyBroken.add(`${r.fromUid} ${r.fromStep ?? ""}`);
  }
  forEachPlaceholderUse(objects, MISSING_FIELD_TOKEN, (obj, text, fromStep, disabled) => {
    if (alreadyBroken.has(`${obj.uid} ${fromStep ?? ""}`)) return;
    const deleted = deletedFieldVia(text, obj.fileUid);
    if (!deleted) return;
    const ref: RawReference = {
      fromUid: obj.uid,
      toType: "field",
      toId: MISSING_REF_ID,
      toName: MISSING_FIELD_TOKEN,
      kind: "field",
      forceBroken: true,
    };
    if (deleted.viaToId != null) ref.viaToId = deleted.viaToId;
    if (fromStep != null) ref.fromStep = fromStep;
    if (disabled) ref.disabled = true;
    references.push(ref);
  });
}

/**
 * The custom-function analog of addMissingCalcFieldRefs: when a calculation,
 * script step, or custom-function body calls a *deleted* custom function,
 * FileMaker leaves only a literal `<Function Missing>` placeholder (no resolvable
 * chunk), so the dependency would otherwise vanish. Emit an explicitly broken
 * customFunction edge so the calling object reads as broken like any other
 * dangling reference.
 */
function addMissingCustomFunctionRefs(objects: FmObject[], references: RawReference[]): void {
  forEachPlaceholderUse(objects, MISSING_FUNCTION_TOKEN, (obj, _text, fromStep, disabled) => {
    const ref: RawReference = {
      fromUid: obj.uid,
      toType: "customFunction",
      toId: MISSING_REF_ID,
      toName: MISSING_FUNCTION_TOKEN,
      kind: "customFunction",
      forceBroken: true,
    };
    if (fromStep != null) ref.fromStep = fromStep;
    if (disabled) ref.disabled = true;
    references.push(ref);
  });
}

interface Container {
  node: unknown;
  /** The sibling <DDR_INFO> section, where calculation chunk-list definitions
   * live (the catalogs only carry pointers into it). */
  ddrInfo: unknown;
  /** The sibling <Metadata> section, which holds file-level options and the
   * file's own script triggers (File Options). */
  metadata: unknown;
  name: string;
  source: string;
  /** FileMaker application version that produced the export, if present. */
  version?: string;
}

/** Find the catalog-bearing <FMSaveAsXML> container, if this is one. */
function locateContainers(root: unknown, source: string): Container[] {
  if (!isRecord(root)) return [];

  const saveAs = root["FMSaveAsXML"];
  if (isRecord(saveAs)) {
    const structure = saveAs["Structure"];
    const addAction = isRecord(structure) ? structure["AddAction"] : undefined;
    return [
      {
        node: addAction ?? structure,
        ddrInfo: saveAs["DDR_INFO"],
        metadata: saveAs["Metadata"],
        name: decodeEntities(attr(saveAs, "File") ?? "Untitled").replace(/\.fmp12$/i, ""),
        source,
        // The FileMaker app version lives in `Source`; `version` is the schema.
        version: attr(saveAs, "Source"),
      },
    ];
  }

  return [];
}

interface FileContext {
  file: FmFile;
  fileObject: FmObject;
  refTags: RefTags;
}

function makeFileContext(container: Container, index: number): FileContext {
  const uid = `F${index}`;
  const file: FmFile = { uid, name: container.name, source: container.source, version: container.version };
  const { attributes, triggers } = fileMetadata(container.metadata);
  const fileObject: FmObject = {
    uid: `${uid}:file:${uid}`,
    type: "file",
    id: uid,
    name: container.name,
    fileUid: uid,
    fileName: container.name,
    attributes,
    text: container.name,
  };
  if (triggers.length) fileObject.detail = { kind: "file", triggers };
  return { file, fileObject, refTags: FMSAVEAS_REF_TAGS };
}

/**
 * File Options, from the <Metadata><AddAction> block beside <Structure>: the
 * file's own script triggers, plus the high-signal scalar options (auto-login
 * account, encryption, minimum version) lifted into `attributes` for display.
 * The trigger script references are wired separately by scanning this block.
 */
function fileMetadata(metadata: unknown): { attributes: Record<string, string>; triggers: LayoutTriggerInfo[] } {
  const add = asArray(isRecord(metadata) ? metadata["AddAction"] : undefined)[0];
  const attributes: Record<string, string> = {};
  if (isRecord(add)) {
    // Auto-login: the file opens straight into this account, no sign-in dialog.
    // The account lives under <AccountName> (older export) or <UserName> (newer).
    // Read only the account, never the sibling password the DDR stores in clear.
    const login = asArray(add["Login"])[0];
    if (isRecord(login)) {
      const account = decodeEntities(collectText(login["AccountName"]) || collectText(login["UserName"])).trim();
      attributes.autoLogin = account ? `Account “${account}”` : "Guest account";
    }
    // Encryption at rest: type 0 means none.
    const encryption = attr(asArray(add["Encryption"])[0], "type");
    if (encryption != null) attributes.encryption = encryption === "0" ? "None" : "Enabled";
    // Minimum FileMaker version allowed to open the file.
    const minVersion = attr(asArray(add["Minimum"])[0], "version");
    if (minVersion) attributes.minimumVersion = minVersion;
  }
  return { attributes, triggers: layoutTriggers(isRecord(add) ? add["ScriptTriggers"] : undefined) };
}

interface CatalogSpec {
  catalogKey: string;
  itemTag: string;
  type: ObjectType;
  scanRefs: boolean;
}

/** Catalogs whose items map directly to objects. Missing catalogs are skipped. */
const CATALOGS: CatalogSpec[] = [
  { catalogKey: "PrivilegeSetsCatalog", itemTag: "PrivilegeSet", type: "privilegeSet", scanRefs: false },
  { catalogKey: "AccountsCatalog", itemTag: "Account", type: "account", scanRefs: true },
  { catalogKey: "TableOccurrenceCatalog", itemTag: "TableOccurrence", type: "tableOccurrence", scanRefs: true },
  { catalogKey: "RelationshipCatalog", itemTag: "Relationship", type: "relationship", scanRefs: true },
  { catalogKey: "ValueListCatalog", itemTag: "ValueList", type: "valueList", scanRefs: true },
  { catalogKey: "CustomFunctionCatalog", itemTag: "CustomFunction", type: "customFunction", scanRefs: true },
  { catalogKey: "CustomFunctionsCatalog", itemTag: "CustomFunction", type: "customFunction", scanRefs: true },
  { catalogKey: "ExtendedPrivilegesCatalog", itemTag: "ExtendedPrivilege", type: "extendedPrivilege", scanRefs: false },
  { catalogKey: "FileAccessCatalog", itemTag: "Authorization", type: "fileAccess", scanRefs: false },
  { catalogKey: "ExternalDataSourceCatalog", itemTag: "ExternalDataSource", type: "externalDataSource", scanRefs: false },
  { catalogKey: "CustomMenuSetCatalog", itemTag: "CustomMenuSet", type: "customMenuSet", scanRefs: true },
  { catalogKey: "CustomMenuCatalog", itemTag: "CustomMenu", type: "customMenu", scanRefs: false },
  { catalogKey: "ThemeCatalog", itemTag: "Theme", type: "theme", scanRefs: false },
];

function parseFile(
  container: Container,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  errors: string[],
  layoutCatalogXml?: string,
): void {
  const containerNode = container.node;
  if (!isRecord(containerNode)) return;

  const stepTextByUuid = buildStepTextByHash(container.ddrInfo);
  chunkContext = buildChunkContext(containerNode, container.ddrInfo, stepTextByUuid);
  layoutObjectUidCounts = new Map();
  try {
    // File-level dependencies (script triggers, default layout, menu set) live in
    // the <Metadata> block, scanned against the file object itself — inside the
    // chunk context, so a trigger parameter's calc references resolve too.
    scanRefs(container.metadata, ctx.fileObject.uid, {}, ctx.refTags, references);
    parseFileBody(containerNode, ctx, objects, references, stepTextByUuid);
    // Parse layouts one at a time to avoid holding a huge object-tree for the
    // full LayoutCatalog (which can be 80-90% of a large DDR file).
    if (layoutCatalogXml) {
      parseLayoutsStreaming(layoutCatalogXml, ctx, objects, references, stepTextByUuid, errors);
    }
  } finally {
    chunkContext = null;
    layoutObjectUidCounts = null;
  }
}

function parseFileBody(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  stepTextByUuid: Map<string, string>,
): void {
  parseTablesAndFields(containerNode, ctx, objects, references);
  parseScripts(containerNode, ctx, objects, references, stepTextByUuid);
  parseLayouts(containerNode, ctx, objects, references, stepTextByUuid);

  // The file's defined external data sources, so an occurrence pointing at one
  // that no longer exists reads as broken rather than merely unresolved.
  const dataSourceIds = new Set<string>();
  for (const source of collectCatalogItems(containerNode["ExternalDataSourceCatalog"], "ExternalDataSource")) {
    const id = attr(source, "id");
    if (id != null) dataSourceIds.add(id);
  }

  for (const spec of CATALOGS) {
    const items = collectCatalogItems(containerNode[spec.catalogKey], spec.itemTag);
    for (const item of items) {
      const obj = makeObject(item, spec.type, ctx);
      if (!obj) continue;
      const detail = detailFor(spec.type, item);
      if (detail) obj.detail = detail;
      if (obj.type === "tableOccurrence") annotateTableOccurrence(item, obj, dataSourceIds);
      if (obj.type === "account") annotateAccount(item, obj);
      if (obj.type === "privilegeSet") annotatePrivilegeSet(item, obj);
      if (obj.type === "valueList") annotateValueList(item, obj);
      if (obj.type === "theme") annotateTheme(item, obj);
      if (obj.type === "fileAccess") annotateFileAccess(item, obj);
      if (obj.type === "extendedPrivilege") {
        annotateExtendedPrivilege(item, obj);
        addExtendedPrivilegeGrants(item, obj, ctx, references);
      }
      if (obj.type === "externalDataSource") annotateExternalDataSource(item, obj);
      if (obj.type === "customMenu") annotateCustomMenu(item, obj);
      if (obj.type === "customMenuSet") annotateCustomMenuSet(item, obj);
      objects.push(obj);
      if (spec.scanRefs) scanRefs(item, obj.uid, {}, ctx.refTags, references);
      // A privilege set's per-object grants aren't dependencies, but the formulas
      // behind its "Limited" record access are: they call fields and functions.
      if (obj.type === "privilegeSet") scanRefs(recordAccessCalcs(item), obj.uid, {}, ctx.refTags, references);
      // A custom menu's items are scanned on their own; its install condition is
      // the menu's own calc.
      if (obj.type === "customMenu" && isRecord(item)) scanRefs(item["Conditions"], obj.uid, {}, ctx.refTags, references);
    }
  }

  attachCustomFunctionCalcs(containerNode, ctx, objects, references);
  attachValueListFields(containerNode, ctx, objects, references);
  parseCustomMenuItems(containerNode, ctx, objects, references);
}

/**
 * Custom menu items live nested inside each <CustomMenu>'s <MenuItemList>, not in
 * a catalog of their own, so the generic CATALOGS pass can't reach them. Each
 * <CustomMenuItem> carries no `id` (only `hash` + `index`), so build it directly,
 * namespacing the uid by the owning menu's id and using `index` as the per-menu
 * id. The item's name comes from whichever it is: a built-in <Command>, a
 * <CustomMenuReference> submenu, or a Perform Script step's <ScriptReference>;
 * separators are kept (in order) and flagged like the script/layout dividers.
 */
function parseCustomMenuItems(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
): void {
  for (const menu of collectCatalogItems(containerNode["CustomMenuCatalog"], "CustomMenu")) {
    if (!isRecord(menu)) continue;
    const menuId = attr(menu, "id");
    if (menuId == null) continue;
    const menuUid = `${ctx.file.uid}:customMenu:${menuId}`;
    const menuName = decodeEntities(attr(menu, "name") ?? "");
    const list = asArray(menu["MenuItemList"])[0];
    if (!isRecord(list)) continue;
    let order = 0;
    for (const item of asArray(list["CustomMenuItem"])) {
      if (!isRecord(item)) continue;
      const index = attr(item, "index") ?? String(order);
      const isSeparator = attr(item, "isSeparatorItem") === "True";
      const attributes: Record<string, string> = { menu: menuName, itemType: menuItemKind(item) };
      const itemHash = attr(item, "hash");
      if (itemHash) attributes.hash = itemHash;
      const shortcut = menuItemShortcut(item);
      if (shortcut) attributes.shortcut = shortcut;
      const install = installCondition(item);
      if (install) attributes.installCondition = install;
      const overrides = menuItemOverrides(item);
      if (overrides) attributes.overrides = overrides;
      const uuid = collectText(item["UUID"]).trim();
      if (uuid) attributes.uuid = uuid;
      const obj: FmObject = {
        uid: `${ctx.file.uid}:customMenuItem:${menuId}.${index}`,
        type: "customMenuItem",
        id: index,
        name: menuItemName(item),
        fileUid: ctx.file.uid,
        fileName: ctx.file.name,
        parentUid: menuUid,
        attributes,
        text: collectText(item),
        order: order++,
      };
      if (isSeparator) obj.isSeparator = true;
      objects.push(obj);
      if (!obj.isSeparator) {
        // A menu item exists only as part of its menu, so the menu is what
        // "references" it — emit a containment edge (menu -> item) so the item
        // lists its menu under "Referenced by". toId mirrors the item's uid id
        // part so buildModel resolves it. The menu's view shows these in its
        // dedicated "Menu items" section, not its outbound list.
        references.push({
          fromUid: menuUid,
          toType: "customMenuItem",
          toId: `${menuId}.${index}`,
          toName: obj.name,
          kind: "menuItem",
        });
        // Catch the script a menu item performs and the submenu it opens (both
        // via Reference tags now in refTags).
        scanRefs(item, obj.uid, {}, ctx.refTags, references);
      }
    }
  }
}

/** Best label for a custom menu item: a built-in command, a submenu it opens, or
 * the script it performs; falls back to a generic separator/item label. */
function menuItemName(item: Record<string, unknown>): string {
  if (attr(item, "isSeparatorItem") === "True") return "—";
  const command = attr(asArray(item["Command"])[0], "name");
  if (command) return decodeEntities(command);
  const submenu = attr(asArray(item["CustomMenuReference"])[0], "name");
  if (submenu) return decodeEntities(submenu);
  const scriptName = findScriptReferenceName(item);
  if (scriptName) return `Perform Script: ${scriptName}`;
  return "(menu item)";
}

/** What a menu item does, for the inspector: a divider, a submenu, a built-in
 * command, a performed script, or some other custom action. */
function menuItemKind(item: Record<string, unknown>): string {
  if (attr(item, "isSeparatorItem") === "True") return "Separator";
  if (attr(item, "isSubMenuItem") === "True" || item["CustomMenuReference"]) return "Submenu";
  if (item["Command"]) return "Command";
  if (findScriptReferenceName(item)) return "Performs script";
  return "Custom";
}

/** Which parts of the base command a menu item overrides (<Override name action
 * Shortcut>), e.g. "Name, Shortcut"; "" when it overrides nothing. */
function menuItemOverrides(item: Record<string, unknown>): string {
  const override = asArray(item["Override"])[0];
  if (!isRecord(override)) return "";
  const LABELS: ReadonlyArray<[string, string]> = [
    ["name", "Name"],
    ["action", "Action"],
    ["Shortcut", "Shortcut"],
  ];
  return LABELS.filter(([key]) => attr(override, key) === "True")
    .map(([, label]) => label)
    .join(", ");
}

/** A menu item's keyboard shortcut, as the raw key/modifier codes FileMaker
 * records (e.g. "key 79, modifier 4"); only present when one is assigned. */
function menuItemShortcut(item: Record<string, unknown>): string | undefined {
  const sc = asArray(item["Shortcut"])[0];
  const key = attr(sc, "key");
  if (!key) return undefined;
  const modifier = attr(sc, "modifier");
  return modifier ? `key ${key}, modifier ${modifier}` : `key ${key}`;
}

/** Depth-first search for the first <ScriptReference name> nested in a menu item
 * (it sits inside the Perform Script step's parameter list). */
function findScriptReferenceName(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const el of node) {
      const found = findScriptReferenceName(el);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  const direct = attr(asArray(node["ScriptReference"])[0], "name");
  if (direct) return decodeEntities(direct);
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR_PREFIX) || key === "#text") continue;
    const found = findScriptReferenceName(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * A "from field" value list's field binding lives in OptionsForValueLists (keyed
 * back to the value list by reference), not in the ValueListCatalog entry that
 * became the object — mirror attachCustomFunctionCalcs and scan that block's
 * <Field> binding against the already-created value-list object. Only the
 * <Field> (Primary/SecondaryField) is scanned, never the leading
 * <ValueListReference> (that's the binding key, not a dependency).
 *
 * A value list can instead source its values from a value list in ANOTHER file
 * (Source = External): the external value list is a real dependency, recorded
 * here so it resolves cross-file (and reads broken when the source file/value
 * list is gone). FileMaker renders the external name as "Unknown" when it can't
 * resolve it at export, but the id + data source are enough to resolve it.
 */
function attachValueListFields(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
): void {
  const blocks = collectCatalogItems(containerNode["OptionsForValueLists"], "ValueList");
  if (blocks.length === 0) return;

  const vlByUid = new Map<string, FmObject>();
  for (const obj of objects) {
    if (obj.type === "valueList" && obj.fileUid === ctx.file.uid) vlByUid.set(obj.uid, obj);
  }

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const ownerId = attr(block["ValueListReference"], "id");
    if (ownerId == null) continue;
    const owner = vlByUid.get(`${ctx.file.uid}:valueList:${ownerId}`);
    if (!owner) continue;
    const detail = valueListDetail(block);
    if (detail) owner.detail = detail;
    scanRefs(activeValueListField(block["Field"]), owner.uid, {}, ctx.refTags, references);
    addExternalValueListSource(block, owner.uid, references);
  }
}

/** A value list's <Field> binding minus the parts that are switched off but still
 * recorded: a second field whose "Also display values from second field" is
 * unchecked (show="False"), and the occurrence of "Include only related values"
 * when that option is off. */
function activeValueListField(field: unknown): unknown {
  if (!isRecord(field)) return field;
  const { SecondaryField, ShowRelated, ...rest } = field;
  return {
    ...rest,
    ...(SecondaryField != null && attr(asArray(SecondaryField)[0], "show") !== "False" ? { SecondaryField } : {}),
    ...(ShowRelated != null && attr(asArray(ShowRelated)[0], "value") === "True" ? { ShowRelated } : {}),
  };
}

/**
 * Emit the cross-file dependency for a "use values from another file's value
 * list" (Source = External) value list. The external value list lives under
 * <External>, named by a sibling <DataSourceReference>. With a data source it
 * resolves against that loaded file (best-effort when not loaded); with the data
 * source gone (a dead external link) it's force-broken, since it can never
 * resolve locally.
 */
function addExternalValueListSource(block: Record<string, unknown>, ownerUid: string, references: RawReference[]): void {
  const external = asArray(block["External"])[0];
  if (!isRecord(external)) return;
  const vlRef = asArray(external["ValueListReference"])[0];
  const extId = attr(vlRef, "id");
  if (extId == null) return;
  const dsRef = asArray(external["DataSourceReference"])[0];
  const dataSource = attr(dsRef, "name");
  const ref: RawReference = {
    fromUid: ownerUid,
    toType: "valueList",
    toId: extId,
    toName: decodeEntities(attr(vlRef, "name") ?? ""),
    kind: "valueList",
  };
  if (dataSource) ref.toFileName = decodeEntities(dataSource);
  else ref.forceBroken = true;
  references.push(ref);
  // The data source itself is a dependency too (it lists this value list among
  // its users). A nameless one is the dead link already flagged above.
  const dsId = attr(dsRef, "id");
  if (dsId != null && dataSource) {
    references.push({ fromUid: ownerUid, toType: "externalDataSource", toId: dsId, toName: decodeEntities(dataSource), kind: "externalDataSource" });
  }
}

/**
 * In FMSaveAsXML a custom function's formula lives in CalcsForCustomFunctions
 * (keyed back to the function by reference), not inline — mirror StepsForScripts
 * and attach the body to the already-created custom-function object.
 */
function attachCustomFunctionCalcs(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
): void {
  const blocks = collectCatalogItems(containerNode["CalcsForCustomFunctions"], "CustomFunctionCalc");
  if (blocks.length === 0) return;

  const cfByUid = new Map<string, FmObject>();
  for (const obj of objects) {
    if (obj.type === "customFunction" && obj.fileUid === ctx.file.uid) cfByUid.set(obj.uid, obj);
  }

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const ownerId = attr(block["CustomFunctionReference"], "id");
    if (ownerId == null) continue;
    const owner = cfByUid.get(`${ctx.file.uid}:customFunction:${ownerId}`);
    if (!owner) continue;
    const body = calculationText(block["Calculation"]);
    const signature = owner.detail?.kind === "calculation" ? owner.detail.signature : owner.name;
    owner.detail = { kind: "calculation", signature, body };
    if (body) owner.text = owner.text ? `${owner.text}\n${body}` : body;
    scanRefs(block["Calculation"], owner.uid, {}, ctx.refTags, references);
  }
}

function detailFor(type: ObjectType, node: unknown) {
  if (type === "customFunction") return customFunctionDetail(node);
  if (type === "relationship") return relationshipDetail(node);
  return undefined;
}

/**
 * Tables come from BaseTableCatalog; their fields live under a top-level
 * FieldsForTables section, keyed back to each table by reference.
 */
function parseTablesAndFields(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
): void {
  const tables = collectCatalogItems(containerNode["BaseTableCatalog"], "BaseTable");
  const tableUidById = new Map<string, { uid: string; id: string }>();
  for (const table of tables) {
    const tableObj = makeObject(table, "table", ctx);
    if (!tableObj) continue;
    objects.push(tableObj);
    tableUidById.set(tableObj.id, { uid: tableObj.uid, id: tableObj.id });
  }

  // Fields live under a top-level FieldsForTables section, each FieldCatalog
  // keyed back to its base table by a leading <BaseTableReference>.
  const fieldsForTables = containerNode["FieldsForTables"];
  for (const fieldCatalog of asArray(isRecord(fieldsForTables) ? fieldsForTables["FieldCatalog"] : undefined)) {
    const tableId = attr(isRecord(fieldCatalog) ? fieldCatalog["BaseTableReference"] : undefined, "id");
    const table = tableId ? tableUidById.get(tableId) : undefined;
    if (!table) continue;
    addFields(fieldCatalog, table.uid, table.id, ctx, objects, references);
  }
}

function addFields(
  fieldContainer: unknown,
  tableUid: string,
  tableId: string,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
): void {
  for (const field of collectCatalogItems(fieldContainer, "Field")) {
    // Field ids are unique only within a base table, so namespace the uid by
    // the owning table to keep object uids globally unique.
    const fieldObj = makeObject(field, "field", ctx, tableUid, tableId);
    if (!fieldObj) continue;
    annotateField(field, fieldObj);
    objects.push(fieldObj);
    // scanRefs skips disabled auto-enter / validation calcs; the placeholder
    // passes (which read text, not elements) must skip them too.
    const active = activeFieldNode(field);
    if (active !== field) refTextOverrides?.set(fieldObj.uid, collectText(active));
    scanRefs(field, fieldObj.uid, {}, ctx.refTags, references);
  }
}

// FileMaker wraps the file name in typographic curly quotes (U+201C…U+201D);
// accept straight quotes too for robustness across export versions.
const STEP_FROM_FILE_RE = /from file:\s*[“"]([^”"]+)[”"]/;
const PERFORM_SCRIPT_STEP_RE = /^Perform Script(?: on Server(?: with Callback)?)?$/;
/** How FileMaker renders (and we name) a target it can no longer resolve. */
const UNKNOWN_TARGET = "<unknown>";

/** Whether a Perform Script step's rendered text names a deleted script —
 * `Perform Script [ “<unknown>” ]` — as opposed to one in a file that wasn't
 * open (`<unknown> from file: …`) or chosen by name at run time (`By name`). */
function namesDeletedScript(stepText: string): boolean {
  return stepText.includes(`“${UNKNOWN_TARGET}”`) || /\[\s*<unknown>(?!\s*from file)/.test(stepText);
}

/**
 * Step targets FileMaker records only in the step's rendered StepText, because
 * the reference element itself is gone:
 *
 *   • Perform Script (also on Server / with Callback) with an empty target list:
 *     the script is in a file that wasn't open at export
 *     (`<unknown> from file: “Fertigung” (file not open)` → an external-leaf
 *     edge the call chain can display), or it was deleted (`“<unknown>”` → a
 *     broken edge).
 *   • Go to Layout / Go to Related Record whose specified layout was deleted
 *     (`[ <unknown> ]`, `Using layout: <unknown>`) — unless it's an External
 *     layout, whose file just wasn't available: unresolvable, not broken.
 *   • Go to Related Record whose occurrence was deleted without a
 *     `<Table Missing>` reference left behind (`From table: <unknown>`).
 */
function addStepTargetRefs(step: Record<string, unknown>, fromUid: string, stepCtx: ScanCtx, out: RawReference[]): void {
  const name = attr(step, "name") ?? "";
  const isPerform = PERFORM_SCRIPT_STEP_RE.test(name);
  const isLayoutStep = name === "Go to Layout" || name === "Go to Related Record";
  if (!isPerform && !isLayoutStep) return;
  const pointer = asArray(step["DDRREF"]).find((r) => attr(r, "kind") === "StepText");
  const hash = attr(pointer, "hash");
  const rendered = hash ? chunkContext?.stepTextByHash.get(hash) : undefined;
  if (rendered == null) return;
  const text = decodeEntities(rendered);

  if (isPerform) {
    if (findElement(step["ParameterValues"], "ScriptReference") != null) return;
    const external = STEP_FROM_FILE_RE.exec(text);
    if (external) {
      const fileName = external[1]!;
      pushRef(out, { fromUid, toType: "script", toId: "", toName: fileName, kind: "performScript", toFileName: fileName }, stepCtx);
    } else if (namesDeletedScript(text)) {
      pushRef(out, { fromUid, toType: "script", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: "performScript", forceBroken: true }, stepCtx);
    }
    return;
  }

  const container = findElement(step["ParameterValues"], "LayoutReferenceContainer");
  const layoutGone =
    isRecord(container) &&
    attr(container, "External") !== "True" &&
    findElement(container, "LayoutReference") == null &&
    (name === "Go to Layout" ? text.includes(UNKNOWN_TARGET) : text.includes(`Using layout: ${UNKNOWN_TARGET}`));
  if (layoutGone) {
    pushRef(out, { fromUid, toType: "layout", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: edgeKind("layout", name), forceBroken: true }, stepCtx);
  }
  if (
    name === "Go to Related Record" &&
    text.includes(`From table: ${UNKNOWN_TARGET}`) &&
    findElement(step["ParameterValues"], "TableOccurrenceReference") == null
  ) {
    pushRef(out, { fromUid, toType: "tableOccurrence", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: "tableOccurrence", forceBroken: true }, stepCtx);
  }
}

/** The first `tag` element anywhere under `node` (depth-first). */
function findElement(node: unknown, tag: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, tag);
      if (found != null) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  if (node[tag] != null) return asArray(node[tag])[0];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR_PREFIX) || key === "#text") continue;
    const found = findElement(value, tag);
    if (found != null) return found;
  }
  return undefined;
}

/**
 * Scripts come from ScriptCatalog; their steps live in a separate
 * StepsForScripts section, each block keyed to its script by a leading
 * <ScriptReference>.
 */
function parseScripts(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  stepTextByUuid: Map<string, string>,
): void {
  const scriptByUid = new Map<string, FmObject>();
  const ordered = collectOrderedWithFolders(containerNode["ScriptCatalog"], "Script");
  let order = 0;
  for (const { node: script, folder } of ordered) {
    const obj = makeObject(script, "script", ctx);
    if (!obj) continue;
    obj.order = order++;
    if (folder) obj.folder = folder;
    // Separator items are dividers the developer uses to organize the script
    // list — not real scripts. Keep them (in order) but mark them as such.
    if (obj.attributes.isSeparatorItem === "True") {
      obj.isSeparator = true;
      objects.push(obj);
      continue;
    }
    annotateScript(script, obj);
    objects.push(obj);
    scriptByUid.set(obj.uid, obj);
  }

  for (const block of asArray(isRecord(containerNode["StepsForScripts"]) ? (containerNode["StepsForScripts"] as Record<string, unknown>)["Script"] : undefined)) {
    if (!isRecord(block)) continue;
    const ownerId = attr(block["ScriptReference"], "id");
    if (ownerId == null) continue;
    const owner = scriptByUid.get(`${ctx.file.uid}:script:${ownerId}`);
    if (!owner) continue;
    // Scan only the steps (ObjectList), not the leading binding reference.
    // (scanRefs also recovers the targets FileMaker records only in a step's
    // rendered text — see addStepTargetRefs.)
    const steps = block["ObjectList"];
    scanRefs(steps, owner.uid, {}, ctx.refTags, references);
    // owner.text is built from FileMaker's pre-rendered StepText (per step,
    // joined by newlines) rather than collectText(steps): the formatted text
    // has real delimiters (`;`, `[`, `]`, …), so search and the placeholder
    // passes see readable steps instead of the raw parameter tree.
    const stepList = scriptSteps(steps, stepTextByUuid);
    const stepText = stepList
      .map((s) => (s.params ? `${s.name} ${s.params}` : s.name))
      .join("\n");
    owner.text = owner.text ? `${owner.text}\n${stepText}` : stepText;
    owner.detail = { kind: "script", steps: stepList };
  }
}

/**
 * Layouts come from LayoutCatalog, structured exactly like ScriptCatalog: a
 * flat document-ordered list with folder markers and separator items. Mirror
 * parseScripts so layouts get the same folder tree, ordering, and dividers in
 * the navigator.
 */
/** A human-readable name for a layout object used as its FmObject.name. */
function nameForLayoutObj(lo: LayoutObjectInfo): string {
  if (lo.type === "Text" && lo.info) {
    const s = lo.info.trim();
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }
  if (lo.fieldRef) return lo.fieldRef;
  if (lo.type === "Portal" && lo.portalTable) return `Portal (${lo.portalTable})`;
  if (lo.info) {
    const bare = lo.info.replace(/^"|"$/g, "");
    if (bare) return `${lo.type} (${bare})`;
  }
  if (lo.name.trim()) return lo.name;
  return lo.type;
}

/** The searchable text fragments of a single layout object — its name, field
 * binding, portal/script references, label/url info, tooltip, and trigger
 * scripts. Shared by the per-object search index and the layout's own compacted
 * text (compactLayoutText). */
function layoutObjectTerms(lo: LayoutObjectInfo): string[] {
  return [
    lo.name,
    lo.fieldRef,
    lo.portalTable,
    lo.scriptRef?.name,
    lo.valueListRef?.name,
    lo.info,
    lo.tooltip,
    ...(lo.triggers ?? []).map((t) => t.scriptName),
  ].filter((s): s is string => !!s);
}

/** Recursively emit layout objects as FmObject entries into `out`. `idChain` is the
 * dot-joined `id` of every ancestor from the owning layout down to (but not
 * including) this call's objects — e.g. `"120.2970"` for objects nested one level
 * inside layout 120's object with id 2970. */
function collectLayoutObjectFmObjects(
  infos: LayoutObjectInfo[],
  parentUid: string,
  idChain: string,
  fileUid: string,
  fileName: string,
  out: FmObject[],
  references: RawReference[],
): void {
  for (const lo of infos) {
    // `uuid` is only populated once FileMaker has stamped this specific object with
    // a per-edit UUID — an object never touched since it was placed has none, which
    // is the common case, not an edge case. Only skip when there's truly nothing to
    // build a uid from (below, `id` is preferred and `uuid` is just the fallback).
    if (!lo.id && !lo.uuid) continue;
    // FileMaker's numeric `id` is unique among siblings under the same parent — like
    // a field's id is unique within its table — so namespace by the full ancestor
    // chain the same way addFields namespaces by table. A single level (layout + own
    // id) isn't enough: two different parents on the same layout (e.g. two Grouped
    // Buttons) can each wrap a child that reuses the same id. `UUID` looks globally
    // unique but isn't reliably so either — duplicating a compound object can leave a
    // child's UUID identical to its sibling's.
    const chain = lo.id ? `${idChain}.${lo.id}` : undefined;
    let uid = chain ? `${fileUid}:layoutObject:${chain}` : `${fileUid}:layoutObject:${lo.uuid}`;
    // Rare last resort: FileMaker can clone a whole subtree without regenerating any
    // identifier in it, so id, the full chain, and UUID can all still collide. Give
    // every occurrence after the first a stable, deterministic suffix so distinct
    // exported objects never collapse onto the same uid.
    const seenCount = layoutObjectUidCounts?.get(uid) ?? 0;
    layoutObjectUidCounts?.set(uid, seenCount + 1);
    if (seenCount > 0) uid = `${uid}#${seenCount}`;
    lo.uid = uid;
    const searchText = layoutObjectTerms(lo).join(" ");
    out.push({
      uid,
      type: "layoutObject",
      id: lo.id ?? "",
      name: nameForLayoutObj(lo),
      fileUid,
      fileName,
      parentUid,
      attributes: (() => {
        const a: Record<string, string> = { loType: lo.type };
        if (lo.hash) a.hash = lo.hash;
        if (lo.bounds) a.position = `${lo.bounds.left}, ${lo.bounds.top} → ${lo.bounds.right}, ${lo.bounds.bottom}`;
        if (lo.info && lo.type !== "Web Viewer" && lo.type !== "Text") {
          const bare = lo.info.replace(/^"|"$/g, "");
          if (bare) a.label = bare;
        }
        if (lo.tooltip) a.tooltip = lo.tooltip;
        if (lo.portalTable) a.portalOccurrence = lo.portalTable;
        if (lo.portalRows != null) a.portalRows = String(lo.portalRows);
        return a;
      })(),
      text: searchText,
      detail: {
        kind: "layoutObject",
        loType: lo.type,
        info: lo.info,
        fieldRef: lo.fieldRef,
        scriptRef: lo.scriptRef,
        valueListRef: lo.valueListRef,
        actionStep: lo.actionStep,
        triggers: lo.triggers,
        tooltip: lo.tooltip,
        bounds: lo.bounds,
        style: lo.style,
        portalTable: lo.portalTable,
        portalRows: lo.portalRows,
      },
    });

    // A field object with <FieldReference id="0" name=""> has no field at all
    // (FileMaker shows it as <Field Missing>); the placeholder pass flags it from
    // its label, so no structural edge to a non-existent id 0.
    if (lo.fieldToId && lo.fieldToId !== "0") {
      // The label reads "<Field Missing>" for a deleted field; the reference keeps
      // the blank name like every other structural reference to it (which is what
      // stops the placeholder pass from counting the same binding twice).
      const fieldName = lo.fieldRef?.split("::")[1] ?? lo.fieldRef ?? "";
      references.push({
        fromUid: uid,
        toType: "field",
        toId: lo.fieldToId,
        toName: fieldName === MISSING_FIELD_TOKEN ? "" : fieldName,
        kind: "field",
        ...(lo.fieldViaToId ? { viaToId: lo.fieldViaToId } : {}),
      });
    }
    if (lo.scriptRef?.id) {
      references.push({
        fromUid: uid,
        toType: "script",
        toId: lo.scriptRef.id,
        toName: lo.scriptRef.name,
        kind: "script",
      });
    } else if (lo.actionStep && PERFORM_SCRIPT_STEP_RE.test(lo.actionStep.name) && namesDeletedScript(lo.actionStep.params)) {
      // A button whose script was deleted: FileMaker keeps the Perform Script
      // action but not its <ScriptReference>.
      references.push({ fromUid: uid, toType: "script", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: "script", forceBroken: true });
    }
    if (lo.valueListRef?.id) {
      references.push({
        fromUid: uid,
        toType: "valueList",
        toId: lo.valueListRef.id,
        toName: lo.valueListRef.name,
        kind: "valueList",
      });
    }
    for (const t of lo.triggers ?? []) {
      references.push(
        t.scriptId
          ? { fromUid: uid, toType: "script", toId: t.scriptId, toName: t.scriptName, kind: "trigger" }
          : // The trigger's script was deleted: the event stays, its <ScriptReference> doesn't.
            { fromUid: uid, toType: "script", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: "trigger", forceBroken: true },
      );
    }

    if (lo.children && lo.children.length > 0) {
      collectLayoutObjectFmObjects(lo.children, uid, chain ?? idChain, fileUid, fileName, out, references);
    }
  }
}

/**
 * Replace each layout's searchable `text` with a compact, deduped set of its
 * genuinely searchable terms (layout name, anchor occurrence, and every layout
 * object's field/script/label text).
 *
 * makeObject fills `text` from collectText — the full styled text of every
 * object on the layout, which is by far the largest thing in a big model (tens
 * of MB for a dense data-entry layout, ~99% of the model's total text). The diff
 * never reads it (layouts diff via their structured detail) and per-object search
 * is already served by each layout object's own searchText, so the only thing
 * lost is free-text search over the raw styled text inside a layout.
 *
 * MUST run after addGlobalVariables and addMissingCalcFieldRefs — those scan the
 * full text for $$globals and <Field Missing> tokens that calcs nested in a
 * layout (conditional formatting, hide conditions, tooltips) can carry.
 */
function compactLayoutText(objects: FmObject[]): void {
  for (const obj of objects) {
    if (obj.type !== "layout" || obj.detail?.kind !== "layout") continue;
    const terms = new Set<string>();
    terms.add(obj.name);
    if (obj.attributes.tableOccurrence) terms.add(obj.attributes.tableOccurrence);
    const walk = (infos: LayoutObjectInfo[]): void => {
      for (const lo of infos) {
        for (const term of layoutObjectTerms(lo)) terms.add(term);
        if (lo.children) walk(lo.children);
      }
    };
    for (const part of obj.detail.parts) walk(part.objects);
    walk(obj.detail.offLayout);
    obj.text = [...terms].join(" ");
  }
}

function parseLayouts(
  containerNode: Record<string, unknown>,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  stepTextByUuid: Map<string, string>,
): void {
  let order = 0;
  for (const { node: layout, folder } of collectOrderedWithFolders(containerNode["LayoutCatalog"], "Layout")) {
    const obj = makeObject(layout, "layout", ctx);
    if (!obj) continue;
    obj.order = order++;
    if (folder) obj.folder = folder;
    if (obj.attributes.isSeparatorItem === "True") {
      obj.isSeparator = true;
      objects.push(obj);
      continue;
    }
    annotateLayout(layout, obj);
    const detail = layoutDetail(layout, ctx.file.uid, stepTextByUuid);
    if (detail) {
      obj.detail = detail;
      if (detail.kind === "layout") {
        const allInfos = [...detail.parts.flatMap((p) => p.objects), ...detail.offLayout];
        collectLayoutObjectFmObjects(allInfos, obj.uid, obj.id, ctx.file.uid, ctx.file.name, objects, references);
      }
    }
    objects.push(obj);
    scanRefs(layout, obj.uid, {}, ctx.refTags, references);
  }
}

/** Return the start/end char positions of the first <LayoutCatalog>…</LayoutCatalog>
 * in an XML string, or null if not present. */
function findLayoutCatalogBounds(xml: string): { start: number; end: number } | null {
  const open = "<LayoutCatalog";
  const close = "</LayoutCatalog>";
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(close, start);
  if (end === -1) return null;
  return { start, end: end + close.length };
}

/** Index of the next real `<Layout` element at or after `from`, or -1. Skips
 * tags that merely share the prefix — most importantly the catalog's own
 * `<LayoutCatalog` opening tag, which `indexOf("<Layout")` would otherwise match
 * at position 0, swallowing the first real entry and corrupting the folder stack
 * — as well as `<LayoutObject`, `<LayoutReference`, etc. A real element is
 * followed by a tag delimiter; a longer tag name has a letter there instead. */
function nextLayoutElement(xml: string, from: number): number {
  const TAG = "<Layout";
  let pos = from;
  for (;;) {
    const lt = xml.indexOf(TAG, pos);
    if (lt === -1) return -1;
    const after = xml[lt + TAG.length]; // char immediately after "<Layout"
    if (after === " " || after === "\t" || after === "\n" || after === "\r" || after === ">" || after === "/") {
      return lt;
    }
    pos = lt + TAG.length;
  }
}

/**
 * Parse layouts from a raw LayoutCatalog XML string one element at a time,
 * so the peak object-tree is bounded by the largest single layout rather than
 * the entire catalog (which can be hundreds of MB in large DDR files).
 *
 * Folder markers (isFolder="True" / "Marker") are handled without a full XML
 * parse — we extract the name attribute with a simple regex — because folder
 * marker layouts contain no reference-bearing content.
 */
function parseLayoutsStreaming(
  catalogXml: string,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  stepTextByUuid: Map<string, string>,
  errors: string[],
): void {
  let order = 0;
  const folderStack: string[] = [];
  const closeTag = "</Layout>";
  let pos = 0;

  while (pos < catalogXml.length) {
    const lt = nextLayoutElement(catalogXml, pos);
    if (lt === -1) break;

    // End of opening tag
    const gt = catalogXml.indexOf(">", lt);
    if (gt === -1) break;

    const openTag = catalogXml.slice(lt, gt + 1);
    const isSelf = openTag.endsWith("/>");

    if (isSelf) {
      pos = gt + 1;
      continue;
    }

    const closePos = catalogXml.indexOf(closeTag, gt + 1);
    if (closePos === -1) break;

    const endPos = closePos + closeTag.length;

    // Folder markers: manage the stack but do not emit an object.
    const folderMatch = /\bisFolder="(True|Marker)"/.exec(openTag);
    if (folderMatch) {
      if (folderMatch[1] === "True") {
        const nameMatch = / name="([^"]*)"/.exec(openTag);
        folderStack.push(nameMatch?.[1] != null ? decodeEntities(nameMatch[1]) : "");
      } else {
        folderStack.pop();
      }
      pos = endPos;
      continue;
    }

    // Real layout: parse the single element and process it immediately so the
    // parsed object-tree can be GC'd before the next layout is parsed.
    const layoutXml = catalogXml.slice(lt, endPos);
    let layoutNode: unknown;
    try {
      const parsed = xmlParser.parse(`<_L>${layoutXml}</_L>`) as Record<string, unknown>;
      const wrapper = parsed["_L"];
      layoutNode = isRecord(wrapper) ? (wrapper as Record<string, unknown>)["Layout"] : undefined;
    } catch (err) {
      // Skipping it silently would hide the layout and every reference on it.
      const layoutName = / name="([^"]*)"/.exec(openTag)?.[1];
      errors.push(
        `${ctx.file.name}: layout ${layoutName != null ? `“${decodeEntities(layoutName)}” ` : ""}could not be parsed and was skipped — ${(err as Error).message}`,
      );
      pos = endPos;
      order++;
      continue;
    }

    const folder = folderStack.join(" / ");
    for (const node of asArray(layoutNode)) {
      processOneLayout(node, folder, order++, ctx, objects, references, stepTextByUuid);
    }

    pos = endPos;
  }
}

function processOneLayout(
  layout: unknown,
  folder: string,
  order: number,
  ctx: FileContext,
  objects: FmObject[],
  references: RawReference[],
  stepTextByUuid: Map<string, string>,
): void {
  const obj = makeObject(layout, "layout", ctx);
  if (!obj) return;
  obj.order = order;
  if (folder) obj.folder = folder;
  if (obj.attributes.isSeparatorItem === "True") {
    obj.isSeparator = true;
    objects.push(obj);
    return;
  }
  annotateLayout(layout, obj);
  const detail = layoutDetail(layout, ctx.file.uid, stepTextByUuid);
  if (detail) {
    obj.detail = detail;
    if (detail.kind === "layout") {
      const allInfos = [...detail.parts.flatMap((p) => p.objects), ...detail.offLayout];
      collectLayoutObjectFmObjects(allInfos, obj.uid, obj.id, ctx.file.uid, ctx.file.name, objects, references);
    }
  }
  objects.push(obj);
  scanRefs(layout, obj.uid, {}, ctx.refTags, references);
}

/**
 * Collect catalog items in document order (= FileMaker workspace order),
 * reconstructing the full folder tree. The catalog is a flat pre-order list of
 * `itemTag` elements with paired markers: `isFolder="True"` opens a folder
 * (push), and `isFolder="Marker"` closes it (pop). An item's folder is the path
 * of all currently-open folders, e.g. "MIGRATION / HISTORY".
 */
function collectOrderedWithFolders(
  node: unknown,
  itemTag: string,
  out: { node: unknown; folder: string }[] = [],
  stack: string[] = [],
): { node: unknown; folder: string }[] {
  if (!isRecord(node)) return out;
  for (const el of asArray(node[itemTag])) {
    const flag = attr(el, "isFolder");
    if (flag === "True") {
      stack.push(decodeEntities((attr(el, "name") ?? "").trim()));
    } else if (flag === "Marker") {
      stack.pop();
    } else {
      out.push({ node: el, folder: stack.join(" / ") });
    }
  }
  for (const container of [...asArray(node["Group"]), ...asArray(node["ObjectList"])]) {
    collectOrderedWithFolders(container, itemTag, out, stack);
  }
  return out;
}

/** Human labels for an <AutoEnter type="…"> other than Calculated/ConstantData
 *  (those are surfaced as the calculation detail / a value). Unlisted types fall
 *  back to the raw type. */
const AUTO_ENTER_LABELS: Readonly<Record<string, string>> = {
  SerialNumber: "Serial number",
  CreationDate: "Creation date",
  CreationTime: "Creation time",
  CreationTimestamp: "Creation timestamp",
  CreationName: "Creation name",
  CreationAccountName: "Creation account name",
  CreationUserName: "Creation user name",
  ModificationDate: "Modification date",
  ModificationTime: "Modification time",
  ModificationTimestamp: "Modification timestamp",
  ModificationName: "Modification name",
  ModificationAccountName: "Modification account name",
  ModificationUserName: "Modification user name",
  LastVisited: "Value from last visited record",
  Looked_up: "Looked-up value",
};

/** Friendly labels for a summary field's <SummaryInfo operation>. */
const SUMMARY_OPERATION_LABELS: Readonly<Record<string, string>> = {
  Total: "Total of",
  Average: "Average of",
  Count: "Count of",
  Minimum: "Minimum of",
  Maximum: "Maximum of",
  StandardDeviation: "Standard deviation of",
  Fraction: "Fraction of total of",
  FractionOfTotal: "Fraction of total of",
  List: "List of",
  RunningTotal: "Running total of",
  RunningCount: "Running count of",
};

/**
 * A container field's storage, e.g. "In file" or "External (Secure) · Mona_Lisa/".
 * External storage is a nested <Remote type="Secure|Open"> whose
 * <BaseDirectoryReference> names the base directory (Manage ▸ Containers).
 */
function containerStorage(storage: unknown): string {
  const remote = asArray(isRecord(storage) ? storage["Remote"] : undefined)[0];
  if (!isRecord(remote)) return "In file";
  const dirRef = asArray(remote["BaseDirectoryReference"])[0];
  const dir = attr(dirRef, "name");
  const parts = [`External (${attr(remote, "type") ?? "Secure"})`];
  if (dir) parts.push(decodeEntities(dir));
  if (attr(dirRef, "absolute") === "True") parts.push("absolute path");
  if (attr(remote, "withFewerFolders") === "True") parts.push("fewer folders");
  return parts.join(" · ");
}

/**
 * Lift storage info onto a field object for the report card and navigator
 * filters. (`fieldType` and `dataType` already arrive via the element's own
 * attributes; here we surface the bits that live in the nested <Storage>.)
 */
function annotateField(fieldNode: unknown, fieldObj: FmObject): void {
  if (!isRecord(fieldNode)) return;
  const storage = asArray(fieldNode["Storage"])[0];
  // A global field is one whose <Storage> declares global storage.
  if (attr(storage, "global") === "True") {
    fieldObj.attributes.global = "true";
  }
  // Container fields: where the data lives — in the file, or externally.
  if (attr(fieldNode, "datatype") === "Binary") {
    fieldObj.attributes.containerStorage = containerStorage(storage);
  }
  // Repetitions beyond the default single value are worth surfacing.
  const reps = attr(storage, "maxRepetitions");
  if (reps && reps !== "1") fieldObj.attributes.repetitions = reps;
  // Indexing: the index level, whether it auto-creates, and the index language.
  const index = attr(storage, "index");
  if (index && index !== "None") fieldObj.attributes.indexing = index;
  if (attr(storage, "autoIndex") === "True") fieldObj.attributes.autoIndex = "Yes";
  const indexLanguage = attr(asArray(isRecord(storage) ? storage["LanguageReference"] : undefined)[0], "name");
  if (indexLanguage && (fieldObj.attributes.indexing || fieldObj.attributes.autoIndex)) {
    fieldObj.attributes.indexLanguage = decodeEntities(indexLanguage);
  }
  // A calculated/summary field carries its formula in a nested <Calculation>;
  // an ordinary field may instead carry an auto-enter calculation under
  // <AutoEnter type="Calculated">. Surface whichever exists as rich detail (like
  // a custom function's body), labeling the auto-enter case so it reads as such.
  const calc = fieldNode["Calculation"];
  const autoEnter = asArray(fieldNode["AutoEnter"])[0];
  const autoEnterCalc =
    calc == null && isRecord(autoEnter) && attr(autoEnter, "type") === "Calculated" && isRecord(autoEnter["Calculated"])
      ? autoEnter["Calculated"]["Calculation"]
      : undefined;
  const formula = calc ?? autoEnterCalc;
  if (formula != null) {
    // An unstored calculation opts out of storing results.
    if (calc != null && attr(storage, "storeCalculationResults") === "False") {
      fieldObj.attributes.unstored = "true";
    }
    const body = calculationText(formula);
    if (body) {
      const signature = autoEnterCalc != null ? "Auto-enter calculation" : "";
      fieldObj.detail = { kind: "calculation", signature, body };
    }
    // The occurrence the formula is evaluated through — where buildModel
    // measures its relationship depth from (annotateRelationshipDepths).
    const contextToId = attr(asArray(isRecord(formula) ? formula["TableOccurrenceReference"] : undefined)[0], "id");
    if (contextToId != null) fieldObj.attributes.calcContextToId = contextToId;
  }

  // A summary field carries no formula — instead a <SummaryInfo> naming the
  // aggregate operation and the field(s) it summarizes. Surface it as detail.
  const summaryInfo = asArray(fieldNode["SummaryInfo"])[0];
  if (!fieldObj.detail && isRecord(summaryInfo)) {
    const operation = SUMMARY_OPERATION_LABELS[attr(summaryInfo, "operation") ?? ""] ?? "Summary of";
    const fields: string[] = [];
    for (const sf of asArray(summaryInfo["SummaryField"])) {
      const name = attr(asArray(isRecord(sf) ? sf["FieldReference"] : undefined)[0], "name");
      if (name) fields.push(decodeEntities(name));
    }
    fieldObj.detail = { kind: "summary", operation, fields };
  }

  // A "looked-up value" auto-enter field carries no formula — instead an
  // enabled <Looked_up> naming the source field it copies from. Surface it as
  // detail, formatted like a value list's field source. (When the lookup is
  // disabled, FileMaker clears the AutoEnter's type but leaves the stale
  // <Looked_up> in place, so checking the type here already excludes it.)
  const lookedUp = isRecord(autoEnter) ? asArray(autoEnter["Looked_up"])[0] : undefined;
  if (!fieldObj.detail && attr(autoEnter, "type") === "Looked_up" && isRecord(lookedUp)) {
    const source = qualifiedField(lookedUp["FieldReference"]);
    if (source) fieldObj.detail = { kind: "lookup", source };
  }

  // Note any non-calculated auto-enter option (the calculated case is already
  // shown above as the field's calculation detail).
  const autoEnterType = isRecord(autoEnter) ? attr(autoEnter, "type") : undefined;
  if (isRecord(autoEnter) && autoEnterType && autoEnterType !== "Calculated") {
    if (autoEnterType === "ConstantData") {
      const value = decodeEntities(collectText(autoEnter["ConstantData"]).trim());
      fieldObj.attributes.autoEnter = value ? `Data: ${value}` : "Data";
    } else {
      fieldObj.attributes.autoEnter = AUTO_ENTER_LABELS[autoEnterType] ?? autoEnterType;
    }
  }

  // Auto-enter behavior flags (apply to any auto-enter, calculated or not).
  if (isRecord(autoEnter)) {
    const flags: string[] = [];
    if (attr(autoEnter, "prohibitModification") === "True") flags.push("Prohibit modification");
    if (attr(autoEnter, "alwaysEvaluate") === "True") flags.push("Always evaluate");
    if (attr(autoEnter, "overwriteExisting") === "True") flags.push("Overwrite existing");
    if (flags.length) fieldObj.attributes.autoEnterOptions = flags.join(", ");

    // Serial-number auto-enter settings. The increment and when-it-generates are
    // real schema; the next value is a live counter that diverges naturally
    // between copies (records created), so it's surfaced for display but excluded
    // from the diff (see buildNoise in diff.ts).
    const serial = asArray(autoEnter["SerialNumber"])[0];
    if (isRecord(serial)) {
      const increment = attr(serial, "increment");
      if (increment != null) fieldObj.attributes.serialIncrement = increment;
      const generate = attr(serial, "generate");
      if (generate != null) {
        fieldObj.attributes.serialGenerate =
          generate === "OnCreation" ? "On creation" : generate === "OnCommit" ? "On commit" : generate;
      }
      const nextValue = attr(serial, "nextvalue");
      if (nextValue != null) fieldObj.attributes.serialNextValue = nextValue;
    }
  }

  annotateFieldValidation(fieldNode, fieldObj);
}

/**
 * Surface a field's validation requirements (the nested <Validation> block):
 * which checks are required, when they run, and whether the user can override.
 * Skipped entirely when no requirement is set, so the default (empty) validation
 * every field carries doesn't clutter the inspector.
 */
function annotateFieldValidation(fieldNode: Record<string, unknown>, fieldObj: FmObject): void {
  const validation = asArray(fieldNode["Validation"])[0];
  if (!isRecord(validation)) return;

  const requirements: string[] = [];
  if (attr(validation, "notEmpty") === "True") requirements.push("Not empty");
  if (attr(validation, "unique") === "True") requirements.push("Unique");
  if (attr(validation, "existing") === "True") requirements.push("Existing value");
  const maxLength = attr(validation, "maxLength");
  if (maxLength) requirements.push(`Max ${maxLength} characters`);
  const valueListName = attr(asArray(validation["ValueListReference"])[0], "name");
  if (valueListName) requirements.push(`In value list “${decodeEntities(valueListName)}”`);
  if (validation["Range"] != null) requirements.push("In range");
  if (validation["Calculation"] != null) requirements.push("By calculation");

  if (requirements.length === 0) return;
  fieldObj.attributes.validation = requirements.join(", ");
  fieldObj.attributes.validateWhen =
    attr(validation, "type") === "Always" ? "Always" : "Only during data entry";
  fieldObj.attributes.validationOverride =
    attr(validation, "allowOverride") === "True" ? "User can override" : "Strict (no override)";
}

/**
 * An <Account> carries no `name` attribute; its login name lives nested at
 * <Authentication><AccountName><INSECURE_TEXT>. Lift it to the object name so
 * accounts read as e.g. "User" rather than the "(account 4)" id fallback, and
 * surface the account's privilege set and description (both nested, not
 * attributes) so they appear in the inspector.
 */
function annotateAccount(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  // `enable="False"` marks a deactivated account.
  obj.attributes.status = attr(node, "enable") === "False" ? "Inactive" : "Active";
  const auth = asArray(node["Authentication"])[0];
  if (isRecord(auth)) {
    // Account name: older exports nest it in <INSECURE_TEXT>, newer ones put it
    // directly in <AccountName>. collectText handles both shapes.
    const nameText = collectText(auth["AccountName"]).trim();
    if (nameText) obj.name = decodeEntities(nameText);
    // A FileMaker-auth account with no stored password is a security risk.
    // (External-auth accounts legitimately have none, so they're excluded.) The
    // password lives in <INSECURE_PASSWORD> (older) or <PasswordEncrypted>
    // (newer), as direct text or a nested <Data>.
    if (attr(node, "type") === "FileMaker") {
      const pwData = collectText(auth["PasswordEncrypted"] ?? auth["INSECURE_PASSWORD"]).trim();
      obj.attributes.password = pwData ? "Yes" : "No";
    }
  }
  // The granted privilege set is a nested <PrivilegeSetReference name=…>.
  const privName = attr(asArray(node["PrivilegeSetReference"])[0], "name");
  if (privName) obj.attributes.privilegeSet = decodeEntities(privName);
  const description = collectText(node["Description"]).trim();
  if (description) obj.attributes.description = decodeEntities(description);
}

/** Surface a privilege set's description and the access level it grants for each
 * object category (records, layouts, value lists, scripts) — all nested under
 * <access>, not attributes. */
function annotatePrivilegeSet(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const description = collectText(node["Description"]).trim();
  if (description) obj.attributes.description = decodeEntities(description);
  const access = asArray(node["access"])[0];
  if (!isRecord(access)) return;
  // Custom record access has no View/Create/Edit/Delete attributes on <Records>
  // itself (those live per-table under <Custom>), so accessLevel() alone would
  // read it as granting nothing — call out "Custom" explicitly instead.
  if (attr(access["Records"], "Custom") === "True") {
    obj.attributes.recordsAccess = "Custom";
    const detail = privilegeSetDetail(access["Records"]);
    if (detail) obj.detail = detail;
  } else {
    const records = accessLevel(access["Records"]);
    if (records) obj.attributes.recordsAccess = records;
  }
  const layouts = accessLevel(access["Layouts"]);
  if (layouts) obj.attributes.layoutsAccess = layouts;
  const valueLists = accessLevel(access["ValueLists"]);
  if (valueLists) obj.attributes.valueListsAccess = valueLists;
  const scripts = accessLevel(access["Scripts"]);
  if (scripts) obj.attributes.scriptsAccess = scripts;
  if (attr(access, "default") === "True") obj.attributes.defaultPrivilegeSet = "Yes";

  // The <Other> block holds the extended management privileges and the menu
  // command level — none of which live in the per-category access nodes above.
  const other = asArray(access["Other"])[0];
  if (!isRecord(other)) return;
  const OTHER_PRIVILEGES: ReadonlyArray<[string, string]> = [
    ["Print", "Printing"],
    ["Export", "Exporting"],
    ["manageAccounts", "Manage accounts"],
    ["manageExtPrivs", "Manage extended privileges"],
    ["allowOverride", "Override data validation"],
    ["allowOpenQuickly", "Allow Open Quickly"],
    ["disconnectIdle", "Disconnect idle users"],
  ];
  const granted = OTHER_PRIVILEGES.filter(([key]) => attr(other, key) === "True").map(([, label]) => label);
  if (granted.length) obj.attributes.otherPrivileges = granted.join(", ");
  const commands = attr(other, "commands");
  if (commands) obj.attributes.menuCommands = commands;
  if (attr(asArray(other["Password"])[0], "prohibitModification") === "True") {
    obj.attributes.passwordChange = "Prohibited";
  }
}

/** The formulas behind a privilege set's "Limited" record access — each custom
 * table grant whose View / Edit / Create / Delete is gated by a calculation. */
function recordAccessCalcs(node: unknown): unknown[] {
  const access = asArray(isRecord(node) ? node["access"] : undefined)[0];
  const records = asArray(isRecord(access) ? access["Records"] : undefined)[0];
  const custom = asArray(isRecord(records) ? records["Custom"] : undefined)[0];
  const list = asArray(isRecord(custom) ? custom["ObjectList"] : undefined)[0];
  const calcs: unknown[] = [];
  for (const table of asArray(isRecord(list) ? list["Table"] : undefined)) {
    if (!isRecord(table)) continue;
    for (const verb of ["View", "Edit", "Create", "Delete"]) {
      for (const grant of asArray(table[verb])) {
        if (isRecord(grant) && attr(grant, "access") === "Calculation") calcs.push(...asArray(grant["Calculation"]));
      }
    }
  }
  return calcs;
}

/** Summarize a permission category node, e.g. <Records Create="True" Edit="True">
 * → "Create, Edit" and <Layouts View="ReadOnly"> → "View: ReadOnly". */
function accessLevel(node: unknown): string {
  if (!isRecord(node)) return "";
  const parts: string[] = [];
  const view = attr(node, "View");
  if (view && view !== "None") parts.push(`View: ${view}`);
  for (const verb of ["Create", "Edit", "Delete"]) {
    if (attr(node, verb) === "True") parts.push(verb);
  }
  return parts.length ? parts.join(", ") : "None";
}

/** Surface a value list's source kind (Custom, Field, …), which lives in a
 * nested <Source value=…> element. */
function annotateValueList(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const source = attr(asArray(node["Source"])[0], "value");
  if (source) obj.attributes.source = source;
}

/**
 * A <Theme> names itself with a reverse-DNS id (`com.filemaker.theme.apex_blue`);
 * its friendly label lives in the `Display` attribute, so prefer that. The theme
 * also embeds a base64 preview <Image> that collectText would otherwise pull into
 * the searchable body — reset the text to the names so the model stays lean. The
 * useful design metadata (color scheme, swatch palette, base font size) lives
 * nested under <Metadata>; lift it so the inspector shows what the theme looks
 * like rather than just version/locale bookkeeping.
 */
function annotateTheme(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const display = attr(node, "Display");
  const internal = obj.name;
  if (display) {
    obj.name = decodeEntities(display);
    // Now the object's title; don't repeat it as a raw property row.
    delete obj.attributes.Display;
  }
  obj.text = [obj.name, internal].filter(Boolean).join(" ");

  const metadata = asArray(node["Metadata"])[0];
  if (!isRecord(metadata)) return;
  // colorScheme sits at the metadata root or under <charting>.
  const scheme =
    collectText(metadata["colorScheme"]).trim() ||
    collectText(isRecord(metadata["charting"]) ? metadata["charting"]["colorScheme"] : undefined).trim();
  if (scheme) obj.attributes.colorScheme = scheme;
  const baseFont = collectText(
    isRecord(metadata["layoutbuilder"]) ? metadata["layoutbuilder"]["kBaseFontSize"] : undefined,
  ).trim();
  if (baseFont) obj.attributes.baseFontSize = baseFont;
  // The palette is <swatch1>..<swatchN> hex values; keep them in swatch order.
  const palette = asArray(metadata["colorpalette"])[0];
  if (isRecord(palette)) {
    const swatches = Object.keys(palette)
      .filter((k) => /^swatch\d+$/.test(k))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
      .map((k) => collectText(palette[k]).trim())
      .filter(Boolean);
    if (swatches.length) obj.attributes.palette = swatches.join(" ");
  }
}

/**
 * A <Authorization> (an authorized client file) carries no `name`; its label is a
 * nested <Display> CDATA. Lift it to the object name, and reset the text to that
 * label so the embedded <Authentication> credential hash stays out of the body.
 * The nested <Source> records who first authorized the file and when.
 */
function annotateFileAccess(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const display = collectText(node["Display"]).trim();
  if (display) obj.name = decodeEntities(display);
  obj.text = obj.name;
  const source = asArray(node["Source"])[0];
  const account = attr(source, "CreationAccountName");
  if (account) obj.attributes.authorizedBy = decodeEntities(account);
  const created = attr(source, "CreationTimestamp");
  if (created) obj.attributes.authorizedOn = created;
}

/** Surface an extended privilege's description (a nested <Description>). */
function annotateExtendedPrivilege(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const description = collectText(node["Description"]).trim();
  if (description) obj.attributes.description = decodeEntities(description);
}

/**
 * An extended privilege names the privilege sets that grant it via a nested
 * <ObjectList> of <PrivilegeSetReference>. The natural edge runs the other way —
 * a privilege set *grants* the extended privilege — so emit privilegeSet ->
 * extendedPrivilege edges (using each reference's `id` as the set's uid). That
 * makes the granting sets show as the extended privilege's inbound references,
 * and the extended privilege show among each set's outbound references.
 */
function addExtendedPrivilegeGrants(
  node: unknown,
  obj: FmObject,
  ctx: FileContext,
  references: RawReference[],
): void {
  if (!isRecord(node)) return;
  const list = asArray(node["ObjectList"])[0];
  for (const ref of asArray(isRecord(list) ? list["PrivilegeSetReference"] : undefined)) {
    const id = attr(ref, "id");
    if (id == null) continue;
    references.push({
      fromUid: `${ctx.file.uid}:privilegeSet:${id}`,
      toType: "extendedPrivilege",
      toId: obj.id,
      toName: obj.name,
      kind: "extendedPrivilege",
    });
  }
}

/** Surface an external data source's path(s) (nested <File><UniversalPathList>). */
function annotateExternalDataSource(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const path = collectText(isRecord(node["File"]) ? node["File"]["UniversalPathList"] : undefined).trim();
  if (path) obj.attributes.path = decodeEntities(path);
}

/** Surface a custom menu's standard base menu (the one it overrides), its
 * developer comment, and the FileMaker modes it installs in. */
function annotateCustomMenu(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  // The base menu the custom menu is derived from is <BaseMenu> (DDR) or <Base>.
  const baseName = attr(asArray(node["BaseMenu"])[0], "name") ?? attr(asArray(node["Base"])[0], "name");
  if (baseName) obj.attributes.basedOn = decodeEntities(baseName);
  const comment = collectText(node["Comment"]).trim();
  if (comment) obj.attributes.comment = decodeEntities(comment);
  const options = asArray(node["Options"])[0];
  if (isRecord(options)) {
    const modes = ["browseMode", "findMode", "previewMode"]
      .filter((m) => attr(options, m) === "True")
      .map((m) => m.replace("Mode", ""));
    if (modes.length) obj.attributes.installsIn = modes.join(", ");
  }
  const install = installCondition(node);
  if (install) obj.attributes.installCondition = install;
}

/** The calculation that gates a menu / menu item's installation
 * (<Conditions><Install><Calculation>), or "" when it is the trivial always-on
 * condition. */
function installCondition(node: Record<string, unknown>): string {
  const conditions = asArray(node["Conditions"])[0];
  const install = isRecord(conditions) ? asArray(conditions["Install"])[0] : undefined;
  const calc = isRecord(install) ? calculationText(install["Calculation"]) : "";
  return calc && calc !== "1" ? calc : "";
}

/** Surface a custom menu set's developer comment and how many menus it contains
 * (the member menus themselves are emitted as references). */
function annotateCustomMenuSet(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const comment = attr(node, "comment");
  if (comment) obj.attributes.comment = decodeEntities(comment);
  const count = attr(asArray(node["CustomMenuList"])[0], "membercount");
  if (count) obj.attributes.menus = count;
  const sourceUuid = collectText(node["SourceUUID"]).trim();
  if (sourceUuid) obj.attributes.sourceUuid = sourceUuid;
}

/** Surface the table occurrence a layout shows records from (a nested
 * <TableOccurrenceReference name=…>), whether it appears in the layout menu, its
 * client type, and the custom menu set it uses. */
function annotateLayout(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const toName = attr(asArray(node["TableOccurrenceReference"])[0], "name");
  if (toName) obj.attributes.tableOccurrence = decodeEntities(toName);
  // hidden="True" leaves the layout out of the layout (menu) pop-up.
  if (attr(asArray(node["Options"])[0], "hidden") === "True") obj.attributes.includeInLayoutMenus = "No";
  const clientType = collectText(node["ClientType"]).trim();
  if (clientType && clientType !== "0") obj.attributes.clientType = clientType;
  const menuSet = attr(asArray(isRecord(node["MenuSet"]) ? node["MenuSet"]["CustomMenuSetReference"] : undefined)[0], "name");
  if (menuSet && menuSet !== "[File Default]") obj.attributes.menuSet = decodeEntities(menuSet);
}

/** Surface script run options nested under <Options> (e.g. "run with full
 * access"), which aren't attributes on the <Script> element. */
function annotateScript(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const options = asArray(node["Options"])[0];
  if (attr(options, "runwithfullaccess") === "True") obj.attributes.runsWithFullAccess = "Yes";
  // hidden="True" means the script is left out of the Scripts menu.
  if (attr(options, "hidden") === "True") obj.attributes.includeInMenu = "No";
  const access = attr(options, "access");
  if (access) obj.attributes.scriptAccess = access;
  const compatibility = attr(options, "compatibility");
  if (compatibility && compatibility !== "0") obj.attributes.compatibility = compatibility;
  if (attr(options, "SiriShortcutVisible") === "True") obj.attributes.siriShortcut = "Visible";
}

/**
 * Capture an FMSaveAsXML table occurrence's base-table id and — for an external
 * occurrence — the data source (file) name it reads from. buildModel uses these
 * to resolve references that read through the occurrence, including references
 * that cross into another file when that file is also loaded.
 */
function annotateTableOccurrence(node: unknown, obj: FmObject, dataSourceIds: ReadonlySet<string>): void {
  if (!isRecord(node)) return;
  // The base table (and, for external occurrences, the data source) live inside
  // a <BaseTableSourceReference> wrapper, not directly on the occurrence.
  const sourceRef = asArray(node["BaseTableSourceReference"])[0];
  const baseTableRef = asArray(isRecord(sourceRef) ? sourceRef["BaseTableReference"] : undefined)[0];
  const baseTableId = attr(baseTableRef, "id");
  if (baseTableId != null) obj.attributes.baseTableId = baseTableId;
  // The readable base-table name (the raw id is internal and hidden from view).
  const baseTableName = attr(baseTableRef, "name");
  if (baseTableName != null) obj.attributes.baseTable = decodeEntities(baseTableName);
  // The base table's own UUID identifies it across files, whatever the data
  // source is named (buildModel matches external occurrences on it).
  const baseTableUuid = attr(baseTableRef, "UUID");
  if (baseTableUuid) obj.attributes.baseTableUuid = baseTableUuid;
  if (obj.attributes.type === "External") {
    const dataSourceRef = asArray(isRecord(sourceRef) ? sourceRef["DataSourceReference"] : undefined)[0];
    const dataSource = attr(dataSourceRef, "name");
    if (dataSource != null) obj.attributes.externalDataSource = decodeEntities(dataSource);
    // No base table: broken only when the export shows the data source itself is
    // gone. Otherwise the source file simply wasn't available when this file was
    // exported (or its path is a variable) — nothing here can be verified.
    if (baseTableId == null) {
      const dataSourceId = attr(dataSourceRef, "id");
      const sourceDeleted =
        dataSource != null &&
        (decodeEntities(dataSource) === UNKNOWN_TARGET || (dataSourceId != null && !dataSourceIds.has(dataSourceId)));
      if (!sourceDeleted) {
        obj.attributes.baseTableUnresolved = "Couldn't be resolved — its file wasn't available when this file was exported";
      }
    }
  }
  if (!isRecord(sourceRef)) return;
  // The occurrence's box on the relationship graph: its position and color.
  const coord = asArray(node["CoordRect"])[0];
  const left = attr(coord, "left");
  const top = attr(coord, "top");
  const right = attr(coord, "right");
  const bottom = attr(coord, "bottom");
  if (left != null && top != null) obj.attributes.graphPosition = `${left}, ${top}`;
  // Full box rectangle ("left,top,right,bottom"), for re-drawing FileMaker's own
  // relationship-graph layout faithfully.
  if (left != null && top != null && right != null && bottom != null) {
    obj.attributes.graphRect = `${left},${top},${right},${bottom}`;
  }
  const color = rgbHex(asArray(node["Color"])[0]);
  if (color) obj.attributes.color = color;
  // How the box is shown on the graph: "Collapse" draws only the title bar, so
  // its CoordRect (the expanded bounds) overstates its drawn height.
  const view = attr(node, "View");
  if (view) obj.attributes.graphView = view;
}

/** A FileMaker <Color red green blue> (0–255 channels) as a #RRGGBB string. */
function rgbHex(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  const channels = ["red", "green", "blue"].map((c) => Number(attr(node, c)));
  if (!channels.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return undefined;
  return "#" + channels.map((n) => n.toString(16).padStart(2, "0")).join("");
}

function makeObject(
  node: unknown,
  type: ObjectType,
  ctx: FileContext,
  parentUid?: string,
  idNamespace?: string,
): FmObject | null {
  const id = attr(node, "id");
  if (id == null) return null;
  const name = decodeEntities(attr(node, "name") ?? `(${type} ${id})`);
  const idPart = idNamespace ? `${idNamespace}.${id}` : id;
  const obj: FmObject = {
    uid: `${ctx.file.uid}:${type}:${idPart}`,
    type,
    id,
    name,
    fileUid: ctx.file.uid,
    fileName: ctx.file.name,
    attributes: attributes(node),
    text: collectText(node),
  };
  if (parentUid) obj.parentUid = parentUid;
  liftUuidMeta(node, obj);
  return obj;
}

/**
 * Lift the per-object <UUID modifications userName accountName timestamp>guid</UUID>
 * metadata FileMaker records onto the object's attributes, so the inspector can
 * show its UUID and who last changed it (and how many times).
 */
function liftUuidMeta(node: unknown, obj: FmObject): void {
  if (!isRecord(node)) return;
  const uuidNode = asArray(node["UUID"])[0];
  if (!isRecord(uuidNode)) return;
  const text = uuidNode["#text"];
  if (text != null) obj.attributes.uuid = String(text);
  const user = attr(uuidNode, "userName");
  if (user != null) obj.attributes.lastModifiedBy = decodeEntities(user);
  const account = attr(uuidNode, "accountName");
  if (account != null) obj.attributes.lastModifiedAccount = decodeEntities(account);
  const timestamp = attr(uuidNode, "timestamp");
  if (timestamp != null) obj.attributes.lastModifiedAt = timestamp;
  const mods = attr(uuidNode, "modifications");
  if (mods != null) obj.attributes.modifications = mods;
}

/**
 * Collect leaf catalog items, descending through <Group>, <ObjectList>, and
 * folder items (isFolder="True"). Folders/containers are organizational and are
 * not returned as objects themselves.
 */
function collectCatalogItems(catalogNode: unknown, itemTag: string): unknown[] {
  if (!isRecord(catalogNode)) return [];
  const items: unknown[] = [];
  for (const el of asArray(catalogNode[itemTag])) {
    if (isFolder(el)) items.push(...collectCatalogItems(el, itemTag));
    else items.push(el);
  }
  for (const container of [...asArray(catalogNode["Group"]), ...asArray(catalogNode["ObjectList"])]) {
    items.push(...collectCatalogItems(container, itemTag));
  }
  return items;
}

function isFolder(node: unknown): boolean {
  // "True" opens a folder, "Marker" closes one — both are organizational
  // markers, not real objects, so neither should become an object.
  const flag = attr(node, "isFolder");
  return flag != null && /^(true|marker)$/i.test(flag);
}

/**
 * Walk an object body and emit a reference for every nested element whose tag
 * is a known reference tag and that carries an `id`. The name of the nearest
 * ancestor <Step> is carried as edge context (so a reference buried inside a
 * step's parameters is still attributed to the right step).
 */
interface ScanCtx {
  stepName?: string;
  /** 1-based index of the enclosing <Step>, matching scriptSteps() numbering. */
  stepIndex?: number;
  /** The enclosing <Step> is disabled (enable="False"). */
  disabled?: boolean;
}

/** A `<DataSourceReference id="0">` names the current file ("Current File" in
 * Close File, Re-Login, …) — except FileMaker's `<unknown>` for a data source
 * that was deleted. */
function namesCurrentFile(id: string | undefined, name: string): boolean {
  return id === "0" && name !== UNKNOWN_TARGET;
}

/** Push a reference, stamped with the originating step (and whether that step is
 * disabled) from the scan context. */
function pushRef(out: RawReference[], ref: RawReference, ctx: ScanCtx): void {
  if (ctx.stepIndex != null) ref.fromStep = ctx.stepIndex;
  if (ctx.disabled) ref.disabled = true;
  out.push(ref);
}

function scanRefs(
  node: unknown,
  fromUid: string,
  ctx: ScanCtx,
  refTags: RefTags,
  out: RawReference[],
  inChunkList = false,
): void {
  if (Array.isArray(node)) {
    for (const item of node) scanRefs(item, fromUid, ctx, refTags, out, inChunkList);
    return;
  }
  if (!isRecord(node)) return;

  // A reference sitting beside a <DataSourceReference> (e.g. an external Perform
  // Script) targets that external file rather than the current one.
  const dataSourceRef = asArray(node["DataSourceReference"])[0];
  const dataSourceName = decodeEntities(attr(dataSourceRef, "name") ?? "");
  const externalFileName =
    dataSourceRef != null && !namesCurrentFile(attr(dataSourceRef, "id"), dataSourceName) ? dataSourceName : undefined;

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR_PREFIX) || key === "#text") continue;

    // A calculation's references live in a separate <_HASH><ChunkList> block,
    // reached only through this pointer; scan it as if inline here so the field /
    // function references resolve with full id + occurrence context (and a script
    // step's index carries through `ctx`). Guard against nested pointers.
    if (key === "DDRREF") {
      if (chunkContext && !inChunkList) scanChunkListPointers(node, value, fromUid, ctx, refTags, out);
      continue;
    }

    // Switched-off auto-enter options (a calc or lookup) and validation calcs stay
    // in the XML — FileMaker even leaves a disabled lookup's references in place
    // after its source relationship is deleted. They're dead configuration, so
    // scan only what's in effect.
    if (key === "AutoEnter" || key === "Validation") {
      for (const el of asArray(value)) {
        scanRefs(key === "AutoEnter" ? activeAutoEnter(el) : activeValidation(el), fromUid, ctx, refTags, out, inChunkList);
      }
      continue;
    }

    // A chunk classified as a custom-function call carries only the function name
    // (no id), so resolve it by name within this file. The type tag means a field
    // or variable of the same name is never mistaken for a function. Variable
    // chunks name globals exactly (comments are chunks of their own, so a $$name
    // mentioned in one is never counted); a global passed by name as a whole
    // string literal is plain text in a NoRef chunk.
    if (key === "Chunk") {
      for (const el of asArray(value)) {
        if (isRecord(el) && chunkContext) {
          const type = attr(el, "type");
          const raw = el["#text"];
          const text = typeof raw === "string" ? decodeEntities(raw.trim()) : "";
          const cfId = type === "CustomFunctionRef" && text ? chunkContext.cfByName.get(text) : undefined;
          const globals =
            type === "VariableReference" && text.startsWith("$$")
              ? [text]
              : type === "NoRef" && text.includes('"$$')
                ? quotedGlobalVariables(text)
                : [];
          if (cfId != null) {
            pushRef(out, { fromUid, toType: "customFunction", toId: cfId, toName: text, kind: "customFunction" }, ctx);
          }
          for (const name of globals) {
            pushRef(out, { fromUid, toType: "globalVariable", toId: name, toName: name, kind: "globalVariable" }, ctx);
          }
        }
        // Recurse to capture the <FieldReference> inside a FieldRef chunk.
        scanRefs(el, fromUid, ctx, refTags, out, inChunkList);
      }
      continue;
    }

    // A script trigger whose script was deleted keeps its event but loses its
    // <ScriptReference> (FileMaker shows the script as <unknown>).
    if (key === "ScriptTrigger") {
      for (const el of asArray(value)) {
        if (isRecord(el) && el["ScriptReference"] == null) {
          pushRef(out, { fromUid, toType: "script", toId: MISSING_REF_ID, toName: UNKNOWN_TARGET, kind: "trigger", forceBroken: true }, ctx);
        }
        scanRefs(el, fromUid, ctx, refTags, out, inChunkList);
      }
      continue;
    }

    // The global a Set Variable step writes (<Name value>) or a step stores its
    // result in (<Variable value>, e.g. Insert from URL's target) isn't a calc,
    // so no chunk records it. (Still recursed below: a target's repetition is.)
    if (key === "Name" || key === "Variable") {
      for (const el of asArray(value)) {
        const variable = decodeEntities(attr(el, "value") ?? "").trim();
        if (variable.startsWith("$$")) {
          pushRef(out, { fromUid, toType: "globalVariable", toId: variable, toName: variable, kind: "globalVariable" }, ctx);
        }
      }
    }

    const targetType = refTags[key];
    const isStepArray = key === "Step";
    let stepCounter = 0;
    for (const el of asArray(value)) {
      if (targetType && isRecord(el)) {
        const id = attr(el, "id");
        const name = decodeEntities(attr(el, "name") ?? "");
        // FileMaker writes a placeholder <FieldReference id="0" name="" UUID="">
        // for every UNMAPPED source column in Import Records (one per slot, even
        // the hundreds that aren't being imported). They aren't real references;
        // emitting them produces a flood of broken edges that mis-flags the step.
        const isPlaceholderField = targetType === "field" && id === "0" && !name;
        // "[File Default]" / "[Standard FileMaker Menus]" aren't catalog menu sets,
        // and "Current File" (Close File, Re-Login, …) isn't an external data source.
        const isPseudo =
          (targetType === "customMenuSet" && (id === "0" || PSEUDO_MENU_SETS.has(name))) ||
          (targetType === "externalDataSource" && namesCurrentFile(id, name));
        if (id != null && !isPlaceholderField && !isPseudo) {
          const ref: RawReference = {
            fromUid,
            toType: targetType,
            toId: id,
            toName: name,
            kind: edgeKind(targetType, ctx.stepName),
          };
          // The data source itself is this file's own catalog entry, not a target
          // inside the external file.
          if (externalFileName != null && targetType !== "externalDataSource") ref.toFileName = externalFileName;
          if (targetType === "field") {
            // A field reference is meaningful only relative to the table
            // occurrence it reads through — a nested <TableOccurrenceReference>.
            const viaToId = attr(asArray(el["TableOccurrenceReference"])[0], "id");
            if (viaToId != null) ref.viaToId = viaToId;
            // Some field references name their base table directly instead (e.g. a
            // summary field's <SummaryField>); resolve through that base table.
            const viaBaseTableId = attr(asArray(el["BaseTableReference"])[0], "id");
            if (viaBaseTableId != null) ref.viaBaseTableId = viaBaseTableId;
          }
          pushRef(out, ref, ctx);
        }
      }
      // A <Step> element sets the step name + index for its whole subtree.
      let childCtx = ctx;
      if (isStepArray && isRecord(el)) {
        stepCounter += 1;
        childCtx = {
          stepName: attr(el, "name") ?? ctx.stepName,
          stepIndex: stepCounter,
          ...(ctx.disabled || attr(el, "enable") === "False" ? { disabled: true } : {}),
        };
        addStepTargetRefs(el, fromUid, childCtx, out);
      }
      // A field read through a deleted occurrence (<Table Missing>, id -1) is one
      // broken reference, not two: don't also emit the dead occurrence itself.
      const deadOccurrence =
        targetType === "field" && isRecord(el) && attr(asArray(el["TableOccurrenceReference"])[0], "id") === "-1";
      scanRefs(deadOccurrence ? withoutKey(el, "TableOccurrenceReference") : el, fromUid, childCtx, refTags, out, inChunkList);
    }
  }
}

function withoutKey(node: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = node;
  return rest;
}

/**
 * Follow a calculation's `<DDRREF kind="ChunkList">` pointer(s) into DDR_INFO. A
 * block is used only if it is really this calc's: its hash must match the
 * pointer's (when both carry one), and its chunks must spell out the calc's own
 * text. Otherwise — an empty list (FileMaker's output for any calc that mentions
 * a deleted field or table) or a block shared through a UUID-less pointer — the
 * references are recovered from the formula text instead.
 */
function scanChunkListPointers(
  calc: Record<string, unknown>,
  pointers: unknown,
  fromUid: string,
  ctx: ScanCtx,
  refTags: RefTags,
  out: RawReference[],
): void {
  const context = chunkContext;
  if (!context) return;
  const textNode = calc["Text"];
  const calcText =
    textNode == null ? undefined : decodeEntities(typeof textNode === "string" ? textNode : collectText(textNode));
  for (const el of asArray(pointers)) {
    if (!isRecord(el) || attr(el, "kind") !== "ChunkList") continue;
    const ptr = el["#text"];
    const block = typeof ptr === "string" ? context.lists.get(ptr) : undefined;
    if (block && chunkBlockBelongsTo(block, attr(el, "hash"), calcText)) {
      scanRefs(block, fromUid, ctx, refTags, out, true);
    } else if (calcText?.trim()) {
      scanCalcTextRefs(calcText, calc, fromUid, ctx, out);
    }
  }
}

function chunkBlockBelongsTo(block: unknown, pointerHash: string | undefined, calcText: string | undefined): boolean {
  const list = asArray(isRecord(block) ? block["ChunkList"] : undefined)[0];
  // FileMaker writes a pointer's hash only on the calc whose chunk list it kept;
  // the others sharing that pointer (owners without a UUID) get hash="". So a
  // hashed pointer always owns its block — though the list is empty when the calc
  // names a deleted field or table, and then only its text has the references.
  if (pointerHash) {
    const blockHash = attr(block, "hash");
    if (blockHash && blockHash !== pointerHash) return false;
    const hasChunks = asArray(isRecord(list) ? list["Chunk"] : undefined).length > 0;
    return hasChunks || !calcText?.trim();
  }
  // An unhashed pointer may be anyone's: use the block only if it spells out
  // this calc's own text (with no text to compare, trust it).
  return calcText == null || chunkListMatchesText(list, calcText);
}

/**
 * Best-effort references from a formula's own text, for a calc whose chunk list
 * is unusable. String literals and comments are blanked first, and names are
 * matched whole against what the file defines:
 *   • `TO::Field` — the occurrence by the longest name before the `::`; for a
 *     local occurrence the field by the longest name after it, for an external
 *     one the field is resolved by name later (its table lives in another file).
 *   • Unqualified field names — only in a field's own calcs, where FileMaker
 *     writes same-table fields bare — against the calc's context table.
 *   • Custom-function calls and $$global variables.
 * Nothing found this way is ever reported broken: a name that doesn't match
 * simply isn't a reference.
 */
function scanCalcTextRefs(
  rawText: string,
  calc: Record<string, unknown>,
  fromUid: string,
  ctx: ScanCtx,
  out: RawReference[],
): void {
  const context = chunkContext;
  if (!context) return;
  const text = stripLiteralsAndComments(rawText);

  for (let pos = text.indexOf("::"); pos !== -1; pos = text.indexOf("::", pos + 2)) {
    const toName = longestNameEndingAt(text, pos, context.toNames);
    const to = toName != null ? context.toByName.get(toName) : undefined;
    if (!to || toName == null) continue;
    // As with a chunk list's field chunk, the occurrence is referenced too.
    pushRef(out, { fromUid, toType: "tableOccurrence", toId: to.id, toName, kind: edgeKind("tableOccurrence", ctx.stepName) }, ctx);
    if (to.localBaseTableId != null) {
      const fields = context.fieldsByTable.get(to.localBaseTableId);
      const field = fields ? longestNameAt(text, pos + 2, fields.index) : undefined;
      const fieldId = field != null ? fields?.idByName.get(field) : undefined;
      if (field != null && fieldId != null) {
        pushRef(out, { fromUid, toType: "field", toId: fieldId, toName: field, kind: "field", viaToId: to.id }, ctx);
      }
    } else if (to.external) {
      const candidate = fieldNameCandidate(text, pos + 2);
      if (candidate && !candidate.startsWith("<")) {
        pushRef(out, { fromUid, toType: "field", toId: "", toName: candidate, kind: "field", viaToId: to.id, byName: true }, ctx);
      }
    }
  }

  if (fromUid.split(":")[1] === "field") {
    const contextToId = attr(asArray(calc["TableOccurrenceReference"])[0], "id");
    const to = contextToId != null ? context.toById.get(contextToId) : undefined;
    const fields = to?.localBaseTableId != null ? context.fieldsByTable.get(to.localBaseTableId) : undefined;
    if (to && fields) {
      forEachBareName(text, fields.index, true, (name) => {
        const fieldId = fields.idByName.get(name);
        if (fieldId != null) pushRef(out, { fromUid, toType: "field", toId: fieldId, toName: name, kind: "field", viaToId: to.id }, ctx);
      });
    }
  }

  forEachBareName(text, context.cfIndex, false, (name) => {
    const cfId = context.cfByName.get(name);
    if (cfId != null) pushRef(out, { fromUid, toType: "customFunction", toId: cfId, toName: name, kind: "customFunction" }, ctx);
  });

  for (const name of [...globalVariablesInText(text), ...quotedGlobalVariables(rawText)]) {
    pushRef(out, { fromUid, toType: "globalVariable", toId: name, toName: name, kind: "globalVariable" }, ctx);
  }
}

/** Every whole, unqualified occurrence of an indexed name in `text`: not part of
 * a longer word, not the field half of `TO::Field`, not a `$variable`, and not
 * itself an occurrence name (followed by `::`). With `notCall`, a name followed
 * by `(` is skipped too (that's a function, not a field). */
function forEachBareName(text: string, index: NameIndex, notCall: boolean, emit: (name: string) => void): void {
  for (let p = 0; p < text.length; p++) {
    if (!index.byFirst.has(text[p]!) || isWordChar(text[p - 1])) continue;
    if (text[p - 1] === "$" || text.startsWith("::", p - 2)) continue;
    const name = longestNameAt(text, p, index);
    if (name == null) continue;
    const after = text.slice(p + name.length).trimStart();
    if (!after.startsWith("::") && !(notCall && after.startsWith("("))) emit(name);
    p += name.length - 1;
  }
}

/** Whether an auto-enter option element is in effect. FileMaker 26 marks each
 * one enable="True|False"; older exports don't, so fall back to the AutoEnter's
 * own `type` (the option it's set to). */
function autoEnterOptionActive(option: unknown, autoEnterType: string | undefined, forType: string): boolean {
  const enable = attr(asArray(option)[0], "enable");
  return enable != null ? enable !== "False" : autoEnterType === forType;
}

/** An <AutoEnter> without its switched-off calc / lookup (the same node when
 * nothing is dropped). */
function activeAutoEnter(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const type = attr(node, "type");
  const dropCalc = node["Calculated"] != null && !autoEnterOptionActive(node["Calculated"], type, "Calculated");
  const dropLookup = node["Looked_up"] != null && !autoEnterOptionActive(node["Looked_up"], type, "Looked_up");
  if (!dropCalc && !dropLookup) return node;
  let active = node;
  if (dropCalc) active = withoutKey(active, "Calculated");
  if (dropLookup) active = withoutKey(active, "Looked_up");
  return active;
}

/** A <Validation> without a validation-by-calculation that's switched off (the
 * same node when it's on or absent). */
function activeValidation(node: unknown): unknown {
  if (!isRecord(node) || attr(asArray(node["Calculated"])[0], "enable") !== "False") return node;
  return withoutKey(node, "Calculated");
}

/** A field element with only its in-effect auto-enter / validation options (the
 * same node when nothing is switched off). */
function activeFieldNode(field: unknown): unknown {
  if (!isRecord(field)) return field;
  const autoEnter = asArray(field["AutoEnter"]);
  const validation = asArray(field["Validation"]);
  const activeAe = autoEnter.map(activeAutoEnter);
  const activeVal = validation.map(activeValidation);
  const changed = activeAe.some((n, i) => n !== autoEnter[i]) || activeVal.some((n, i) => n !== validation[i]);
  return changed ? { ...field, AutoEnter: activeAe, Validation: activeVal } : field;
}
