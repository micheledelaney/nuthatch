import type { FmObject, FmReference, LayoutTriggerInfo, StepIr } from "@/types/ddr";
import { tokenize } from "./calcTokens";
import { holdersOf, keyReadAt, passedKeys, sourceAt } from "./jsonKeys";
import { stepList, type ScriptAnalysisInput, type ScriptFinding } from "./findings";

/**
 * Scripts that take a JSON parameter: the keys a script reads from it
 * (`JSONGetElement ( Get ( ScriptParameter ) ; "key" )`, or through a variable
 * set to `Get ( ScriptParameter )`) against the keys its callers build
 * (`JSONSetElement ( "{}" ; [ "key" ; … ] … )`; see jsonKeys). A caller
 * passing anything else, or a script using its parameter any other way, makes
 * the comparison incomplete, and the check then says nothing it can't back.
 */

/** The keys a script reads from its parameter, with the steps that read each. */
interface KeyReads {
  keys: Map<string, number[]>;
  /** False when the script also uses its parameter in some other way. */
  complete: boolean;
}

/** One caller: where it is and the keys it passes (undefined: can't tell). */
interface Caller {
  uid: string;
  step?: number;
  keys: string[] | undefined;
}

export function checkParameterKeys(input: ScriptAnalysisInput): ScriptFinding[] {
  const { model, irs } = input;
  const findings: ScriptFinding[] = [];
  for (const [uid, steps] of irs) {
    const reads = keyReads(steps);
    if (!reads) continue;
    const callers = (model.inbound.get(uid) ?? [])
      .filter((ref) => (ref.kind === "performScript" || ref.kind === "trigger") && !ref.disabled)
      .map((ref) => caller(input, ref, model.byUid.get(uid)));
    findings.push(...unpassedKeys(uid, reads, callers), ...unreadKeys(uid, model.byUid.get(uid)?.name ?? "the script", reads, callers));
  }
  return findings;
}

/** Keys the script reads that no caller passes — when every caller is understood. */
function unpassedKeys(uid: string, reads: KeyReads, callers: readonly Caller[]): ScriptFinding[] {
  if (callers.length === 0 || callers.some((c) => !c.keys) || callers.every((c) => c.keys!.length === 0)) return [];
  const passed = new Set(callers.flatMap((c) => c.keys!));
  const list = [...passed].sort().join(", ");
  return [...reads.keys]
    .filter(([key]) => !passed.has(key))
    .map(([key, at]) => ({
      rule: "unpassed-parameter-key",
      certainty: "likely",
      uid,
      step: at[0]!,
      title: ["Parameter key ", { code: `"${key}"` }, " isn't passed"],
      detail: [`${at.length > 1 ? `Read at ${stepList(at)}. ` : ""}${noCallerPasses(callers.length)} ${callers.length === 1 ? "It passes" : "They pass"}: ${list}.`],
    }));
}

/** "Its caller doesn't pass it." / "Neither of its 2 callers passes it." / "None of its 5 callers pass it." */
function noCallerPasses(count: number): string {
  if (count === 1) return "Its caller doesn't pass it.";
  return count === 2 ? "Neither of its 2 callers passes it." : `None of its ${count} callers pass it.`;
}

/** Keys a caller passes that the script never reads — when the script only
 * reads its parameter by literal keys. */
function unreadKeys(uid: string, scriptName: string, reads: KeyReads, callers: readonly Caller[]): ScriptFinding[] {
  if (!reads.complete) return [];
  const list = [...reads.keys.keys()].sort().join(", ");
  return callers.flatMap((c) =>
    (c.keys ?? [])
      .filter((key) => !reads.keys.has(key))
      .map((key) => ({
        rule: "unread-parameter-key" as const,
        certainty: "possible" as const,
        uid: c.uid,
        ...(c.step != null ? { step: c.step } : {}),
        title: ["Parameter key ", { code: `"${key}"` }, " is never read"],
        detail: [`Passed to ${scriptName}${uid === c.uid ? " (itself)" : ""}, which reads only: ${list}.`],
      })),
  );
}

function caller(input: ScriptAnalysisInput, ref: FmReference, script: FmObject | undefined): Caller {
  const { model, irs } = input;
  const from = model.byUid.get(ref.fromUid);
  const at = { uid: ref.fromUid, ...(ref.fromStep != null ? { step: ref.fromStep } : {}) };
  if (from?.type === "script" && ref.fromStep != null) {
    const step = irs.get(from.uid)?.[ref.fromStep - 1];
    // A callback's parameter isn't told apart from the main script's.
    if (!step || (step.name !== "Perform Script" && step.name !== "Perform Script on Server")) return { ...at, keys: undefined };
    return { ...at, keys: passedKeys(step.parameter) };
  }
  if (ref.kind === "performScript" && from?.detail?.kind === "layoutObject") return { ...at, keys: passedKeys(from.detail.scriptParameter) };
  if (ref.kind === "trigger" && script) {
    const triggers = triggersOf(from).filter((t) => t.scriptId === script.id);
    if (triggers.length === 1) return { ...at, keys: passedKeys(triggers[0]!.parameter) };
  }
  return { ...at, keys: undefined };
}

function triggersOf(obj: FmObject | undefined): readonly LayoutTriggerInfo[] {
  const detail = obj?.detail;
  if (detail?.kind === "layout" || detail?.kind === "file") return detail.triggers;
  return detail?.kind === "layoutObject" ? (detail.triggers ?? []) : [];
}

/** The literal keys a script reads from its parameter; undefined when it
 * reads none (it doesn't take a JSON parameter, as far as this can tell). */
export function keyReads(steps: readonly StepIr[]): KeyReads | undefined {
  const holders = holdersOf(steps, "scriptparameter");
  const keys = new Map<string, number[]>();
  let complete = true;
  for (const step of steps) {
    if (!step.enabled) continue;
    step.calcs.forEach((formula, n) => {
      const tokens = tokenize(formula);
      for (let i = 0; i < tokens.length; i++) {
        const width = sourceAt(tokens, i, "scriptparameter", holders);
        if (width === 0) continue;
        if (holders.has(step.setsVariable?.toLowerCase() ?? "") && n === 0 && width === tokens.length) continue; // the holder's own Set Variable
        const key = keyReadAt(tokens, i, width);
        if (key == null) complete = false;
        else (keys.get(key) ?? keys.set(key, []).get(key)!).push(step.index);
        i += width - 1;
      }
    });
  }
  return keys.size > 0 ? { keys, complete } : undefined;
}
