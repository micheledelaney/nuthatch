import { useEffect, useRef, useState } from "react";
import { type FmObject, type ScriptStep, type SolutionModel } from "@/types/ddr";
import { Highlight, LinkedCode, decodeEntities } from "./Highlight";

const INDENT_PX = 18;
const PARAMS_COLLAPSE_THRESHOLD = 120;

/** Step names whose params can be very long and should be collapsible. */
function isCollapsibleStep(name: string): boolean {
  return name === "Insert Text" || name.startsWith("Import ") || name.startsWith("Export ");
}

/** Steps that open a block (indent following steps). */
const OPENERS = new Set(["If", "Loop"]);
/** Steps that close a block (dedent themselves and following steps). */
const CLOSERS = new Set(["End If", "End Loop"]);
/** Steps that sit one level out without changing the running depth. */
const MIDDLES = new Set(["Else", "Else If"]);

const FLOW_STEPS = new Set([
  "If", "Else If", "Else", "End If",
  "Loop", "Exit Loop If", "End Loop",
  "Begin Transaction", "End Transaction", "Roll Back Transaction",
]);
const NAV_STEPS = new Set([
  "Go to Layout", "Go to Related Record", "New Window",
]);
const EXIT_STEPS = new Set([
  "Halt Script", "Exit Script", "Exit Application",
]);
const DELETE_STEPS = new Set([
  "Delete Record/Request", "Truncate Table", "Delete Portal Row",
]);

function stepColorClass(name: string): string {
  if (FLOW_STEPS.has(name)) return "sw-flow";
  if (NAV_STEPS.has(name)) return "sw-nav";
  if (EXIT_STEPS.has(name)) return "sw-exit";
  if (DELETE_STEPS.has(name)) return "sw-delete";
  return "";
}

interface Line {
  step: ScriptStep;
  depth: number;
  isComment: boolean;
}

/**
 * Render a script the way FileMaker's Script Workspace does: a numbered list
 * with If/Loop blocks indented, comments highlighted, disabled steps dimmed.
 * When `highlight` is set (from a clicked broken reference), the step(s) whose
 * parameters mention the target are flagged and scrolled into view.
 */
export function ScriptWorkspace({
  steps,
  brokenSteps,
  scrollToStep,
  stepRefs,
  scriptGlobals,
  model,
  fileUid,
  onGo,
}: {
  steps: ScriptStep[];
  brokenSteps?: Set<number>;
  scrollToStep?: number | null;
  /** Objects each step references (by step index), linked inline in its params. */
  stepRefs?: Map<number, FmObject[]>;
  /** Global variable objects used anywhere in the script — merged into every step. */
  scriptGlobals?: FmObject[];
  /** Model + fileUid for LinkedCode's qualified-ref delegation. */
  model?: SolutionModel;
  fileUid?: string;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const lines = layout(steps);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggleExpanded(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Scroll only to an explicitly clicked broken step (from the Issues view). On
  // plain navigation the detail opens at the top — broken steps are still
  // flagged, just not auto-scrolled to.
  const scrollIndex = scrollToStep ?? null;

  useEffect(() => {
    if (scrollIndex != null) scrollRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollIndex]);

  return (
    <div className="sw">
      {lines.map(({ step, depth, isComment }) => {
        const hit = brokenSteps?.has(step.index) ?? false;
        const refs = isComment ? [] : [...(stepRefs?.get(step.index) ?? []), ...(scriptGlobals ?? [])];
        const long = !isComment && isCollapsibleStep(step.name) && step.params.length > PARAMS_COLLAPSE_THRESHOLD;
        const nameClass = stepColorClass(step.name);
        const isExpanded = !long || expanded.has(step.index);
        const paramsText = long && !isExpanded
          ? step.params.slice(0, PARAMS_COLLAPSE_THRESHOLD) + "…"
          : step.params;
        return (
          <div
            key={step.index}
            ref={step.index === scrollIndex ? scrollRef : undefined}
            className={`sw-line${isComment ? " comment" : ""}${step.enabled ? "" : " disabled"}${hit ? " hit" : ""}`}
          >
            {long ? (
              <button type="button" className="lo-chevron" onClick={() => toggleExpanded(step.index)}>
                <span className={`fchevron${isExpanded ? " open" : ""}`}>›</span>
              </button>
            ) : (
              <span className="lo-chevron-space" />
            )}
            <span className="sw-ln">{step.index}</span>
            <span className="sw-step" style={{ paddingLeft: depth * INDENT_PX }}>
              {isComment ? (
                <span className="sw-comment"># {decodeEntities(step.params)}</span>
              ) : (
                <>
                  <span className={nameClass ? `sw-name ${nameClass}` : "sw-name"}>{decodeEntities(step.name)}</span>
                  {step.params && (
                    <span className="sw-params">
                      {" "}
                      {onGo && refs.length > 0 ? (
                        // Link even while collapsed — the truncated preview still
                        // shows real references, and they should be clickable. A
                        // name cut off at the truncation boundary just won't match.
                        <LinkedCode text={paramsText} objects={refs} onGo={onGo} model={model} fileUid={fileUid} />
                      ) : (
                        <Highlight text={paramsText} />
                      )}
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Assign an indent depth to each step based on block open/close steps. */
function layout(steps: ScriptStep[]): Line[] {
  let depth = 0;
  return steps.map((step) => {
    let lineDepth = depth;
    if (CLOSERS.has(step.name)) {
      depth = Math.max(0, depth - 1);
      lineDepth = depth;
    } else if (MIDDLES.has(step.name)) {
      lineDepth = Math.max(0, depth - 1);
    }
    if (OPENERS.has(step.name)) depth += 1;
    return { step, depth: lineDepth, isComment: step.name.startsWith("#") };
  });
}
