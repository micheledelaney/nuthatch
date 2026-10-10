import type { FieldTarget, LayoutChoice, StepIr } from "@/types/ddr";
import { calculationText } from "../calcText";
import { ownValue } from "../ownValue";
import { isPasswordParameterType, withoutPasswordText } from "../passwords";
import { stepNodes } from "../steps";
import { asArray, attr, child, children, isElementKey, isRecord, textAttr } from "../xmlUtils";

const LAYOUT_CHOICES: Readonly<Record<string, LayoutChoice>> = { "0": "none", "1": "original", "5": "specified" };

/** Steps that name a field they only read (Write to Data File's "Target" is
 * its data source), or whose target the Set Field check reads from its
 * setField reference: no fieldTargets. */
const NOT_FIELD_TARGETS: ReadonlySet<string> = new Set(["Set Field", "Copy", "Export Field Contents", "Sort Records by Field", "Install Plug-In File", "Write to Data File"]);

/** Steps that pick a layout (see LayoutChoice). */
const LAYOUT_STEPS: ReadonlySet<string> = new Set(["Go to Layout", "New Window", "Go to Related Record"]);

/** The typed steps of a step list (a script's <ObjectList>), in order. */
export function stepIrs(container: unknown): StepIr[] {
  return stepNodes(container).map((step, i) => stepIr(step, i + 1));
}

function stepIr(step: Record<string, unknown>, index: number): StepIr {
  const name = textAttr(step, "name") ?? "(step)";
  const params = step["ParameterValues"];
  const setsVariable = writtenVariable(params);
  const inputs = name === "Show Custom Dialog" ? inputVariables(params) : [];
  const targets = NOT_FIELD_TARGETS.has(name) ? [] : fieldTargets(params);
  const layoutChoice = LAYOUT_STEPS.has(name) ? layoutChoiceOf(params) : undefined;
  const parameter = name.startsWith("Perform Script") ? parameterFormula(params) : undefined;
  const flags = booleanFlags(params);
  return {
    index,
    name,
    enabled: (attr(step, "enable") ?? "True") !== "False",
    calcs: stepFormulas(params),
    ...(setsVariable ? { setsVariable } : {}),
    ...(inputs.length > 0 ? { inputVariables: inputs } : {}),
    ...(targets.length > 0 ? { fieldTargets: targets } : {}),
    ...(layoutChoice ? { layoutChoice } : {}),
    ...(parameter ? { parameter } : {}),
    ...(flags ? { flags } : {}),
  };
}

/** Every formula under `node`: a <Calculation>'s once (not again for the
 * <Calculation> nested in it), a password's without its typed text — under a
 * `<Parameter type="Password">` or a `<Password>`, as in the step's text. */
function stepFormulas(node: unknown, out: string[] = [], inPassword = false): string[] {
  for (const item of asArray(node)) {
    if (!isRecord(item)) continue;
    const isPassword = inPassword || isPasswordParameterType(attr(item, "type"));
    for (const [key, value] of Object.entries(item)) {
      if (!isElementKey(key)) continue;
      if (key !== "Calculation") {
        stepFormulas(value, out, isPassword || key === "Password");
        continue;
      }
      for (const calc of asArray(value)) {
        const formula = calculationText(calc);
        if (formula) out.push(isPassword ? withoutPasswordText(formula, [formula]) : formula);
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

/** Show Custom Dialog's input fields that write a variable: a
 * <Parameter type="Field1"> (to Field3) holding a target's Parameter. */
function inputVariables(params: unknown): string[] {
  return children(params, "Parameter")
    .filter((param) => /^Field\d$/.test(attr(param, "type") ?? ""))
    .flatMap((param) => writtenVariable(param) ?? []);
}

/** The fields a step names in its own parameter: a <Parameter
 * type="FieldReference"> (Go to Field, Replace Field Contents, Paste …) or
 * type="Target"> (Insert Text, Insert from URL …), or a Show Custom Dialog
 * input's target (<Parameter type="Field1"> to Field3). */
function fieldTargets(params: unknown): FieldTarget[] {
  const out: FieldTarget[] = [];
  for (const param of children(params, "Parameter")) {
    const type = attr(param, "type") ?? "";
    const holder = type === "FieldReference" || type === "Target" ? param : /^Field\d$/.test(type) ? child(param, "Parameter") : undefined;
    const ref = child(holder, "FieldReference");
    const field = attr(ref, "id");
    const occurrence = attr(child(ref, "TableOccurrenceReference"), "id");
    if (field && occurrence) out.push({ field, occurrence });
  }
  return out;
}

/** The step's <LayoutReferenceContainer value>: in its parameter, or New
 * Window's in the parameter's <WindowReference>. */
function layoutChoiceOf(params: unknown): LayoutChoice {
  for (const param of children(params, "Parameter")) {
    const container = child(param, "LayoutReferenceContainer") ?? child(child(param, "WindowReference"), "LayoutReferenceContainer");
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
