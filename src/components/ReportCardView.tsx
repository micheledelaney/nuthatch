import { useStore } from "@/state/store";
import { OBJECT_TYPE_META, isUnresolvedTableOccurrence, type ObjectType } from "@/types/ddr";

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

  // Point the navigator at every type, filtered to broken / unreferenced objects,
  // and switch to Browse so the sidebar is visible.
  const showBroken = () => {
    showBrowse();
    setNavType("all");
    setNavRefFilter("broken");
  };
  const showUnreferenced = () => {
    showBrowse();
    setNavType("all");
    setNavRefFilter("unreferenced");
  };

  const typeMetrics = (Object.keys(OBJECT_TYPE_META) as ObjectType[])
    .filter((t) => t !== "file" && card.countsByType[t] > 0)
    .map((t) => ({ type: t, label: OBJECT_TYPE_META[t].plural, value: card.countsByType[t] }));

  return (
    <div className="panel">
      {unresolvedExternalCount > 0 && (
        <div className="report-warning" role="note">
          <span className="report-warning-icon" aria-hidden>
            ⚠
          </span>
          <span>
            <strong>Incomplete DDR export.</strong> {unresolvedExternalCount.toLocaleString()} external
            table occurrence{unresolvedExternalCount === 1 ? "" : "s"} couldn't be resolved because their
            source files weren't available when this DDR was generated — references through them can't be
            verified, so they aren't counted as broken. Re-export the DDR with all referenced files open for
            complete broken-reference detection.
          </span>
        </div>
      )}
      {/* Problems the parser hit but could work around (a missing DDR_INFO, a
          layout it couldn't read) — the numbers below are incomplete without them. */}
      {model.parseErrors.map((message, i) => (
        <div key={i} className="report-warning" role="note">
          <span className="report-warning-icon" aria-hidden>
            ⚠
          </span>
          <span>{message}</span>
        </div>
      ))}
      <h2 style={{ fontSize: 13 }}>Health</h2>
      <div className="metrics">
        <Metric label="References" value={card.referenceCount} />
        <Metric label="Objects with broken references" value={card.brokenReferenceCount} onClick={showBroken} accent={card.brokenReferenceCount > 0 ? "high" : undefined} />
        <Metric label="Unreferenced objects" value={card.unreferencedCount} onClick={showUnreferenced} accent={card.unreferencedCount > 0 ? "warn" : undefined} />
        <Metric label="Active accounts, no password" value={card.accountsNoPasswordCount} onClick={() => { showBrowse(); setNavRefFilter("all"); setNavType("account"); setNavAccountFilter("active"); setNavAccountPw("none"); }} accent={card.accountsNoPasswordCount > 0 ? "high" : undefined} />
        <Metric label="Unstored calculations" value={card.unstoredCalculationCount} onClick={() => { setNavRefFilter("all"); focusFields("unstored"); }} accent={card.unstoredCalculationCount > 0 ? "warn" : undefined} />
        <Metric label="Deep calcs (depth ≥ 2)" value={card.deepCalcCount} onClick={() => { setNavRefFilter("all"); focusFields("deepCalc"); }} accent={card.deepCalcCount > 0 ? "warn" : undefined} />
        <Metric label="Global variables" value={card.globalVariableCount} onClick={() => { showBrowse(); setNavRefFilter("all"); setNavType("globalVariable"); }} />
        <Metric label="Global fields" value={card.globalFieldCount} onClick={() => { setNavRefFilter("all"); focusFields("global"); }} />
      </div>

      <h2 style={{ fontSize: 13 }}>Risk flags</h2>
      <ul className="flags">
        {card.riskFlags.map((flag, i) => (
          <li key={i} className={flag.severity}>
            {flag.message}
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 13 }}>Object inventory</h2>
      <div className="metrics" style={{ marginTop: 10 }}>
        {typeMetrics.map((m) => (
          <Metric
            key={m.type}
            label={m.label}
            value={m.value}
            onClick={() => {
              showBrowse();
              setNavRefFilter("all");
              setNavType(m.type);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  onClick,
  accent,
}: {
  label: string;
  value: number;
  onClick?: () => void;
  accent?: "high" | "warn";
}) {
  return (
    <div
      className={`metric${onClick ? " clickable" : ""}${accent ? ` ${accent}` : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <div className="value">{value.toLocaleString()}</div>
      <div className="label">{label}</div>
    </div>
  );
}
