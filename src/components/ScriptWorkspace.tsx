import { useEffect, useRef, useState } from "react";
import { type FmObject, type ScriptStep, type SolutionModel } from "@/types/ddr";
import { Highlight, LinkedCode } from "./Highlight";
import { CodeBox } from "./CodeBox";
import { matchOffsets, useFindHighlights, type FindState } from "./ScriptFind";

const INDENT_PX = 18;
const PARAMS_COLLAPSE_THRESHOLD = 120;

/** Step names whose params can be very long and should be collapsible. */
function isCollapsibleStep(name: string): boolean {
  return name === "Insert Text" || name.startsWith("Import ") || name.startsWith("Export ");
}

/** Steps that open a block (indent following steps). */
const OPENERS = new Set(["If", "Loop", "Open Transaction"]);
/** Steps that close a block (dedent themselves and following steps). */
const CLOSERS = new Set(["End If", "End Loop", "Commit Transaction"]);
/** Steps that sit one level out without changing the running depth. */
const MIDDLES = new Set(["Else", "Else If"]);

const FLOW_STEPS = new Set([
  "If", "Else If", "Else", "End If",
  "Loop", "Exit Loop If", "End Loop",
  "Open Transaction", "Commit Transaction", "Revert Transaction",
]);
const NAV_STEPS = new Set([
  "Go to Layout", "Go to Related Record", "Go to Record/Request/Page",
  "Go to Object", "Go to Field", "Go to Portal Row", "Close Popover",
  "New Window", "Select Window", "Close Window", "Adjust Window",
  "Move/Resize Window", "Freeze Window", "Refresh Window",
]);
const CALL_STEPS = new Set([
  "Perform Script", "Perform Script on Server", "Perform Script on Server with Callback",
  "Perform JavaScript in Web Viewer", "Perform AppleScript", "Execute FileMaker Data API",
  "Install OnTimer Script",
]);
const EXIT_STEPS = new Set([
  "Halt Script", "Exit Script", "Exit Application",
]);
const DELETE_STEPS = new Set([
  "Delete Record/Request", "Delete All Records", "Delete Portal Row", "Truncate Table",
  "Delete File", "Delete Account",
]);
/** Steps that change records: the ones a reader most needs to see. */
const CHANGE_STEPS = new Set([
  "Set Field", "Set Field By Name", "Replace Field Contents", "Relookup Field Contents",
  "Insert Text", "Insert Calculated Result", "Insert from URL", "Insert File", "Clear", "Paste",
  "New Record/Request", "Duplicate Record/Request", "Commit Records/Requests",
  "Revert Record/Request", "Import Records",
]);
const SET_STEPS = new Set([
  "Set Variable", "Copy", "Set Selection",
]);
const FIND_STEPS = new Set([
  "Enter Find Mode", "Enter Browse Mode", "Enter Preview Mode", "Perform Find", "Perform Quick Find",
  "Show All Records", "Omit Record", "Omit Multiple Records", "Show Omitted Only",
  "Constrain Found Set", "Extend Found Set", "Sort Records", "Open Record/Request", "Export Records",
]);
/** Steps that set how the script runs, not what it does: shown quieter. */
const QUIET_STEPS = new Set([
  "Set Error Capture", "Allow User Abort", "Pause/Resume Script", "Beep",
  "Set Layout Object Animation", "Set Zoom Level",
  "Show/Hide Toolbars", "Show/Hide Menubar", "Show/Hide Text Ruler",
]);

const STEP_GROUPS: [Set<string>, string][] = [
  [FLOW_STEPS, "sw-flow"],
  [NAV_STEPS, "sw-nav"],
  [CALL_STEPS, "sw-call"],
  [EXIT_STEPS, "sw-exit"],
  [DELETE_STEPS, "sw-delete"],
  [CHANGE_STEPS, "sw-change"],
  [SET_STEPS, "sw-set"],
  [FIND_STEPS, "sw-find"],
  [QUIET_STEPS, "sw-quiet"],
];

