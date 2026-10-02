import { renderedStepText, type FileParse } from "../context";
import { attr, findElement, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { edgeKind } from "../refTags";
import { UNKNOWN_TARGET } from "../sentinels";
import { GO_TO_LAYOUT_STEP, GO_TO_RELATED_RECORD_STEP, isPerformScriptStep } from "../stepNames";
import { brokenRef, pushRef, type ScanContext } from "./refBuilders";

// FileMaker wraps the file name in typographic curly quotes (U+201C…U+201D);
// accept straight quotes too for robustness across export versions.
const STEP_FROM_FILE_RE = /from file:\s*[“"]([^”"]+)[”"]/;

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
 *     (`<unknown> from file: “Orders” (file not open)` → an external-leaf
 *     edge the call chain can display), or it was deleted (`“<unknown>”` → a
 *     broken edge).
 *   • Go to Layout / Go to Related Record whose specified layout was deleted
 *     (`[ <unknown> ]`, `Using layout: <unknown>`) — unless it's an External
 *     layout whose file wasn't open at export (the step's occurrence has no
 *     base table): unresolvable, not broken.
 *   • Go to Related Record whose occurrence was deleted without a
 *     `<Table Missing>` reference left behind (`From table: <unknown>`).
 */
export function addStepTargetRefs(fp: FileParse, step: Record<string, unknown>, fromUid: string, stepCtx: ScanContext): void {
  const name = attr(step, "name") ?? "";
  const isPerform = isPerformScriptStep(name);
  if (!isPerform && name !== GO_TO_LAYOUT_STEP && name !== GO_TO_RELATED_RECORD_STEP) return;
  const rendered = renderedStepText(fp.index.stepTextByHash, step);
  if (rendered == null) return;
  const text = decodeEntities(rendered);
  const params = step["ParameterValues"];
  const out = fp.references;

  if (isPerform) {
    if (findElement(params, "ScriptReference") != null) return;
    // Checked before `from file:` — a deleted script in another file reads
    // `“<unknown>” from file: “DS_Ext”` (quoted, no "(file not open)").
    const external = STEP_FROM_FILE_RE.exec(text);
    if (namesDeletedScript(text)) {
      pushRef(out, brokenRef(fromUid, "script", UNKNOWN_TARGET, "performScript"), stepCtx);
    } else if (external) {
      const fileName = external[1]!;
      pushRef(out, { fromUid, toType: "script", toId: "", toName: fileName, kind: "performScript", toFileName: fileName }, stepCtx);
    }
    return;
  }

  const container = findElement(params, "LayoutReferenceContainer");
  const occurrence = findElement(params, "TableOccurrenceReference");
  const occurrenceId = attr(occurrence, "id");
  const externalVerifiable = occurrenceId != null && fp.index.toById.get(occurrenceId)?.fileOpenAtExport === true;
  const layoutGone =
    isRecord(container) &&
    (attr(container, "External") !== "True" || externalVerifiable) &&
    findElement(container, "LayoutReference") == null &&
    (name === GO_TO_LAYOUT_STEP ? text.includes(UNKNOWN_TARGET) : text.includes(`Using layout: ${UNKNOWN_TARGET}`));
  if (layoutGone) {
    pushRef(out, brokenRef(fromUid, "layout", UNKNOWN_TARGET, edgeKind("layout", name)), stepCtx);
  }
  if (name === GO_TO_RELATED_RECORD_STEP && text.includes(`From table: ${UNKNOWN_TARGET}`) && occurrence == null) {
    pushRef(out, brokenRef(fromUid, "tableOccurrence", UNKNOWN_TARGET), stepCtx);
  }
}
