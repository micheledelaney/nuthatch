import { Fragment } from "react";
import { decodeEntities } from "@/core/parser/entities";
import { isWordChar } from "@/core/identifiers";
import { objectLabel, type FmObject, type SolutionModel } from "@/types/ddr";
import { FieldRefLink } from "./FieldRefLink";

export { decodeEntities };

type TokenClass = "string" | "var" | "field" | "func" | "kw" | "num" | "op" | "missing" | "comment" | null;

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "xor",
  "let",
  "case",
  "if",
  "end",
  "true",
  "false",
]);

/** Ordered token matchers for FileMaker calculation / step-parameter syntax. */
const MATCHERS: { cls: TokenClass; re: RegExp }[] = [
  // Comments — matched before everything else so their content is never colored.
  { cls: "comment", re: /^\/\*[\s\S]*?\*\// },
  { cls: "comment", re: /^\/\/[^\r\n]*/ },
  // A deleted reference FileMaker left as a placeholder, e.g. "<Field Missing>"
  // or "<Table Missing>" — flagged before `op` would swallow the leading "<".
  { cls: "missing", re: /^<[^<>]*Missing>/ },
  // Require a closing quote so an unbalanced quote doesn't color the rest green.
  { cls: "string", re: /^"(?:[^"\\]|\\.)*"/ },
  // Name chars: anything that is not an operator, delimiter, whitespace, or quote.
  // This covers Unicode letters (ä, ü, …), digits, underscore, tilde, period, etc.
  { cls: "var", re: /^\$\$?(?:[^\s"$=≠≤≥<>+\-*/&;,(){}[\]]|(?<=\S) (?=[^\s"$=≠≤≥<>+\-*/&;,(){}[\]]))+/u },
  { cls: "field", re: /^(?:[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]|(?<=\S) (?=[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]))+::(?:[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]|(?<=\S) (?=[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]))+/u },
  // A field part on its own, e.g. when LinkedCode already peeled the occurrence
  // off as a clickable link and left "::Field" behind — still greyed as a field.
  { cls: "field", re: /^::(?:[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]|(?<=\S) (?=[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]))+/u },
  { cls: "func", re: /^[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]+(?=\s*\()/u },
  { cls: "num", re: /^\d+(?:\.\d+)?/ },
  { cls: "op", re: /^[=≠≤≥<>+\-*/&;,(){}[\]]/ },
  { cls: null, re: /^[^\s"$:=≠≤≥<>+\-*/&;,(){}[\]]+/u }, // identifier (maybe keyword)
  { cls: null, re: /^\s+/ }, // whitespace
  { cls: null, re: /^[^\s]/ }, // any other single char
];

interface Token {
  cls: TokenClass;
  text: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let rest = input;
  let guard = 0;
  while (rest.length > 0 && guard++ < 20000) {
    for (const { cls, re } of MATCHERS) {
      const match = re.exec(rest);
      if (!match) continue;
      const text = match[0];
      const resolved = cls === null && KEYWORDS.has(text.toLowerCase()) ? "kw" : cls;
      tokens.push({ cls: resolved, text });
      rest = rest.slice(text.length);
      break;
    }
  }
  return tokens;
}

/** A `TO::Field` reference that reached the highlighter unlinked is, by
 * construction, not clickable (LinkedCode extracts every resolvable field as a
 * button first) — i.e. external or unresolved. Render the occurrence blue and
 * the field grey, mirroring how external references read elsewhere. */
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

/** Render text with FileMaker-flavored syntax highlighting. */
export function Highlight({ text }: { text: string }) {
  const tokens = tokenize(decodeEntities(text));
  return (
    <>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.cls === "field" ? (
            <FieldToken text={t.text} />
          ) : t.cls ? (
            <span className={`syn-${t.cls}`}>{t.text}</span>
          ) : (
            t.text
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Returns ranges [start, end) that are inside line or block comments, skipping string literals. */
function commentRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
    } else if (text[i] === '/' && text[i + 1] === '/') {
      const start = i;
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      ranges.push([start, end]);
      i = end;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const start = i;
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      ranges.push([start, end]);
      i = end;
    } else {
      i++;
    }
  }
  return ranges;
}

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
  fileUid,
}: {
  text: string;
  objects: FmObject[];
  onGo: (uid: string, rowKey: string) => void;
  /** When passed, qualified `TO::Field` matches delegate to FieldRefLink so
   * the field half goes through the same resolver the property sheets use —
   * keeps external/missing rendering consistent everywhere. Optional for
   * back-compat with callers that haven't been threaded through yet. */
  model?: SolutionModel;
  fileUid?: string;
}) {
  const decoded = decodeEntities(text);
  // Unique candidates, longest name first so "DATA~FOCUS" wins over "DATA" and
  // "Access.canEdit" wins over "Access".
  const cands = [...new Map(objects.filter((o) => o.name).map((o) => [o.name, o])).values()].sort(
    (a, b) => b.name.length - a.name.length,
  );
  if (cands.length === 0) return <Highlight text={decoded} />;

  // Occurrence candidates (longest name first), kept separate from `cands` so
  // that detecting the `TO::` half of a qualified ref never depends on the
  // by-name dedup above: in FileMaker a field, base table, and layout can all
  // share the occurrence's name (e.g. "Material", "Material_Chargen"), and
  // whichever won the dedup would otherwise shadow the occurrence and break the
  // `TO::Field` link. The field target is then resolved by id via the
  // occurrence's base table (resolveQualifiedRef), not by name-matching.
  const occCands = objects
    .filter((o) => o.type === "tableOccurrence" && o.name)
    .sort((a, b) => b.name.length - a.name.length);

  const comments = commentRanges(decoded);
  const inComment = (pos: number) => comments.some(([s, e]) => pos >= s && pos < e);
  const canQualify = model != null && fileUid != null;

  const out: React.ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  const flush = (end: number) => {
    if (end > plainStart) out.push(<Highlight key={`h${plainStart}`} text={decoded.slice(plainStart, end)} />);
  };
  while (i < decoded.length) {
    if (inComment(i)) {
      i++;
      continue;
    }
    // Detect the `TO::Field` shape first, using the occurrence-only candidates
    // for the `TO` half so a same-named field/table/layout can't shadow it.
    // The whole span renders through FieldRefLink (one source of truth for
    // resolved / external / broken styling), which resolves the field by id.
    let qualifiedLength = 0;
    if (canQualify) {
      const toCand = occCands.find(
        (o) =>
          decoded.startsWith(o.name, i) &&
          !isWordChar(decoded[i - 1] ?? "") &&
          decoded.startsWith("::", i + o.name.length),
      );
      if (toCand) {
        const fieldStart = i + toCand.name.length + 2;
        const fieldHit = cands.find(
          (o) =>
            decoded.startsWith(o.name, fieldStart) &&
            !isWordChar(decoded[fieldStart + o.name.length] ?? ""),
        );
        if (fieldHit) qualifiedLength = toCand.name.length + 2 + fieldHit.name.length;
      }
    }

    const hit = cands.find(
      (o) =>
        decoded.startsWith(o.name, i) &&
        // Don't match the tail of a $local / $$global variable: `$_id_bezug`
        // must not link its `_id_bezug` portion to a same-named field/TO.
        decoded[i - 1] !== "$" &&
        !isWordChar(decoded[i - 1] ?? "") &&
        !isWordChar(decoded[i + o.name.length] ?? ""),
    );
    if (!hit && qualifiedLength === 0) {
      i++;
      continue;
    }
    flush(i);
    if (qualifiedLength > 0) {
      const span = decoded.slice(i, i + qualifiedLength);
      out.push(
        <FieldRefLink key={`q${i}`} qualified={span} model={model!} fileUid={fileUid!} onGo={onGo} />,
      );
      i += qualifiedLength;
    } else if (hit) {
      out.push(
        <button
          key={`l${i}`}
          type="button"
          className="obj-link"
          title={objectLabel(hit)}
          onClick={() => onGo(hit.uid, `link:${hit.uid}`)}
        >
          {hit.name}
        </button>,
      );
      i += hit.name.length;
    }
    plainStart = i;
  }
  flush(decoded.length);
  return <>{out}</>;
}
