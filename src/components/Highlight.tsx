import { Fragment } from "react";
import { BROKEN_PLACEHOLDER_RE, isWordChar } from "@/core/identifiers";
import { objectLabel, type FmObject, type SolutionModel } from "@/types/ddr";
import { FieldRefLink } from "./FieldRefLink";

type TokenClass =
  | "string"
  | "var"
  | "field"
  | "func"
  | "kw"
  | "const"
  | "label"
  | "num"
  | "op"
  | "missing"
  | "comment"
  | null;

/** Logical operators: keywords wherever they appear, `not (` included. */
const LOGICAL = new Set(["and", "or", "xor", "not"]);
/** Functions that steer a calculation, coloured like the If / Loop steps. */
const CONTROL = new Set(["if", "case", "let", "while", "choose"]);
const CONSTANTS = new Set(["true", "false"]);
/** Step options FileMaker writes after a label ("With dialog: Off") or on
 * their own ("Set Error Capture [ On ]"). */
const OPTION_VALUES = new Set(["On", "Off"]);

// Name boundaries: whitespace, quotes, operators, brackets, separators, `$`, `¶`.
const DELIM = String.raw`\s"$=≠≤≥<>+\-*/^&;,(){}[\]¶`;
/** A char of a variable name. */
const VAR_CHAR = `[^${DELIM}]`;
/** A char of any other name (field, occurrence, function, …): anything that is
 * not a boundary, so Unicode letters, digits, `_`, `~` and `.` all count. */
const NAME_CHAR = `[^${DELIM}:]`;
const LOGICAL_WORD = `(?:and|or|xor|not)(?!${NAME_CHAR})`;
/** A name, spaces between its words included ("Due Date") — but never a
 * logical operator: FileMaker writes a name that contains one as `${…}`, so a
 * bare `and` next to a name is always the operator. */
const NAME = `${NAME_CHAR}(?:${NAME_CHAR}| (?!${LOGICAL_WORD})(?=${NAME_CHAR}))*`;

/** Ordered token matchers for FileMaker calculation / step-parameter syntax.
 * Sticky, so each one matches exactly where the previous token ended. A
 * `name` is a bare word whose colour depends on its neighbours (classify). */
const MATCHERS: { cls: TokenClass | "name"; re: RegExp; paramStart?: boolean }[] = [
  // Comments — matched before everything else so their content is never colored.
  { cls: "comment", re: /\/\*[\s\S]*?\*\//y },
  { cls: "comment", re: /\/\/[^\r\n]*/y },
  // A deleted reference FileMaker left as a placeholder ("<Field Missing>",
  // "<unknown>"), the same ones the model counts as broken — flagged before
  // `op` would swallow the leading "<".
  { cls: "missing", re: new RegExp(BROKEN_PLACEHOLDER_RE.source, "y") },
  // Require a closing quote so an unbalanced quote doesn't color the rest green.
  { cls: "string", re: /"(?:[^"\\]|\\.)*"/y },
  // A name FileMaker quotes in step text (“Layout”, “Script”). Before `func`,
  // which would take a name followed by ` (TO)` for a function call. A quoted
  // placeholder (“<unknown>”) stays a placeholder.
  { cls: "string", re: new RegExp(`“(?!(?:${BROKEN_PLACEHOLDER_RE.source})”)[^“”]*”`, "y") },
  // A step option's label ("Parameter:", "With dialog:", "Value:" with no
  // space after it), only where an option starts: at the beginning, or after
  // `[` or `;`. Never the `TO` of a `TO::Field`.
  { cls: "label", re: /\p{Lu}[\p{L}\p{N}/]*(?: [\p{L}\p{N}/]+)*:(?!:)/uy, paramStart: true },
  { cls: "var", re: new RegExp(String.raw`\$\$?${VAR_CHAR}+`, "uy") },
  // `TO::Field`; the occurrence half never starts with a logical operator.
  { cls: "field", re: new RegExp(`(?!${LOGICAL_WORD})${NAME}::${NAME}`, "iuy") },
  // A field part on its own, e.g. when LinkedCode already peeled the occurrence
  // off as a clickable link and left "::Field" behind — still greyed as a field.
  { cls: "field", re: new RegExp(`::${NAME}`, "iuy") },
  { cls: "func", re: new RegExp(String.raw`${NAME_CHAR}+(?=\s*\()`, "uy") },
  { cls: "num", re: /\d+(?:\.\d+)?|\.\d+/y },
  { cls: "const", re: /¶/y },
  { cls: "op", re: /[=≠≤≥<>+\-*/^&;,(){}[\]]/y },
  { cls: "name", re: new RegExp(`${NAME_CHAR}+`, "uy") },
  { cls: null, re: /\s+/y }, // whitespace
  { cls: null, re: /[^\s]/y }, // any other single char
];

