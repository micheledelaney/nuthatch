import type { FmObject, ObjectDetail } from "@/types/ddr";
import type { FileIndex, FileParse, TextScan } from "../context";
import { attr, cdataText, child, children, displayText, enabledLabels, isRecord, textAttr } from "../xmlUtils";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { ownValue } from "../ownValue";
import { collectCatalogItems, fieldCatalogs } from "../catalogWalk";
import { scanRefs } from "../refs/scanRefs";
import { activeFieldNode, isAutoEnterOptionActive, isValidationOptionActive } from "../refs/activeOptions";
import { makeObject } from "./catalogItems";
import { calculationText } from "../calcText";
import { calcOf, qualifiedField } from "./common";

/**
 * Tables come from BaseTableCatalog; their fields live under a top-level
 * FieldsForTables section, each FieldCatalog keyed back to its base table by a
 * leading <BaseTableReference>.
 */
export function parseTablesAndFields(fp: FileParse, containerNode: Record<string, unknown>, scans: TextScan[]): void {
  const tableUidById = new Map<string, string>();
  for (const table of collectCatalogItems(containerNode["BaseTableCatalog"], "BaseTable")) {
    const tableObj = makeObject(fp, table, "table");
    if (!tableObj) continue;
    fp.objects.push(tableObj);
    scans.push({ obj: tableObj, text: cdataText(table) });
    tableUidById.set(tableObj.id, tableObj.uid);
  }
  let orphans = 0;
  for (const catalog of fieldCatalogs(containerNode)) {
    const tableUid = tableUidById.get(catalog.tableId);
    if (tableUid) addFields(fp, catalog.node, tableUid, catalog.tableId, scans);
    else orphans += collectCatalogItems(catalog.node, "Field").length;
  }
  if (orphans > 0) {
    const what = orphans === 1 ? "1 field of a table that isn't in its table catalog was" : `${orphans} fields of tables that aren't in its table catalog were`;
    fp.errors.push(`${fp.file.source}: ${what} left out.`);
  }
}

function addFields(fp: FileParse, fieldContainer: unknown, tableUid: string, tableId: string, scans: TextScan[]): void {
  for (const field of collectCatalogItems(fieldContainer, "Field")) {
    // Field ids are unique only within a base table, so namespace the uid by
    // the owning table to keep object uids globally unique.
    const base = makeObject(fp, field, "field", tableUid, tableId);
    if (!base || !isRecord(field)) continue;
    const fieldObj = annotateField(field, base, fp.index);
    fp.objects.push(fieldObj);
    // Without its switched-off auto-enter / validation calcs, for the element
    // scan and the placeholder passes (which read text, not elements) alike.
    const active = activeFieldNode(field);
    scans.push({ obj: fieldObj, text: cdataText(active) });
    scanRefs(fp, active, fieldObj);
  }
}

/** Human labels for an <AutoEnter type="…"> other than Calculated/ConstantData
 *  (those are surfaced as the calculation detail / a value). Unlisted types fall
 *  back to the raw type. */
const AUTO_ENTER_LABELS: Readonly<Record<string, string>> = {
  SerialNumber: "Serial number",
  CreationDate: "Creation date",
  CreationTime: "Creation time",
  CreationTimestamp: "Creation timestamp",
  CreationName: "Creation name",
  CreationAccountName: "Creation account name",
  CreationUserName: "Creation user name",
  ModificationDate: "Modification date",
  ModificationTime: "Modification time",
  ModificationTimestamp: "Modification timestamp",
  ModificationName: "Modification name",
  ModificationAccountName: "Modification account name",
  ModificationUserName: "Modification user name",
  LastVisited: "Value from last visited record",
  Looked_up: "Looked-up value",
};

const AUTO_ENTER_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ["prohibitModification", "Prohibit modification"],
  ["alwaysEvaluate", "Always evaluate"],
  ["overwriteExisting", "Overwrite existing"],
];

