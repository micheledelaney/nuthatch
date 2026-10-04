import type { FmObject, JoinPredicate, ObjectType, RelationshipSide } from "@/types/ddr";
import { pressable } from "./a11y";

const TITLE_H = 28;
const ROW_H = 26;
const TOP = 6;
const PAD = 10; // horizontal padding inside a box
const GAP = 60; // space between the two boxes for the link line + operator
const MIN_BOX_W = 80;

const TITLE_FONT = 11;
const FIELD_FONT = 10;
const NOTE_FONT = 11;
const NOTE_H = 16; // line height of the cascade/sort notes under a box

/** A compact ERD for a relationship: the two table occurrences and the field
 * pairs (with comparison operator) that join them. */
export function RelationshipERD({
  leftTable,
  rightTable,
  predicates,
  left,
  right,
  resolve,
  onGo,
}: {
  leftTable: string;
  rightTable: string;
  predicates: JoinPredicate[];
  left?: RelationshipSide;
  right?: RelationshipSide;
  /** Resolve a name (optionally typed) to a navigable object, so the table
   * occurrences and predicate fields can be made clickable. */
  resolve?: (name: string, type?: ObjectType) => FmObject | null;
  onGo?: (uid: string, rowKey: string) => void;
}) {
  const rows = Math.max(predicates.length, 1);

  // A click handler for a name, or undefined when it can't be resolved/navigated.
  const linkTo = (name: string, type: ObjectType): (() => void) | undefined => {
    const o = resolve?.(name, type);
    return o && onGo ? () => onGo(o.uid, `link:${o.uid}`) : undefined;
  };

  const leftBoxW = boxWidth(leftTable, predicates.map((p) => p.leftField));
  const rightBoxW = boxWidth(rightTable, predicates.map((p) => p.rightField));

  const leftNotes = sideNotes(left);
  const rightNotes = sideNotes(right);

  const boxesW = leftBoxW + GAP + rightBoxW;
  const LEFT_X = 0;
  const RIGHT_X = boxesW - rightBoxW;
  const CENTER_X = LEFT_X + leftBoxW + GAP / 2;
  // A note can be wider than its box; keep the right-hand one inside the SVG.
  const W = Math.max(boxesW, RIGHT_X + notesWidth(rightNotes));

  const bodyTop = TOP + TITLE_H + 6;
  const boxBottom = bodyTop + rows * ROW_H + 4;
  const noteRows = Math.max(leftNotes.length, rightNotes.length);
  const height = bodyTop + rows * ROW_H + 6 + (noteRows > 0 ? 4 + noteRows * NOTE_H : 0);
  const rowY = (i: number) => bodyTop + i * ROW_H + ROW_H / 2;

  return (
    <div className="graph-wrap">
      <svg width={W} height={height} role="group" aria-label="Relationship diagram">
        <TableBox x={LEFT_X} width={leftBoxW} rows={rows} label={leftTable} onClick={linkTo(leftTable, "tableOccurrence")} />
        <TableBox x={RIGHT_X} width={rightBoxW} rows={rows} label={rightTable} onClick={linkTo(rightTable, "tableOccurrence")} />

        {predicates.length === 0 && (
          <text className="erd-empty" x={CENTER_X} y={rowY(0)} textAnchor="middle">
            (no predicate fields)
          </text>
        )}

        {predicates.map((p, i) => {
          const y = rowY(i);
          const leftClick = linkTo(p.leftField, "field");
          const rightClick = linkTo(p.rightField, "field");
          return (
            <g key={i}>
              <line className="erd-link" x1={LEFT_X + leftBoxW} y1={y} x2={RIGHT_X} y2={y} />
              <FieldLabel text={p.leftField} x={LEFT_X + leftBoxW - PAD} boxX={LEFT_X} boxW={leftBoxW} y={y} align="end" onClick={leftClick} />
              <text className="erd-op" x={CENTER_X} y={y - 3} textAnchor="middle">
                {p.operator}
              </text>
              <FieldLabel text={p.rightField} x={RIGHT_X + PAD} boxX={RIGHT_X} boxW={rightBoxW} y={y} align="start" onClick={rightClick} />
            </g>
          );
        })}

        <BoxNotes x={LEFT_X} top={boxBottom} lines={leftNotes} />
        <BoxNotes x={RIGHT_X} top={boxBottom} lines={rightNotes} />
      </svg>
    </div>
  );
}