interface Token {
  cls: TokenClass;
  text: string;
  start: number;
}

/** The colour of a function or bare word, from the word and the tokens before
 * it (`prev` is the nearest one that isn't whitespace or a comment). */
function classify(cls: TokenClass | "name", text: string, prev?: Token, prev2?: Token): TokenClass {
  if (cls !== "name" && cls !== "func") return cls;
  const word = text.toLowerCase();
  if (LOGICAL.has(word)) return "kw";
  if (cls === "func") return CONTROL.has(word) ? "kw" : "func";
  if (CONSTANTS.has(word)) return "const";
  const isOption = prev?.cls === "label" || prev?.text === "[" || prev?.text === ";";
  if (isOption && OPTION_VALUES.has(text)) return "const";
  // The constant in `Get ( AccountName )`.
  if (prev?.text === "(" && prev2?.text.toLowerCase() === "get") return "const";
  return null;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let prev: Token | undefined;
  let prev2: Token | undefined;
  let pos = 0;
  while (pos < input.length) {
    const atParamStart = prev == null || prev.text === "[" || prev.text === ";";
    for (const { cls, re, paramStart } of MATCHERS) {
      if (paramStart && !atParamStart) continue;
      re.lastIndex = pos;
      const match = re.exec(input);
      if (!match) continue;
      const token = { cls: classify(cls, match[0], prev, prev2), text: match[0], start: pos };
      tokens.push(token);
      pos += match[0].length;
      if (token.cls !== "comment" && /\S/.test(token.text)) [prev, prev2] = [token, prev];
      break;
    }
  }
  return tokens;
}

/** A `TO::Field` reference that reached the highlighter unlinked is, by
 * construction, not clickable (LinkedCode extracts every resolvable field as a
 * button first) — i.e. external or unresolved. Render the occurrence in the
 * occurrence colour and the field grey, mirroring how external references read
 * elsewhere. */
function FieldToken({ text }: { text: string }) {
  const sep = text.indexOf("::");
  if (sep < 0) return <span className="syn-field">{text}</span>;
  return (
    <>
      {sep > 0 && <span className="syn-to">{text.slice(0, sep)}</span>}
      {"::"}
      <span className="syn-field">{text.slice(sep + 2)}</span>
    </>
  );
}

function TokenText({ cls, text }: { cls: TokenClass; text: string }) {
  if (cls === "field") return <FieldToken text={text} />;
  if (cls) return <span className={`syn-${cls}`}>{text}</span>;
  return <>{text}</>;
}

/** Render text with FileMaker-flavored syntax highlighting. */
export function Highlight({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t) => (
        <TokenText key={t.start} cls={t.cls} text={t.text} />
      ))}
    </>
  );
}

/** Renders the stretch [from, to) of the tokenized text, each piece in its
 * token's colour (a token cut by a link keeps its colour on both sides).
 * Stretches must be asked for in order. */
function tokenRenderer(tokens: Token[]) {
  let first = 0;
  return (from: number, to: number): React.ReactNode[] => {
    while (first < tokens.length && tokens[first]!.start + tokens[first]!.text.length <= from) first++;
    const out: React.ReactNode[] = [];
    for (let k = first; k < tokens.length && tokens[k]!.start < to; k++) {
      const t = tokens[k]!;
      const start = Math.max(from, t.start);
      const text = t.text.slice(start - t.start, Math.min(to, t.start + t.text.length) - t.start);
      out.push(<TokenText key={`t${start}`} cls={t.cls} text={text} />);
    }
    return out;
  };
}

/** Tokens no object name is linked inside: they never name an object. */
const UNLINKED = new Set<TokenClass>(["comment", "label", "missing"]);

/**
 * Syntax-highlighted code (a calculation body, a script step's parameters, a
 * trigger parameter) with the objects it references made clickable in place.
 * Each object's name is matched as a whole token — longest names first, so a
 * field links inside `TO::Field` and a dotted custom-function name links whole —
 * and the gaps between matches keep their normal highlighting. Names are matched
 * literally, so periods, tildes, and other non-word characters in object names
 * are handled.
 */
