import type { SolutionModel } from "@/types/ddr";
import { buildBlocks } from "./blocks";
import { checkContext, contextIndex } from "./context";
import { checkFieldReads, nameTakingFunctions } from "./fieldReads";
import type { Certainty, ScriptAnalysisInput, ScriptFinding, SkippedCheck } from "./findings";
import { checkParameterKeys } from "./paramKeys";
import { checkScriptResults } from "./scriptResults";
import { checkUnreachable } from "./unreachable";
import { checkVariables, customFunctionUses } from "./variables";

export interface ScriptAnalysis {
  findings: ScriptFinding[];
  skipped: SkippedCheck[];
  /** Scripts checked: those with steps. */
  scriptCount: number;
}

/** Run every script check over a solution: the model plus each script's typed steps. */
export function analyzeScripts(input: ScriptAnalysisInput): ScriptAnalysis {
  const { model, irs } = input;
  const functions = customFunctionUses(model);
  const context = contextIndex(input);
  const nameTaking = nameTakingFunctions(model);
  const findings: ScriptFinding[] = [];
  const skipped: SkippedCheck[] = [];
  let scriptCount = 0;
  for (const script of model.objects) {
    const steps = script.type === "script" ? irs.get(script.uid) : undefined;
    if (!steps || steps.length === 0) continue;
    scriptCount++;
    const variables = checkVariables(script.uid, steps, functions.get(script.fileUid));
    findings.push(...variables.findings);
    skipped.push(...variables.skipped);
    const blocks = buildBlocks(steps);
    if ("error" in blocks) {
      skipped.push({ uid: script.uid, check: "unreachable-steps, unrelated-set-field, unrelated-field-target, unrelated-field-read, script results", reason: `its blocks don't nest: ${blocks.error}` });
      continue;
    }
    findings.push(...checkUnreachable(script.uid, blocks), ...checkContext(context, script));
    findings.push(...checkFieldReads(context, script, nameTaking.get(script.fileUid) ?? new Set()));
  }
  findings.push(...checkParameterKeys(input), ...checkScriptResults(input));
  return { findings, skipped, scriptCount };
}

const analysisByModel = new WeakMap<SolutionModel, ScriptAnalysis>();

/** The script checks of a model's own typed steps, run once per model. */
export function modelScriptAnalysis(model: SolutionModel): ScriptAnalysis {
  const cached = analysisByModel.get(model);
  if (cached) return cached;
  const analysis = analyzeScripts({ model, irs: model.scriptSteps });
  analysisByModel.set(model, analysis);
  return analysis;
}

/** What the app shows: facts and likely defects, not the often deliberate rest. */
const SHOWN_CERTAINTIES: ReadonlySet<Certainty> = new Set(["fact", "likely"]);

const shownByModel = new WeakMap<SolutionModel, Map<string, ScriptFinding[]>>();

/** The findings the app shows, by script: those on a script's own steps, in
 * step order. The one source of a script's Script checks section, its flag
 * and the Script checks filter. */
export function shownScriptChecksByScript(model: SolutionModel): ReadonlyMap<string, readonly ScriptFinding[]> {
  const cached = shownByModel.get(model);
  if (cached) return cached;
  const byScript = new Map<string, ScriptFinding[]>();
  for (const finding of modelScriptAnalysis(model).findings) {
    if (finding.step == null || !SHOWN_CERTAINTIES.has(finding.certainty) || model.byUid.get(finding.uid)?.type !== "script") continue;
    (byScript.get(finding.uid) ?? byScript.set(finding.uid, []).get(finding.uid)!).push(finding);
  }
  for (const findings of byScript.values()) findings.sort((a, b) => a.step! - b.step!);
  shownByModel.set(model, byScript);
  return byScript;
}

/** Whether the script checks ran on a model: not for an analysis saved before
 * them, whose scripts have steps but no typed steps. */
export function scriptChecksRan(model: SolutionModel): boolean {
  return !model.objects.some((o) => o.detail?.kind === "script" && o.detail.steps.length > 0 && !model.scriptSteps.has(o.uid));
}

/** The findings a script's page lists (see shownScriptChecksByScript). */
export function shownScriptChecks(model: SolutionModel, scriptUid: string): readonly ScriptFinding[] {
  return shownScriptChecksByScript(model).get(scriptUid) ?? [];
}