/** The non-default cascade/sort settings of one side, one per line, so plain
 * relationships stay uncluttered. */
function sideNotes(side?: RelationshipSide): string[] {
  if (!side) return [];
  const flags: string[] = [];
  if (side.cascadeCreate) flags.push("allow creation");
  if (side.cascadeDelete) flags.push("delete related");
  if (side.sorted) flags.push("sorted");
  return flags;
}

function notesWidth(lines: string[]): number {
  return Math.ceil(lines.reduce((max, l) => Math.max(max, estTextWidth(l, NOTE_FONT, false)), 0));
}

/** A box's notes, left-aligned underneath it. */
function BoxNotes({ x, top, lines }: { x: number; top: number; lines: string[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <text key={l} className="erd-note" x={x} y={top + 14 + i * NOTE_H}>
          {l}
        </text>
      ))}
    </>
  );
}

/** A table occurrence's box: one seamless card (outline, title bar, divider,
 * field rows) instead of a separate title box floating over a separate field
 * box — matches the node styling in the full relationship graph view. */
function TableBox({
  x,
  width,
  rows,
  label,
  onClick,
}: {
  x: number;
  width: number;
  rows: number;
  label: string;
  onClick?: () => void;
}) {
  const boxHeight = TITLE_H + 10 + rows * ROW_H;
  return (
    <g className={`erd-node${onClick ? " clickable" : ""}`} aria-label={label || undefined} {...pressable(() => onClick?.(), { inert: !onClick })}>
      <rect className="erd-box" x={x} y={TOP} width={width} height={boxHeight} rx={6} />
      <rect className="erd-titlebar" x={x} y={TOP} width={width} height={Math.min(TITLE_H, boxHeight)} rx={6} />
      {boxHeight > TITLE_H && (
        <rect className="erd-titlebar" x={x} y={TOP + TITLE_H / 2} width={width} height={TITLE_H / 2} />
      )}
      <line className="erd-divider" x1={x} y1={TOP + TITLE_H} x2={x + width} y2={TOP + TITLE_H} />
      <text className="erd-title" x={x + width / 2} y={TOP + TITLE_H / 2 + 4} textAnchor="middle">
        {label || "—"}
      </text>
    </g>
  );
}

const FIELD_HIT_H = 18;
/** Inset of the field hover/hit box from each side of the table box, so the
 * highlight spans almost the full box width (like a navigator row) with a little
 * breathing room on each side, rather than hugging the text. */
const FIELD_HIT_INSET = 4;

/** A predicate field name: an invisible hit pill behind the label, so hovering
 * it shows the same grey fill as a row. The pill spans the whole table box
 * (minus a small inset), like the full-width row hover elsewhere. */
function FieldLabel({
  text,
  x,
  boxX,
  boxW,
  y,
  align,
  onClick,
}: {
  text: string;
  x: number;
  boxX: number;
  boxW: number;
  y: number;
  align: "start" | "end";
  onClick?: () => void;
}) {
  return (
    <g className={`erd-field-label${onClick ? " clickable" : ""}`} aria-label={text} {...pressable(() => onClick?.(), { inert: !onClick })}>
      {onClick && (
        <rect
          className="erd-field-hit"
          x={boxX + FIELD_HIT_INSET}
          y={y - FIELD_HIT_H / 2}
          width={boxW - FIELD_HIT_INSET * 2}
          height={FIELD_HIT_H}
          rx={6}
        />
      )}
      <text className="erd-field" x={x} y={y + 4} textAnchor={align}>
        {text}
      </text>
    </g>
  );
}

/** Width needed to fit the (bold) title and the widest (regular) field, plus padding. */
function boxWidth(title: string, fields: string[]): number {
  const titleW = estTextWidth(title || "—", TITLE_FONT, true);
  const fieldW = fields.reduce((max, f) => Math.max(max, estTextWidth(f, FIELD_FONT, false)), 0);
  return Math.max(MIN_BOX_W, Math.ceil(Math.max(titleW, fieldW) + PAD * 2));
}

/** Estimate rendered text width without DOM measurement (good enough for SVG sizing). */
function estTextWidth(text: string, fontSize: number, bold: boolean): number {
  return text.length * fontSize * (bold ? 0.62 : 0.58);
}
