import { layoutOf, type FmObject, type FmReference, type SolutionModel, type StepIr } from "@/types/ddr";
import { objectUid } from "@/core/parser/uid";
import { buildBlocks, walk, type Domain } from "./blocks";
import { refsByStep, type ScriptAnalysisInput, type ScriptFinding } from "./findings";

/**
 * Which layout a script is on at each step, as far as the export shows: where
 * it starts (the layouts of the buttons and triggers that run it, and those
 * the scripts that perform it are on at that step), then whatever a Go to
 * Layout, New Window or Go to Related Record names. Anything else that can
 * change the window or layout, or lets the user change it (a pause), makes it
 * unknown — and so does a call to a script that might. With it, a Set Field,
 * or another step that writes into or goes to a field (Insert Text, Go to
 * Field …), into an occurrence that isn't related to the layout's own is
 * found: FileMaker has no record there.
 */

/** The layouts (uids) the script may be on, or "unknown". */
export type Where = "unknown" | ReadonlySet<string>;

/** Steps that can leave the script on another window or layout, or let the
 * user go to one. Go to Layout, New Window and Go to Related Record are
 * followed where they name their layout (see transfer), and Perform Script
 * through what it calls. */
const CHANGES_WINDOW: ReadonlySet<string> = new Set([
  "Go to Related Record",
  "New Window",
  "Select Window",
  "Close Window",
  "Open File",
  "Close File",
  "Pause/Resume Script",
]);

/** One of CHANGES_WINDOW, or a step that pauses for the user (Enter Find Mode
 * [ Pause ] …). */
function changesWindow(step: StepIr): boolean {
  return CHANGES_WINDOW.has(step.name) || step.flags?.["Pause"] === true;
}

function joinWhere(a: Where, b: Where): Where {
  return a === "unknown" || b === "unknown" ? "unknown" : new Set([...a, ...b]);
}

function sameWhere(a: Where, b: Where): boolean {
  return a === "unknown" || b === "unknown" ? a === b : a.size === b.size && [...a].every((uid) => b.has(uid));
}

/** What the context check needs from the whole solution: built once, and
 * each script's layouts worked out as they're needed. */
export interface ContextIndex {
  model: SolutionModel;
  irs: ReadonlyMap<string, readonly StepIr[]>;
  /** Layout uid → the uid of the occurrence it shows records from. */
  layoutOccurrence: Map<string, string>;
  /** Occurrence uid → a representative of its group of related occurrences. */
  occurrenceGroup: Map<string, string>;
  /** Scripts that might leave their caller on another window or layout. */
  changesContext: Set<string>;
  /** Script uid → the layouts it starts on (see entryLayouts). */
  entries: Map<string, Where>;
  /** Script uid → the layouts it's on before each step a path reaches; null
   * when its blocks don't nest (see layoutsBefore). */
  befores: Map<string, ReadonlyMap<number, Where> | null>;
  /** Scripts whose start is being worked out: a call back into one (a script
   * that runs itself again) starts somewhere unknown. */
  pending: Set<string>;
}

