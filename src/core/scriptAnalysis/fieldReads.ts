import { inertEnd } from "@/core/parser/calcLiterals";
import { objectUid } from "@/core/parser/uid";
import { isNameChar } from "@/core/identifiers";
import type { FmObject, FmReference, SolutionModel, StepIr } from "@/types/ddr";
import { calledFunctions, tokenize } from "./calcTokens";
import { layoutsBefore, unreachedField, type ContextIndex } from "./context";
import { refsByStep, type ScriptFinding } from "./findings";

/**
 * Fields a step's formulas read through an occurrence that isn't related to
 * the layout the script is on there (see context): FileMaker reads them as
 * empty. A formula that takes only a field's name doesn't read it:
 * `GetFieldName ( T::f )`, `IsValid ( T::f )` (which asks whether it can be
 * read), and an argument of a custom function that may pass it on to either.
 */

/** Functions (lower case) that take a field without reading its value. */
const NAME_ONLY: ReadonlySet<string> = new Set(["getfieldname", "isvalid"]);

/** Steps whose formulas may be evaluated in the window they open. */
const OWN_WINDOW: ReadonlySet<string> = new Set(["New Window", "Go to Related Record"]);

/** Per file uid, the custom functions (lower-case names) that may take a field
 * only for its name: those that call one of NAME_ONLY, or such a function. */
export function nameTakingFunctions(model: SolutionModel): Map<string, Set<string>> {
  const callsByFile = new Map<string, Map<string, string[]>>();
  for (const obj of model.objects) {
    if (obj.type !== "customFunction" || obj.detail?.kind !== "calculation") continue;
    const calls = callsByFile.get(obj.fileUid) ?? callsByFile.set(obj.fileUid, new Map()).get(obj.fileUid)!;
    calls.set(obj.name.toLowerCase(), calledFunctions(tokenize(obj.detail.body)));
  }
  const out = new Map<string, Set<string>>();
  for (const [fileUid, calls] of callsByFile) {
    const taking = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, called] of calls) {
        if (taking.has(name) || !called.some((fn) => NAME_ONLY.has(fn) || taking.has(fn))) continue;
        taking.add(name);
        changed = true;
      }
    }
    out.set(fileUid, taking);
  }
  return out;
}

/** The field-read check for one script; `nameTaking` is its file's
 * (see nameTakingFunctions). */
export function checkFieldReads(index: ContextIndex, script: FmObject, nameTaking: ReadonlySet<string>): ScriptFinding[] {
  const before = layoutsBefore(index, script);
  if (!before) return [];
  const byStep = refsByStep(index.model, script.uid);
  const findings: ScriptFinding[] = [];
  for (const step of index.irs.get(script.uid) ?? []) {
    const where = before.get(step.index);
    if (!step.enabled || where == null || where === "unknown" || OWN_WINDOW.has(step.name) || step.calcs.length === 0) continue;
    const refs = byStep.get(step.index) ?? [];
    // A field the step also writes into or goes to has its own finding.
    const skip = targetKeys(script.fileUid, step, refs);
    for (const ref of refs) {
      const key = fieldKey(ref.viaUid, ref.toId);
      if (ref.kind !== "field" || skip.has(key)) continue;
      skip.add(key);
      const unreached = unreachedField(index, ref, where);
      if (!unreached || !step.calcs.some((formula) => readsField(formula, unreached.field, nameTaking))) continue;
      findings.push({
        rule: "unrelated-field-read",
        certainty: "likely",
        uid: script.uid,
        step: step.index,
        title: [{ code: unreached.field }, " is empty here"],
        detail: [unreached.why],
      });
    }
  }
  return findings;
}

function fieldKey(occurrenceUid: string | undefined, fieldId: string): string {
  return `${occurrenceUid ?? ""}\u0000${fieldId}`;
}

/** The fields a step writes into or goes to: Set Field's, and its fieldTargets. */
function targetKeys(fileUid: string, step: StepIr, refs: readonly FmReference[]): Set<string> {
  const out = new Set(refs.filter((ref) => ref.kind === "setField").map((ref) => fieldKey(ref.viaUid, ref.toId)));
  for (const target of step.fieldTargets ?? []) out.add(fieldKey(objectUid(fileUid, "tableOccurrence", target.occurrence), target.field));
  return out;
}

/** Whether a formula reads `field` (`T::f`) anywhere: outside strings and
 * comments, and not as the argument of a function that takes only its name. */
export function readsField(formula: string, field: string, nameTaking: ReadonlySet<string>): boolean {
  // The function (lower case) each open bracket belongs to; null for a plain
  // bracket, a Let's [ list or a repetition.
  const open: (string | null)[] = [];
  for (let i = 0; i < formula.length; ) {
    const inert = inertEnd(formula, i);
    if (inert > i) {
      i = inert;
      continue;
    }
    if (formula.startsWith(field, i) && !isNameChar(formula[i - 1]) && !isNameChar(formula[i + field.length])) {
      const fn = open[open.length - 1];
      if (fn == null || !(NAME_ONLY.has(fn) || nameTaking.has(fn))) return true;
      i += field.length;
      continue;
    }
    const c = formula[i]!;
    if (c === "(") open.push(nameBefore(formula, i));
    else if (c === "[") open.push(null);
    else if (c === ")" || c === "]") open.pop();
    i++;
  }
  return false;
}

/** The name right before `formula[at]` (spaces between allowed), lower case;
 * null when there's none. */
function nameBefore(formula: string, at: number): string | null {
  let end = at;
  while (end > 0 && /\s/.test(formula[end - 1]!)) end--;
  let start = end;
  while (start > 0 && isNameChar(formula[start - 1])) start--;
  return start < end ? formula.slice(start, end).toLowerCase() : null;
}
