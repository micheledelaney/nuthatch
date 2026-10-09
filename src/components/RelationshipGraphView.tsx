import { SearchIcon } from "./workbench/CommandPalette";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { buildRelationshipGraph, type FileGraph, type GraphNode } from "@/core/analysis/relationshipGraph";

const PAD = 16;
const TITLE_H = 22;
const ROW_H = 15;
const FIELD_CAP = 60;
const FONT = 12;
const MIN_SCALE = 0.1;
const MAX_SCALE = 2;
/** Zoom level used when opening the graph focused on a specific occurrence — close
 * enough to read it, rather than the zoomed-out fit-to-width default. */
const FOCUS_SCALE = 1.5;

type CascadeRule = "del" | "create" | "sort";

/** The cascade rules a relationship line can be colored by, in priority order:
 * a line with several rules takes the first one that's switched on. */
const CASCADE_RULES: { key: CascadeRule; label: string; title: string }[] = [
  { key: "del", label: "Delete", title: "Delete related records" },
  { key: "create", label: "Create", title: "Allow creation of records" },
  { key: "sort", label: "Sorted", title: "Sorted relationship" },
];

// function orthogonalPath(x1: number, y1: number, x2: number, y2: number): string {
//   const dx = x2 - x1;
//   const absDx = Math.abs(dx);
//   // Minimum arm so curves don't collapse when boxes are close/overlapping
//   const cp = Math.max(absDx / 2, 60);
//   const sign = dx >= 0 ? 1 : -1;
//   return `M ${x1} ${y1} C ${x1 + sign * cp} ${y1}, ${x2 - sign * cp} ${y2}, ${x2} ${y2}`;
// }
function orthogonalPath(x1: number, y1: number, x2: number, y2: number): string {
  const midX = (x1 + x2) / 2;

  return `
    M ${x1} ${y1}
    L ${midX} ${y1}
    L ${midX} ${y2}
    L ${x2} ${y2}
  `;
}

function getAnchorPoint(n: GraphNode, expanded: boolean, side: "left" | "right") {
  const h = drawnHeight(n, expanded);
  return {
    x: side === "left" ? n.left : n.right,
    y: n.top + h / 2,
  };
}

function shownFields(n: GraphNode, expanded: boolean): { rows: string[]; overflow: number } {
  if (!expanded || n.fields.length === 0) return { rows: [], overflow: 0 };
  if (n.fields.length <= FIELD_CAP) return { rows: n.fields, overflow: 0 };
  return { rows: n.fields.slice(0, FIELD_CAP), overflow: n.fields.length - FIELD_CAP };
}

function drawnHeight(n: GraphNode, expanded: boolean): number {
  const { rows, overflow } = shownFields(n, expanded);
  return TITLE_H + (rows.length + (overflow > 0 ? 1 : 0)) * ROW_H;
}

/** A box's colours, drawn like the type tags: the occurrence's colour toned
 * toward the ground for the border and the name, with a faint tint of it as
 * the title bar's fill. */
function boxColors(color: string | undefined): { fill: string; border: string; text: string } {
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : "var(--accent)";
  return {
    fill: `color-mix(in srgb, ${c} 14%, var(--nh-deep))`,
    border: `color-mix(in srgb, ${c} var(--tag-border), var(--nh-deep))`,
    text: `color-mix(in srgb, ${c} 92%, var(--nh-deep))`,
  };
}

/** Truncate `name` to the characters that fit in `avail` px of text width.
 * `avail` is the space already net of the box's padding, so don't subtract more. */
