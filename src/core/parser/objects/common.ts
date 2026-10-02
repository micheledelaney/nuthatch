import type { LayoutTriggerInfo } from "@/types/ddr";
import type { FileIndex } from "../context";
import { asArray, attr, child, children, displayText, enabledLabels, isRecord, ownText, textAttr } from "../xmlUtils";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";

/** Calculation text from a <Calculation> node. The formula lives in its <Text>,
 * or in a nested <Calculation> (a step parameter's `<Calculation datatype…>`
 * wraps the calc itself); FM 21 sometimes writes it as the node's own CDATA.
 * Not entity-decoded: see decodeEntities' policy. */
export function calculationText(calc: unknown): string {
  if (!isRecord(calc)) return ownText(calc).trim();
  if (calc["Text"] != null) return displayText(calc["Text"]);
  if (calc["Calculation"] != null) return calculationText(child(calc, "Calculation"));
  return ownText(calc).trim();
}

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

/** The field a <FieldReference> names. FileMaker leaves the reference in place
 * with its `name` blank in two cases: the field was deleted — flagged the way
 * a broken reference reads anywhere else in the app — or it sits behind an
 * occurrence whose file wasn't available at export, which proves nothing; that
 * one reads by its id, like any other unnamed object. */
export function fieldRefName(ref: unknown, index: FileIndex): string {
  const name = textAttr(ref, "name");
  if (name) return name;
  const toId = attr(child(ref, "TableOccurrenceReference"), "id");
  const unverifiable = toId != null && index.toById.get(toId)?.unresolved === true;
  return unverifiable ? `(field ${attr(ref, "id") ?? "?"})` : MISSING_FIELD_TOKEN;
}

/** Strip a single layer of surrounding double-quotes (FileMaker wraps static
 * labels like `"Tab Name"` in quotes in the Calculation text, and a button's
 * label is shown quoted). */
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
