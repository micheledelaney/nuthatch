import type { StepIr } from "@/types/ddr";
import { isCommentStep } from "@/core/parser/steps";
import { walk, type Block, type DeadEnd, type Domain } from "./blocks";
import type { ScriptFinding } from "./findings";

/** Only whether a path gets there: the walker tracks that itself. */
const REACHED: Domain<true> = { join: () => true, equals: () => true, transfer: () => true };

/** Steps that only close or continue a block: never reported on their own. */
const BLOCK_STEPS: ReadonlySet<string> = new Set(["Else If", "Else", "End If", "End Loop"]);

interface DeadRun {
  first: StepIr;
  last: StepIr;
  deadEnd: DeadEnd | undefined;
}

/** Runs of enabled steps no path reaches — after an Exit Script or Halt
 * Script, an If whose every branch stops the script, or a Loop that only
 * stops with the script. Comments and disabled steps don't count. */
export function checkUnreachable(scriptUid: string, blocks: readonly Block[]): ScriptFinding[] {
  const runs: DeadRun[] = [];
  let open: DeadRun | undefined;
  walk(blocks, true, REACHED, (step, state, deadEnd) => {
    if (!step.enabled || isCommentStep(step.name)) return;
    if (state != null) {
      open = undefined;
      return;
    }
    if (BLOCK_STEPS.has(step.name)) return;
    if (open) open.last = step;
    else runs.push((open = { first: step, last: step, deadEnd }));
  });
  return runs.map((run) => ({
    rule: "unreachable-steps",
    certainty: "fact",
    uid: scriptUid,
    step: run.first.index,
    ...(run.last !== run.first ? { lastStep: run.last.index } : {}),
    title: [run.first === run.last ? "This step never runs" : `Steps ${run.first.index}–${run.last.index} never run`],
    detail: [`${because(run.deadEnd)}.`],
  }));
}

function because(deadEnd: DeadEnd | undefined): string {
  if (!deadEnd) return "No path reaches it";
  const { step } = deadEnd;
  if (deadEnd.kind === "ended") return `The script always stops at step ${step.index} (${step.name}) first`;
  if (deadEnd.kind === "allBranchesEnd") return `Every branch of the If at step ${step.index} stops the script`;
  return `The Loop at step ${step.index} has no Exit Loop If (or Go to Record/Portal Row) to leave it by`;
}
