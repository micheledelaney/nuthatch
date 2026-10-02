import type { FmObject, RawReference } from "@/types/ddr";
import { isBrokenTableOccurrence } from "@/types/ddr";
import type { FileIndex, FileParse } from "../context";
import { longestNameEndingAt } from "@/core/identifiers";
import { MISSING_FIELD_TOKEN, MISSING_FUNCTION_TOKEN, MISSING_TABLE_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { brokenRef, pushRef, type ScanContext } from "./refBuilders";

/** `<Table Missing>` not followed by `::` — a deleted target, not a field read
 * through a deleted occurrence (`<Table Missing>::Field`, handled structurally). */
const BARE_MISSING_TABLE_RE = /<Table Missing>(?!::)/;

/**
 * Broken references that only show in rendered text, for a batch of objects
 * whose structural references are already recorded (in `fp.references`, from
 * `refStart` on): the `<Field Missing>`, bare `<Table Missing>` and
 * `<Function Missing>` placeholders FileMaker leaves where a reference's target
 * was deleted, plus a local occurrence's deleted base table. The batch is a
 * file's catalog objects, or one layout and its objects — so a layout's full
 * text can be compacted as soon as its batch is done.
 */
export function addPlaceholderRefs(fp: FileParse, batch: readonly FmObject[], refStart: number): void {
  addMissingFieldRefs(fp, batch, refStart);
  // After addMissingFieldRefs: a step it already flagged isn't flagged again.
  addMissingTargetTableRefs(fp, batch, refStart);
  forEachPlaceholderUse(fp, batch, MISSING_FUNCTION_TOKEN, (obj, _text, site) => {
    pushRef(fp.references, brokenRef(obj.uid, "customFunction", MISSING_FUNCTION_TOKEN), site);
  });
  addBrokenTableOccurrenceRefs(fp, batch);
}

/**
 * Invoke `emit` for every object whose reference-bearing text contains `token`.
 * Scripts are scanned per step (so the broken edge carries `fromStep` and the
 * right line lights up); every other object is scanned once. The placeholders
 * carry no identity, so it's one edge per step (scripts) or per object, not per
 * distinct missing target. A field is scanned through its *active* calcs only
 * (FileParse.activeText), so a disabled auto-enter calc naming a deleted field
 * doesn't flag it.
 *
 * Step parameters and layout-object text are decoded, but every other object's
 * `text` is raw XML text, where a placeholder inside an attribute value stays
 * entity-encoded (`name="&lt;Table Missing&gt;"`) and so isn't matched here. On
 * purpose: those all sit on a `<TableOccurrenceReference id="-1">`, which the
 * element scan already records as the broken reference. The placeholders this
 * pass is for are in calculation text (CDATA, verbatim) and rendered steps.
 */
function forEachPlaceholderUse(
  fp: FileParse,
  batch: readonly FmObject[],
  token: string,
  emit: (obj: FmObject, text: string, site: ScanContext) => void,
): void {
  for (const obj of batch) {
    if (obj.type === "file" || !obj.text) continue;
    if (obj.detail?.kind === "script") {
      for (const step of obj.detail.steps) {
        if (step.params.includes(token)) emit(obj, step.params, { stepIndex: step.index, disabled: !step.enabled });
      }
      continue;
    }
    const text = fp.activeText.get(obj.uid) ?? obj.text;
    if (text.includes(token)) emit(obj, text, {});
  }
}

/** `fromUid` + step of every reference from `refStart` on that `matches` — e.g.
 * the sites already carrying a broken field edge. */
function sitesWith(refs: readonly RawReference[], refStart: number, matches: (r: RawReference) => boolean): Set<string> {
  const sites = new Set<string>();
  for (let i = refStart; i < refs.length; i++) {
    const r = refs[i]!;
    if (matches(r)) sites.add(siteKey(r.fromUid, r.fromStep));
  }
  return sites;
}

function siteKey(uid: string, fromStep: number | undefined): string {
  return `${uid} ${fromStep ?? ""}`;
}

/**
 * A reference to a deleted field is never recorded structurally: FileMaker
 * omits the `<FieldReference>` (and its chunk entry) and leaves only the
 * literal `<Field Missing>` placeholder in whatever text carries the reference
 * — a calc field's body, a script step's parameter, a custom function's body,
 * a layout trigger's parameter, a relationship predicate, etc. Each becomes an
 * explicitly broken field edge so the object is flagged like any other
 * dangling reference.
 *
 * FileMaker writes the same placeholder when it simply couldn't resolve a field
 * because the occurrence's file wasn't available at export — so a placeholder
 * behind an occurrence that was unresolved at export proves nothing and is not
 * counted.
 */
function addMissingFieldRefs(fp: FileParse, batch: readonly FmObject[], refStart: number): void {
  // Sometimes FileMaker leaves the `<FieldReference>` element in place with a
  // blank name/UUID instead of omitting it outright — already scanned
  // structurally (blank toName) — while its rendered text *also* carries the
  // "<Field Missing>" placeholder. Without this check, that single dangling
  // field would be counted and displayed twice.
  const alreadyBroken = sitesWith(fp.references, refStart, (r) => r.toType === "field" && r.toName === "");
  forEachPlaceholderUse(fp, batch, MISSING_FIELD_TOKEN, (obj, text, site) => {
    if (alreadyBroken.has(siteKey(obj.uid, site.stepIndex))) return;
    const deleted = deletedFieldVia(text, fp.index);
    if (!deleted) return;
    const ref = {
      ...brokenRef(obj.uid, "field", MISSING_FIELD_TOKEN),
      // The field is gone but its occurrence is still a navigable target (keeps
      // the TO clickable inline, and surfaces the broken ref under its inbound list).
      ...(deleted.viaToId != null ? { viaToId: deleted.viaToId } : {}),
    };
    pushRef(fp.references, ref, site);
  });
}

/** Classify every `<Field Missing>` in the text: one qualified by an occurrence
 * that was unresolved at export is unverifiable and skipped; any other
 * (qualified by a real or missing occurrence, or bare) is a deleted field.
 * Returns the occurrence of the first deleted one (the navigable context), or
 * null when every placeholder was unverifiable. */
function deletedFieldVia(text: string, index: FileIndex): { viaToId?: string } | null {
  for (let pos = text.indexOf(MISSING_FIELD_TOKEN); pos !== -1; pos = text.indexOf(MISSING_FIELD_TOKEN, pos + 1)) {
    if (!text.endsWith("::", pos)) return {};
    const name = longestNameEndingAt(text, pos - 2, index.toNames);
    const occ = name != null ? index.toByName.get(name) : undefined;
    if (occ?.unresolved) continue;
    return occ ? { viaToId: occ.id } : {};
  }
  return null;
}

/**
 * A step whose target field AND its occurrence were deleted (e.g. Set Field)
 * keeps only a blank `<FieldReference id="0" name="">` — which the element scan
 * skips, because Import Records writes that same placeholder for every unmapped
 * column — and renders its target as a bare `<Table Missing>` (no `::Field`
 * after it, unlike a field read through a deleted occurrence). The same bare
 * placeholder marks a merge field whose occurrence was deleted
 * (`<<<Table Missing>>>`) and a portal whose occurrence was deleted. Emit one
 * explicitly broken edge per such step (or object) — to a table occurrence for
 * a portal, to a field otherwise. Skips steps already carrying a broken field
 * edge, and a portal whose own scan recorded its dead occurrence (id -1).
 */
function addMissingTargetTableRefs(fp: FileParse, batch: readonly FmObject[], refStart: number): void {
  const alreadyBroken = sitesWith(fp.references, refStart, (r) => r.toType === "field" && (r.forceBroken === true || r.toName === ""));
  const deadOccurrence = sitesWith(fp.references, refStart, (r) => r.toType === "tableOccurrence" && r.toId === "-1");
  forEachPlaceholderUse(fp, batch, MISSING_TABLE_TOKEN, (obj, text, site) => {
    const key = siteKey(obj.uid, site.stepIndex);
    if (!BARE_MISSING_TABLE_RE.test(text) || alreadyBroken.has(key)) return;
    const isPortal = obj.detail?.kind === "layoutObject" && obj.detail.portalTable === MISSING_TABLE_TOKEN;
    if (isPortal && deadOccurrence.has(key)) return;
    const toType = isPortal ? "tableOccurrence" : "field";
    pushRef(fp.references, brokenRef(obj.uid, toType, MISSING_TABLE_TOKEN), site);
  });
}

/**
 * A local table occurrence whose base table was deleted has no
 * `<BaseTableReference>`, so the element scan emits no base-table edge for it.
 * Record that missing base table as an explicitly broken reference so the
 * occurrence is flagged broken like any other dangling reference.
 *
 * An external occurrence counts only when its data source was deleted; one that
 * merely couldn't be resolved at export time isn't broken at all
 * (isUnresolvedTableOccurrence).
 */
function addBrokenTableOccurrenceRefs(fp: FileParse, batch: readonly FmObject[]): void {
  for (const obj of batch) {
    if (isBrokenTableOccurrence(obj)) {
      fp.references.push(brokenRef(obj.uid, "table", obj.attributes.externalDataSource || UNKNOWN_TARGET));
    }
  }
}
