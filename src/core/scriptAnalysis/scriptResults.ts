import type { FmReference, StepIr } from "@/types/ddr";
import { buildBlocks, walk, type Domain } from "./blocks";
import { GET_TOKENS, isGet, tokenize } from "./calcTokens";
import { refsByStep, stepList, type ScriptAnalysisInput, type ScriptFinding } from "./findings";
import { holdersOf, isHolderStep, jsonBuild, keyReadAt, passedKeys, sourceAt } from "./jsonKeys";

/**
 * Script results: the keys a script returns (`Exit Script [ Text Result: … ]`)
 * against the keys its callers read (`JSONGetElement ( Get ( ScriptResult ) ;
 * "key" )`, or through a variable set to `Get ( ScriptResult )`). A read gets
 * the result of the script performed last before it, so reads are followed
 * along the script's paths (see blocks.walk) back to their Perform Script.
 *
 * A result is understood when it's a JSON build (see jsonKeys), a variable
 * only ever set to such builds, a custom function without parameters whose
 * body is one, or `Get ( ScriptResult )` passing on a subscript's result.
 * Anything else makes the script's result unknown, and the check then says
 * nothing about reads of it.
 */

/** The Perform Script steps (by index) that may have run last before a step;
 * NO_CALL when none may have, OTHER for a step that sets Get ( ScriptResult )
 * some other way. */
type Sources = ReadonlySet<number>;
const NO_CALL = 0;
const OTHER = -1;

/** What a script returns: the keys of its JSON result, `nothing` when it
 * returns no result at all — or "unknown". */
type Returns = { keys: ReadonlySet<string>; nothing: boolean } | "unknown";

const UNKNOWN: Returns = "unknown";

/** Steps that perform a script, setting Get ( ScriptResult ). */
const PERFORM_STEPS: ReadonlySet<string> = new Set(["Perform Script", "Perform Script on Server", "Perform Script on Server with Callback"]);

/** Steps after which Get ( ScriptResult ) holds something this check can't
 * follow: a JavaScript function's return value, or the result of a script a
 * button runs while the script is paused. */
const OTHER_RESULT_STEPS: ReadonlySet<string> = new Set(["Perform JavaScript in Web Viewer", "Pause/Resume Script"]);

const SOURCES: Omit<Domain<Sources>, "transfer"> = {
  join: (a, b) => new Set([...a, ...b]),
  equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)),
};

/** A script's steps with, for each step a path reaches, its Sources. */
interface Flow {
  steps: readonly StepIr[];
  before: Map<number, Sources>;
}

export function checkScriptResults(input: ScriptAnalysisInput): ScriptFinding[] {
  const results = new ResultIndex(input);
  const findings: ScriptFinding[] = [];
  for (const uid of input.irs.keys()) findings.push(...results.findingsFor(uid));
  return findings;
}

class ResultIndex {
  private readonly flows = new Map<string, Flow | null>();
  private readonly returns = new Map<string, Returns>();
  /** Lower-case name → keys built by each file's custom functions without parameters. */
  private readonly functionKeys = new Map<string, Map<string, string[] | undefined>>();

  constructor(private readonly input: ScriptAnalysisInput) {
    for (const obj of input.model.objects) {
      if (obj.type !== "customFunction" || obj.detail?.kind !== "calculation" || obj.detail.signature.includes("(")) continue;
      const byName = this.functionKeys.get(obj.fileUid) ?? this.functionKeys.set(obj.fileUid, new Map()).get(obj.fileUid)!;
      byName.set(obj.name.toLowerCase(), passedKeys(obj.detail.body));
    }
  }

  /** The script's Sources at each step; null when its blocks don't nest. */
  private flow(uid: string): Flow | null {
    const cached = this.flows.get(uid);
    if (cached !== undefined) return cached;
    const steps = this.input.irs.get(uid);
    const blocks = steps ? buildBlocks(steps) : null;
    if (!steps || !blocks || "error" in blocks) {
      this.flows.set(uid, null);
      return null;
    }
    const before = new Map<number, Sources>();
    const domain: Domain<Sources> = { ...SOURCES, transfer: (step, sources) => transferSources(step, sources) };
    walk(blocks, new Set([NO_CALL]), domain, (step, sources) => {
      if (sources) before.set(step.index, sources);
    });
    const flow = { steps, before };
    this.flows.set(uid, flow);
    return flow;
  }

