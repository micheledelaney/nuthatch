import { layoutOf, type FmObject, type FmReference, type SolutionModel, type StepIr } from "@/types/ddr";
import { objectUid } from "@/core/parser/uid";
import { walk, type Block, type Domain } from "./blocks";
import { refsByStep, type ScriptAnalysisInput, type ScriptFinding } from "./findings";

/**
 * Which layout a script is on at each step, as far as the export shows: the
 * layout of the trigger or button that runs it, then whatever a Go to Layout
 * names. Anything else that can change the window or layout makes it unknown —
 * and so does a call to a script that might. With it, a Set Field into an
 * occurrence that isn't related to the layout's own is found: FileMaker has no
 * record to set there.
 */

/** The layouts (uids) the script may be on, or "unknown". */
type Where = "unknown" | ReadonlySet<string>;

/** Steps that can leave the script on another window or layout. Go to Layout
 * and Perform Script are handled on their own. */
const CHANGES_WINDOW: ReadonlySet<string> = new Set(["Go to Related Record", "New Window", "Select Window", "Close Window", "Open File", "Close File"]);

function joinWhere(a: Where, b: Where): Where {
  return a === "unknown" || b === "unknown" ? "unknown" : new Set([...a, ...b]);
}

function sameWhere(a: Where, b: Where): boolean {
  return a === "unknown" || b === "unknown" ? a === b : a.size === b.size && [...a].every((uid) => b.has(uid));
}

/** What the context check needs from the whole solution, built once. */
export interface ContextIndex {
  model: SolutionModel;
  /** Layout uid → the uid of the occurrence it shows records from. */
  layoutOccurrence: Map<string, string>;
  /** Occurrence uid → a representative of its group of related occurrences. */
  occurrenceGroup: Map<string, string>;
  /** Scripts that might leave their caller on another window or layout. */
  changesContext: Set<string>;
}

export function contextIndex(input: ScriptAnalysisInput): ContextIndex {
  return {
    model: input.model,
    layoutOccurrence: layoutOccurrences(input.model),
    occurrenceGroup: occurrenceGroups(input.model),
    changesContext: scriptsThatChangeContext(input),
  };
}

function layoutOccurrences(model: SolutionModel): Map<string, string> {
  const occurrenceByName = new Map<string, string>();
  for (const obj of model.objects) if (obj.type === "tableOccurrence") occurrenceByName.set(`${obj.fileUid}\u0000${obj.name}`, obj.uid);
  const out = new Map<string, string>();
  for (const obj of model.objects) {
    const occurrence = obj.type === "layout" ? occurrenceByName.get(`${obj.fileUid}\u0000${obj.attributes.tableOccurrence ?? ""}`) : undefined;
    if (occurrence) out.set(obj.uid, occurrence);
  }
  return out;
}

/** Occurrences joined by relationships, per file (union–find). */
function occurrenceGroups(model: SolutionModel): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (uid: string): string => {
    const up = parent.get(uid);
    if (up == null || up === uid) return uid;
    const root = find(up);
    parent.set(uid, root);
    return root;
  };
  for (const obj of model.objects) {
    if (obj.type !== "relationship" || obj.detail?.kind !== "relationship") continue;
    const { leftToId, rightToId } = obj.detail;
    if (leftToId == null || rightToId == null) continue;
    const a = find(objectUid(obj.fileUid, "tableOccurrence", leftToId));
    const b = find(objectUid(obj.fileUid, "tableOccurrence", rightToId));
    if (a !== b) parent.set(a, b);
  }
  return new Map([...parent.keys()].map((uid) => [uid, find(uid)]));
}

function related(index: ContextIndex, a: string, b: string): boolean {
  return a === b || (index.occurrenceGroup.get(a) ?? a) === (index.occurrenceGroup.get(b) ?? b);
}

/** The scripts a Perform Script step calls. */
function performed(refs: readonly FmReference[] | undefined): FmReference[] {
  return (refs ?? []).filter((ref) => ref.kind === "performScript");
}

/** Whether a Perform Script step calls something this check can't follow: a
 * script chosen by name, a deleted one, or one in another file. */
function opaqueCall(model: SolutionModel, fileUid: string, targets: readonly FmReference[]): boolean {
  return targets.length === 0 || targets.some((ref) => !ref.toUid || model.byUid.get(ref.toUid)?.fileUid !== fileUid);
}

/** Scripts that might change the window or layout: with such a step of their
 * own, or a call to a script in another file, to one the export can't name
 * (by name, deleted), or to one that might — and those without typed steps. */