function fit(name: string, avail: number, font: number): string {
  const max = Math.max(1, Math.floor(avail / (font * 0.58)));
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const centerX = (n: GraphNode) => (n.left + n.right) / 2;

export function RelationshipGraphView() {
  const model = useStore((s) => s.model);
  const openObject = useStore((s) => s.openObject);
  const setNavType = useStore((s) => s.setNavType);
  const setNavRelFilter = useStore((s) => s.setNavRelFilter);
  const graphFocus = useStore((s) => s.graphFocus);
  const clearGraphFocus = useStore((s) => s.clearGraphFocus);

  const graphs = useMemo(() => (model ? buildRelationshipGraph(model) : []), [model]);
  const [fileUid, setFileUid] = useState<string | null>(null);
  // A focus target (opened from a table occurrence elsewhere) lives in another
  // file's graph as often as not, so switch to that file before drawing.
  const focusFileUid = graphFocus ? model?.byUid.get(graphFocus)?.fileUid ?? null : null;
  useEffect(() => {
    if (focusFileUid) setFileUid(focusFileUid);
  }, [focusFileUid]);
  const graph = graphs.find((g) => g.fileUid === fileUid) ?? graphs[0] ?? null;

  const reveal = (uid: string, type: "tableOccurrence" | "relationship") => {
    setNavType(type);
    if (type === "relationship") setNavRelFilter("all");
    openObject(uid);
  };

  if (!model) return null;
  if (graphs.length === 0) {
    return (
      <div className="panel">
        <div className="subtle">No table occurrences with graph coordinates were found.</div>
      </div>
    );
  }

  return (
    <div className="panel fmg-panel">
      <GraphCanvas
        key={graph!.fileUid}
        graph={graph!}
        head={
          <>
            <span className="subtle">
              {graph!.nodes.length} occurrences · {graph!.edges.length} relationships
            </span>
            {graphs.length > 1 && (
              <select className="fmg-file-select" value={graph!.fileUid} onChange={(e) => setFileUid(e.target.value)}>
                {graphs.map((g) => (
                  <option key={g.fileUid} value={g.fileUid}>
                    {g.fileName}
                  </option>
                ))}
              </select>
            )}
          </>
        }
        onOpen={reveal}
        focusUid={graphFocus && focusFileUid === graph!.fileUid ? graphFocus : null}
        onFocusConsumed={clearGraphFocus}
      />
    </div>
  );
}

/** A bold serif "i" that fills the icon box: a dot over a stem with a flag
 * and a foot. No circle. */
function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="2.6" r="1.35" fill="currentColor" stroke="none" />
      <path d="M5.8 6.2h2.6v7.3M5.6 13.6h5" />
    </svg>
  );
}

