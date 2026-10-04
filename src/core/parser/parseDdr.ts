import type { FmFile, FmObject, ParseResult, RawReference } from "@/types/ddr";
import { OBJECT_TYPE_META } from "@/types/ddr";
import { buildFileIndex, type FileParse, type TextScan } from "./context";
import { xmlParser } from "./xmlParser";
import { attr, cdataText, isRecord, textAttr } from "./xmlUtils";
import { fileUidAt } from "./uid";
import { globalVariableObjects } from "./refs/globalVariables";
import { addTextDerivedRefs } from "./refs/textRefs";
import { parseCatalogs } from "./objects/catalogs";
import { deferredLayoutTargets } from "./objects/deferredLayouts";
import { parseTablesAndFields } from "./objects/fields";
import { addFileRefs, makeFileObject } from "./objects/fileObject";
import { parseLayoutsInTree, parseLayoutsStreaming, splitLayoutCatalog } from "./objects/layoutStream";
import { parseCustomMenuItems } from "./objects/menus";
import { parseScripts } from "./objects/scripts";
import { addThemeBases } from "./objects/themes";

interface SourceDoc {
  name: string;
  content: string;
}

/**
 * Parse one or more FileMaker "Save a Copy as XML" (<FMSaveAsXML>) documents
 * into a flat, serializable model. References are emitted unresolved; buildModel
 * resolves and indexes them. Each document is read once, in order, so `docs`
 * can decode it only then (and nothing here keeps it after it's parsed).
 */
export function parseDocuments(docs: Iterable<SourceDoc>): ParseResult {
  const files: FmFile[] = [];
  const objects: FmObject[] = [];
  const references: RawReference[] = [];
  const globals: FmObject[] = [];
  const errors: string[] = [];
  for (const doc of docs) {
    const parsed = parseDocument(doc, files.length, errors);
    if (!parsed) continue;
    files.push(parsed.file);
    for (const obj of parsed.objects) objects.push(obj);
    for (const ref of parsed.references) references.push(ref);
    for (const obj of parsed.globals) globals.push(obj);
  }
  // Global variables come last, after every file's catalog objects.
  for (const obj of globals) objects.push(obj);
  return { files, objects, references: dedupeRefs(references), errors };
}

interface ParsedFile {
  file: FmFile;
  objects: FmObject[];
  references: RawReference[];
  globals: FmObject[];
}

function parseDocument(doc: SourceDoc, fileIndex: number, errors: string[]): ParsedFile | null {
  if (isTruncated(doc.content)) {
    errors.push(`${doc.name}: the file is incomplete — it ends before </${ROOT_TAG}> (an interrupted export or copy), so it was left out. Export or copy it again.`);
    return null;
  }
  const { rest, layoutCatalog } = splitLayoutCatalog(doc.content);
  let root: unknown;
  try {
    root = xmlParser.parse(rest);
  } catch (err) {
    errors.push(`${doc.name}: failed to parse XML — ${(err as Error).message}`);
    return null;
  }
  const container = locateContainer(root, doc.name);
  if (!container) {
    errors.push(`${doc.name}: no <FMSaveAsXML> structure found — not a recognized FileMaker "Save a Copy as XML" export.`);
    return null;
  }
  // Calculation and step references resolve precisely through the DDR_INFO
  // <ChunkList> blocks. Without DDR_INFO only the best-effort scan of each
  // calc's text is left (and script steps lose their rendered text), so
  // references would be silently incomplete. Surface that.
  if (container.ddrInfo == null) {
    errors.push(
      `${doc.name}: missing <DDR_INFO> — references inside calculations and script steps cannot be resolved. Re-export with "Include details for analysis tools" enabled.`,
    );
  }
  if (container.splitCatalogs) {
    errors.push(`${doc.name}: saved with split catalogs (split_catalogs="True"), which this app doesn't support — some objects may be missing.`);
  }
  try {
    return parseFile(container, fileIndex, errors, layoutCatalog);
  } catch (err) {
    // Each file parses into its own lists, so nothing of this one is left half-added.
    errors.push(`${doc.name}: parsing stopped and this file was left out — ${(err as Error).message}`);
    // The message alone doesn't say where it failed.
    console.error(`${doc.name}: parsing stopped`, err);
    return null;
  }
}

