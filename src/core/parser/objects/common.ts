import type { LayoutTriggerInfo } from "@/types/ddr";
import { asArray, attr, child, children, collectText, enabledLabels, isRecord, ownText, textAttr } from "../xmlUtils";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";

/** Calculation text from a <Calculation> node. The formula lives in its <Text>,
 * or in a nested <Calculation> (a step parameter's `<Calculation datatype…>`
 * wraps the calc itself); FM 21 sometimes writes it as the node's own CDATA.
 * Not entity-decoded: see decodeEntities' policy. */
export function calculationText(calc: unknown): string {
  if (!isRecord(calc)) return ownText(calc).trim();
  if (calc["Text"] != null) return collectText(calc["Text"]).trim();
  if (calc["Calculation"] != null) return calculationText(child(calc, "Calculation"));
  return ownText(calc).trim();
}

/** A "TableOccurrence::Field" label from a <FieldReference> (with its nested TO).
 * A deleted field can leave <FieldReference> in place with the TO still named
 * but its own `name` attribute empty — flag it the way a broken reference reads
 * anywhere else in the app. "" when there's no <FieldReference> at all. */
export function qualifiedField(wrapper: unknown): string {
  const ref = asArray(wrapper)[0];
  if (!isRecord(ref)) return "";
  const to = textAttr(child(ref, "TableOccurrenceReference"), "name") ?? "";
  const field = textAttr(ref, "name") ?? "";
  if (field) return to ? `${to}::${field}` : field;
  return to ? `${to}::${MISSING_FIELD_TOKEN}` : MISSING_FIELD_TOKEN;
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
    const parameter = isRecord(script) ? calculationText(script["Calculation"]) : "";
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
