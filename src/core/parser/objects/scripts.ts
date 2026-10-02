import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, children, isRecord } from "../xmlUtils";
import { collectOrderedWithFolders, firstBlockByOwner } from "../catalogWalk";
import { scanRefs } from "../refs/scanRefs";
import { makeObject, placeInCatalog } from "./catalogItems";
import { scriptSteps } from "./stepText";

/**
 * Scripts come from ScriptCatalog (in workspace order, with folders and
 * separator items); their steps live in a separate StepsForScripts section,
 * each block keyed to its script by a leading <ScriptReference>.
 */
export function parseScripts(fp: FileParse, containerNode: Record<string, unknown>): void {
  const stepBlocks = firstBlockByOwner(children(containerNode["StepsForScripts"], "Script"), "ScriptReference");
  let order = 0;
  for (const { node, folder } of collectOrderedWithFolders(containerNode["ScriptCatalog"], "Script")) {
    const base = makeObject(fp, node, "script");
    if (!base) continue;
    const placed = placeInCatalog(base, order++, folder);
    if (placed.isSeparator) {
      fp.objects.push(placed);
      continue;
    }
    const block = stepBlocks.get(placed.id);
    const script = annotateScript(node, placed);
    fp.objects.push(block ? withSteps(fp, script, block) : script);
  }
}

/** A script with its steps: their references scanned, their rendered text
 * appended to its searchable text, and the step list as its detail. */
function withSteps(fp: FileParse, script: FmObject, block: Record<string, unknown>): FmObject {
  // Scan only the steps (ObjectList), not the leading binding reference.
  // (scanRefs also recovers the targets FileMaker records only in a step's
  // rendered text — see addStepTargetRefs.)
  const steps = block["ObjectList"];
  scanRefs(fp, steps, script);
  // The text is built from FileMaker's pre-rendered StepText (per step,
  // joined by newlines) rather than collectText(steps): the formatted text
  // has real delimiters (`;`, `[`, `]`, …), so search and the placeholder
  // passes see readable steps instead of the raw parameter tree.
  const stepList = scriptSteps(steps, fp.index.stepTextByHash);
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
