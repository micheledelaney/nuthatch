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