const ROOT_TAG = "FMSaveAsXML";
const ROOT_CLOSE = `</${ROOT_TAG}>`;

/** What XML allows after the root element (comments and processing
 * instructions), removed before checking that only whitespace is left. */
const AFTER_ROOT_MARKUP_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;

/** Whether a "Save a Copy as XML" document stops before its closing root tag:
 * an interrupted export or copy. The XML parser reads such a document without
 * complaint when the cut lands in the right place, and the layout catalog then
 * can't be cut out, so whole catalogs would go missing without a word. After
 * the closing tag, whitespace, comments and the NUL padding a copy can leave
 * are fine. Any other document is left to the checks below. */
function isTruncated(xml: string): boolean {
  if (/<([A-Za-z_][\w.:-]*)/.exec(xml)?.[1] !== ROOT_TAG) return false;
  const end = xml.lastIndexOf(ROOT_CLOSE);
  return end === -1 || !/^[\s\0]*$/.test(xml.slice(end + ROOT_CLOSE.length).replace(AFTER_ROOT_MARKUP_RE, ""));
}

interface Container {
  /** The catalog-bearing node: <Structure><AddAction>, or <Structure> itself. */
  node: unknown;
  /** The sibling <DDR_INFO> section, where calculation chunk-list definitions
   * live (the catalogs only carry pointers into it). */
  ddrInfo: unknown;
  /** The sibling <Metadata> section, which holds file-level options and the
   * file's own script triggers (File Options). */
  metadata: unknown;
  /** FM 22's <Structure><ModifyAction>: second-pass edits to catalogs defined in
   * AddAction (FM 26 exports have no such block). */
  modifyAction: unknown;
  name: string;
  source: string;
  /** FileMaker application version that produced the export, if present. */
  version?: string;
  /** The root's split_catalogs="True": an export format no sample has. */
  splitCatalogs: boolean;
}

/** The catalog-bearing <FMSaveAsXML> container, if this is one. */
function locateContainer(root: unknown, source: string): Container | null {
  const saveAs = isRecord(root) ? root["FMSaveAsXML"] : undefined;
  if (!isRecord(saveAs)) return null;
  const structure = saveAs["Structure"];
  return {
    node: (isRecord(structure) ? structure["AddAction"] : undefined) ?? structure,
    ddrInfo: saveAs["DDR_INFO"],
    metadata: saveAs["Metadata"],
    modifyAction: isRecord(structure) ? structure["ModifyAction"] : undefined,
    name: (textAttr(saveAs, "File") ?? "Untitled").replace(/\.fmp12$/i, ""),
    source,
    // The FileMaker app version lives in `Source`; `version` is the schema.
    version: attr(saveAs, "Source"),
    splitCatalogs: attr(saveAs, "split_catalogs") === "True",
  };
}

/** One file's objects and references, in emission order: the catalogs (with
 * their text-derived references), then the layouts one at a time. */