/** Friendly labels for a summary field's <SummaryInfo operation>. */
const SUMMARY_OPERATION_LABELS: Readonly<Record<string, string>> = {
  Total: "Total of",
  Average: "Average of",
  Count: "Count of",
  Minimum: "Minimum of",
  Maximum: "Maximum of",
  StandardDeviation: "Standard deviation of",
  Fraction: "Fraction of total of",
  FractionOfTotal: "Fraction of total of",
  List: "List of",
  RunningTotal: "Running total of",
  RunningCount: "Running count of",
};

/** Validation's "Strict data type" option (<Strict>). */
const STRICT_TYPE_LABELS: Readonly<Record<string, string>> = {
  Numeric: "Strict data type: numeric only",
  FourDigitYear: "Strict data type: 4-digit year date",
  Time: "Strict data type: time of day",
};

/**
 * Lift a field's settings onto its object for the report card, navigator
 * filters, and inspector: storage, its formula (a calculated field's, or an
 * auto-enter calculation), summary or lookup source, auto-enter options, and
 * validation. (`fieldType` and `dataType` already arrive via the element's own
 * attributes.)
 */
function annotateField(fieldNode: Record<string, unknown>, fieldObj: FmObject, index: FileIndex): FmObject {
  const storage = child(fieldNode, "Storage");
  const autoEnter = child(fieldNode, "AutoEnter");
  const formula = fieldFormula(fieldNode, autoEnter, storage);
  const detail = formula?.detail ?? summaryDetail(fieldNode) ?? lookupDetail(autoEnter, index);
  return {
    ...fieldObj,
    attributes: {
      ...fieldObj.attributes,
      ...storageAttributes(fieldNode, storage),
      ...formula?.attributes,
      ...autoEnterAttributes(autoEnter),
      ...validationAttributes(fieldNode),
    },
    ...(detail ? { detail } : {}),
  };
}

/** Global storage, container storage, repetitions, and indexing (all in <Storage>). */
function storageAttributes(fieldNode: Record<string, unknown>, storage: unknown): Record<string, string> {
  const a: Record<string, string> = {};
  if (attr(storage, "global") === "True") a.global = "Yes";
  // Container fields: where the data lives — in the file, or externally.
  if (attr(fieldNode, "datatype") === "Binary") a.containerStorage = containerStorage(storage);
  // Repetitions beyond the default single value are worth surfacing.
  const reps = attr(storage, "maxRepetitions");
  if (reps && reps !== "1") a.repetitions = reps;
  // Indexing: the index level, whether it auto-creates, and the index language.
  const index = attr(storage, "index");
  if (index && index !== "None") a.indexing = index;
  if (attr(storage, "autoIndex") === "True") a.autoIndex = "Yes";
  const indexLanguage = textAttr(child(storage, "LanguageReference"), "name");
  if (indexLanguage && (a.indexing || a.autoIndex)) a.indexLanguage = indexLanguage;
  return a;
}

/**
 * A container field's storage, e.g. "In file" or "External (Secure) · Mona_Lisa/".
 * External storage is a nested <Remote type="Secure|Open"> whose
 * <BaseDirectoryReference> names the base directory (Manage ▸ Containers).
 */
function containerStorage(storage: unknown): string {
  const remote = child(storage, "Remote");
  if (!isRecord(remote)) return "In file";
  const dirRef = child(remote, "BaseDirectoryReference");
  const dir = textAttr(dirRef, "name");
  const parts = [`External (${attr(remote, "type") ?? "Secure"})`];
  if (dir) parts.push(dir);
  if (attr(dirRef, "absolute") === "True") parts.push("absolute path");
  if (attr(remote, "withFewerFolders") === "True") parts.push("fewer folders");
  return parts.join(" · ");
}

