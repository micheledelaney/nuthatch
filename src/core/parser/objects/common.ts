import type { LayoutTriggerInfo } from "@/types/ddr";
import { asArray, attr, child, children, collectText, enabledLabels, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";

/** Calculation text from a <Calculation> node (the formula lives in <Text>; FM 21
 * sometimes writes it as the node's own text, which the XML parser gives as a
 * string). Not entity-decoded: see decodeEntities' policy. */
export function calculationText(calc: unknown): string {
  if (typeof calc === "string") return calc.trim();
  if (!isRecord(calc)) return "";
  return (collectText(calc["Text"]) || collectText(calc)).trim();
}

/** A "TableOccurrence::Field" label from a <FieldReference> (with its nested TO).
 * A deleted field can leave <FieldReference> in place with the TO still named
 * but its own `name` attribute empty — flag it the way a broken reference reads
 * anywhere else in the app. "" when there's no <FieldReference> at all. */
export function qualifiedField(wrapper: unknown): string {
  const ref = asArray(wrapper)[0];
  if (!isRecord(ref)) return "";
  const to = decodeEntities(attr(child(ref, "TableOccurrenceReference"), "name") ?? "");
  const field = decodeEntities(attr(ref, "name") ?? "");
  if (field) return to ? `${to}::${field}` : field;
  return to ? `${to}::${MISSING_FIELD_TOKEN}` : MISSING_FIELD_TOKEN;
}

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
    const parameterFieldName = attr(trigger, "scriptParameterFieldName");
    out.push({
      action: attr(trigger, "action") ?? "ScriptTrigger",
      id: attr(trigger, "id"),
      // A trigger whose script was deleted keeps its event but loses the <ScriptReference>.
      scriptName: decodeEntities(attr(script, "name") ?? "") || UNKNOWN_TARGET,
      scriptId: attr(script, "id"),
      scriptUuid: attr(script, "UUID"),
      modes: enabledLabels(trigger, TRIGGER_MODES),
      ...(parameter ? { parameter } : {}),
      ...(parameterFieldName ? { parameterFieldName: decodeEntities(parameterFieldName) } : {}),
    });
  }
  return out;
}
