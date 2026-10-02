import type { ObjectType, RawReference } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, child, children, collectText, isElementKey, isRecord, withoutKey } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { FMSAVEAS_REF_TAGS, edgeKind } from "../refTags";
import { PSEUDO_MENU_SETS, UNKNOWN_TARGET } from "../sentinels";
import { chunkListMatchesText, quotedGlobalVariables } from "../calcText";
import { activeAutoEnter, activeValidation } from "./activeOptions";
import { scanCalcTextRefs } from "./calcTextRefs";
import { addStepTargetRefs } from "./stepTargets";
import { brokenRef, globalVariableRef, pushRef, type RefOwner, type ScanCtx } from "./refBuilders";

/**
 * Walk an object body and record a reference for every nested element whose tag
 * is a known reference tag and that carries an `id`, into `fp.references`. The
 * name and index of the nearest ancestor <Step> are carried as edge context (so
 * a reference buried inside a step's parameters is still attributed to the
 * right step).
 */
export function scanRefs(fp: FileParse, node: unknown, owner: RefOwner, ctx: ScanCtx = {}, inChunkList = false): void {
  if (Array.isArray(node)) {
    for (const item of node) scanRefs(fp, item, owner, ctx, inChunkList);
    return;
  }
  if (!isRecord(node)) return;

  // A reference sitting beside a <DataSourceReference> (e.g. an external Perform
  // Script) targets that external file rather than the current one.
  const externalFileName = externalFileOf(child(node, "DataSourceReference"));

  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    switch (key) {
      case "DDRREF":
        // A calculation's references live in a separate <_HASH><ChunkList> block,
        // reached only through this pointer; scan it as if inline here so the
        // field / function references resolve with full id + occurrence context
        // (and a script step's index carries through `ctx`). Guard against
        // nested pointers.
        if (!inChunkList) followChunkLists(fp, node, value, owner, ctx);
        continue;
      case "AutoEnter":
        for (const el of asArray(value)) scanRefs(fp, activeAutoEnter(el), owner, ctx, inChunkList);
        continue;
      case "Validation":
        for (const el of asArray(value)) scanRefs(fp, activeValidation(el), owner, ctx, inChunkList);
        continue;
      case "Chunk":
        scanChunks(fp, value, owner, ctx, inChunkList);
        continue;
      case "Map":
        // Import Records lists every field of the target table as a <Map>: kind 0
        // "import to", kind 2 "match with" (update matching records), and kind 1
        // "not import to" — which isn't a use of the field.
        for (const el of asArray(value)) {
          if (attr(el, "kind") !== "1") scanRefs(fp, el, owner, ctx, inChunkList);
        }
        continue;
      case "ScriptTrigger":
        // A script trigger whose script was deleted keeps its event but loses its
        // <ScriptReference> (FileMaker shows the script as <unknown>).
        for (const el of asArray(value)) {
          if (isRecord(el) && el["ScriptReference"] == null) {
            pushRef(fp.references, brokenRef(owner.uid, "script", UNKNOWN_TARGET, "trigger"), ctx);
          }
          scanRefs(fp, el, owner, { ...ctx, inTrigger: true }, inChunkList);
        }
        continue;
      case "Name":
      case "Variable":
        // The global a Set Variable step writes (<Name value>) or a step stores its
        // result in (<Variable value>, e.g. Insert from URL's target) isn't a calc,
        // so no chunk records it. (Still scanned below: a target's repetition is.)
        for (const el of asArray(value)) {
          const variable = decodeEntities(attr(el, "value") ?? "").trim();
          if (variable.startsWith("$$")) pushRef(fp.references, globalVariableRef(owner.uid, variable), ctx);
        }
        break;
    }
    scanElements(fp, key, value, owner, ctx, inChunkList, externalFileName);
  }
}

/** The elements under one key: a reference for each that is one, then their
 * subtrees (a <Step> setting the step context for its own). */
