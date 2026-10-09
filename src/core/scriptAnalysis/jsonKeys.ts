import type { StepIr } from "@/types/ddr";
import { bracketArgs, closingIndex, GET_TOKENS, isCall, isGet, isPunct, literalArg, tokenize, type Token } from "./calcTokens";

/**
 * JSON keys in formulas, for the checks that compare what one side builds with
 * what the other reads: a script parameter, a script result. Only literal keys
 * are understood, compared by their first path segment (`customer.id` →
 * `customer`), with case, as JSON does.
 */

/** The keys a formula builds: [] for an empty one; undefined unless it's
 * nothing but JSONSetElement calls on "{}" or "" with literal keys. */
export function passedKeys(formula: string | undefined): string[] | undefined {
  if (formula == null || formula.trim() === "") return [];
  const tokens = tokenize(formula);
  const built = jsonBuild(tokens);
  return built?.end === tokens.length ? built.keys : undefined;
}

/** The keys a JSON build at `tokens[at]` adds, and where it ends: "{}", "", a
 * JSONSetElement of a build — or, with `self`, that variable (a build that
 * adds to it: `JSONSetElement ( $result ; … )`). */
export function jsonBuild(tokens: readonly Token[], at = 0, self?: string): { keys: string[]; end: number } | undefined {
  const first = tokens[at];
  if (first?.kind === "string" && (first.value === "" || first.value.replace(/\s/g, "") === "{}")) return { keys: [], end: at + 1 };
  if (self != null && first?.kind === "var" && first.name.toLowerCase() === self) return { keys: [], end: at + 1 };
  if (!isCall(tokens, at, "jsonsetelement")) return undefined;
  const { args, close } = bracketArgs(tokens, at + 1);
  const [json, ...rest] = args;
  const base = json ? jsonBuild(json, 0, self) : undefined;
  if (!base || base.end !== json!.length) return undefined;
  const groups = rest.every(isBracketGroup) ? rest.map((arg) => bracketArgs(arg, 0).args[0]) : rest.length === 3 ? [rest[0]] : undefined;
  const keys = groups?.map((key) => firstSegment(literalArg(key)));
  if (!keys || keys.length === 0 || keys.some((key) => key == null)) return undefined;
  return { keys: [...base.keys, ...(keys as string[])], end: close + 1 };
}

/** An argument that is one `[ key ; value ; type ]` group. */
function isBracketGroup(arg: readonly Token[]): boolean {
  return isPunct(arg[0], "[") && closingIndex(arg, 0) === arg.length - 1;
}

/** A key path's first segment (`customer.id` → `customer`); undefined for one
 * that starts with an index (`[0]`) or isn't a literal. */
function firstSegment(path: string | undefined): string | undefined {
  const segment = path?.split(/[.[]/)[0];
  return segment ? segment : undefined;
}

/** Variables (lower case) that only ever hold `Get ( <what> )`: every enabled
 * step that sets one is a Set Variable to exactly that. */
export function holdersOf(steps: readonly StepIr[], what: string): Set<string> {
  const exact = new Set<string>();
  const other = new Set<string>();
  for (const step of steps) {
    if (!step.enabled || !step.setsVariable) continue;
    (isHolderStep(step, what) ? exact : other).add(step.setsVariable.toLowerCase());
  }
  return new Set([...exact].filter((name) => !other.has(name)));
}

/** A Set Variable to exactly `Get ( <what> )`. */
export function isHolderStep(step: StepIr, what: string): boolean {
  if (step.name !== "Set Variable" || !step.setsVariable) return false;
  const tokens = tokenize(step.calcs[0] ?? "");
  return tokens.length === GET_TOKENS && isGet(tokens, 0, what);
}

/** How many tokens at `i` stand for `Get ( <what> )`: 4 for the call, 1 for a
 * holder variable, 0 for neither. */
export function sourceAt(tokens: readonly Token[], i: number, what: string, holders: ReadonlySet<string>): number {
  if (isGet(tokens, i, what)) return GET_TOKENS;
  const token = tokens[i]!;
  return token.kind === "var" && holders.has(token.name.toLowerCase()) ? 1 : 0;
}

/** The key read when the source at `i` (`width` tokens) is the whole first
 * argument of `JSONGetElement ( … ; "key" )` (or JSONGetElementType). */
export function keyReadAt(tokens: readonly Token[], i: number, width: number): string | undefined {
  const fn = tokens[i - 2];
  if (!isPunct(tokens[i - 1], "(") || fn?.kind !== "name" || !/^jsongetelement(type)?$/i.test(fn.text)) return undefined;
  if (!isPunct(tokens[i + width], ";") || !isPunct(tokens[i + width + 2], ")")) return undefined;
  return firstSegment(literalArg([tokens[i + width + 1]!]));
}