/**
 * A calculated/summary field carries its formula in a nested <Calculation>; an
 * ordinary field may instead carry an auto-enter calculation under
 * <AutoEnter><Calculated> — in effect by the same rule the reference scan uses
 * (isAutoEnterOptionActive), which also holds beside an auto-entered Data
 * value. Either is surfaced as rich detail (like a custom function's body),
 * labeling the auto-enter case so it reads as such.
 */
function fieldFormula(
  fieldNode: Record<string, unknown>,
  autoEnter: unknown,
  storage: unknown,
): { detail?: ObjectDetail; attributes: Record<string, string> } | undefined {
  const calc = fieldNode["Calculation"];
  const calculated = isAutoEnterOptionActive(autoEnter, "Calculated") ? child(autoEnter, "Calculated") : undefined;
  const autoEnterCalc = calc == null && isRecord(calculated) ? calculated["Calculation"] : undefined;
  const formula = calc ?? autoEnterCalc;
  if (formula == null) return undefined;
  const body = calculationText(formula);
  // The occurrence the formula is evaluated through — where buildModel
  // measures its relationship depth from (annotateRelationshipDepths).
  const contextToId = attr(child(formula, "TableOccurrenceReference"), "id");
  return {
    ...(body ? { detail: { kind: "calculation", signature: autoEnterCalc != null ? "Auto-enter calculation" : "", body } } : {}),
    attributes: {
      // An unstored calculation opts out of storing results.
      ...(calc != null && attr(storage, "storeCalculationResults") === "False" ? { unstored: "Yes" } : {}),
      ...(contextToId != null ? { calcContextToId: contextToId } : {}),
    },
  };
}

/** A summary field carries no formula — instead a <SummaryInfo> naming the
 * aggregate operation and the field(s) it summarizes. */
function summaryDetail(fieldNode: Record<string, unknown>): ObjectDetail | undefined {
  const summaryInfo = child(fieldNode, "SummaryInfo");
  if (!isRecord(summaryInfo)) return undefined;
  const operation = ownValue(SUMMARY_OPERATION_LABELS, attr(summaryInfo, "operation")) ?? "Summary of";
  const fields: string[] = [];
  for (const sf of children(summaryInfo, "SummaryField")) {
    const ref = child(sf, "FieldReference");
    // A deleted field's reference stays, with its name blank.
    if (ref != null) fields.push(textAttr(ref, "name") || MISSING_FIELD_TOKEN);
  }
  return { kind: "summary", operation, fields };
}

/** A "looked-up value" auto-enter field carries no formula — instead an enabled
 * <Looked_up> naming the source field it copies from, formatted like a value
 * list's field source. (A disabled lookup stays in the XML; it's skipped by the
 * same rule the reference scan uses.) */
function lookupDetail(autoEnter: unknown, index: FileIndex): ObjectDetail | undefined {
  const lookedUp = child(autoEnter, "Looked_up");
  if (!isAutoEnterOptionActive(autoEnter, "Looked_up") || !isRecord(lookedUp)) return undefined;
  const source = qualifiedField(lookedUp["FieldReference"], index);
  return source ? { kind: "lookup", source } : undefined;
}

/** Any non-calculated auto-enter option (the calculated case is the field's
 * calculation detail), its behavior flags, and the serial-number settings. */
