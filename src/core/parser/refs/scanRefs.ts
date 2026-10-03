import type { ObjectType, RawReference, RefKind } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, child, children, isElementKey, isRecord, textAttr, withoutKey } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { FMSAVEAS_REF_TAGS, edgeKind } from "../refTags";
import { ownValue } from "../ownValue";
import { PSEUDO_MENU_SETS, UNKNOWN_TARGET, namesCurrentFile } from "../sentinels";
import { calculationText, chunkListMatchesText, quotedGlobalVariables } from "../calcText";
import { stepNodes } from "../steps";
import { scanCalcTextRefs } from "./calcTextRefs";
import { addStepTargetRefs } from "./stepTargets";
import { brokenRef, customFunctionRef, globalVariableRef, pushRef, type RefOwner, type ScanContext } from "./refBuilders";

/**
 * Walk an object body and record a reference for every nested element whose tag
 * is a known reference tag and that carries an `id`, into `fp.references`. The
 * name and index of the nearest ancestor <Step> are carried as edge context (so
 * a reference buried inside a step's parameters is still attributed to the
 * right step).
 */
export function scanRefs(fp: FileParse, node: unknown, owner: RefOwner, ctx: ScanContext = {}): void {
  if (Array.isArray(node)) {
    for (const item of node) scanRefs(fp, item, owner, ctx);
    return;
  }
  if (!isRecord(node)) return;

  // A reference sitting beside a <DataSourceReference> (e.g. an external Perform
  // Script) targets that external file rather than the current one.
  const externalFileName = externalFileOf(child(node, "DataSourceReference"));

  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    if (scanSpecialElements(fp, node, key, value, owner, ctx)) continue;
    scanElements(fp, key, value, owner, ctx, externalFileName);
  }
}

/** The element keys that need more than the generic scan. True when the
 * elements are fully handled here. */
function scanSpecialElements(
  fp: FileParse,
  node: Record<string, unknown>,
  key: string,
  value: unknown,
  owner: RefOwner,
  ctx: ScanContext,
): boolean {
  switch (key) {
    case "DDRREF":
      // A calculation's references live in a separate <_HASH><ChunkList> block,
      // reached only through this pointer; scan it as if inline here so the
      // field / function references resolve with full id + occurrence context
      // (and a script step's index carries through `ctx`). Guard against
      // nested pointers.
      if (!ctx.inChunkList) followChunkLists(fp, node, value, owner, ctx);
      return true;
    case "Chunk":
      scanChunks(fp, value, owner, ctx);
      return true;
    case "Map":
      // Import Records lists every field of the target table as a <Map>: kind 0
      // "import to", kind 2 "match with" (update matching records), and kind 1
      // "not import to" — which isn't a use of the field.
      for (const el of asArray(value)) {
        if (attr(el, "kind") !== "1") scanRefs(fp, el, owner, ctx);
      }
      return true;
    case "ScriptTrigger":
      scanTriggers(fp, value, owner, ctx);
      return true;
    case "Step":
      stepNodes(node).forEach((step, i) => scanStep(fp, step, i + 1, owner, ctx));
      return true;
    case "Name":
    case "Variable":
      addVariableTargetRefs(fp, value, owner, ctx);
      // Still scanned generically: a target's repetition is a calc.
      return false;
    default:
      return false;
  }
}

/** Script triggers: their script is a "trigger" edge. A trigger whose script
 * was deleted keeps its event but loses its <ScriptReference> (FileMaker shows
 * the script as <unknown>). */
function scanTriggers(fp: FileParse, value: unknown, owner: RefOwner, ctx: ScanContext): void {
  for (const el of asArray(value)) {
    if (isRecord(el) && el["ScriptReference"] == null) {
      pushRef(fp.references, brokenRef(owner.uid, "script", UNKNOWN_TARGET, "trigger"), ctx);
    }
    scanRefs(fp, el, owner, { ...ctx, inTrigger: true });
  }
}

/** The global a Set Variable step writes (<Name value>) or a step stores its
 * result in (<Variable value>, e.g. Insert from URL's target): not a calc, so
 * no chunk records it. */
