import type { StepIr } from "@/types/ddr";

/**
 * A script's steps as nested blocks. FileMaker has no goto, and its script
 * editor keeps If/Else If/Else/End If and Loop/End Loop balanced, so the paths
 * through a script follow its blocks — no general control-flow graph needed.
 */
export type Block =
  | { kind: "step"; step: StepIr }
  | { kind: "if"; branches: IfBranch[]; hasElse: boolean; end: StepIr }
  | { kind: "loop"; head: StepIr; body: Block[]; end: StepIr };

/** An If's, Else If's or Else's step and the steps it runs. */
export interface IfBranch {
  head: StepIr;
  body: Block[];
}

type Frame = { kind: "if"; branches: IfBranch[]; hasElse: boolean } | { kind: "loop"; head: StepIr; body: Block[] };

/** The script's blocks, or why its steps don't nest: an unbalanced block, or a
 * disabled If/Loop step (what FileMaker then runs isn't modelled). */
export function buildBlocks(steps: readonly StepIr[]): Block[] | { error: string } {
  const root: Block[] = [];
  const stack: Frame[] = [];
  const body = (): Block[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.kind === "loop" ? top.body : top.branches[top.branches.length - 1]!.body;
  };
  for (const step of steps) {
    const top = stack[stack.length - 1];
    if (CONTROL_STEPS.has(step.name) && !step.enabled) return { error: `step ${step.index} (${step.name}) is disabled` };
    switch (step.name) {
      case "If":
        stack.push({ kind: "if", branches: [{ head: step, body: [] }], hasElse: false });
        break;
      case "Else If":
      case "Else":
        if (top?.kind !== "if" || top.hasElse) return unbalanced(step);
        top.branches.push({ head: step, body: [] });
        top.hasElse = step.name === "Else";
        break;
      case "End If":
        if (top?.kind !== "if") return unbalanced(step);
        stack.pop();
        body().push({ kind: "if", branches: top.branches, hasElse: top.hasElse, end: step });
        break;
      case "Loop":
        stack.push({ kind: "loop", head: step, body: [] });
        break;
      case "End Loop":
        if (top?.kind !== "loop") return unbalanced(step);
        stack.pop();
        body().push({ kind: "loop", head: top.head, body: top.body, end: step });
        break;
      case "Exit Loop If":
        if (!stack.some((frame) => frame.kind === "loop")) return unbalanced(step);
        body().push({ kind: "step", step });
        break;
      default:
        body().push({ kind: "step", step });
    }
  }
  return stack.length === 0 ? root : { error: `a block opened at step ${openingStep(stack[stack.length - 1]!).index} isn't closed` };
}

/** Steps that shape the blocks. (A disabled Exit Loop If just doesn't run.) */
const CONTROL_STEPS: ReadonlySet<string> = new Set(["If", "Else If", "Else", "End If", "Loop", "End Loop"]);

function unbalanced(step: StepIr): { error: string } {
  return { error: `step ${step.index} (${step.name}) has no block to belong to` };
}

function openingStep(frame: Frame): StepIr {
  return frame.kind === "loop" ? frame.head : frame.branches[0]!.head;
}

/** Steps after which the script stops: nothing that follows on their path runs. */
const ENDING_STEPS: ReadonlySet<string> = new Set(["Exit Script", "Halt Script"]);

/** Steps that can end a loop without an Exit Loop If: "Exit after last" on the
 * last record, request, page or portal row. */
const MAYBE_LOOP_EXITS: ReadonlySet<string> = new Set(["Go to Record/Request/Page", "Go to Portal Row"]);

/**
 * What a check tracks along a script's paths. A state of `null` means no path
 * reaches the step; the walker handles that (and disabled steps, which never
 * run) itself.
 */
export interface Domain<S> {
  join(a: S, b: S): S;
  equals(a: S, b: S): boolean;
  /** The state after an enabled step that isn't an If, Loop or Exit Loop If. */
  transfer(step: StepIr, state: S): S;
}

