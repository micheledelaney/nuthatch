import type { RawReference } from "@/types/ddr";
import type { FileIndex, FileParse, TextScan } from "../context";
import { attr, child } from "../xmlUtils";
import { missingFieldOccurrences } from "@/core/identifiers";
import { MISSING_FIELD_TOKEN, MISSING_FUNCTION_TOKEN, MISSING_TABLE_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { formulasUnder, inertSpansWith } from "../calcText";
import { isCommentStep } from "../steps";
import { brokenRef, pushRef, type ScanContext } from "./refBuilders";

/** `<Table Missing>` not followed by `::` — a deleted target, not a field read
 * through a deleted occurrence (`<Table Missing>::Field`, handled structurally). */
const BARE_MISSING_TABLE_RE = /<Table Missing>(?!::)/;

/**
 * Broken references that only show in rendered text, for a batch of objects
 * whose structural references are already recorded (they're `fp.references`):
 * the `<Field Missing>`, bare `<Table Missing>` and `<Function Missing>`
 * placeholders FileMaker leaves where a reference's target was deleted, plus a
 * local occurrence's deleted base table. The batch is a file's catalog objects,
 * or one layout and its objects — so a layout's full text can be compacted as
 * soon as its batch is done.
 */
export function addPlaceholderRefs(fp: FileParse, batch: readonly TextScan[]): void {
  addMissingFieldRefs(fp, batch);
  // After addMissingFieldRefs: a step it already flagged isn't flagged again.
  addMissingTargetTableRefs(fp, batch);
  forEachPlaceholderUse(batch, MISSING_FUNCTION_TOKEN, ({ obj }, _text, site) => {
    pushRef(fp.references, brokenRef(obj.uid, "customFunction", MISSING_FUNCTION_TOKEN), site);
  });
  addBrokenTableOccurrenceRefs(fp, batch);
}

/**
 * Invoke `emit` for every object whose reference-bearing text contains `token`.
 * Scripts are scanned per step (so the broken edge carries `fromStep` and the
 * right line lights up); every other object is scanned once. The placeholders
 * carry no identity, so it's one edge per step (scripts) or per object, not per
 * distinct missing target.
 *
 * The placeholders this pass is for are in calculation text and rendered steps,
 * so every object is read through its scan text (TextScan): a script's steps
 * as FileMaker rendered them, and every other object the CDATA of what its
 * element scan read (a field: its *active* calcs only, so a disabled
 * auto-enter calc naming a deleted field doesn't flag it), after the
 * placeholder of a layout object's field binding whose field is gone. Not its
 * search `text`, where a placeholder FileMaker wrote as an attribute value
 * (`<TableOccurrenceReference id="-1" name="&lt;Table Missing&gt;">`) reads
 * decoded: those are structural, and the element scan already records them as
 * the broken reference.
 */
function forEachPlaceholderUse(
  batch: readonly TextScan[],
  token: string,
  emit: (scan: TextScan, text: string, site: ScanContext) => void,
): void {
  for (const scan of batch) {
    const { obj, text } = scan;
    if (obj.detail?.kind === "script") {
      obj.detail.steps.forEach((step, i) => {
        const rendered = scan.renderedSteps?.[i] ?? "";
        if (isCommentStep(step.name) || !rendered.includes(token)) return;
        const live = liveText(rendered, scan);
        if (live.includes(token)) emit(scan, live, { stepIndex: step.index, disabled: !step.enabled });
      });
      continue;
    }
    if (!text.includes(token)) continue;
    const live = liveText(text, scan);
    if (live.includes(token)) emit(scan, live, {});
  }
}

const PLACEHOLDER_TOKENS = [MISSING_FIELD_TOKEN, MISSING_TABLE_TOKEN, MISSING_FUNCTION_TOKEN];

const inertSpansOf = new WeakMap<TextScan, string[]>();

/**
 * `text` with the placeholders a developer typed blanked out: those inside a
 * string literal or comment of one of the object's formulas (inertSpansWith),
 * which FileMaker never rewrites. Each such span is matched as written, so a
 * placeholder FileMaker wrote — in a formula outside its literals, in layout
 * text, in a step's rendered target — is never touched; one that's only
 * typed text but can't be matched that way is still read, as before.
 */
function liveText(text: string, scan: TextScan): string {
  let spans = inertSpansOf.get(scan);
  if (!spans) {
    spans = [...new Set(formulasUnder(scan.source).flatMap((formula) => inertSpansWith(formula, PLACEHOLDER_TOKENS)))];
    inertSpansOf.set(scan, spans);
  }
  let live = text;
  for (const span of spans) {
    // A step's rendered text shows a formula's tabs (and other control
    // characters) as spaces.
    for (const form of new Set([span, span.replace(/[\0-\t\v-\x1f]/g, " ")])) live = live.split(form).join(" ".repeat(form.length));
  }
  return live;
}

/** The sites of every reference that `matches` — e.g. the sites already
 * carrying a broken field edge. A reference counts for its step (a script's
 * placeholders are checked per step) and for its object as a whole (every
 * other object's are checked once, whatever step inside it — a button's
 * action — the reference came from). */
function sitesWith(refs: readonly RawReference[], matches: (r: RawReference) => boolean): Set<string> {
  const sites = new Set<string>();
  for (const r of refs) {
    if (!matches(r)) continue;
    sites.add(siteKey(r.fromUid, r.fromStep));
    sites.add(siteKey(r.fromUid, undefined));
  }
  return sites;
}

function siteKey(uid: string, fromStep: number | undefined): string {
  return `${uid} ${fromStep ?? ""}`;
}

/** A field read through an occurrence whose file wasn't available at export:
 * FileMaker blanks its name, but it's unverifiable, not broken. */
function throughUnresolvedOccurrence(r: RawReference, index: FileIndex): boolean {
  return r.viaToId != null && index.toById.get(r.viaToId)?.unresolved === true;
}

/** A field reference FileMaker left in place with its name blanked because the
 * field is gone — not one behind a file that was unavailable at export. */
function isBlankedDeletedField(r: RawReference, index: FileIndex): boolean {
  return r.toType === "field" && r.toName === "" && !throughUnresolvedOccurrence(r, index);
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
function addMissingFieldRefs(fp: FileParse, batch: readonly TextScan[]): void {
  // Sometimes FileMaker leaves the `<FieldReference>` element in place with a
  // blank name/UUID instead of omitting it outright — already scanned
  // structurally (blank toName) — while its rendered text *also* carries the
  // "<Field Missing>" placeholder. Without this check, that single dangling
  // field would be counted and displayed twice. A blank name behind an
  // unavailable file is no such field: it doesn't hide a placeholder.
  const alreadyBroken = sitesWith(fp.references, (r) => isBlankedDeletedField(r, fp.index));
  forEachPlaceholderUse(batch, MISSING_FIELD_TOKEN, ({ obj }, text, site) => {
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
  for (const name of missingFieldOccurrences(text, index.toNames)) {
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
function addMissingTargetTableRefs(fp: FileParse, batch: readonly TextScan[]): void {
  const alreadyBroken = sitesWith(fp.references, (r) => (r.toType === "field" && r.forceBroken === true) || isBlankedDeletedField(r, fp.index));
  const deadOccurrence = sitesWith(fp.references, (r) => r.toType === "tableOccurrence" && r.toId === "-1");
  forEachPlaceholderUse(batch, MISSING_TABLE_TOKEN, (scan, text, site) => {
    const { obj } = scan;
    const key = siteKey(obj.uid, site.stepIndex);
    if (!BARE_MISSING_TABLE_RE.test(text) || alreadyBroken.has(key)) return;
    const isPortal = isDeadPortal(scan.source);
    if (isPortal && deadOccurrence.has(key)) return;
    const toType = isPortal ? "tableOccurrence" : "field";
    pushRef(fp.references, brokenRef(obj.uid, toType, MISSING_TABLE_TOKEN), site);
  });
}

/** A portal whose occurrence was deleted: FileMaker writes it as
 * `<TableOccurrenceReference id="-1" name="&lt;Table Missing&gt;">`. */
function isDeadPortal(element: unknown): boolean {
  return attr(child(child(element, "Portal"), "TableOccurrenceReference"), "id") === "-1";
}

/**
 * A local table occurrence whose base table was deleted has no
 * `<BaseTableReference>`, so the element scan emits no base-table edge for it.
 * Record that missing base table as an explicitly broken reference so the
 * occurrence is flagged broken like any other dangling reference.
 *
 * An external occurrence counts only when its data source was deleted; one that
 * merely couldn't be resolved at export time isn't broken at all
 * (OccurrenceSource.unresolved).
 */
function addBrokenTableOccurrenceRefs(fp: FileParse, batch: readonly TextScan[]): void {
  for (const { obj } of batch) {
    const source = obj.type === "tableOccurrence" ? fp.index.toById.get(obj.id) : undefined;
    if (source && source.baseTableId == null && !source.unresolved) {
      fp.references.push(brokenRef(obj.uid, "table", source.dataSourceName || UNKNOWN_TARGET));
    }
  }
}