function GraphCanvas({
  graph,
  head,
  onOpen,
  focusUid,
  onFocusConsumed,
}: {
  graph: FileGraph;
  /** The title row's left side (title, counts, file picker); the zoom controls join it on the right. */
  head: React.ReactNode;
  onOpen: (uid: string, type: "tableOccurrence" | "relationship") => void;
  /** A table occurrence to select and scroll to on mount (opened from elsewhere). */
  focusUid?: string | null;
  onFocusConsumed?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [selected, setSelected] = useState<{ uid: string; key: string | undefined; name: string | undefined } | null>(
    null,
  );
  const [cascade, setCascade] = useState<Record<CascadeRule, boolean>>({ del: true, create: true, sort: true });
  const [showInfo, setShowInfo] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const nodes = graph.nodes;

  const searchLower = search.trim().toLowerCase();
  const nodeMatches = (n: GraphNode) =>
    !searchLower ||
    n.name.toLowerCase().includes(searchLower) ||
    (n.baseTable?.toLowerCase().includes(searchLower) ?? false);

  const bounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.left);
      minY = Math.min(minY, n.top);
      maxX = Math.max(maxX, n.right);
      maxY = Math.max(maxY, n.top + drawnHeight(n, expanded.has(n.uid)));
    }
    return { minX, minY, maxX, maxY };
  }, [nodes, expanded]);
  const boundsW = bounds.maxX - bounds.minX + PAD * 2;
  const boundsH = bounds.maxY - bounds.minY + PAD * 2;
  const viewBox = `${bounds.minX - PAD} ${bounds.minY - PAD} ${boundsW} ${boundsH}`;

  const byUid = useMemo(() => new Map(nodes.map((n) => [n.uid, n])), [nodes]);

  const orderedNodes = useMemo(
    () =>
      expanded.size
        ? [...nodes].sort((a, b) => Number(expanded.has(a.uid)) - Number(expanded.has(b.uid)))
        : nodes,
    [nodes, expanded],
  );

  // Don't zoom out past fit-to-width, but cap that floor at 100% so small graphs
  // (whose fit exceeds MAX_SCALE) still leave a zoom range.
  const minScale = () => {
    const el = scrollRef.current;
    return el ? Math.max(MIN_SCALE, Math.min(1, el.clientWidth / boundsW)) : MIN_SCALE;
  };
  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(minScale(), s));

  const fitToView = () => {
    const el = scrollRef.current;
    if (!el) return;
    // When opened on a specific occurrence, zoom in and center it; otherwise fit
    // the whole graph to width and center that.
    const focusNode = focusUid ? byUid.get(focusUid) : null;
    const s = focusNode ? clampScale(FOCUS_SCALE) : clampScale(el.clientWidth / boundsW);
    setScale(s);
    requestAnimationFrame(() => {
      if (focusNode) {
        const cx = (centerX(focusNode) - (bounds.minX - PAD)) * s;
        const cy = (focusNode.top + drawnHeight(focusNode, false) / 2 - (bounds.minY - PAD)) * s;
        el.scrollLeft = Math.max(0, Math.min(boundsW * s - el.clientWidth, cx - el.clientWidth / 2));
        el.scrollTop = Math.max(0, Math.min(boundsH * s - el.clientHeight, cy - el.clientHeight / 2));
      } else {
        el.scrollLeft = Math.max(0, (boundsW * s - el.clientWidth) / 2);
        el.scrollTop = 0;
      }
    });
  };
  // Not keyed on boundsH: expanding a box grows the graph and shouldn't reset zoom.
  useLayoutEffect(fitToView, [graph, boundsW]);

  // Opened from a table occurrence elsewhere: highlight it as if it were clicked.
  useLayoutEffect(() => {
    if (!focusUid) return;
    const node = byUid.get(focusUid);
    if (node) setSelected({ uid: node.uid, key: node.baseKey, name: node.baseTable });
    onFocusConsumed?.();
  }, [focusUid]);

  const zoomBy = (factor: number) => setScale((s) => clampScale(s * factor));

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left + el.scrollLeft;
    const py = e.clientY - rect.top + el.scrollTop;
    const next = clampScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    const ratio = next / scale;
    setScale(next);
    requestAnimationFrame(() => {
      el.scrollLeft = px * ratio - (e.clientX - rect.left);
      el.scrollTop = py * ratio - (e.clientY - rect.top);
    });
  };

  const kinCount = selected
    ? nodes.filter((n) => (selected.key ? n.baseKey === selected.key : n.uid === selected.uid)).length
    : 0;

  const boxState = (n: GraphNode): "kin" | "sel" | "dim" | "" => {
    if (searchLower && !nodeMatches(n)) return "dim";
    if (!selected) return "";
    const isKin = selected.key ? n.baseKey === selected.key : n.uid === selected.uid;
    if (!isKin) return "dim";
    return n.uid === selected.uid ? "sel" : "kin";
  };

  const edgeCascadeClass = (e: FileGraph["edges"][number]): string => {
    // An edge with several rules takes the first enabled one, in this order.
    for (const rule of CASCADE_RULES) {
      if (cascade[rule.key] && e[rule.key]) return ` cas-${rule.key}`;
    }
    return "";
  };

  return (
    <>
      <div className="erd-head">
        {head}
        <div className="fmg-zoom" role="group" aria-label="Zoom">
          <button className="icon-btn" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
            −
          </button>
          <span className="fmg-zoom-pct">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in">
            +
          </button>
          <button className="btn" onClick={fitToView}>
            Fit
          </button>
        </div>
      </div>

      <div className="fmg-toolbar">
        <label className="nav-search has-query">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search table occurrences"
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <span className="fmg-cascade-group" role="group" aria-label="Color lines by cascade rule">
          <span className="subtle">Color:</span>
          {CASCADE_RULES.map((rule) => (
            <button
              key={rule.key}
              type="button"
              className={`chip fmg-cascade-toggle${cascade[rule.key] ? " active" : ""}`}
              aria-pressed={cascade[rule.key]}
              title={`${rule.title}: ${cascade[rule.key] ? "colored" : "not colored"}`}
              onClick={() => setCascade((c) => ({ ...c, [rule.key]: !c[rule.key] }))}
            >
              <span className={`fmg-swatch cas-${rule.key}`} />
              {rule.label}
            </button>
          ))}
        </span>
        <span className="fmg-info-wrap">
          <button
            type="button"
            className="icon-btn"
            aria-label="About the graph"
            onClick={() => setShowInfo((v) => !v)}
          >
            <InfoIcon />
          </button>
          {showInfo && (
            <>
              <div className="fmg-info-overlay" onClick={() => setShowInfo(false)} />
              <div className="popover fmg-info-pop" role="tooltip">
                <div className="fmg-info-title">Relationship lines are colored by cascade option:</div>
                <div className="fmg-info-row">
                  <span className="fmg-swatch cas-del" /> Delete related records
                </div>
                <div className="fmg-info-row">
                  <span className="fmg-swatch cas-create" /> Allow creation of records
                </div>
                <div className="fmg-info-row">
                  <span className="fmg-swatch cas-sort" /> Sorted relationship
                </div>
                <div className="fmg-info-title fmg-info-gap">Using the graph:</div>
                <div className="fmg-info-row">Click a box to highlight its siblings</div>
                <div className="fmg-info-row">Double-click a box to expand it</div>
                <div className="fmg-info-row">⌘/Ctrl-click a box or line to open it</div>
              </div>
            </>
          )}
        </span>
        {selected ? (
          <span className="fmg-selinfo">
            <strong>{selected.name ?? "(no base table)"}</strong> · {kinCount} occurrence
            {kinCount === 1 ? "" : "s"}
            <button className="btn" onClick={() => setSelected(null)}>
              Clear
            </button>
          </span>
        ) : null}
      </div>

      <div className="fmg-canvas-wrap" ref={scrollRef} onWheel={onWheel}>
        <svg
          width={boundsW * scale}
          height={boundsH * scale}
          viewBox={viewBox}
          className={`fmg-canvas${selected ? " selecting" : ""}`}
          role="group"
          aria-label="FileMaker relationship graph"
          onClick={() => setSelected(null)}
        >
          <defs>
            <pattern id="fmg-dots" width="34" height="34" patternUnits="userSpaceOnUse">
              <circle className="fmg-dot" cx="1" cy="1" r="1.1" />
            </pattern>
          </defs>
          <rect
            className="fmg-bg"
            x={bounds.minX - PAD}
            y={bounds.minY - PAD}
            width={boundsW}
            height={boundsH}
            fill="url(#fmg-dots)"
          />
          {(() => {
            const edgeElements = graph.edges.map((e, i) => {
              const a = byUid.get(e.a);
              const b = byUid.get(e.b);
              if (!a || !b) return null;

              const hot = hoveredEdge === i || (hovered != null && (hovered === e.a || hovered === e.b));
              const edgeDim = searchLower && !nodeMatches(a) && !nodeMatches(b);
              const aExpanded = expanded.has(a.uid);
              const bExpanded = expanded.has(b.uid);

              const aCenter = centerX(a);
              const bCenter = centerX(b);
              const aY = a.top + drawnHeight(a, aExpanded) / 2;
              const bY = b.top + drawnHeight(b, bExpanded) / 2;

              const overlap = a.left < b.right && b.left < a.right;
              let path: string;
              if (overlap) {
                // Stacked boxes: U-bend out the right side
                // const armX = Math.max(a.right, b.right) + 40;
                // path = `M ${a.right} ${aY} C ${armX} ${aY}, ${armX} ${bY}, ${b.right} ${bY}`;
                const armX = Math.max(a.right, b.right) + 40;
                path = `
                  M ${a.right} ${aY}
                  L ${armX} ${aY}
                  L ${armX} ${bY}
                  L ${b.right} ${bY}
                `;
              } else {
                const goesRight = bCenter > aCenter;
                const start = getAnchorPoint(a, aExpanded, goesRight ? "right" : "left");
                const end = getAnchorPoint(b, bExpanded, goesRight ? "left" : "right");
                path = orthogonalPath(start.x, start.y, end.x, end.y);
              }

              return {
                key: i,
                hot,
                element: (
                  <g
                    key={i}
                    onMouseEnter={() => setHoveredEdge(i)}
                    onMouseLeave={() => setHoveredEdge(null)}
                    onClick={(ev) => {
                      if (ev.metaKey || ev.ctrlKey) {
                        ev.stopPropagation();
                        onOpen(e.uid, "relationship");
                      }
                    }}
                  >
                    <path className="fmg-edge-hit" d={path} fill="none" />
                    <path className={`fmg-edge${hot ? " hot" : ""}${edgeCascadeClass(e)}${edgeDim ? " dim" : ""}`} d={path} fill="none" />
                  </g>
                ),
              };
            });

            return (
              <>
                {edgeElements.filter((item): item is { key: number; hot: false; element: JSX.Element } => !!item && !item.hot).map((item) => item.element)}
                {edgeElements.filter((item): item is { key: number; hot: true; element: JSX.Element } => !!item && item.hot).map((item) => item.element)}
              </>
            );
          })()}

          {orderedNodes.map((n) => (
            <GraphBox
              key={n.uid}
              node={n}
              state={boxState(n)}
              expanded={expanded.has(n.uid)}
              onHover={(uid) => {
                setHoveredEdge(null);
                setHovered(uid);
              }}
              onSelect={() => {
                setSearch("");
                setSelected((prev) => (prev?.uid === n.uid ? null : { uid: n.uid, key: n.baseKey, name: n.baseTable }));
              }
              }
              onToggleExpand={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(n.uid) ? next.delete(n.uid) : next.add(n.uid);
                  return next;
                })
              }
              onOpen={() => onOpen(n.uid, "tableOccurrence")}
            />
          ))}
        </svg>
      </div>
    </>
  );
}

