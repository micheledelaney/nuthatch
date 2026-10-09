import type {
  FmObject,
  FmReference,
  ObjectType,
  ParseResult,
  ReportCard,
  RiskFlag,
} from "@/types/ddr";
import { OBJECT_TYPE_META } from "@/types/ddr";

/** Compute the report-card metrics for the solution. */
export function buildReportCard(
  parsed: Pick<ParseResult, "files" | "objects">,
  references: FmReference[],
  /** Objects with a broken reference (see brokenSources). */
  brokenSources: ReadonlySet<string>,
  unreferenced: FmObject[],
  unusedChain: FmObject[],
  markedUsedCount: number,
): ReportCard {
  const countsByType = emptyCounts();
  for (const obj of parsed.objects) {
    if (obj.isSeparator) continue; // dividers, not real objects
    countsByType[obj.type] += 1;
  }

  const unstoredCalculationCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.unstored === "Yes",
  ).length;

  const deepCalcCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.unstored === "Yes" && (o.relationshipDepth ?? 0) >= 2,
  ).length;

  // The parser's global-variable objects: one per name per file, whatever its case.
  const globalVariableCount = countsByType.globalVariable;

  const globalFieldCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.global === "Yes",
  ).length;

  // Active FileMaker-auth accounts with no password set.
  const accountsNoPasswordCount = parsed.objects.filter(
    (o) => o.type === "account" && o.attributes.status !== "Inactive" && o.attributes.password === "No",
  ).length;

  const reportCard: ReportCard = {
    fileCount: parsed.files.length,
    countsByType,
    referenceCount: references.length,
    brokenReferenceCount: brokenSources.size,
    unreferencedCount: unreferenced.length,
    unusedChainCount: unusedChain.length,
    markedUsedCount,
    unstoredCalculationCount,
    deepCalcCount,
    globalVariableCount,
    globalFieldCount,
    accountsNoPasswordCount,
    riskFlags: [],
  };
  reportCard.riskFlags = deriveRiskFlags(reportCard);
  return reportCard;
}

/** The risks worth flagging, most severe first (broken references, then
 * accounts with no password, then the rest), so the report card can lead with
 * the first. Checks that find nothing are left out. */
function deriveRiskFlags(card: ReportCard): RiskFlag[] {
  const flags: RiskFlag[] = [
    { kind: "broken", severity: "high", count: card.brokenReferenceCount },
    { kind: "noPassword", severity: "high", count: card.accountsNoPasswordCount },
    { kind: "unreferenced", severity: "warn", count: card.unreferencedCount },
    { kind: "unstored", severity: "warn", count: card.unstoredCalculationCount },
    // "info", not "warn": the saved-analyses trend counts warn flags, and this
    // adds no new problem — it shows how far the unreferenced ones reach.
    { kind: "unusedChain", severity: "info", count: card.unusedChainCount },
  ];
  return flags.filter((f) => f.count > 0);
}

function emptyCounts(): Record<ObjectType, number> {
  const counts = {} as Record<ObjectType, number>;
  for (const type of Object.keys(OBJECT_TYPE_META) as ObjectType[]) counts[type] = 0;
  return counts;
}