export function LinkedCode({
  text,
  objects,
  onGo,
  model,
  owner,
}: {
  text: string;
  objects: FmObject[];
  onGo: (uid: string, rowKey: string) => void;
  /** When passed, qualified `TO::Field` matches delegate to FieldRefLink, which
   * shows the owner's own reference to that field the way the property sheets
   * do. Optional for callers that link names only. */
  model?: SolutionModel;
  /** The object the text belongs to (its uid). */
  owner?: string;
}) {
  // Unique candidates, longest name first so "DATA~MAIN" wins over "DATA" and
  // "Access.canEdit" wins over "Access".
  const cands = [...new Map(objects.filter((o) => o.name).map((o) => [o.name, o])).values()].sort(
    (a, b) => b.name.length - a.name.length,
  );
  if (cands.length === 0) return <Highlight text={text} />;

  // Occurrence candidates (longest name first), kept separate from `cands` so
  // that detecting the `TO::` half of a qualified ref never depends on the
  // by-name dedup above: in FileMaker a field, base table, and layout can all
  // share the occurrence's name (e.g. "Stock", "Stock_Batches"), and
  // whichever won the dedup would otherwise shadow the occurrence and break the
  // `TO::Field` link. The field shown is then the owner's own reference to it
  // (ownFieldRef), with the model's verdict on it.
  const occCands = objects
    .filter((o) => o.type === "tableOccurrence" && o.name)
    .sort((a, b) => b.name.length - a.name.length);

  // The whole text is coloured once and the links laid over it, so a link
  // can't split a string or comment in two, and a link takes the colour of
  // the token it sits in (a linked `$$global` stays a variable).
  const tokens = tokenize(text);
  const render = tokenRenderer(tokens);
  let ti = 0;
  const tokenAt = (pos: number): Token => {
    while (tokens[ti]!.start + tokens[ti]!.text.length <= pos) ti++;
    return tokens[ti]!;
  };
  const canQualify = model != null && owner != null;

  const out: React.ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  const flush = (end: number) => {
    if (end > plainStart) out.push(...render(plainStart, end));
  };
  while (i < text.length) {
    const token = tokenAt(i);
    if (UNLINKED.has(token.cls)) {
      i = token.start + token.text.length;
      continue;
    }
    // Detect the `TO::Field` shape first, using the occurrence-only candidates
    // for the `TO` half so a same-named field/table/layout can't shadow it.
    // The whole span renders through FieldRefLink (one source of truth for
    // resolved / external / broken styling), which shows the owner's reference.
    let qualifiedLength = 0;
    if (canQualify) {
      const toCand = occCands.find(
        (o) =>
          text.startsWith(o.name, i) &&
          !isWordChar(text[i - 1] ?? "") &&
          text.startsWith("::", i + o.name.length),
      );
      if (toCand) {
        const fieldStart = i + toCand.name.length + 2;
        const fieldHit = cands.find(
          (o) =>
            text.startsWith(o.name, fieldStart) &&
            !isWordChar(text[fieldStart + o.name.length] ?? ""),
        );
        if (fieldHit) qualifiedLength = toCand.name.length + 2 + fieldHit.name.length;
      }
    }

    const hit = cands.find(
      (o) =>
        text.startsWith(o.name, i) &&
        // Don't match the tail of a $local / $$global variable: `$_id_parent`
        // must not link its `_id_parent` portion to a same-named field/TO.
        text[i - 1] !== "$" &&
        !isWordChar(text[i - 1] ?? "") &&
        !isWordChar(text[i + o.name.length] ?? ""),
    );
    if (!hit && qualifiedLength === 0) {
      i++;
      continue;
    }
    flush(i);
    if (qualifiedLength > 0) {
      const span = text.slice(i, i + qualifiedLength);
      out.push(
        <FieldRefLink key={`q${i}`} qualified={span} model={model!} owner={owner!} onGo={onGo} />,
      );
      i += qualifiedLength;
    } else if (hit) {
      const link = (
        <button
          type="button"
          className="obj-link"
          title={objectLabel(hit)}
          onClick={() => onGo(hit.uid, `link:${hit.uid}`)}
        >
          {hit.name}
        </button>
      );
      // A field token's halves are coloured by FieldToken, not as a whole.
      out.push(
        token.cls && token.cls !== "field" ? (
          <span key={`l${i}`} className={`syn-${token.cls}`}>{link}</span>
        ) : (
          <Fragment key={`l${i}`}>{link}</Fragment>
        ),
      );
      i += hit.name.length;
    }
    plainStart = i;
  }
  flush(text.length);
  return <>{out}</>;
}