function parseFile(container: Container, fileIndex: number, errors: string[], layoutCatalog?: string): ParsedFile {
  const file: FmFile = { uid: fileUidAt(fileIndex), name: container.name, source: container.source, version: container.version };
  const fileObject = makeFileObject(file, container.node, container.metadata);
  const node = container.node;
  if (!isRecord(node)) {
    // e.g. a <Structure> with several <AddAction> blocks: a shape no sample has.
    errors.push(`${container.source}: unrecognized <Structure> layout (expected one <AddAction>) — none of its catalogs could be read.`);
    return { file, objects: [fileObject], references: [], globals: [] };
  }

  const fp: FileParse = {
    file,
    fileObject,
    index: buildFileIndex(node, container.ddrInfo),
    deferredLayoutTargets: deferredLayoutTargets(container.modifyAction),
    layoutObjectUidCounts: new Map(),
    withoutId: new Map(),
    themeBases: new Map(),
    objects: [fileObject],
    references: [],
    errors,
  };
  // The catalog objects, each with the text the text-based passes read for it
  // — the file's own first: its triggers' parameters are calcs too.
  const scans: TextScan[] = [{ obj: fileObject, text: cdataText(container.metadata), source: container.metadata }];
  addFileRefs(fp, node, container.metadata);
  parseTablesAndFields(fp, node, scans);
  parseScripts(fp, node, scans);
  parseCatalogs(fp, node, scans);
  parseCustomMenuItems(fp, node, scans);
  // Text-derived references for everything so far; each layout gets its own
  // pass (processOneLayout), so its full text can be dropped right after.
  addTextDerivedRefs(fp, scans);
  const nextOrder = layoutCatalog ? parseLayoutsStreaming(fp, layoutCatalog) : 0;
  parseLayoutsInTree(fp, node["LayoutCatalog"], nextOrder);
  addThemeBases(fp);
  for (const [type, count] of fp.withoutId) {
    const { label, plural } = OBJECT_TYPE_META[type];
    const what = count === 1 ? `1 ${label.toLowerCase()} without an id was` : `${count} ${plural.toLowerCase()} without an id were`;
    errors.push(`${container.source}: ${what} left out.`);
  }
  return { file, objects: fp.objects, references: fp.references, globals: globalVariableObjects(fp) };
}

/** Drop exact-duplicate references (same source, target, kind, occurrence
 * context, and originating step). The text-based passes can rediscover an edge
 * another pass already recorded; collapsing them keeps reference counts honest.
 * Distinct step usages (different fromStep) are preserved, since broken-step
 * flagging needs them, and so are distinct kinds (a Set Field that both sets
 * and reads a field). Of a disabled and an enabled duplicate — a layout's
 * copies of the same use by two of its buttons — the enabled one is kept. */
function dedupeRefs(refs: RawReference[]): RawReference[] {
  const seen = new Map<string, number>();
  const out: RawReference[] = [];
  for (const r of refs) {
    const key = refKey(r);
    const at = seen.get(key);
    if (at == null) {
      seen.set(key, out.length);
      out.push(r);
    } else if (out[at]!.disabled && !r.disabled) {
      out[at] = r;
    }
  }
  return out;
}

/** Whether each reference field tells two references apart in dedupeRefs.
 * Every field is listed, so a new one has to be placed here. */
const IS_IDENTITY_FIELD: Readonly<Record<keyof RawReference, boolean>> = {
  fromUid: true,
  toType: true,
  toId: true,
  kind: true,
  viaToId: true,
  viaBaseTableId: true,
  fromStep: true,
  toFileName: true,
  // Only a name-based reference's name: its toId is empty (see refKey).
  toName: false,
  byName: false,
  // Of a disabled and an enabled duplicate, the enabled one is kept.
  disabled: false,
  // A forced-broken reference never shares the identity fields with one that
  // isn't: a placeholder's toId is MISSING_REF_ID, and an external value list
  // (or its data source) whose data source is gone is only recorded broken.
  forceBroken: false,
};

const IDENTITY_FIELDS = (Object.keys(IS_IDENTITY_FIELD) as (keyof RawReference)[]).filter((field) => IS_IDENTITY_FIELD[field]);

/** What makes a reference the same use as another (see dedupeRefs). */
function refKey(r: RawReference): string {
  // Name-based references share an empty toId, so their name is the identity.
  return [...IDENTITY_FIELDS.map((field) => r[field] ?? ""), r.byName ? r.toName : ""].join("|");
}
