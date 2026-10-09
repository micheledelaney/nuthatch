import { useMemo } from "react";
import { TypePill } from "@/components/TypePill";
import { pressable } from "@/components/a11y";
import { brokenSourcesFor } from "@/components/browseA/refStats";
import {
  OBJECT_TYPE_META,
  type ObjectType,
  type RiskFlag,
  type RiskFlagKind,
  type SolutionModel,
} from "@/types/ddr";

/** How each flag reads. `what` follows the big number in the main widget;
 * `detail` explains it underneath. */
const FLAG_COPY: Record<
  RiskFlagKind,
  { title: (n: number) => string; what: (n: number) => string; detail: string }
> = {
  broken: {
    title: () => "Broken references",
    what: (n) => (n === 1 ? "object points to something that no longer exists" : "objects point to something that no longer exists"),
    detail: "Each of these objects refers to a script, field, layout or other object that was deleted or can’t be found, so the step, calculation or button that uses it fails when it runs. Click here to list the affected objects; the types below narrow it down.",
  },
  noPassword: {
    title: (n) => (n === 1 ? "Active account with no password" : "Active accounts with no password"),
    what: (n) => (n === 1 ? "active account has no password" : "active accounts have no password"),
    detail: "An active account without a password lets anyone who knows the account name open the file. Set a password, or turn the account off.",
  },
  unreferenced: {
    title: (n) => (n === 1 ? "Potentially unreferenced object" : "Potentially unreferenced objects"),
    what: (n) => (n === 1 ? "object that nothing points to" : "objects that nothing points to"),
    detail: "Nothing in the file points to these. They may be dead code, but check before deleting: something outside the export (a server schedule, the Data API, another file) could still use them.",
  },
  unstored: {
    title: (n) => (n === 1 ? "Unstored calculation" : "Unstored calculations"),
    what: (n) => (n === 1 ? "calculation is recalculated on display" : "calculations are recalculated on display"),
    detail: "These are recalculated every time they are displayed, which slows lists, finds and reports. Store them where you can, or move the logic out of the field.",
  },
  unusedChain: {
    title: (n) => (n === 1 ? "Object used only by unreferenced objects" : "Objects used only by unreferenced objects"),
    what: (n) => (n === 1 ? "object is used only by unreferenced objects" : "objects are used only by unreferenced objects"),
    detail: "These are used only by objects that nothing points to, so they are dead code as well. Deleting the unreferenced ones would leave them without a caller.",
  },
  globalVariables: {
    title: (n) => (n === 1 ? "Distinct global variable in use" : "Distinct global variables in use"),
    what: (n) => (n === 1 ? "global variable is in use" : "global variables are in use"),
    detail: "Global variables are state shared across scripts, and each one is a hidden dependency between them. They are worth knowing about, not necessarily a problem.",
  },
};

/** The value colour for each severity: red, yellow, or the accent. */
const TONE: Record<RiskFlag["severity"], "danger" | "warning" | "accent"> = {
  high: "danger",
  warn: "warning",
  info: "accent",
};

/**
 * Risk flags: the most severe flag as the main issue. Flags arrive most severe
 * first (see deriveRiskFlags), so it is broken references when there are any,
 * then accounts with no password, then the rest.
 */
export function RiskFlags({
  model,
  goTo,
  onFoundIn,
}: {
  model: SolutionModel;
  goTo: Record<RiskFlagKind, () => void>;
  onFoundIn: (type: ObjectType) => void;
}) {
  const [top] = model.reportCard.riskFlags;
  if (!top) {
    return (
      <div className="nh-notice">
        <p>
          <strong>No structural risks detected.</strong>
        </p>
      </div>
    );
  }

  return (
    <div className="nh-risk">
      <MainIssue flag={top} model={model} onShowAll={goTo[top.kind]} onFoundIn={onFoundIn} />
    </div>
  );
}

function MainIssue({
  flag,
  model,
  onShowAll,
  onFoundIn,
}: {
  flag: RiskFlag;
  model: SolutionModel;
  onShowAll: () => void;
  onFoundIn: (type: ObjectType) => void;
}) {
  const copy = FLAG_COPY[flag.kind];
  const types = useMemo(() => (flag.kind === "broken" ? brokenTypes(model) : []), [flag.kind, model]);

  return (
    <section className={`nh-issue nh-card tone-${TONE[flag.severity]}`}>
      {/* The whole statement is one click target; the type chips below are
          separate buttons, so they sit outside it. */}
      <div className="nh-issue__main" title={`Show all ${flag.count.toLocaleString()}`} {...pressable(onShowAll)}>
        <h3 className="nh-issue__title">{copy.title(flag.count)}</h3>
        <div className="nh-issue__big">
          <span className="nh-issue__num">{flag.count.toLocaleString()}</span>
          <span className="nh-issue__what">{copy.what(flag.count)}</span>
        </div>
        <p className="nh-issue__detail">{copy.detail}</p>
      </div>
      {types.length > 0 && (
        <div className="nh-issue__found">
          <p className="head">Found in</p>
          <div className="nh-issue__chips">
            {types.map((type) => (
              <button key={type} type="button" className="glyph-btn type-pill-btn" onClick={() => onFoundIn(type)}>
                <TypePill type={type} label={OBJECT_TYPE_META[type].plural} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** The object types that hold broken references, in the usual type order —
 * from the same source as the count, the dots and the Broken filter. */
function brokenTypes(model: SolutionModel): ObjectType[] {
  const brokenFrom = brokenSourcesFor(model);
  const present = new Set(model.objects.filter((o) => brokenFrom.has(o.uid)).map((o) => o.type));
  return (Object.keys(OBJECT_TYPE_META) as ObjectType[]).filter((t) => present.has(t));
}