function GraphBox({
  node,
  state,
  expanded,
  onHover,
  onSelect,
  onToggleExpand,
  onOpen,
}: {
  node: GraphNode;
  state: "kin" | "sel" | "dim" | "";
  expanded: boolean;
  onHover: (uid: string | null) => void;
  onSelect: () => void;
  onToggleExpand: () => void;
  onOpen: () => void;
}) {
  const w = node.right - node.left;
  const h = drawnHeight(node, expanded);
  const { rows, overflow } = shownFields(node, expanded);
  // A broken occurrence (its base table is gone) reads like anything broken:
  // red outline and red name.
  const colors = node.broken ? { ...boxColors(node.color), border: "var(--high)", text: "var(--high)" } : boxColors(node.color);

  return (
    <g
      className={`fmg-node${state ? ` ${state}` : ""}`}
      style={{ ["--toc" as string]: colors.border }}
      role="button"
      tabIndex={0}
      aria-label={`${node.name} — Enter selects, ⌘/Ctrl+Enter opens, Shift+Enter shows fields`}
      aria-pressed={state === "sel"}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) onOpen();
        else if (e.shiftKey) onToggleExpand();
        else onSelect();
      }}
      onFocus={() => onHover(node.uid)}
      onBlur={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) onOpen();
        else onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onToggleExpand();
      }}
      onMouseEnter={() => onHover(node.uid)}
      onMouseLeave={() => onHover(null)}
    >
      <rect className="fmg-box" x={node.left} y={node.top} width={w} height={h} rx={6} />
      <rect className="fmg-title" x={node.left} y={node.top} width={w} height={Math.min(TITLE_H, h)} rx={6} fill={colors.fill} />
      {h > TITLE_H && <rect className="fmg-title" x={node.left} y={node.top + TITLE_H / 2} width={w} height={TITLE_H / 2} fill={colors.fill} />}
      {/* Outline drawn again above the title fills, which otherwise cover its inner half. */}
      <rect className="fmg-box fmg-outline" x={node.left} y={node.top} width={w} height={h} rx={6} />
      {rows.length > 0 && <line className="fmg-divider" x1={node.left} y1={node.top + TITLE_H} x2={node.left + w} y2={node.top + TITLE_H} />}
      <text className="fmg-label" x={node.left + 8} y={node.top + TITLE_H / 2 + FONT / 2 - 1} textAnchor="start" fill={colors.text}>
        {fit(node.name, w - 16, FONT)}
      </text>
      {rows.map((f, i) => (
        <text key={i} className="fmg-field" x={node.left + 7} y={node.top + TITLE_H + i * ROW_H + ROW_H * 0.72}>
          {fit(f, w - 14, 11)}
        </text>
      ))}
      {overflow > 0 && (
        <text className="fmg-field more" x={node.left + 7} y={node.top + TITLE_H + rows.length * ROW_H + ROW_H * 0.72}>
          +{overflow} more
        </text>
      )}
      <title>
        {node.broken
          ? `${node.name}  ·  base table missing`
          : node.baseTable && node.baseTable !== node.name
            ? `${node.name}  ·  ${node.baseTable}`
            : node.name}
      </title>
    </g>
  );
}