/** A step name's colour class by its step group ("" for none); the step boxes
 * outside a script (triggers, buttons) use it too. */
export function stepColorClass(name: string): string {
  return STEP_GROUPS.find(([steps]) => steps.has(name))?.[1] ?? "";
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
  owner,
  onGo,
  find,
}: {
  steps: ScriptStep[];
  brokenSteps?: Set<number>;
  scrollToStep?: number | null;
  /** Objects each step references (by step index), linked inline in its params. */
  stepRefs?: Map<number, FmObject[]>;
  /** Global variable objects used anywhere in the script — merged into every step. */
  scriptGlobals?: FmObject[];
  /** Model + the script's uid for LinkedCode's qualified-ref delegation. */
  model?: SolutionModel;
  owner?: string;
  onGo?: (uid: string, rowKey: string) => void;
  /** A search to highlight in the steps (from the section's find field). */
  find?: FindState;
}) {
  const lines = layout(steps);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const findLayerRef = useRef<HTMLDivElement>(null);
  useFindHighlights(boxRef, findLayerRef, ".sw-step", find);
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
    <CodeBox text={scriptText(lines)}>
    <div className="sw" ref={boxRef}>
      {/* Tints behind search matches, drawn by useFindHighlights. First, so the
          steps paint over it. */}
      <div className="sw-find-layer" ref={findLayerRef} aria-hidden />
      {lines.map(({ step, depth, isComment }) => {
        const hit = brokenSteps?.has(step.index) ?? false;
        const refs = isComment ? [] : [...(stepRefs?.get(step.index) ?? []), ...(scriptGlobals ?? [])];
        const long = !isComment && isCollapsibleStep(step.name) && step.params.length > PARAMS_COLLAPSE_THRESHOLD;
        const nameClass = stepColorClass(step.name);
        // A long step opens while the search matches inside it.
        const isExpanded =
          !long || expanded.has(step.index) || (find != null && matchOffsets(step.params, find.query).length > 0);
        const paramsText = long && !isExpanded
          ? step.params.slice(0, PARAMS_COLLAPSE_THRESHOLD) + "…"
          : step.params;
        return (
          <div
            key={step.index}
            ref={step.index === scrollIndex ? scrollRef : undefined}
            className={`sw-line${isComment ? " comment" : ""}${step.enabled ? "" : " disabled"}${hit ? " hit" : ""}`}
          >
            <span className="lo-chevron-space" />
            <span className="sw-ln">
              {long && (
                <button type="button" className="glyph-btn lo-chevron" onClick={() => toggleExpanded(step.index)}>
                  <span className={`fchevron${isExpanded ? " open" : ""}`}>›</span>
                </button>
              )}
              {step.index}
            </span>
            <span className="sw-step" style={{ paddingLeft: depth * INDENT_PX }}>
              {isComment ? (
                <span className="sw-comment"># {step.params}</span>
              ) : (
                <>
                  <span className={nameClass ? `sw-name ${nameClass}` : "sw-name"}>{step.name}</span>
                  {step.params && (
                    <span className="sw-params">
                      {" "}
                      {onGo && refs.length > 0 ? (
                        // Link even while collapsed — the truncated preview still
                        // shows real references, and they should be clickable. A
                        // name cut off at the truncation boundary just won't match.
                        <LinkedCode text={paramsText} objects={refs} onGo={onGo} model={model} owner={owner} />
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
    </CodeBox>
  );
}

/** The script as plain text: one step per line, blocks indented, comments as `# ...`. */
function scriptText(lines: Line[]): string {
  return lines
    .map(({ step, depth, isComment }) => {
      const indent = "  ".repeat(depth);
      if (isComment) return `${indent}# ${step.params}`;
      return `${indent}${step.name}${step.params ? ` ${step.params}` : ""}`;
    })
    .join("\n");
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
