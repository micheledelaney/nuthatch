import type { ScriptStep } from "@/types/ddr";
import type { StepTexts } from "../context";
import { INSERT_TEXT_STEP, isCommentStep, renderedStepText, stepNodes } from "../steps";
import { attr, child, children, isElementKey, isRecord, textAttr } from "../xmlUtils";
import { charForCode, decodeEntities } from "../entities";
import { formulasUnder } from "../calcText";
import { isPasswordParameterType, withoutPasswordText } from "../passwords";

const PSOS_STEP = "Perform Script on Server";

/** Build the ordered step list shown in a script's inspector, and each step's
 * rendered parameters (renderedParams, "" for a step without), by position. */
export function scriptSteps(stepsContainer: unknown, stepTexts: StepTexts): { steps: ScriptStep[]; rendered: string[] } {
  const nodes = stepNodes(stepsContainer);
  const names = nodes.map((step) => textAttr(step, "name") ?? "(step)");
  const rendered = nodes.map((step, i) => renderedParams(step, names[i]!, stepTexts));
  const steps = nodes.map((step, i) => ({
    index: i + 1,
    name: names[i]!,
    enabled: (attr(step, "enable") ?? "True") !== "False",
    params: displayParams(step, names[i]!, rendered[i]),
  }));
  return { steps, rendered: rendered.map((params) => params ?? "") };
}

/** The step's display parameters: its rendered parameters (renderedParams)
 * without their passwords, plus what FileMaker's rendering leaves out. */
export function stepParams(step: Record<string, unknown>, name: string, stepTexts: StepTexts): string {
  return displayParams(step, name, renderedParams(step, name, stepTexts));
}

/** The rendered parameters (renderedParams) of an action's steps — a button's
 * or a custom menu item's — comment steps left out: what the text-based
 * passes read of the action, as of a script's steps. */
export function actionScanTexts(steps: readonly Record<string, unknown>[], stepTexts: StepTexts): string[] {
  return steps.flatMap((step) => {
    const name = textAttr(step, "name") ?? "";
    return isCommentStep(name) ? [] : [renderedParams(step, name, stepTexts) ?? ""];
  });
}

/** The rendered parameters without their passwords' typed text
 * (withoutPasswordText). Insert Text omits the text value from StepText —
 * append it from ParameterValues. It's typed text, so only for display: the
 * text-based passes read renderedParams. Perform Script on Server's StepText
 * says "[ Wait for completion ]" when it waits and nothing when it doesn't —
 * append the off state. */
function displayParams(step: Record<string, unknown>, name: string, rendered: string | undefined): string {
  if (rendered == null) return "";
  const shown = withoutPasswordText(rendered, passwordFormulas(step["ParameterValues"]));
  const text = name === INSERT_TEXT_STEP ? insertTextValue(step) : undefined;
  const added = text ? `[ Text: "${text}" ]` : name === PSOS_STEP && doesNotWait(step) ? "[ Wait for completion: Off ]" : undefined;
  if (!added) return shown;
  return shown ? `${shown} ${added}` : added;
}

/**
 * The step's parameters as FileMaker rendered them, taken from its
 * pre-rendered <DDR_INFO><Script><ObjectList> StepText (located via the step's
 * <DDRREF kind="StepText"> pointer); undefined when it has none. The step name
 * is already rendered into that text, so strip the leading "Name " (or "# "
 * for comment steps) — the UI shows the name separately. CR/LF in the source
 * (e.g. between Import Records field mappings, or between a multi-bracket
 * step's bracket groups) are kept as newlines so the rendered step preserves
 * FileMaker's layout.
 */
