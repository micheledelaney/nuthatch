import type { LayoutTriggerInfo, SortField } from "@/types/ddr";
import type { FileIndex } from "../context";
import { asArray, attr, child, children, enabledLabels, isRecord, textAttr } from "../xmlUtils";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { calculationText } from "../calcText";

/** The formula of a node's <Calculation> child, "" when it has none. */
export function calcOf(node: unknown): string {
  return isRecord(node) ? calculationText(child(node, "Calculation")) : "";
}

/** A "TableOccurrence::Field" label from a <FieldReference> (with its nested TO),
 * "" when there's no <FieldReference> at all. See fieldRefName for a field
 * whose name FileMaker left blank. */
export function qualifiedField(wrapper: unknown, index: FileIndex): string {
  const ref = asArray(wrapper)[0];
  if (!isRecord(ref)) return "";
  const to = textAttr(child(ref, "TableOccurrenceReference"), "name") ?? "";
  const field = fieldRefName(ref, index);
  return to ? `${to}::${field}` : field;
}

/** The fields a <SortSpecification> sorts by, in order; none when its "Sort
 * records" box is off (FileMaker then writes no list). */
export function sortFields(spec: unknown, index: FileIndex): SortField[] {
  if (attr(spec, "value") !== "True") return [];
  return children(child(spec, "SortList"), "Sort")
    .filter(isRecord)
    .map((sort) => {
      const valueList = textAttr(child(sort, "ValueListReference"), "name");
      const summaryField = qualifiedField(child(child(sort, "SummaryField"), "FieldReference"), index);
      return {
        field: qualifiedField(child(child(sort, "PrimaryField"), "FieldReference"), index),
        order: attr(sort, "type") ?? "Ascending",
        ...(valueList ? { valueList } : {}),
        ...(summaryField ? { summaryField } : {}),
      };
    });
}

/** What a <FieldReference> says about its field. FileMaker leaves the reference
 * in place with its `name` blank in two cases: the field was deleted, or it
 * sits behind an occurrence whose file wasn't available at export, which
 * proves nothing. */
export type FieldRefState = "named" | "deleted" | "unverifiable";

export function fieldRefState(ref: unknown, index: FileIndex): FieldRefState {
  if (textAttr(ref, "name")) return "named";
  const toId = attr(child(ref, "TableOccurrenceReference"), "id");
  return toId != null && index.toById.get(toId)?.unresolved === true ? "unverifiable" : "deleted";
}

/** The field a <FieldReference> names (see fieldRefState): a deleted one is
 * flagged the way a broken reference reads anywhere else in the app; an
 * unverifiable one reads by its id, like any other unnamed object. */
export function fieldRefName(ref: unknown, index: FileIndex): string {
  const state = fieldRefState(ref, index);
  if (state === "named") return textAttr(ref, "name") ?? "";
  return state === "unverifiable" ? `(field ${attr(ref, "id") ?? "?"})` : MISSING_FIELD_TOKEN;
}

/** A button's label without the quotes it's shown in (see behaviorLine). A
 * formula's static text is literalText's to read: a computed formula can start
 * and end with a quote too. */
export function stripOuterQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length > 2 ? s.slice(1, -1) : s;
}

/** The layout-object elements that carry a button's <action> (a Group and a
 * Grouped Button share <GroupedButton>), in the order they're checked. */
export const BUTTON_ACTION_TAGS = ["Button", "GroupedButton"] as const;

const TRIGGER_MODES: ReadonlyArray<readonly [string, string]> = [
  ["browseMode", "Browse"],
  ["findMode", "Find"],
  ["previewMode", "Preview"],
];

/** Script triggers from a <ScriptTriggers> container — layout-level
 * (OnLayoutEnter, OnRecordLoad, …), object-level, or file-level
 * (OnFirstWindowOpen, …); the element shape is identical. */
export function scriptTriggers(container: unknown): LayoutTriggerInfo[] {
  const out: LayoutTriggerInfo[] = [];
  for (const trigger of children(container, "ScriptTrigger")) {
    if (!isRecord(trigger)) continue;
    const script = child(trigger, "ScriptReference");
    const parameter = calcOf(script);
    const parameterFieldName = textAttr(trigger, "scriptParameterFieldName");
    out.push({
      action: attr(trigger, "action") ?? "ScriptTrigger",
      id: attr(trigger, "id"),
      // A trigger whose script was deleted keeps its event but loses the <ScriptReference>.
      scriptName: textAttr(script, "name") || UNKNOWN_TARGET,
      scriptId: attr(script, "id"),
      scriptUuid: attr(script, "UUID"),
      modes: enabledLabels(trigger, TRIGGER_MODES),
      ...(parameter ? { parameter } : {}),
      ...(parameterFieldName ? { parameterFieldName } : {}),
    });
  }
  return out;
}
