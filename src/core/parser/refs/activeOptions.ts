/**
 * Switched-off auto-enter options (a calc or lookup) and validation calcs stay
 * in the XML — FileMaker even leaves a disabled lookup's references in place
 * after its source relationship is deleted. They're dead configuration, so the
 * scanners only look at what's in effect.
 */

import { asArray, attr, isRecord, withoutKey } from "../xmlUtils";

/** Whether an <AutoEnter>'s calculated value / looked-up value is in effect.
 * FileMaker 26 marks each option enable="True|False" — and several can be on at
 * once (a Data value with a Calculated value over it); older exports don't
 * mark them, so fall back to the AutoEnter's own `type` (the option it's set
 * to). The scan and the field's inspector both go by this. */
export function isAutoEnterOptionActive(autoEnter: unknown, option: "Calculated" | "Looked_up"): boolean {
  if (!isRecord(autoEnter) || autoEnter[option] == null) return false;
  const enable = attr(asArray(autoEnter[option])[0], "enable");
  return enable != null ? enable !== "False" : attr(autoEnter, "type") === option;
}

/** Whether a validation option element (<Calculated>, <MessageCalc>) is in
 * effect: present, and not marked enable="False" (FM 22 writes no `enable`). */
export function isValidationOptionActive(option: unknown): boolean {
  return isRecord(option) && attr(option, "enable") !== "False";
}

/** An <AutoEnter> without its switched-off calc / lookup (the same node when
 * nothing is dropped). */
function activeAutoEnter(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const dropCalc = node["Calculated"] != null && !isAutoEnterOptionActive(node, "Calculated");
  const dropLookup = node["Looked_up"] != null && !isAutoEnterOptionActive(node, "Looked_up");
  if (!dropCalc && !dropLookup) return node;
  const withoutCalc = dropCalc ? withoutKey(node, "Calculated") : node;
  return dropLookup ? withoutKey(withoutCalc, "Looked_up") : withoutCalc;
}

/** A <Validation> without a validation-by-calculation or custom-message
 * calculation that's switched off (the same node when neither is). */
function activeValidation(node: unknown): unknown {
  if (!isRecord(node)) return node;
  return ["Calculated", "MessageCalc"].reduce(
    (active, key) => (active[key] != null && !isValidationOptionActive(asArray(active[key])[0]) ? withoutKey(active, key) : active),
    node,
  );
}

/** A field element with only its in-effect auto-enter / validation options (the
 * same node when nothing is switched off). */
export function activeFieldNode(field: unknown): unknown {
  if (!isRecord(field)) return field;
  const autoEnter = asArray(field["AutoEnter"]);
  const validation = asArray(field["Validation"]);
  const activeAe = autoEnter.map(activeAutoEnter);
  const activeVal = validation.map(activeValidation);
  const changed = activeAe.some((n, i) => n !== autoEnter[i]) || activeVal.some((n, i) => n !== validation[i]);
  return changed ? { ...field, AutoEnter: activeAe, Validation: activeVal } : field;
}