function scriptsThatChangeContext(input: ScriptAnalysisInput): Set<string> {
  const { model, irs } = input;
  const out = new Set(model.objects.filter((obj) => obj.type === "script" && !irs.has(obj.uid)).map((obj) => obj.uid));
  const callees = new Map<string, string[]>();
  for (const [uid, steps] of irs) {
    const fileUid = model.byUid.get(uid)?.fileUid ?? "";
    const byStep = refsByStep(model, uid);
    const calls: string[] = [];
    for (const step of steps) {
      if (!step.enabled) continue;
      if (step.name === "Go to Layout" || CHANGES_WINDOW.has(step.name)) out.add(uid);
      if (step.name !== "Perform Script") continue;
      const targets = performed(byStep.get(step.index));
      if (opaqueCall(model, fileUid, targets)) out.add(uid);
      for (const ref of targets) if (ref.toUid) calls.push(ref.toUid);
    }
    callees.set(uid, calls);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [uid, calls] of callees) {
      if (out.has(uid) || !calls.some((callee) => out.has(callee))) continue;
      out.add(uid);
      changed = true;
    }
  }
  return out;
}

/** The layouts a script starts on: those of the triggers and buttons that run
 * it, when nothing else does (another script, a menu, the file's triggers,
 * a server schedule — or nothing in the export). */
function entryLayouts(index: ContextIndex, script: FmObject): Where {
  const { byUid } = index.model;
  const callers = (index.model.inbound.get(script.uid) ?? []).filter((ref) => (ref.kind === "performScript" || ref.kind === "trigger") && !ref.disabled);
  if (callers.length === 0) return "unknown";
  const layouts = new Set<string>();
  for (const ref of callers) {
    const from = byUid.get(ref.fromUid);
    const layout = from?.type === "layout" ? from : from?.type === "layoutObject" ? layoutOf(from, byUid) : null;
    if (!layout || layout.fileUid !== script.fileUid || !index.layoutOccurrence.has(layout.uid)) return "unknown";
    layouts.add(layout.uid);
  }
  return layouts;
}

/** The context check for one script. */
export function checkContext(index: ContextIndex, script: FmObject, blocks: readonly Block[]): ScriptFinding[] {
  const { model } = index;
  const byStep = refsByStep(model, script.uid);
  const entry = entryLayouts(index, script);
  const domain: Domain<Where> = { join: joinWhere, equals: sameWhere, transfer: (step, where) => transfer(index, script.fileUid, byStep, entry, step, where) };
  const findings: ScriptFinding[] = [];
  walk(blocks, entry, domain, (step, where) => {
    if (!step.enabled || step.name !== "Set Field" || where == null || where === "unknown") return;
    for (const ref of byStep.get(step.index) ?? []) {
      const finding = unrelatedSetField(index, script.uid, step, ref, where);
      if (finding) findings.push(finding);
    }
  });
  return findings;
}

function transfer(index: ContextIndex, fileUid: string, byStep: ReadonlyMap<number, FmReference[]>, entry: Where, step: StepIr, where: Where): Where {
  if (step.name === "Go to Layout") {
    if (step.layoutChoice === "original") return entry;
    const target = (byStep.get(step.index) ?? []).find((ref) => ref.kind === "goToLayout");
    return step.layoutChoice === "specified" && target?.toUid && index.layoutOccurrence.has(target.toUid) ? new Set([target.toUid]) : "unknown";
  }
  if (step.name === "Perform Script") {
    const targets = performed(byStep.get(step.index));
    return opaqueCall(index.model, fileUid, targets) || targets.some((ref) => index.changesContext.has(ref.toUid!)) ? "unknown" : where;
  }
  return CHANGES_WINDOW.has(step.name) ? "unknown" : where;
}

function unrelatedSetField(index: ContextIndex, scriptUid: string, step: StepIr, ref: FmReference, where: ReadonlySet<string>): ScriptFinding | undefined {
  const { byUid } = index.model;
  if (ref.kind !== "setField" || !ref.toUid || !ref.viaUid) return undefined;
  // A global field holds one value for the whole file: any context reaches it.
  if (byUid.get(ref.toUid)?.attributes.global === "Yes") return undefined;
  const target = ref.viaUid;
  if ([...where].some((layout) => related(index, index.layoutOccurrence.get(layout)!, target))) return undefined;
  const occurrenceName = byUid.get(target)?.name ?? "?";
  const layouts = [...where].map((layout) => `${byUid.get(layout)?.name ?? "?"} (${byUid.get(index.layoutOccurrence.get(layout)!)?.name ?? "?"})`);
  return {
    rule: "unrelated-set-field",
    certainty: "likely",
    uid: scriptUid,
    step: step.index,
    title: ["Set Field into ", { code: `${occurrenceName}::${ref.toName}` }, " has no record to set"],
    detail: [`${occurrenceName} isn't related to the occurrence of the layout the script is on here: ${layouts.join(" or ")}.`],
  };
}
