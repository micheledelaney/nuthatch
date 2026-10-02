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

/** The <Step> elements of a step list (a script's <ObjectList>, a button's
 * <action>), in order. A step's 1-based position here is its number
 * everywhere: the script's step list, a reference's `fromStep`, an FM 22
 * button target. */
export function stepNodes(container: unknown): Record<string, unknown>[] {
  return children(container, "Step").filter(isRecord);
}

/** FileMaker's rendered text for a step, looked up by the hash on its
 * `<DDRREF kind="StepText">` pointer (entities intact). */
export function renderedStepText(stepTextByHash: ReadonlyMap<string, string>, step: Record<string, unknown>): string | undefined {
  for (const ref of asArray(step["DDRREF"])) {
    if (!isRecord(ref) || attr(ref, "kind") !== "StepText") continue;
    const hash = attr(ref, "hash");
    if (hash != null) return stepTextByHash.get(hash);
  }
  return undefined;
}