function addVariableTargetRefs(fp: FileParse, value: unknown, owner: RefOwner, ctx: ScanContext): void {
  for (const el of asArray(value)) {
    const variable = (textAttr(el, "value") ?? "").trim();
    if (variable.startsWith("$$")) pushRef(fp.references, globalVariableRef(owner.uid, variable), ctx);
  }
}

/** The `index`-th step of a step list (see stepNodes), setting the step context
 * for everything inside it. */
function scanStep(fp: FileParse, step: Record<string, unknown>, index: number, owner: RefOwner, ctx: ScanContext): void {
  const stepCtx: ScanContext = {
    stepName: attr(step, "name") ?? ctx.stepName,
    stepIndex: index,
    ...(ctx.disabled || attr(step, "enable") === "False" ? { disabled: true } : {}),
    ...(ctx.inChunkList ? { inChunkList: true } : {}),
  };
  addStepTargetRefs(fp, step, owner.uid, stepCtx);
  scanRefs(fp, step, owner, stepCtx);
}

/** The elements under one key: a reference for each that is one, then their
 * subtrees. */
function scanElements(
  fp: FileParse,
  key: string,
  value: unknown,
  owner: RefOwner,
  ctx: ScanContext,
  externalFileName: string | undefined,
): void {
  const targetType = ownValue(FMSAVEAS_REF_TAGS, key);
  for (const el of asArray(value)) {
    if (targetType && isRecord(el)) {
      const ref = elementRef(el, targetType, owner.uid, ctx, externalFileName);
      if (ref) pushRef(fp.references, ref, ctx);
    }
    // A field read through a deleted occurrence (<Table Missing>, id -1) is one
    // broken reference, not two: don't also emit the dead occurrence itself.
    const deadOccurrence = targetType === "field" && isRecord(el) && attr(child(el, "TableOccurrenceReference"), "id") === "-1";
    scanRefs(fp, deadOccurrence ? withoutKey(el, "TableOccurrenceReference") : el, owner, ctx);
  }
}

/** The reference a `targetType` element records, or undefined for FileMaker's
 * placeholders that aren't references at all. */
function elementRef(
  el: Record<string, unknown>,
  targetType: ObjectType,
  fromUid: string,
  ctx: ScanContext,
  externalFileName: string | undefined,
): RawReference | undefined {
  const id = attr(el, "id");
  if (id == null) return undefined;
  const name = textAttr(el, "name") ?? "";
  // FileMaker writes a placeholder <FieldReference id="0" name="" UUID="">
  // for every UNMAPPED source column in Import Records (one per slot, even
  // the hundreds that aren't being imported). They aren't real references;
  // emitting them produces a flood of broken edges that mis-flags the step.
  if (targetType === "field" && id === "0" && !name) return undefined;
  // The built-in menu sets aren't catalog menu sets, and "Current File" (Close
  // File, Re-Login, …) isn't an external data source.
  if (targetType === "customMenuSet" && (id === "0" || PSEUDO_MENU_SETS.has(name))) return undefined;
  if (targetType === "externalDataSource" && namesCurrentFile(id, name)) return undefined;

  // A field reference is meaningful only relative to the table occurrence it
  // reads through (a nested <TableOccurrenceReference>); some name their base
  // table directly instead (e.g. a summary field's <SummaryField>).
  const viaToId = targetType === "field" ? attr(child(el, "TableOccurrenceReference"), "id") : undefined;
  const viaBaseTableId = targetType === "field" ? attr(child(el, "BaseTableReference"), "id") : undefined;
  return {
    fromUid,
    toType: targetType,
    toId: id,
    toName: name,
    kind: refKind(targetType, ctx),
    // The data source itself is this file's own catalog entry, not a target
    // inside the external file.
    ...(externalFileName != null && targetType !== "externalDataSource" ? { toFileName: externalFileName } : {}),
    ...(viaToId != null ? { viaToId } : {}),
    ...(viaBaseTableId != null ? { viaBaseTableId } : {}),
  };
}

/** A reference's edge kind: a trigger's script, a step's own target (see
 * edgeKind), or — for what a calculation reads, even inside a step — the plain
 * target type. (A Set Field's value calc reads fields; it doesn't set them.) */
function refKind(targetType: ObjectType, ctx: ScanContext): RefKind {
  if (ctx.inTrigger && targetType === "script") return "trigger";
  return ctx.inChunkList ? targetType : edgeKind(targetType, ctx.stepName);
}

