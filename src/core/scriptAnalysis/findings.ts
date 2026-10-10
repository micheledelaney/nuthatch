import type { FmReference, SolutionModel, StepIr } from "@/types/ddr";

/**
 * How sure a finding is:
 *   • fact — what the steps say, e.g. a step no path reaches;
 *   • likely — a defect unless something the export can't show makes up for it;
 *   • possible — worth a look, often deliberate.
 */
export type Certainty = "fact" | "likely" | "possible";

export type RuleId =
  | "unreachable-steps"
  | "unset-variable"
  | "unread-variable"
  | "unrelated-set-field"
  | "unrelated-field-target"
  | "unrelated-field-read"
  | "unpassed-parameter-key"
  | "unread-parameter-key"
  | "unreturned-result-key"
  | "result-before-call";

/** A finding's text: words, and the code it names (a variable, key or field),
 * which the app shows in its code colours. */
export type FindingText = readonly (string | { code: string })[];

/** The text as one plain string. */
export function plainText(text: FindingText): string {
  return text.map((part) => (typeof part === "string" ? part : part.code)).join("");
}

export interface ScriptFinding {
  rule: RuleId;
  certainty: Certainty;
  /** The object it's about: a script, or a layout object that passes a parameter. */
  uid: string;
  /** The step it's about (1-based), when it's about a script step. */
  step?: number;
  /** The last of the steps it's about, when it's about a run of them. */
  lastStep?: number;
  /** What's wrong, in a few words. */
  title: FindingText;
  /** Where it shows and why it matters. */
  detail: FindingText;
}

/** A check left out for one script, and why. */
export interface SkippedCheck {
  uid: string;
  check: string;
  reason: string;
}

/** What the checks read: the model and each script's typed steps (see scriptStepIrs). */
export interface ScriptAnalysisInput {
  model: SolutionModel;
  irs: ReadonlyMap<string, readonly StepIr[]>;
}

/** A script's outbound references by the step they come from. */
export function refsByStep(model: SolutionModel, scriptUid: string): Map<number, FmReference[]> {
  const out = new Map<number, FmReference[]>();
  for (const ref of model.outbound.get(scriptUid) ?? []) {
    if (ref.fromStep == null) continue;
    (out.get(ref.fromStep) ?? out.set(ref.fromStep, []).get(ref.fromStep)!).push(ref);
  }
  return out;
}

/** Every variable a step writes: its Set Variable's or target's, and its
 * Show Custom Dialog inputs'. */
export function writtenVariables(step: StepIr): string[] {
  return [...(step.setsVariable ? [step.setsVariable] : []), ...(step.inputVariables ?? [])];
}

export function isLocalVariable(name: string): boolean {
  return name.startsWith("$") && !name.startsWith("$$");
}

/** "step 4" / "steps 4, 9". */
export function stepList(steps: readonly number[]): string {
  const unique = [...new Set(steps)].sort((a, b) => a - b);
  return `${unique.length === 1 ? "step" : "steps"} ${unique.join(", ")}`;
}