function scanElements(
  fp: FileParse,
  key: string,
  value: unknown,
  owner: RefOwner,
  ctx: ScanCtx,
  inChunkList: boolean,
  externalFileName: string | undefined,
): void {
  const targetType = FMSAVEAS_REF_TAGS[key];
  let stepIndex = 0;
  for (const el of asArray(value)) {
    if (targetType && isRecord(el)) {
      const ref = elementRef(el, targetType, owner.uid, ctx, externalFileName);
      if (ref) pushRef(fp.references, ref, ctx);
    }
    let childCtx = ctx;
    if (key === "Step" && isRecord(el)) {
      stepIndex += 1;
      childCtx = {
        stepName: attr(el, "name") ?? ctx.stepName,
        stepIndex,
        ...(ctx.disabled || attr(el, "enable") === "False" ? { disabled: true } : {}),
      };
      addStepTargetRefs(fp.chunks, el, owner.uid, childCtx, fp.references);
    }
    // A field read through a deleted occurrence (<Table Missing>, id -1) is one
    // broken reference, not two: don't also emit the dead occurrence itself.
    const deadOccurrence = targetType === "field" && isRecord(el) && attr(child(el, "TableOccurrenceReference"), "id") === "-1";
    scanRefs(fp, deadOccurrence ? withoutKey(el, "TableOccurrenceReference") : el, owner, childCtx, inChunkList);
  }
}

/** The reference a `targetType` element records, or undefined for FileMaker's
 * placeholders that aren't references at all. */
function elementRef(
  el: Record<string, unknown>,
  targetType: ObjectType,
  fromUid: string,
  ctx: ScanCtx,
  externalFileName: string | undefined,
): RawReference | undefined {
  const id = attr(el, "id");
  if (id == null) return undefined;
  const name = decodeEntities(attr(el, "name") ?? "");
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
    kind: ctx.inTrigger && targetType === "script" ? "trigger" : edgeKind(targetType, ctx.stepName),
    // The data source itself is this file's own catalog entry, not a target
    // inside the external file.
    ...(externalFileName != null && targetType !== "externalDataSource" ? { toFileName: externalFileName } : {}),
    ...(viaToId != null ? { viaToId } : {}),
    ...(viaBaseTableId != null ? { viaBaseTableId } : {}),
  };
}

/** A `<DataSourceReference id="0">` names the current file ("Current File" in
 * Close File, Re-Login, …) — except FileMaker's `<unknown>` for a data source
 * that was deleted. */
export function namesCurrentFile(id: string | undefined, name: string): boolean {
  return id === "0" && name !== UNKNOWN_TARGET;
}

/** The external file a <DataSourceReference> points into, or undefined when
 * there is none or it names the current file. */
function externalFileOf(dataSourceRef: unknown): string | undefined {
  if (dataSourceRef == null) return undefined;
  const name = decodeEntities(attr(dataSourceRef, "name") ?? "");
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
function scanChunks(fp: FileParse, value: unknown, owner: RefOwner, ctx: ScanCtx, inChunkList: boolean): void {
  for (const el of asArray(value)) {
    if (isRecord(el)) {
      const type = attr(el, "type");
      const raw = el["#text"];
      const text = typeof raw === "string" ? decodeEntities(raw.trim()) : "";
      const cfId = type === "CustomFunctionRef" && text ? fp.chunks.cfByName.get(text) : undefined;
      if (cfId != null) {
        pushRef(fp.references, { fromUid: owner.uid, toType: "customFunction", toId: cfId, toName: text, kind: "customFunction" }, ctx);
      }
      const globals =
        type === "VariableReference" && text.startsWith("$$")
          ? [text]
          : type === "NoRef" && text.includes('"$$')
            ? quotedGlobalVariables(text)
            : [];
      for (const name of globals) pushRef(fp.references, globalVariableRef(owner.uid, name), ctx);
    }
    // Recurse to capture the <FieldReference> inside a FieldRef chunk.
    scanRefs(fp, el, owner, ctx, inChunkList);
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
function followChunkLists(fp: FileParse, calc: Record<string, unknown>, pointers: unknown, owner: RefOwner, ctx: ScanCtx): void {
  const textNode = calc["Text"];
  const calcText = textNode == null ? undefined : decodeEntities(typeof textNode === "string" ? textNode : collectText(textNode));
  for (const el of asArray(pointers)) {
    if (!isRecord(el) || attr(el, "kind") !== "ChunkList") continue;
    const ptr = el["#text"];
    const block = typeof ptr === "string" ? fp.chunks.lists.get(ptr) : undefined;
    if (block && chunkBlockBelongsTo(block, attr(el, "hash"), calcText)) {
      scanRefs(fp, block, owner, ctx, true);
    } else if (calcText?.trim()) {
      scanCalcTextRefs(fp.chunks, calcText, calc, owner, ctx, fp.references);
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

