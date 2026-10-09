import { useStore } from "@/state/store";
import { isUnresolvedTableOccurrence, type ObjectType, type RiskFlagKind } from "@/types/ddr";
import { RiskFlags } from "@/components/RiskFlags";
import { shownScriptChecksByScript } from "@/core/scriptAnalysis/analyze";

/** Report card dashboard — the home base for a parsed solution. */
export function ReportCardView() {
  const model = useStore((s) => s.model);
  const showBrowse = useStore((s) => s.showBrowse);
  const setNavType = useStore((s) => s.setNavType);
  const setNavAccountFilter = useStore((s) => s.setNavAccountFilter);
  const setNavAccountPw = useStore((s) => s.setNavAccountPw);
  const setNavRefFilter = useStore((s) => s.setNavRefFilter);
  const focusFields = useStore((s) => s.focusFields);
  if (!model) return null;
  const card = model.reportCard;

  // External table occurrences FileMaker couldn't resolve when the file was
  // exported (the source file wasn't available, or the data source's path is a
  // variable): no base table is recorded, so nothing read through them can be
  // checked. They're not counted as broken — say so, so the numbers don't mislead.
  const unresolvedExternalCount = model.objects.filter(isUnresolvedTableOccurrence).length;

  // Where each check's "show me" goes: the navigator, pointed at the matching
  // objects, on the Browse tab so the sidebar is visible. Shared by the tiles
  // and the risk flags.
  const showAll = (filter: "broken" | "unreferenced" | "unusedChain" | "scriptChecks") => {
    showBrowse();
    setNavType("all");
    setNavRefFilter(filter);
  };
  const goTo: Record<RiskFlagKind, () => void> = {
    broken: () => showAll("broken"),
    unreferenced: () => showAll("unreferenced"),
    unusedChain: () => showAll("unusedChain"),
    noPassword: () => {
      showBrowse();
      setNavRefFilter("all");
      setNavType("account");
      setNavAccountFilter("active");
      setNavAccountPw("none");
    },
    unstored: () => {
      setNavRefFilter("all");
      focusFields("unstored");
    },
  };
  // A type's broken objects, for the risk card's "Found in" chips.
  const showBrokenOfType = (type: ObjectType) => {
    showBrowse();
    setNavType(type);
    setNavRefFilter("broken");
  };
  const showMarkedUsed = () => {
    showBrowse();
    setNavType("all");
    setNavRefFilter("markedUsed");
  };

  // The main issue above already shows (and links) its own figure, so its tile
  // is left out rather than repeating the number.
  const hero = card.riskFlags[0]?.kind;
  // Scripts with a finding: the same source as their flag and the Script checks filter.
  const scriptCheckCount = shownScriptChecksByScript(model).size;

  return (
    <div className="report-card">
      {unresolvedExternalCount > 0 && (
        <div className="nh-notice" role="note">
          <span className="nh-notice__icon" aria-hidden>
            !
          </span>
          <p>
            <strong>Incomplete DDR export.</strong> {unresolvedExternalCount.toLocaleString()} external
            table occurrence{unresolvedExternalCount === 1 ? "" : "s"} couldn't be resolved because their
            source files weren't available when this DDR was generated — references through them can't be
            verified, so they aren't counted as broken. Re-export the DDR with all referenced files open for
            complete broken-reference detection.
          </p>
        </div>
      )}
      {/* Problems the parser hit but could work around (a missing DDR_INFO, a
          layout it couldn't read) — the numbers below are incomplete without them. */}
      {model.parseErrors.map((message, i) => (
        <div key={i} className="nh-notice" role="note">
          <span className="nh-notice__icon" aria-hidden>
            !
          </span>
          <p>{message}</p>
        </div>
      ))}

      <section>
        <RiskFlags model={model} goTo={goTo} onFoundIn={showBrokenOfType} />
      </section>

      <section>
        <div className="nh-tiles nh-card report-tiles">
          {hero !== "broken" && <Metric label="Objects with broken references" hint="They point to something that was deleted or can't be found, so the step, calculation or button that uses it fails." value={card.brokenReferenceCount} onClick={goTo.broken} tone={card.brokenReferenceCount > 0 ? "danger" : undefined} />}
          {hero !== "noPassword" && <Metric label="Active accounts, no password" hint="Anyone who knows the account name can open the file. Set a password or turn the account off." value={card.accountsNoPasswordCount} onClick={goTo.noPassword} tone={card.accountsNoPasswordCount > 0 ? "danger" : undefined} />}
          {/* Left out for an analysis saved before the script checks: it has no steps to check. */}
          {model.scriptSteps.size > 0 && <Metric label="Scripts flagged by script checks" hint="Steps that never run, variables that are never set, and other mistakes that make a script misbehave." value={scriptCheckCount} onClick={() => showAll("scriptChecks")} tone={scriptCheckCount > 0 ? "warning" : undefined} />}
          {hero !== "unstored" && <Metric label="Unstored calculations" hint="Recalculated every time they're displayed, which slows lists, finds and reports. Store them where you can." value={card.unstoredCalculationCount} onClick={goTo.unstored} tone={card.unstoredCalculationCount > 0 ? "warning" : undefined} />}
          <Metric label="Unstored calculations, 2+ hops" hint="Unstored calculations that read a field two or more relationships away. FileMaker follows every hop each time one is displayed, so they're the slowest kind." value={card.deepCalcCount} onClick={() => { setNavRefFilter("all"); focusFields("deepCalc"); }} tone={card.deepCalcCount > 0 ? "warning" : undefined} />
        </div>
      </section>

      <section>
        <div className="nh-tiles nh-card report-tiles">
          {hero !== "unreferenced" && <Metric label="Unreferenced objects" hint="Objects that no calculation, script, layout, button or relationship refers to." value={card.unreferencedCount} onClick={goTo.unreferenced} tone={card.unreferencedCount > 0 ? "warning" : undefined} />}
          {hero !== "unusedChain" && <Metric label="Used only by unreferenced objects" hint="Their only users are unreferenced too, so they are dead as well." value={card.unusedChainCount} onClick={goTo.unusedChain} tone={card.unusedChainCount > 0 ? "warning" : undefined} />}
          {/* Only once something is marked: it explains why the two numbers beside it dropped. */}
          {card.markedUsedCount > 0 && <Metric label="Marked as used" hint="Used by something the export can't see (a server schedule, the Data API, another file), so they and what they use don't count as unused." value={card.markedUsedCount} onClick={showMarkedUsed} />}
        </div>
      </section>
    </div>
  );
}

/** A stat tile: a cell in the section's tile strip. The value takes the
 * severity colour; clickable tiles are buttons that fill on hover. */
function Metric({
  label,
  hint,
  value,
  onClick,
  tone,
}: {
  label: string;
  /** One line on what the figure means. */
  hint?: string;
  value: number;
  onClick?: () => void;
  tone?: "danger" | "warning";
}) {
  const body = (
    <>
      <b className={`nh-tile__value${tone ? ` nh-val-${tone}` : ""}`}>{value.toLocaleString()}</b>
      <span className="nh-tile__label">{label}</span>
      {hint && <span className="nh-tile__hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="nh-tile" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="nh-tile">{body}</div>
  );
}