function autoEnterAttributes(autoEnter: unknown): Record<string, string> {
  if (!isRecord(autoEnter)) return {};
  const a: Record<string, string> = {};
  const type = attr(autoEnter, "type");
  if (type === "ConstantData") {
    const value = displayText(autoEnter["ConstantData"]);
    a.autoEnter = value ? `Data: ${value}` : "Data";
  } else if (type && type !== "Calculated") {
    a.autoEnter = ownValue(AUTO_ENTER_LABELS, type) ?? type;
  }
  // Behavior flags apply to any auto-enter, calculated or not.
  const flags = enabledLabels(autoEnter, AUTO_ENTER_FLAGS);
  if (flags.length) a.autoEnterOptions = flags.join(", ");
  // The increment and when-it-generates are real schema; the next value is a
  // live counter that diverges naturally between copies (records created), so
  // it's surfaced for display but excluded from the diff (see buildNoise in
  // diff.ts).
  const serial = child(autoEnter, "SerialNumber");
  if (isRecord(serial)) {
    const increment = attr(serial, "increment");
    if (increment != null) a.serialIncrement = increment;
    const generate = attr(serial, "generate");
    if (generate != null) {
      a.serialGenerate = generate === "OnCreation" ? "On creation" : generate === "OnCommit" ? "On commit" : generate;
    }
    const nextValue = attr(serial, "nextvalue");
    if (nextValue != null) a.serialNextValue = nextValue;
  }
  return a;
}

/**
 * A field's validation requirements (the nested <Validation> block): which
 * checks are required, when they run, whether the user can override, and the
 * validation formula and custom failure message, if any. Empty when no
 * requirement is set, so the default (empty) validation every field carries
 * doesn't clutter the inspector.
 */
function validationAttributes(fieldNode: Record<string, unknown>): Record<string, string> {
  const validation = child(fieldNode, "Validation");
  if (!isRecord(validation)) return {};

  const requirements: string[] = [];
  const strict = displayText(validation["Strict"]);
  if (strict) requirements.push(ownValue(STRICT_TYPE_LABELS, strict) ?? `Strict data type: ${strict}`);
  if (attr(validation, "notEmpty") === "True") requirements.push("Not empty");
  if (attr(validation, "unique") === "True") requirements.push("Unique");
  if (attr(validation, "existing") === "True") requirements.push("Existing value");
  // Newer exports write a `maxLength` attribute, FM 22 a <MaximumSize> element;
  // for a container field the limit is in kilobytes.
  const maxLength = attr(validation, "maxLength") ?? displayText(validation["MaximumSize"]);
  if (maxLength) {
    const unit = attr(fieldNode, "datatype") === "Binary" ? "KB" : maxLength === "1" ? "character" : "characters";
    requirements.push(`Max ${maxLength} ${unit}`);
  }
  // A deleted value list stays referenced, as id -1 with an empty name.
  const valueListRef = child(validation, "ValueListReference");
  if (valueListRef != null) requirements.push(`In value list “${textAttr(valueListRef, "name") || UNKNOWN_TARGET}”`);
  const range = child(validation, "Range");
  if (range != null) {
    const from = textAttr(range, "from");
    const to = textAttr(range, "to");
    requirements.push(from != null && to != null ? `In range ${from} to ${to}` : "In range");
  }
  // Validation by calculation: <Calculated><Calculation>, left in place with
  // enable="False" when the option is switched off.
  const calculated = child(validation, "Calculated");
  const isCalculated = isValidationOptionActive(calculated);
  if (isCalculated) requirements.push("By calculation");
  if (requirements.length === 0) return {};

  const formula = isCalculated ? calcOf(calculated) : "";
  const message = validationMessage(validation);
  return {
    validation: requirements.join(", "),
    ...(formula ? { validationCalculation: formula } : {}),
    ...(message ? { validationMessage: message } : {}),
    validateWhen: attr(validation, "type") === "Always" ? "Always" : "Only during data entry",
    validationOverride: attr(validation, "allowOverride") === "True" ? "User can override" : "Strict (no override)",
  };
}

/**
 * The custom message shown when validation fails. FM 26 writes it as a
 * calculation (<MessageCalc>, enable="False" when the option is off) or as
 * <Message> text; FM 22 writes both, with no `enable`. Prefer the calculation.
 */
function validationMessage(validation: Record<string, unknown>): string {
  const messageCalc = child(validation, "MessageCalc");
  if (isRecord(messageCalc)) {
    return isValidationOptionActive(messageCalc) ? calcOf(messageCalc) : "";
  }
  return displayText(validation["Message"]);
}