  /** What a script returns, over all its Exit Script steps. */
  private returnsOf(uid: string): Returns {
    const cached = this.returns.get(uid);
    if (cached !== undefined) return cached;
    this.returns.set(uid, UNKNOWN); // a script that passes on its own result stays unknown
    const flow = this.flow(uid);
    const result = flow ? this.exitResults(uid, flow) : UNKNOWN;
    this.returns.set(uid, result);
    return result;
  }

  private exitResults(uid: string, flow: Flow): Returns {
    const keys = new Set<string>();
    let returnsSomething = false;
    for (const step of flow.steps) {
      if (!step.enabled || step.name !== "Exit Script" || !flow.before.has(step.index)) continue;
      const formula = (step.calcs[0] ?? "").trim();
      if (!formula) continue;
      const returned = this.exitResult(uid, flow, step, formula);
      if (returned === "unknown") return UNKNOWN;
      returned.keys.forEach((key) => keys.add(key));
      returnsSomething ||= !returned.nothing;
    }
    return { keys, nothing: !returnsSomething };
  }

  /** What one Exit Script returns. */
  private exitResult(uid: string, flow: Flow, step: StepIr, formula: string): Returns {
    const built = passedKeys(formula);
    if (built) return { keys: new Set(built), nothing: false };
    const tokens = tokenize(formula);
    const [only] = tokens;
    if (tokens.length === GET_TOKENS && isGet(tokens, 0, "scriptresult")) return this.resultOf(flow.before.get(step.index)!, uid);
    if (tokens.length !== 1) return UNKNOWN;
    if (only?.kind === "var") return keysAsReturns(builderKeys(flow.steps, only.name.toLowerCase()));
    if (only?.kind === "name") {
      const fileUid = this.input.model.byUid.get(uid)?.fileUid ?? "";
      return keysAsReturns(this.functionKeys.get(fileUid)?.get(only.text.toLowerCase()));
    }
    return UNKNOWN;
  }

  /** The result Get ( ScriptResult ) holds after `sources`: the union of what
   * each script that may have run last returns. */
  private resultOf(sources: Sources, uid: string): Returns {
    if (sources.has(NO_CALL) || sources.has(OTHER)) return UNKNOWN;
    const byStep = refsByStep(this.input.model, uid);
    const steps = this.input.irs.get(uid)!;
    const keys = new Set<string>();
    let returnsSomething = false;
    for (const index of sources) {
      const returned = this.performed(steps[index - 1]!, byStep.get(index));
      if (returned === "unknown") return UNKNOWN;
      returned.keys.forEach((key) => keys.add(key));
      returnsSomething ||= !returned.nothing;
    }
    return { keys, nothing: !returnsSomething };
  }

  /** What a Perform Script step leaves in Get ( ScriptResult ). */
  private performed(step: StepIr, refs: readonly FmReference[] | undefined): Returns {
    if (step.name === "Perform Script on Server" && step.flags?.["Wait for completion"] === false) return { keys: new Set(), nothing: true };
    const targets = (refs ?? []).filter((ref) => ref.kind === "performScript");
    if (step.name === "Perform Script on Server with Callback" || targets.length !== 1 || !targets[0]!.toUid) return UNKNOWN;
    return this.returnsOf(targets[0]!.toUid);
  }

  /** The findings on one script's reads of Get ( ScriptResult ). */
  findingsFor(uid: string): ScriptFinding[] {
    const flow = this.flow(uid);
    if (!flow) return [];
    const holders = holdersOf(flow.steps, "scriptresult");
    const holderSources = new Map<string, Set<number>>();
    for (const step of flow.steps) {
      const sources = flow.before.get(step.index);
      if (!step.enabled || !sources || !isHolderStep(step, "scriptresult")) continue;
      const name = step.setsVariable!.toLowerCase();
      if (holders.has(name)) holderSources.set(name, new Set([...(holderSources.get(name) ?? []), ...sources]));
    }
    const findings: ScriptFinding[] = [];
    const isCallback = this.isCallback(uid);
    for (const step of flow.steps) {
      const before = flow.before.get(step.index);
      if (!step.enabled || !before) continue;
      for (const formula of step.calcs) {
        const tokens = tokenize(formula);
        for (let i = 0; i < tokens.length; i++) {
          const width = sourceAt(tokens, i, "scriptresult", holders);
          if (width === 0) continue;
          const direct = width === GET_TOKENS;
          if (direct && !isCallback && before.size === 1 && before.has(NO_CALL)) findings.push(readBeforeAnyCall(uid, step));
          const key = keyReadAt(tokens, i, width);
          const token = tokens[i]!;
          const sources = direct ? before : holderSources.get(token.kind === "var" ? token.name.toLowerCase() : "");
          if (key != null && sources) findings.push(...this.unreturnedKey(uid, step, key, sources));
          i += width - 1;
        }
      }
    }
    return dedupe(findings);
  }

