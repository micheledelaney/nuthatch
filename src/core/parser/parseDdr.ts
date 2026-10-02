import type { FmFile, FmObject, ParseResult, RawReference } from "@/types/ddr";
import { buildFileIndex, type FileParse } from "./context";
import { xmlParser } from "./xmlParser";
import { attr, isRecord, textAttr } from "./xmlUtils";
import { fileUidAt } from "./uid";
import { globalVariableObjects } from "./refs/globalVariables";
import { addTextDerivedRefs } from "./refs/textRefs";
import { parseCatalogs } from "./objects/catalogs";
import { deferredLayoutTargets } from "./objects/deferredLayouts";
import { parseTablesAndFields } from "./objects/fields";
import { addFileRefs, makeFileObject } from "./objects/fileObject";
import { parseLayoutsStreaming, splitLayoutCatalog } from "./objects/layoutStream";
import { parseCustomMenuItems } from "./objects/menus";
import { parseScripts } from "./objects/scripts";

interface SourceDoc {
  name: string;
  content: string;
}

/**
 * Parse one or more FileMaker "Save a Copy as XML" (<FMSaveAsXML>) documents
 * into a flat, serializable model. References are emitted unresolved; buildModel
 * resolves and indexes them.
 */
export function parseDocuments(docs: SourceDoc[]): ParseResult {
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
  try {
    return parseFile(container, fileIndex, errors, layoutCatalog);
  } catch (err) {
    // Each file parses into its own lists, so nothing of this one is left half-added.
    errors.push(`${doc.name}: parsing stopped and this file was left out — ${(err as Error).message}`);
    return null;
  }
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
    errors.push(`${container.name}: unrecognized <Structure> layout (expected one <AddAction>) — none of its catalogs could be read.`);
    return { file, objects: [fileObject], references: [], globals: [] };
  }

  const fp: FileParse = {
    file,
    fileObject,
    index: buildFileIndex(node, container.ddrInfo),
    deferredLayoutTargets: deferredLayoutTargets(container.modifyAction),
    activeText: new Map(),
    layoutObjectUidCounts: new Map(),
    objects: [fileObject],
    references: [],
    errors,
  };
  addFileRefs(fp, node, container.metadata);
  parseTablesAndFields(fp, node);
  parseScripts(fp, node);
  parseCatalogs(fp, node);
  parseCustomMenuItems(fp, node);
  // Text-derived references for everything so far; each streamed layout gets
  // its own pass (processOneLayout), so its full text can be dropped right after.
  addTextDerivedRefs(fp, fp.objects, 0);
  if (layoutCatalog) parseLayoutsStreaming(fp, layoutCatalog);
  return { file, objects: fp.objects, references: fp.references, globals: globalVariableObjects(fp) };
}

/** Drop exact-duplicate references (same source, target, kind, occurrence
 * context, and originating step). The text-based passes can rediscover an edge
 * another pass already recorded; collapsing them keeps reference counts honest.
 * Distinct step usages (different fromStep) are preserved, since broken-step
 * flagging needs them, and so are distinct kinds (a Set Field that both sets
 * and reads a field). */
function dedupeRefs(refs: RawReference[]): RawReference[] {
  const seen = new Set<string>();
  const out: RawReference[] = [];
  for (const r of refs) {
    // Name-based references share an empty toId, so their name is the identity.
    const key = `${r.fromUid}|${r.toType}|${r.toId}|${r.kind}|${r.byName ? r.toName : ""}|${r.viaToId ?? ""}|${r.viaBaseTableId ?? ""}|${r.fromStep ?? ""}|${r.toFileName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
