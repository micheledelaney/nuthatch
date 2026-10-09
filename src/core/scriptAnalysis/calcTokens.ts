import { inertEnd } from "@/core/parser/calcLiterals";
import { isNameChar } from "@/core/identifiers";

/**
 * A formula as tokens: enough of FileMaker's calculation syntax to tell which
 * variables it reads and sets and which functions it calls — not a parser.
 * Comments are dropped; string literals are kept, unescaped, since their text
 * isn't code.
 */
export type Token =
  /** `$name` or `$$name`, as written. */
  | { kind: "var"; name: string }
  /** A function, field, occurrence, Let-variable or keyword name, or a number. */
  | { kind: "name"; text: string }
  | { kind: "string"; value: string }
  /** Any other character: `(`, `)`, `[`, `]`, `;`, `=`, `&` … */
  | { kind: "punct"; text: string };

export function tokenize(formula: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < formula.length; ) {
    const c = formula[i]!;
    const inert = inertEnd(formula, i);
    if (inert > i) {
      if (c === '"') out.push({ kind: "string", value: unescape(formula.slice(i + 1, formula[inert - 1] === '"' && inert - 1 > i ? inert - 1 : inert)) });
      i = inert;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "$" && formula[i + 1] === "{") {
      // ${Field name}: a field name FileMaker had to quote, not a variable.
      const close = formula.indexOf("}", i + 2);
      out.push({ kind: "name", text: formula.slice(i + 2, close === -1 ? formula.length : close) });
      i = close === -1 ? formula.length : close + 1;
    } else if (c === "$") {
      const start = formula[i + 1] === "$" ? i + 2 : i + 1;
      const end = nameEnd(formula, start);
      if (end > start) out.push({ kind: "var", name: formula.slice(i, end) });
      else out.push({ kind: "punct", text: c });
      i = Math.max(end, i + 1);
    } else if (isNameChar(c)) {
      const end = nameEnd(formula, i);
      out.push({ kind: "name", text: formula.slice(i, end) });
      i = end;
    } else {
      out.push({ kind: "punct", text: c });
      i++;
    }
  }
  return out;
}

function nameEnd(formula: string, from: number): number {
  let j = from;
  while (isNameChar(formula[j])) j++;
  return j;
}

/** FileMaker's `\"`, `\\` and `\¶` escapes undone. */
function unescape(body: string): string {
  return body.replace(/\\(["\\¶])/g, "$1");
}

export function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

/** Whether `tokens[at]` is a call of `fn` (a lower-case function name). */
export function isCall(tokens: readonly Token[], at: number, fn: string): boolean {
  const token = tokens[at];
  return token?.kind === "name" && token.text.toLowerCase() === fn && isPunct(tokens[at + 1], "(");
}

/** Every name the formula calls as a function, in lower case. */
export function calledFunctions(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((token, i) => {
    if (token.kind === "name" && isPunct(tokens[i + 1], "(")) out.push(token.text.toLowerCase());
  });
  return out;
}

/** Every name that may be a call, in lower case: one followed by `(`, or a
 * bare one — how a custom function without parameters is called — that isn't
 * either side of a `TO::Field`. */
export function calledNames(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== "name") return;
    const isFieldPart = isPunct(tokens[i - 1], ":") && isPunct(tokens[i - 2], ":");
    const isOccurrence = isPunct(tokens[i + 1], ":") && isPunct(tokens[i + 2], ":");
    if (!isFieldPart && !isOccurrence) out.push(token.text.toLowerCase());
  });
  return out;
}

/** Whether `tokens[at…]` is `Get ( <what> )`, e.g. `Get ( ScriptParameter )`
 * for "scriptparameter" (a lower-case name). */
export function isGet(tokens: readonly Token[], at: number, what: string): boolean {
  const arg = tokens[at + 2];
  return isCall(tokens, at, "get") && arg?.kind === "name" && arg.text.toLowerCase() === what && isPunct(tokens[at + 3], ")");
}

/** The number of tokens a `Get ( … )` takes. */
export const GET_TOKENS = 4;

/** +1 for an opening `(` or `[`, -1 for a closing one, else 0. */
function bracketStep(token: Token): number {
  if (token.kind !== "punct") return 0;
  if (token.text === "(" || token.text === "[") return 1;
  return token.text === ")" || token.text === "]" ? -1 : 0;
}

/** The index of the bracket that closes the `(` or `[` at `open`; the end of
 * the tokens when it isn't closed. */
export function closingIndex(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    depth += bracketStep(token);
    if (depth === 0) return i;
  }
  return tokens.length;
}

/** The arguments of the bracket group opened at `open` — split at its own
 * `;`s, not those of a nested call or `[…]` — and where it closes. */
export function bracketArgs(tokens: readonly Token[], open: number): { args: Token[][]; close: number } {
  const close = closingIndex(tokens, open);
  const args: Token[][] = [[]];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]!;
    depth += bracketStep(token);
    if (depth === 0 && isPunct(token, ";")) args.push([]);
    else args[args.length - 1]!.push(token);
  }
  return { args, close };
}

/** The variables a formula reads and the ones its `Let` definitions set
 * (`Let ( [ $x = … ] ; … )`), each as written, in order. */
export function variableUses(tokens: readonly Token[]): { reads: string[]; sets: string[] } {
  const setAt = letDefinedVariables(tokens);
  const reads: string[] = [];
  const sets: string[] = [];
  tokens.forEach((token, i) => {
    if (token.kind === "var") (setAt.has(i) ? sets : reads).push(token.name);
  });
  return { reads, sets };
}

/** Indexes of the variable tokens a `Let` defines: the name before the `=` of
 * each definition — `$x = …` or `$x[2] = …`. */
function letDefinedVariables(tokens: readonly Token[]): Set<number> {
  const out = new Set<number>();
  tokens.forEach((_, i) => {
    if (!isCall(tokens, i, "let")) return;
    const { args } = bracketArgs(tokens, i + 1);
    const definitions = args[0] ?? [];
    const list = isPunct(definitions[0], "[") ? bracketArgs(definitions, 0).args : [definitions];
    for (const definition of list) {
      const [first] = definition;
      if (first?.kind !== "var") continue;
      const next = isPunct(definition[1], "[") ? closingIndex(definition, 1) + 1 : 1;
      if (isPunct(definition[next], "=")) out.add(tokens.indexOf(first, i));
    }
  });
  return out;
}

/** A string literal that is the whole of `arg`. */
export function literalArg(arg: readonly Token[] | undefined): string | undefined {
  const [only] = arg ?? [];
  return arg?.length === 1 && only?.kind === "string" ? only.value : undefined;
}
