import type { SolutionModel, StepIr } from "@/types/ddr";
import { calledFunctions, calledNames, tokenize, variableUses, type Token } from "./calcTokens";
import { isLocalVariable, stepList, type ScriptFinding, type SkippedCheck } from "./findings";

/**
 * Local variables ($x) belong to one run of one script: a subscript has its
 * own, and a custom function the script calls shares the script's. So within
 * a script, every read of $x should have a set of $x somewhere — in a step, a
 * Let, or a custom function it calls — and every set should have a read.
 * Names are compared without case, as FileMaker does.
 */

/** What formulas do to the variables of the script that evaluates them (lower-case names). */
export interface FormulaUses {
  reads: Set<string>;
  sets: Set<string>;
  /** Names that may be custom function calls (lower case). */
  calls: Set<string>;
  /** Calls Evaluate, which can set or read any variable. */
  evaluates: boolean;
}

function emptyUses(): FormulaUses {
  return { reads: new Set(), sets: new Set(), calls: new Set(), evaluates: false };
}

function addFormula(uses: FormulaUses, tokens: readonly Token[]): void {
  const { reads, sets } = variableUses(tokens);
  for (const name of reads) uses.reads.add(name.toLowerCase());
  for (const name of sets) uses.sets.add(name.toLowerCase());
  if (calledFunctions(tokens).includes("evaluate")) uses.evaluates = true;
  for (const name of calledNames(tokens)) uses.calls.add(name);
}

/** Per file uid, each custom function's uses (by lower-case name), with those
 * of the custom functions it calls, transitively. */
export function customFunctionUses(model: SolutionModel): Map<string, Map<string, FormulaUses>> {
  const byFile = new Map<string, Map<string, FormulaUses>>();
  for (const obj of model.objects) {
    if (obj.type !== "customFunction" || obj.detail?.kind !== "calculation") continue;
    const uses = emptyUses();
    addFormula(uses, tokenize(obj.detail.body));
    (byFile.get(obj.fileUid) ?? byFile.set(obj.fileUid, new Map()).get(obj.fileUid)!).set(obj.name.toLowerCase(), uses);
  }
  for (const functions of byFile.values()) {
    for (let changed = true; changed; ) {
      changed = false;
      for (const uses of functions.values()) {
        for (const name of uses.calls) changed = absorb(uses, functions.get(name)) || changed;
      }
    }
  }
  return byFile;
}

/** Add `from`'s uses to `into`; whether that added anything. */
function absorb(into: FormulaUses, from: FormulaUses | undefined): boolean {
  if (!from || from === into) return false;
  const before = into.reads.size + into.sets.size + into.calls.size + (into.evaluates ? 1 : 0);
  for (const name of from.reads) into.reads.add(name);
  for (const name of from.sets) into.sets.add(name);
  for (const name of from.calls) into.calls.add(name);
  into.evaluates ||= from.evaluates;
  return into.reads.size + into.sets.size + into.calls.size + (into.evaluates ? 1 : 0) > before;
}

/** Where a script's steps read and set each local variable (by lower-case
 * name), enabled and disabled steps apart. */
interface StepUses {
  spelling: Map<string, string>;
  reads: Map<string, number[]>;
  sets: Map<string, number[]>;
  disabledReads: Map<string, number[]>;
  disabledSets: Map<string, number[]>;
  /** What the custom functions its enabled steps call read and set. */
  functions: FormulaUses;
  /** The text of every string literal in its enabled steps, lower case. */
  strings: string[];
}

function stepUses(steps: readonly StepIr[], functions: ReadonlyMap<string, FormulaUses> | undefined): StepUses {
  const out: StepUses = {
    spelling: new Map(),
    reads: new Map(),
    sets: new Map(),
    disabledReads: new Map(),
    disabledSets: new Map(),
    functions: emptyUses(),
    strings: [],
  };
  const note = (into: Map<string, number[]>, name: string, step: number) => {
    if (!isLocalVariable(name)) return;
    const key = name.toLowerCase();
    if (!out.spelling.has(key)) out.spelling.set(key, name);
    (into.get(key) ?? into.set(key, []).get(key)!).push(step);
  };
  for (const step of steps) {
    const reads = step.enabled ? out.reads : out.disabledReads;
    const sets = step.enabled ? out.sets : out.disabledSets;
    if (step.setsVariable) note(sets, step.setsVariable, step.index);
    for (const formula of step.calcs) {
      const tokens = tokenize(formula);
      const uses = variableUses(tokens);
      for (const name of uses.reads) note(reads, name, step.index);
      for (const name of uses.sets) note(sets, name, step.index);
      if (!step.enabled) continue;
      for (const token of tokens) if (token.kind === "string") out.strings.push(token.value.toLowerCase());
      const own = emptyUses();
      addFormula(own, tokens);
      out.functions.evaluates ||= own.evaluates;
      for (const fn of own.calls) absorb(out.functions, functions?.get(fn));
    }
  }
  return out;
}

/** The variable checks for one script. */
export function checkVariables(
  scriptUid: string,
  steps: readonly StepIr[],
  functions: ReadonlyMap<string, FormulaUses> | undefined,
): { findings: ScriptFinding[]; skipped: SkippedCheck[] } {
  const uses = stepUses(steps, functions);
  const findings: ScriptFinding[] = [];
  const skipped: SkippedCheck[] = [];
  const name = (key: string) => uses.spelling.get(key) ?? key;

  if (uses.functions.evaluates) {
    skipped.push({ uid: scriptUid, check: "unset-variable", reason: "it calls Evaluate (itself or in a custom function), which can set any variable" });
  } else {
    for (const [key, readAt] of uses.reads) {
      if (uses.sets.has(key) || uses.functions.sets.has(key)) continue;
      const disabled = uses.disabledSets.get(key);
      findings.push({
        rule: "unset-variable",
        certainty: "likely",
        uid: scriptUid,
        step: readAt[0]!,
        title: [{ code: name(key) }, " is never set"],
        detail: [`Read at ${stepList(readAt)}${disabled ? `; only disabled ${stepList(disabled)} would set it` : ""}, so it's always empty.`],
      });
    }
  }

  for (const [key, setAt] of uses.sets) {
    if (uses.reads.has(key) || uses.functions.reads.has(key)) continue;
    if (uses.strings.some((text) => text.includes(key))) continue; // maybe read by name, e.g. through Evaluate
    const disabled = uses.disabledReads.get(key);
    findings.push({
      rule: "unread-variable",
      certainty: "possible",
      uid: scriptUid,
      step: setAt[0]!,
      title: [{ code: name(key) }, " is never read"],
      detail: [`Set at ${stepList(setAt)}${disabled ? `; only disabled ${stepList(disabled)} would read it` : ""}.`],
    });
  }
  return { findings, skipped };
}
