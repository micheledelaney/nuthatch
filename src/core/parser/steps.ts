import type { StepTexts } from "./context";
import { asArray, attr, children, isRecord } from "./xmlUtils";

/** Script step names the parser treats specially, as FileMaker writes them in
 * `<Step name>`. */
export const GO_TO_LAYOUT_STEP = "Go to Layout";
export const GO_TO_RELATED_RECORD_STEP = "Go to Related Record";
export const SET_FIELD_STEP = "Set Field";
export const INSERT_TEXT_STEP = "Insert Text";

const PERFORM_SCRIPT_STEP_RE = /^Perform Script(?: on Server(?: with Callback)?)?$/;

/** Perform Script, Perform Script on Server, or Perform Script on Server with
 * Callback. */
export function isPerformScriptStep(name: string): boolean {
  return PERFORM_SCRIPT_STEP_RE.test(name);
}

/** A comment step (`# (comment)`): typed text, never a reference. */
export function isCommentStep(name: string): boolean {
  return name.startsWith("#");
}

/** The <Step> elements of a step list (a script's <ObjectList>, a button's
 * <action>), in order. A step's 1-based position here is its number
 * everywhere: the script's step list, a reference's `fromStep`, an FM 22
 * button target. */
export function stepNodes(container: unknown): Record<string, unknown>[] {
  return children(container, "Step").filter(isRecord);
}

/** FileMaker's rendered text for a step (entities intact): the entry its
 * `<DDRREF kind="StepText">` pointer names — of several sharing the pointer,
 * the one with the pointer's hash (see stepTextIndex). */
export function renderedStepText(stepTexts: StepTexts, step: Record<string, unknown>): string | undefined {
  for (const ref of asArray(step["DDRREF"])) {
    if (!isRecord(ref) || attr(ref, "kind") !== "StepText") continue;
    const hash = attr(ref, "hash") ?? "";
    const pointer = ref["#text"];
    const entries = typeof pointer === "string" ? stepTexts.byPointer.get(pointer) : undefined;
    const own = entries?.length === 1 ? entries[0] : entries?.find((entry) => entry.hash === hash);
    return own?.text ?? stepTexts.byHash.get(hash);
  }
  return undefined;
}