/** Why the steps after a point can't run, for the unreachable-step message. */
export type DeadEnd = { kind: "ended"; step: StepIr } | { kind: "allBranchesEnd"; step: StepIr } | { kind: "endlessLoop"; step: StepIr };

/** Called for each step with the state before it (null when unreachable). */
export type Visitor<S> = (step: StepIr, state: S | null, deadEnd: DeadEnd | undefined) => void;

/** A loop's state at its head stops changing within this many passes; past it
 * the walker stops iterating (a safety net — the domains here are finite). */
const MAX_LOOP_PASSES = 50;

/** Walk the blocks from `entry`, calling `visit` for every step once; returns
 * the state where the script ends by running off its last step. */
export function walk<S>(blocks: readonly Block[], entry: S, domain: Domain<S>, visit: Visitor<S>): S | null {
  const walker = new Walker(domain, visit);
  return walker.list(blocks, entry);
}

class Walker<S> {
  /** The joined states at each enclosing loop's exits, innermost last. */
  private readonly loopExits: (S | null)[] = [];
  private visiting = true;
  /** Why no path goes on: set wherever a reachable path ends. */
  private deadEnd: DeadEnd | undefined;

  constructor(
    private readonly domain: Domain<S>,
    private readonly visitor: Visitor<S>,
  ) {}

  list(blocks: readonly Block[], state: S | null): S | null {
    let current = state;
    for (const block of blocks) current = this.block(block, current);
    return current;
  }

  private block(block: Block, state: S | null): S | null {
    if (block.kind === "step") return this.step(block.step, state);
    if (block.kind === "if") return this.ifBlock(block, state);
    return this.loop(block, state);
  }

  private visit(step: StepIr, state: S | null): void {
    if (this.visiting) this.visitor(step, state, state == null ? this.deadEnd : undefined);
  }

  private step(step: StepIr, state: S | null): S | null {
    this.visit(step, state);
    if (state == null || !step.enabled) return state;
    if (ENDING_STEPS.has(step.name)) {
      this.deadEnd = { kind: "ended", step };
      return null;
    }
    if (step.name === "Exit Loop If") {
      this.exitLoop(state);
      return state;
    }
    const after = this.domain.transfer(step, state);
    if (MAYBE_LOOP_EXITS.has(step.name) && this.loopExits.length > 0) this.exitLoop(after);
    return after;
  }

  private exitLoop(state: S): void {
    const top = this.loopExits.length - 1;
    this.loopExits[top] = this.join(this.loopExits[top]!, state);
  }

  private ifBlock(block: Extract<Block, { kind: "if" }>, state: S | null): S | null {
    let out: S | null = block.hasElse ? null : state;
    for (const branch of block.branches) {
      this.visit(branch.head, state);
      out = this.join(out, this.list(branch.body, state));
    }
    if (state != null && out == null) this.deadEnd = { kind: "allBranchesEnd", step: block.branches[0]!.head };
    this.visit(block.end, out);
    return out;
  }

  private loop(block: Extract<Block, { kind: "loop" }>, state: S | null): S | null {
    this.visit(block.head, state);
    // Find the state at the loop's head (entry joined with each pass's end)
    // without visiting, then walk the body once more to visit its steps.
    const visiting = this.visiting;
    this.visiting = false;
    let head = state;
    for (let pass = 0; pass < MAX_LOOP_PASSES; pass++) {
      this.loopExits.push(null);
      const next = this.join(state, this.list(block.body, head));
      this.loopExits.pop();
      if (this.same(next, head)) break;
      head = next;
    }
    this.visiting = visiting;
    this.loopExits.push(null);
    const end = this.list(block.body, head);
    const exits = this.loopExits.pop() ?? null;
    this.visit(block.end, end);
    if (state != null && exits == null) this.deadEnd = { kind: "endlessLoop", step: block.head };
    return exits;
  }

  private join(a: S | null, b: S | null): S | null {
    if (a == null) return b;
    if (b == null) return a;
    return this.domain.join(a, b);
  }

  private same(a: S | null, b: S | null): boolean {
    if (a == null || b == null) return a === b;
    return this.domain.equals(a, b);
  }
}