/** The external file a <DataSourceReference> points into, or undefined when
 * there is none or it names the current file. */
function externalFileOf(dataSourceRef: unknown): string | undefined {
  if (dataSourceRef == null) return undefined;
  const name = textAttr(dataSourceRef, "name") ?? "";
  return namesCurrentFile(attr(dataSourceRef, "id"), name) ? undefined : name;
}

/**
 * The chunks of a chunk list. A chunk classified as a custom-function call
 * carries only the function name (no id), so it's resolved by name within this
 * file; the type tag means a field or variable of the same name is never
 * mistaken for a function. Variable chunks name globals exactly (comments are
 * chunks of their own, so a $$name mentioned in one is never counted); a global
 * passed by name as a whole string literal is plain text in a NoRef chunk.
 */
function scanChunks(fp: FileParse, value: unknown, owner: RefOwner, ctx: ScanContext): void {
  for (const el of asArray(value)) {
    if (isRecord(el)) {
      const type = attr(el, "type");
      const raw = el["#text"];
      const text = typeof raw === "string" ? decodeEntities(raw.trim()) : "";
      const cfId = type === "CustomFunctionRef" && text ? fp.index.cfByName.get(text) : undefined;
      if (cfId != null) pushRef(fp.references, customFunctionRef(owner.uid, cfId, text), ctx);
      const globals =
        type === "VariableReference" && text.startsWith("$$")
          ? [text]
          : type === "NoRef" && text.includes('"$$')
            ? quotedGlobalVariables(text)
            : [];
      for (const name of globals) pushRef(fp.references, globalVariableRef(owner.uid, name), ctx);
    }
    // Recurse to capture the <FieldReference> inside a FieldRef chunk.
    scanRefs(fp, el, owner, ctx);
  }
}

/**
 * Follow a calculation's `<DDRREF kind="ChunkList">` pointer(s) into DDR_INFO. A
 * block is used only if it is really this calc's: its hash must match the
 * pointer's (when both carry one), and its chunks must spell out the calc's own
 * text. Otherwise — an empty list (FileMaker's output for any calc that mentions
 * a deleted field or table) or a block shared through a UUID-less pointer — the
 * references are recovered from the formula text instead.
 */
function followChunkLists(fp: FileParse, calc: Record<string, unknown>, pointers: unknown, owner: RefOwner, ctx: ScanContext): void {
  // The formula as written: CDATA verbatim (a chunk's text is entity-encoded,
  // and chunkListMatchesText decodes that side). It's the calc's <Text>, or in
  // FM 21 (install conditions, menu overrides) the bare-CDATA <Calculation>
  // beside the pointer; a node that only lists pointers has none.
  const calcText = calc["Text"] != null || calc["Calculation"] != null ? calculationText(calc) : undefined;
  for (const el of asArray(pointers)) {
    if (!isRecord(el) || attr(el, "kind") !== "ChunkList") continue;
    const ptr = el["#text"];
    const block = typeof ptr === "string" ? fp.index.lists.get(ptr) : undefined;
    if (block && chunkBlockBelongsTo(block, attr(el, "hash"), calcText)) {
      scanRefs(fp, block, owner, { ...ctx, inChunkList: true });
    } else if (calcText?.trim()) {
      scanCalcTextRefs(fp, calcText, calc, owner, ctx);
    }
  }
}

function chunkBlockBelongsTo(block: unknown, pointerHash: string | undefined, calcText: string | undefined): boolean {
  const list = child(block, "ChunkList");
  // FileMaker writes a pointer's hash only on the calc whose chunk list it kept;
  // the others sharing that pointer (owners without a UUID) get hash="". So a
  // hashed pointer always owns its block — though the list is empty when the calc
  // names a deleted field or table, and then only its text has the references.
  if (pointerHash) {
    const blockHash = attr(block, "hash");
    if (blockHash && blockHash !== pointerHash) return false;
    const hasChunks = children(list, "Chunk").length > 0;
    return hasChunks || !calcText?.trim();
  }
  // An unhashed pointer may be anyone's: use the block only if it spells out
  // this calc's own text (with no text to compare, trust it).
  return calcText == null || chunkListMatchesText(list, calcText);
}
