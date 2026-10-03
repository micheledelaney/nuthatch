import type { ScriptStep } from "@/types/ddr";
import type { StepTexts } from "../context";
import { INSERT_TEXT_STEP, renderedStepText, stepNodes } from "../steps";
import { attr, child, children, isRecord, textAttr } from "../xmlUtils";
import { charForCode, decodeEntities } from "../entities";

/** Build the ordered step list shown in a script's inspector. */
export function scriptSteps(stepsContainer: unknown, stepTexts: StepTexts): ScriptStep[] {
  return stepNodes(stepsContainer).map((step, i) => {
    const name = textAttr(step, "name") ?? "(step)";
    return {
      index: i + 1,
      name,
      enabled: (attr(step, "enable") ?? "True") !== "False",
      params: stepParams(step, name, stepTexts),
    };
  });
}

/**
 * The step's display parameters, taken from FileMaker's pre-rendered
 * <DDR_INFO><Script><ObjectList> StepText (located via the step's
 * <DDRREF kind="StepText"> pointer). The step name is already rendered into
 * that text, so strip the leading "Name " (or "# " for comment steps) — the UI
 * shows the name separately. CR/LF in the source (e.g. between Import Records
 * field mappings, or between a multi-bracket step's bracket groups) are kept
 * as newlines so the rendered step preserves FileMaker's layout.
 */
export function stepParams(step: Record<string, unknown>, name: string, stepTexts: StepTexts): string {
  const raw = renderedStepText(stepTexts, step);
  if (raw == null) return "";
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
  const base = flattenNewlinesOutsideBrackets(stripped);

  // Insert Text omits the text value from StepText — append it from ParameterValues.
  if (name === INSERT_TEXT_STEP) {
    const text = insertTextValue(step);
    if (text) return base ? `${base} [ Text: "${text}" ]` : `[ Text: "${text}" ]`;
  }
  return base;
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
 * per-mapping layout is preserved. */
function flattenNewlinesOutsideBrackets(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[") {
      depth++;
      out += c;
      continue;
    }
    if (c === "]") {
      depth = Math.max(0, depth - 1);
      out += c;
      continue;
    }
    if (depth === 0 && (c === "\n" || c === "\r")) {
      // Collapse a run of whitespace including the newline into one space.
      while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++;
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
      continue;
    }
    out += c;
  }
  return out;
}
