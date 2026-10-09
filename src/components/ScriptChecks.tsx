import type { FindingText, ScriptFinding } from "@/core/scriptAnalysis/findings";
import { pressable } from "./a11y";
import { Highlight } from "./Highlight";

/** The steps a finding is about: its step, through its last for a run. */
export function findingSteps(finding: ScriptFinding): number[] {
  if (finding.step == null) return [];
  const last = finding.lastStep ?? finding.step;
  return Array.from({ length: last - finding.step + 1 }, (_, i) => finding.step! + i);
}

/** What the script checks found in a script, one row per finding: its step
 * number in a gutter, a headline, and a dim detail line. A row shows its step
 * in the script's steps. */
export function ScriptChecks({ checks, onShow }: { checks: readonly ScriptFinding[]; onShow: (step: number) => void }) {
  // Wide enough for the longest step number, so the headlines line up.
  const gutter = `${Math.max(...checks.map((check) => String(check.step).length))}ch`;
  return (
    <ul className="ref-list">
      {checks.map((check, i) => (
        // A step can have several findings of one rule (two unset variables).
        <li key={`${check.rule}:${check.step}:${i}`}>
          <div className="row script-check" {...pressable(() => onShow(check.step!))}>
            <span className="script-check-step" style={{ width: gutter }}>
              {check.step}
            </span>
            <span className="script-check-text">
              <span>
                <FindingTextView text={check.title} />
              </span>
              <span className="script-check-detail">
                <FindingTextView text={check.detail} />
              </span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Words as they are; the code they name in its code colours. */
function FindingTextView({ text }: { text: FindingText }) {
  return (
    <>
      {text.map((part, i) => (typeof part === "string" ? part : <Highlight key={i} text={part.code} />))}
    </>
  );
}