export function contextIndex(input: ScriptAnalysisInput): ContextIndex {
  return {
    model: input.model,
    irs: input.irs,
    layoutOccurrence: layoutOccurrences(input.model),
    occurrenceGroup: occurrenceGroups(input.model),
    changesContext: scriptsThatChangeContext(input),
    entries: new Map(),
    befores: new Map(),
    pending: new Set(),
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
      if (step.name === "Go to Layout" || changesWindow(step)) out.add(uid);
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

/** The layouts a script starts on: those of the buttons and triggers that run
 * it, and those the scripts that perform it are on at that step. Unknown when
 * anything else runs it (a menu, the file's triggers, a script on the server
 * or in another file, a server schedule — or nothing in the export), and for a
 * script that runs itself again. */
function entryLayouts(index: ContextIndex, script: FmObject): Where {
  const cached = index.entries.get(script.uid);
  if (cached) return cached;
  if (index.pending.has(script.uid)) return "unknown";
  index.pending.add(script.uid);
  const entry = callerLayouts(index, script);
  index.pending.delete(script.uid);
  index.entries.set(script.uid, entry);
  return entry;
}

function callerLayouts(index: ContextIndex, script: FmObject): Where {
  const callers = (index.model.inbound.get(script.uid) ?? []).filter((ref) => (ref.kind === "performScript" || ref.kind === "trigger") && !ref.disabled);
  let layouts: Where | null = null;
  for (const ref of callers) {
    const from = index.model.byUid.get(ref.fromUid);
    const at = from?.type === "script" ? layoutsAtCall(index, script, from, ref) : callerLayout(index, script, from);
    if (at === "unknown") return "unknown";
    if (at) layouts = layouts ? joinWhere(layouts, at) : at;
  }
  // No caller, or none whose call is ever reached.
  return layouts ?? "unknown";
}

/** The layout of the button or trigger that runs a script. */
function callerLayout(index: ContextIndex, script: FmObject, from: FmObject | undefined): Where {
  const layout = from?.type === "layout" ? from : from?.type === "layoutObject" ? layoutOf(from, index.model.byUid) : null;
  return layout && layout.fileUid === script.fileUid && index.layoutOccurrence.has(layout.uid) ? new Set([layout.uid]) : "unknown";
}

/** The layouts a script that performs `script` is on at its Perform Script
 * step; null when no path reaches the step. */
function layoutsAtCall(index: ContextIndex, script: FmObject, caller: FmObject, ref: FmReference): Where | null {
  const step = ref.fromStep == null ? undefined : index.irs.get(caller.uid)?.[ref.fromStep - 1];
  // Performed on the server, or from another file, it starts somewhere else.
  if (step?.name !== "Perform Script" || caller.fileUid !== script.fileUid) return "unknown";
  const before = layoutsBefore(index, caller);
  return before ? (before.get(step.index) ?? null) : "unknown";
}

/** The layouts a script is on before each step a path reaches; null when its
 * blocks don't nest. */
export function layoutsBefore(index: ContextIndex, script: FmObject): ReadonlyMap<number, Where> | null {
  const cached = index.befores.get(script.uid);
  if (cached !== undefined) return cached;
  const steps = index.irs.get(script.uid);
  const blocks = steps ? buildBlocks(steps) : null;
  if (!blocks || "error" in blocks) {
    index.befores.set(script.uid, null);
    return null;
  }
  // Worked out while its own start is (it runs itself again): not kept, since
  // its start, once known, may be more than unknown.
  const isPending = index.pending.has(script.uid);
  const entry = entryLayouts(index, script);
  const byStep = refsByStep(index.model, script.uid);
  const domain: Domain<Where> = { join: joinWhere, equals: sameWhere, transfer: (step, where) => transfer(index, script.fileUid, byStep, entry, step, where) };
  const before = new Map<number, Where>();
  walk(blocks, entry, domain, (step, where) => {
    if (where != null) before.set(step.index, where);
  });
  if (!isPending) index.befores.set(script.uid, before);
  return before;
}

/** The context check for one script. */
export function checkContext(index: ContextIndex, script: FmObject): ScriptFinding[] {
  const before = layoutsBefore(index, script);
  if (!before) return [];
  const byStep = refsByStep(index.model, script.uid);
  const findings: ScriptFinding[] = [];
  for (const step of index.irs.get(script.uid) ?? []) {
    const where = before.get(step.index);
    if (!step.enabled || where == null || where === "unknown") continue;
    const refs = byStep.get(step.index) ?? [];
    if (step.name === "Set Field") {
      for (const ref of refs) {
        const finding = ref.kind === "setField" ? unrelatedSetField(index, script.uid, step, ref, where) : undefined;
        if (finding) findings.push(finding);
      }
    }
    for (const target of step.fieldTargets ?? []) {
      const occurrence = objectUid(script.fileUid, "tableOccurrence", target.occurrence);
      const ref = refs.find((r) => r.toType === "field" && r.toId === target.field && r.viaUid === occurrence);
      const finding = ref ? unrelatedTarget(index, script.uid, step, ref, where) : undefined;
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

function transfer(index: ContextIndex, fileUid: string, byStep: ReadonlyMap<number, FmReference[]>, entry: Where, step: StepIr, where: Where): Where {
  const named = () => namedLayout(index, fileUid, byStep.get(step.index));
  switch (step.name) {
    case "Go to Layout":
      if (step.layoutChoice === "original") return entry;
      return step.layoutChoice === "specified" ? named() : "unknown";
    case "New Window":
      // "<Current Layout>", or none given: the new window shows the layout the script is on.
      if (step.layoutChoice === "original" || step.layoutChoice === "none") return where;
      return step.layoutChoice === "specified" ? named() : "unknown";
    case "Go to Related Record":
      if (step.layoutChoice === "original") return where;
      // With no related record, FileMaker stays where it was.
      return step.layoutChoice === "specified" ? joinWhere(where, named()) : "unknown";
    case "Perform Script": {
      const targets = performed(byStep.get(step.index));
      return opaqueCall(index.model, fileUid, targets) || targets.some((ref) => index.changesContext.has(ref.toUid!)) ? "unknown" : where;
    }
  }
  return changesWindow(step) ? "unknown" : where;
}

/** The layout a step names, when it's in the script's own file and shows
 * records from a known occurrence. */
function namedLayout(index: ContextIndex, fileUid: string, refs: readonly FmReference[] | undefined): Where {
  const layout = (refs ?? []).find((ref) => ref.toType === "layout")?.toUid;
  return layout && index.model.byUid.get(layout)?.fileUid === fileUid && index.layoutOccurrence.has(layout) ? new Set([layout]) : "unknown";
}

function unrelatedSetField(index: ContextIndex, scriptUid: string, step: StepIr, ref: FmReference, where: ReadonlySet<string>): ScriptFinding | undefined {
  const unreached = unreachedField(index, ref, where);
  if (!unreached) return undefined;
  return {
    rule: "unrelated-set-field",
    certainty: "likely",
    uid: scriptUid,
    step: step.index,
    title: ["Set Field into ", { code: unreached.field }, " has no record to set"],
    detail: [unreached.why],
  };
}

/** Another step that writes into or goes to a field (see StepIr.fieldTargets). */
function unrelatedTarget(index: ContextIndex, scriptUid: string, step: StepIr, ref: FmReference, where: ReadonlySet<string>): ScriptFinding | undefined {
  const unreached = unreachedField(index, ref, where);
  if (!unreached) return undefined;
  return {
    rule: "unrelated-field-target",
    certainty: "likely",
    uid: scriptUid,
    step: step.index,
    title: [`${step.name} can't reach `, { code: unreached.field }],
    detail: [unreached.why],
  };
}

/** A field reached through an occurrence related to none of the layouts the
 * script may be on: its name and why. Undefined when one of them reaches it,
 * or it's global. */
export function unreachedField(index: ContextIndex, ref: FmReference, where: ReadonlySet<string>): { field: string; why: string } | undefined {
  const { byUid } = index.model;
  if (!ref.toUid || !ref.viaUid) return undefined;
  // A global field holds one value for the whole file: any context reaches it.
  if (byUid.get(ref.toUid)?.attributes.global === "Yes") return undefined;
  const target = ref.viaUid;
  if ([...where].some((layout) => related(index, index.layoutOccurrence.get(layout)!, target))) return undefined;
  const occurrenceName = byUid.get(target)?.name ?? "?";
  const layouts = [...where].map((layout) => `${byUid.get(layout)?.name ?? "?"} (${byUid.get(index.layoutOccurrence.get(layout)!)?.name ?? "?"})`);
  return {
    field: `${occurrenceName}::${ref.toName}`,
    why: `${occurrenceName} isn't related to the occurrence of the layout the script is on here: ${layouts.join(" or ")}.`,
  };
}
