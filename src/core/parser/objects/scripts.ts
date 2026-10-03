import type { FmObject } from "@/types/ddr";
import type { FileParse, StepTexts, TextScan } from "../context";
import { attr, cdataText, child, children, isRecord, textAttr } from "../xmlUtils";
import { collectOrderedWithFolders, firstBlockByOwner } from "../catalogWalk";
import { stepNodes } from "../steps";
import { scanRefs } from "../refs/scanRefs";
import { makeObject, placeInCatalog } from "./catalogItems";
import { scriptSteps, stepTextNamesStep } from "./stepText";

/**
 * Scripts come from ScriptCatalog (in workspace order, with folders and
 * separator items); their steps live in a separate StepsForScripts section,
 * each block keyed to its script by a leading <ScriptReference>.
 */
export function parseScripts(fp: FileParse, containerNode: Record<string, unknown>, scans: TextScan[]): void {
  const stepBlocks = firstBlockByOwner(children(containerNode["StepsForScripts"], "Script"), "ScriptReference");
  let order = 0;
  const scriptsWithSteps = new Set<string>();
  for (const { node, folder } of collectOrderedWithFolders(containerNode["ScriptCatalog"], "Script")) {
    const base = makeObject(fp, node, "script");
    if (!base) continue;
    const placed = placeInCatalog(base, order++, folder);
    if (placed.isSeparator) {
      fp.objects.push(placed);
      scans.push({ obj: placed, text: cdataText(node) });
      continue;
    }
    const block = stepBlocks.get(placed.id);
    if (block) scriptsWithSteps.add(placed.id);
    const script = annotateScript(node, placed);
    // The steps' references: only the steps (ObjectList), not the block's
    // leading binding reference. (scanRefs also recovers the targets FileMaker
    // records only in a step's rendered text — see addStepTargetRefs.)
    if (block) scanRefs(fp, block["ObjectList"], script);
    const obj = block ? withSteps(script, block["ObjectList"], fp.index.stepTexts) : script;
    fp.objects.push(obj);
    // A script with steps is read per step (its rendered text), not by this text.
    scans.push({ obj, text: cdataText(node) });
  }
  const orphans = stepBlocks.size - scriptsWithSteps.size;
  if (orphans > 0) {
    const what = orphans === 1 ? "1 script that isn't in its script catalog were" : `${orphans} scripts that aren't in its script catalog were`;
    fp.errors.push(`${fp.file.source}: the steps of ${what} left out.`);
  }
  warnIfStepTextNotEnglish(fp, stepBlocks.values());
}

/** How many steps with rendered text warnIfStepTextNotEnglish reads: plenty
 * to tell the language of a file's step text. */
const LANGUAGE_SAMPLE_STEPS = 200;

/** Fewer steps with rendered text than this say nothing about its language. */
const LANGUAGE_MIN_STEPS = 10;

/**
 * The checks that read FileMaker's rendered step text go by its English
 * wording (`from file:`, `Using layout:`, the step's name), as in every sample.
 * A file exported by a FileMaker in another language would leave the deleted
 * scripts and layouts that text shows unflagged without a word — so warn when
 * most of a file's steps don't start with their name.
 */
function warnIfStepTextNotEnglish(fp: FileParse, blocks: Iterable<Record<string, unknown>>): void {
  let checked = 0;
  let named = 0;
  for (const block of blocks) {
    for (const step of stepNodes(block["ObjectList"])) {
      const namesStep = stepTextNamesStep(step, textAttr(step, "name") ?? "", fp.index.stepTexts);
      if (namesStep == null) continue;
      checked++;
      if (namesStep) named++;
      if (checked === LANGUAGE_SAMPLE_STEPS) break;
    }
    if (checked === LANGUAGE_SAMPLE_STEPS) break;
  }
  if (checked < LANGUAGE_MIN_STEPS || named * 2 >= checked) return;
  fp.errors.push(
    `${fp.file.source}: its script steps are written in a language other than English, which this app can't read — deleted scripts and layouts that only the steps' text shows (and calls into files that weren't open) aren't flagged.`,
  );
}

/** A script with its steps: their rendered text appended to its searchable
 * text, and the step list as its detail. */
function withSteps(script: FmObject, steps: unknown, stepTexts: StepTexts): FmObject {
  // The text is built from FileMaker's pre-rendered StepText (per step,
  // joined by newlines) rather than displayText(steps): the formatted text
  // has real delimiters (`;`, `[`, `]`, …), so search and the placeholder
  // passes see readable steps instead of the raw parameter tree.
  const stepList = scriptSteps(steps, stepTexts);
  const stepText = stepList.map((s) => (s.params ? `${s.name} ${s.params}` : s.name)).join("\n");
  return { ...script, text: script.text ? `${script.text}\n${stepText}` : stepText, detail: { kind: "script", steps: stepList } };
}

/** Surface script run options nested under <Options> (e.g. "run with full
 * access"), which aren't attributes on the <Script> element. */
function annotateScript(node: unknown, obj: FmObject): FmObject {
  if (!isRecord(node)) return obj;
  const options = child(node, "Options");
  const a: Record<string, string> = {};
  if (attr(options, "runwithfullaccess") === "True") a.runsWithFullAccess = "Yes";
  // hidden="True" means the script is left out of the Scripts menu.
  if (attr(options, "hidden") === "True") a.includeInMenu = "No";
  const access = attr(options, "access");
  if (access) a.scriptAccess = access;
  const compatibility = attr(options, "compatibility");
  if (compatibility && compatibility !== "0") a.compatibility = compatibility;
  if (attr(options, "SiriShortcutVisible") === "True") a.siriShortcut = "Visible";
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}
