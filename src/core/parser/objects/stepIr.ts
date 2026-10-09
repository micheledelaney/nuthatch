import type { LayoutChoice, StepIr } from "@/types/ddr";
import { calculationText } from "../calcText";
import { ownValue } from "../ownValue";
import { isPasswordParameterType } from "../passwords";
import { stepNodes } from "../steps";
import { asArray, attr, child, children, isElementKey, isRecord, textAttr } from "../xmlUtils";

const LAYOUT_CHOICES: Readonly<Record<string, LayoutChoice>> = { "1": "original", "5": "specified" };

/** The typed steps of a step list (a script's <ObjectList>), in order. */
export function stepIrs(container: unknown): StepIr[] {
  return stepNodes(container).map((step, i) => stepIr(step, i + 1));
}

function stepIr(step: Record<string, unknown>, index: number): StepIr {
  const name = textAttr(step, "name") ?? "(step)";
  const params = step["ParameterValues"];
  const setsVariable = writtenVariable(params);
  const layoutChoice = name === "Go to Layout" ? goToLayoutChoice(params) : undefined;
  const parameter = name.startsWith("Perform Script") ? parameterFormula(params) : undefined;
  const flags = booleanFlags(params);
  return {
    index,
    name,
    enabled: (attr(step, "enable") ?? "True") !== "False",
    calcs: stepFormulas(params),
    ...(setsVariable ? { setsVariable } : {}),
    ...(layoutChoice ? { layoutChoice } : {}),
    ...(parameter ? { parameter } : {}),
    ...(flags ? { flags } : {}),
  };
}

/** Every formula under `node`: a <Calculation>'s once (not again for the
 * <Calculation> nested in it), none of a password's. */
function stepFormulas(node: unknown, out: string[] = []): string[] {
  for (const item of asArray(node)) {
    if (!isRecord(item) || isPasswordParameterType(attr(item, "type"))) continue;
    for (const [key, value] of Object.entries(item)) {
      if (!isElementKey(key) || key === "Password") continue;
      if (key !== "Calculation") {
        stepFormulas(value, out);
        continue;
      }
      for (const calc of asArray(value)) {
        const formula = calculationText(calc);
        if (formula) out.push(formula);
      }
    }
  }
  return out;
}

/** Set Variable's <Parameter type="Variable"><Name value>, or a target's
 * <Variable value>. */
function writtenVariable(params: unknown): string | undefined {
  for (const param of children(params, "Parameter")) {
    const type = attr(param, "type");
    const el = type === "Variable" ? child(param, "Name") : type === "Target" ? child(param, "Variable") : undefined;
    const name = textAttr(el, "value")?.trim();
    if (name?.startsWith("$")) return name;
  }
  return undefined;
}

function goToLayoutChoice(params: unknown): LayoutChoice {
  for (const param of children(params, "Parameter")) {
    const container = child(param, "LayoutReferenceContainer");
    if (container != null) return ownValue(LAYOUT_CHOICES, attr(container, "value")) ?? "calculated";
  }
  return "calculated";
}

/** The formula of a Perform Script step's <Parameter type="Parameter">. */
function parameterFormula(params: unknown): string | undefined {
  const param = children(params, "Parameter").find((p) => attr(p, "type") === "Parameter");
  return param == null ? undefined : stepFormulas(param)[0];
}

/** The step's <Parameter type="Boolean"><Boolean type value> options; undefined
 * when it has none. */
function booleanFlags(params: unknown): Record<string, boolean> | undefined {
  const entries = children(params, "Parameter")
    .filter((param) => attr(param, "type") === "Boolean")
    .flatMap((param) => children(param, "Boolean"))
    .map((el) => [textAttr(el, "type") ?? "", attr(el, "value") === "True"] as const)
    .filter(([type]) => type !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