function renderedParams(step: Record<string, unknown>, name: string, stepTexts: StepTexts): string | undefined {
  const raw = renderedStepText(stepTexts, step);
  if (raw == null) return undefined;
  // Normalise the raw StepText into just the bracketed parameters:
  //   1. CR/LF entities → real newlines (decodeEntities would otherwise collapse
  //      them to spaces, flattening Import Records' per-mapping layout).
  //   2. Decode the rest of the entities (curly quotes, &quot;, &amp; …).
  //      (Both are decodeEntities with keepLineBreaks.)
  //   3. Drop a leading `// ` — FileMaker prefixes a disabled step's StepText
  //      with this, but the line already wears the `disabled` class.
  //   4. Drop the step name prefix (or `#` for comments) — ScriptWorkspace
  //      renders the name in a separate span next to params.
  //   5. Collapse newlines that sit *between* bracket groups to a single
  //      space, so steps like `Adjust Window\n[ Resize to fit ]` and
  //      `Go to Related Record [ … ]\n[ Show only related records ]` render
  //      on one line. Newlines INSIDE brackets (Import/Export's per-mapping
  //      layout) survive — the depth tracker only flattens at depth 0.
  const undisabled = renderedStepBody(raw);
  const stripped = name.startsWith("#")
    ? undisabled.replace(/^#\s*/, "")
    : undisabled.startsWith(name)
      ? undisabled.slice(name.length).replace(/^\s+/, "")
      : undisabled;
  return flattenNewlinesOutsideBrackets(stripped);
}

/** Whether a step's rendered text starts with its name (`#`, for a comment),
 * as an English FileMaker writes it; undefined when it has none (an empty
 * comment line renders as nothing at all). */
export function stepTextNamesStep(step: Record<string, unknown>, name: string, stepTexts: StepTexts): boolean | undefined {
  const raw = renderedStepText(stepTexts, step);
  const body = raw == null ? "" : renderedStepBody(raw);
  return body ? body.startsWith(name.startsWith("#") ? "#" : name) : undefined;
}

/** Rendered step text decoded, with CR/LF as newlines, and without the `// `
 * FileMaker puts before a disabled step's (steps 1–3 of stepParams). */
function renderedStepBody(raw: string): string {
  return decodeEntities(raw, true).trim().replace(/^\/\/\s*/, "");
}

/** Decode FileMaker's {{charN}} attribute encoding to the actual character. */
function decodeFmChars(s: string): string {
  return s.replace(/{{char(\d+)}}/g, (_, n: string) => charForCode(parseInt(n, 10), true) ?? "");
}

/** The formulas of a step's passwords: under a `<Parameter type="Password">`
 * (Re-Login's, Add Account's …) or a `<Password>` (Send Mail's SMTP one). */
function passwordFormulas(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) passwordFormulas(item, out);
    return out;
  }
  if (!isRecord(node)) return out;
  if (isPasswordParameterType(attr(node, "type"))) return formulasUnder(node, out);
  for (const [key, value] of Object.entries(node)) {
    if (!isElementKey(key)) continue;
    if (key === "Password") formulasUnder(value, out);
    else passwordFormulas(value, out);
  }
  return out;
}

/** Whether a step's <Boolean type="Wait for completion"> is set to False. */
function doesNotWait(step: Record<string, unknown>): boolean {
  return children(child(step, "ParameterValues"), "Parameter")
    .filter((param) => attr(param, "type") === "Boolean")
    .flatMap((param) => children(param, "Boolean"))
    .some((el) => textAttr(el, "type") === "Wait for completion" && attr(el, "value") === "False");
}

/** Extract the literal text value from an Insert Text step's ParameterValues. */
function insertTextValue(step: Record<string, unknown>): string | undefined {
  for (const param of children(child(step, "ParameterValues"), "Parameter")) {
    if (!isRecord(param) || attr(param, "type") !== "Text") continue;
    const textEl = child(param, "Text");
    if (!isRecord(textEl)) continue;
    const raw = attr(textEl, "value");
    return raw == null ? undefined : decodeFmChars(decodeEntities(raw, true));
  }
  return undefined;
}

/** Replace newlines (and surrounding whitespace) with a single space whenever
 * they sit at bracket depth 0 — i.e. between `]` and the next `[`, or before
 * the first `[`. Newlines inside `[ … ]` survive, so Import / Export Records'
 * per-mapping layout is preserved. Joined once at the end: a string built a
 * character at a time is a rope as long as nothing reads it, and the step
 * list keeps it — several times the memory of the text. */
function flattenNewlinesOutsideBrackets(text: string): string {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "[") {
      depth++;
      out.push(c);
      continue;
    }
    if (c === "]") {
      depth = Math.max(0, depth - 1);
      out.push(c);
      continue;
    }
    if (depth === 0 && (c === "\n" || c === "\r")) {
      // Collapse a run of whitespace including the newline into one space.
      while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++;
      if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
      continue;
    }
    out.push(c);
  }
  return out.join("");
}