  private unreturnedKey(uid: string, step: StepIr, key: string, sources: Sources): ScriptFinding[] {
    const returned = this.resultOf(sources, uid);
    if (returned === "unknown" || returned.keys.has(key)) return [];
    const names = this.calledNames(uid, sources);
    const list = [...returned.keys].sort().join(", ");
    const steps = this.input.irs.get(uid)!;
    const noWait = [...sources].every((index) => steps[index - 1]?.flags?.["Wait for completion"] === false);
    const detail = noWait
      ? `The Perform Script on Server at ${stepList([...sources])} doesn't wait for its script, so there's no result.`
      : returned.nothing
          ? `${capitalized(names)} doesn't return a result.`
          : `${capitalized(names)} never returns it. ${names.includes(" or ") ? "They return" : "It returns"}: ${list}.`;
    return [
      {
        rule: "unreturned-result-key",
        certainty: "likely",
        uid,
        step: step.index,
        title: ["Result key ", { code: `"${key}"` }, " isn't returned"],
        detail: [detail],
      },
    ];
  }

  /** "S_Sub", or "A or B": the scripts Get ( ScriptResult ) may come from —
   * "the script step 12 performs" for one the export doesn't name. */
  private calledNames(uid: string, sources: Sources): string {
    const byStep = refsByStep(this.input.model, uid);
    const names = [...sources].map((index) => {
      const target = (byStep.get(index) ?? []).find((ref) => ref.kind === "performScript" && ref.toUid);
      return target ? (this.input.model.byUid.get(target.toUid!)?.name ?? target.toName) : `the script step ${index} performs`;
    });
    return [...new Set(names)].join(" or ");
  }

  /** A script some Perform Script on Server with Callback runs: as its
   * callback it reads the server script's result without performing it. */
  private isCallback(uid: string): boolean {
    return (this.input.model.inbound.get(uid) ?? []).some(
      (ref) => ref.kind === "performScript" && ref.fromStep != null && this.input.irs.get(ref.fromUid)?.[ref.fromStep - 1]?.name === "Perform Script on Server with Callback",
    );
  }
}

/** The keys a variable is built with, when every enabled step that sets it is
 * a Set Variable to a JSON build — of itself, "{}" or "" — with literal keys. */
function builderKeys(steps: readonly StepIr[], name: string): string[] | undefined {
  const keys: string[] = [];
  let sets = 0;
  for (const step of steps) {
    if (!step.enabled || step.setsVariable?.toLowerCase() !== name) continue;
    if (step.name !== "Set Variable") return undefined;
    const tokens = tokenize(step.calcs[0] ?? "");
    const built = jsonBuild(tokens, 0, name);
    if (!built || built.end !== tokens.length) return undefined;
    keys.push(...built.keys);
    sets++;
  }
  return sets > 0 ? keys : undefined;
}

function transferSources(step: StepIr, sources: Sources): Sources {
  if (PERFORM_STEPS.has(step.name)) return new Set([step.index]);
  return OTHER_RESULT_STEPS.has(step.name) ? new Set([OTHER]) : sources;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function keysAsReturns(keys: string[] | undefined): Returns {
  return keys ? { keys: new Set(keys), nothing: false } : UNKNOWN;
}

function readBeforeAnyCall(uid: string, step: StepIr): ScriptFinding {
  return {
    rule: "result-before-call",
    certainty: "likely",
    uid,
    step: step.index,
    title: [{ code: "Get ( ScriptResult )" }, " is read before any script runs"],
    detail: ["No Perform Script runs before this step in this script, so there's no result of its own to read."],
  };
}

/** One finding per rule, step and title. */
function dedupe(findings: ScriptFinding[]): ScriptFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.rule}:${f.step}:${JSON.stringify(f.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
