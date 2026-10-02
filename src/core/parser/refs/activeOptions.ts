import { asArray, attr, isRecord, withoutKey } from "../xmlUtils";

/**
 * Switched-off auto-enter options (a calc or lookup) and validation calcs stay
 * in the XML — FileMaker even leaves a disabled lookup's references in place
 * after its source relationship is deleted. They're dead configuration, so the
 * scanners only look at what's in effect.
 */

/** Whether an auto-enter option element is in effect. FileMaker 26 marks each
 * one enable="True|False"; older exports don't, so fall back to the AutoEnter's
 * own `type` (the option it's set to). */
function autoEnterOptionActive(option: unknown, autoEnterType: string | undefined, forType: string): boolean {
  const enable = attr(asArray(option)[0], "enable");
  return enable != null ? enable !== "False" : autoEnterType === forType;
}

/** An <AutoEnter> without its switched-off calc / lookup (the same node when
 * nothing is dropped). */
export function activeAutoEnter(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const type = attr(node, "type");
  const dropCalc = node["Calculated"] != null && !autoEnterOptionActive(node["Calculated"], type, "Calculated");
  const dropLookup = node["Looked_up"] != null && !autoEnterOptionActive(node["Looked_up"], type, "Looked_up");
  if (!dropCalc && !dropLookup) return node;
  const withoutCalc = dropCalc ? withoutKey(node, "Calculated") : node;
  return dropLookup ? withoutKey(withoutCalc, "Looked_up") : withoutCalc;
}

/** A <Validation> without a validation-by-calculation or custom-message
 * calculation that's switched off (the same node when neither is). */
export function activeValidation(node: unknown): unknown {
  if (!isRecord(node)) return node;
  return ["Calculated", "MessageCalc"].reduce(
    (active, key) => (attr(asArray(active[key])[0], "enable") === "False" ? withoutKey(active, key) : active),
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
