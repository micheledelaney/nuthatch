import type {
  FmObject,
  FmReference,
  ObjectType,
  ParseResult,
  ReportCard,
  RiskFlag,
} from "@/types/ddr";
import { OBJECT_TYPE_META } from "@/types/ddr";

const GLOBAL_VAR_RE = /\$\$[A-Za-z0-9_]+/g;

/** Compute the report-card metrics for the solution. */
export function buildReportCard(
  parsed: ParseResult,
  references: FmReference[],
  broken: FmReference[],
  unreferenced: FmObject[],
): ReportCard {
  const countsByType = emptyCounts();
  for (const obj of parsed.objects) {
    if (obj.isSeparator) continue; // dividers, not real objects
    countsByType[obj.type] += 1;
  }

  const unstoredCalculationCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.unstored === "true",
  ).length;

  const deepCalcCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.unstored === "true" && (o.relationshipDepth ?? 0) >= 2,
  ).length;

  const globalVariableCount = countGlobalVariables(parsed.objects);

  const globalFieldCount = parsed.objects.filter(
    (o) => o.type === "field" && o.attributes.global === "true",
  ).length;

  // Active FileMaker-auth accounts with no password set.
  const accountsNoPasswordCount = parsed.objects.filter(
    (o) => o.type === "account" && o.attributes.status !== "Inactive" && o.attributes.password === "No",
  ).length;

  const reportCard: ReportCard = {
    fileCount: parsed.files.length,
    countsByType,
    referenceCount: references.length,
    brokenReferenceCount: new Set(broken.map((r) => r.fromUid)).size,
    unreferencedCount: unreferenced.length,
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

function countGlobalVariables(objects: FmObject[]): number {
  const names = new Set<string>();
  for (const obj of objects) {
    const matches = obj.text.match(GLOBAL_VAR_RE);
    if (matches) for (const m of matches) names.add(m);
  }
  return names.size;
}

function deriveRiskFlags(card: ReportCard): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (card.brokenReferenceCount > 0) {
    flags.push({
      severity: "high",
      message: `${card.brokenReferenceCount} object${plural(card.brokenReferenceCount)} with broken references.`,
    });
  }
  if (card.accountsNoPasswordCount > 0) {
    flags.push({
      severity: "high",
      message: `${card.accountsNoPasswordCount} active account${plural(card.accountsNoPasswordCount)} with no password.`,
    });
  }
  if (card.unreferencedCount > 0) {
    flags.push({
      severity: "warn",
      message: `${card.unreferencedCount} potentially unreferenced object${plural(card.unreferencedCount)}.`,
    });
  }
  if (card.unstoredCalculationCount > 0) {
    flags.push({
      severity: "warn",
      message: `${card.unstoredCalculationCount} unstored calculation${plural(card.unstoredCalculationCount)} — review for performance.`,
    });
  }
  if (card.globalVariableCount > 0) {
    flags.push({
      severity: "info",
      message: `${card.globalVariableCount} distinct global variable${plural(card.globalVariableCount)} in use.`,
    });
  }
  if (flags.length === 0) {
    flags.push({ severity: "info", message: "No structural risks detected." });
  }
  return flags;
}

function emptyCounts(): Record<ObjectType, number> {
  const counts = {} as Record<ObjectType, number>;
  for (const type of Object.keys(OBJECT_TYPE_META) as ObjectType[]) counts[type] = 0;
  return counts;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
