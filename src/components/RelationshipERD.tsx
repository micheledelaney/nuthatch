import type { FmObject, JoinPredicate, ObjectType, RelationshipSide } from "@/types/ddr";

const TITLE_H = 28;
const ROW_H = 26;
const TOP = 6;
const PAD = 10; // horizontal padding inside a box
const GAP = 60; // space between the two boxes for the link line + operator
const MIN_BOX_W = 80;

const TITLE_FONT = 11;
const FIELD_FONT = 10;

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

  const W = leftBoxW + GAP + rightBoxW;
  const LEFT_X = 0;
  const RIGHT_X = W - rightBoxW;
  const CENTER_X = LEFT_X + leftBoxW + GAP / 2;

  const bodyTop = TOP + TITLE_H + 6;
  const height = bodyTop + rows * ROW_H + 6;
  const rowY = (i: number) => bodyTop + i * ROW_H + ROW_H / 2;

  return (
    <div className="graph-wrap">
      <svg width={W} height={height} role="img" aria-label="Relationship diagram">
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
      </svg>
      <CascadeNotes leftTable={leftTable} rightTable={rightTable} left={left} right={right} />
    </div>
  );
}

/** The per-side cascade/sort settings beneath the diagram. Rendered only for the
 * sides that have a non-default setting, so plain relationships stay uncluttered. */
function CascadeNotes({
  leftTable,
  rightTable,
  left,
  right,
}: {
  leftTable: string;
  rightTable: string;
  left?: RelationshipSide;
  right?: RelationshipSide;
}) {
  const notes = [
    [leftTable, left],
    [rightTable, right],
  ]
    .map(([table, side]) => {
      const s = side as RelationshipSide | undefined;
      if (!s) return null;
      const flags: string[] = [];
      if (s.cascadeCreate) flags.push("allow creation");
      if (s.cascadeDelete) flags.push("delete related");
      if (s.sorted) flags.push("sorted");
      return flags.length ? `${table as string}: ${flags.join(", ")}` : null;
    })
    .filter((n): n is string => n != null);

  if (notes.length === 0) return null;
  return (
    <ul className="rel-cascade subtle">
      {notes.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
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
    <g className={`erd-node${onClick ? " clickable" : ""}`} onClick={onClick}>
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

/** A predicate field name: an invisible hit/highlight box behind the label so
 * hovering it shows the same bg-elevated highlight as any other inline link,
 * instead of a one-off accent+underline treatment. The hit box spans the whole
 * table box (minus a small inset), matching the full-width row hover elsewhere. */
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
    <g className={`erd-field-label${onClick ? " clickable" : ""}`} onClick={onClick}>
      {onClick && (
        <rect
          className="erd-field-hit"
          x={boxX + FIELD_HIT_INSET}
          y={y - FIELD_HIT_H / 2}
          width={boxW - FIELD_HIT_INSET * 2}
          height={FIELD_HIT_H}
          rx={3}
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
