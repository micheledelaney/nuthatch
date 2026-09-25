import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { readSourceDocs } from "@/state/loadFiles";
import { Menu } from "@/components/Menu";
import type { ProjectRecord, SavedMeta } from "@/state/savedAnalyses";
import { PlaybackVideo } from "./PlaybackVideo";

/** Format an epoch-millis timestamp as `yyyy-mm-dd hh:mm` (local, 24-hour). */
function formatSavedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Just the `yyyy-mm-dd` date part, for compact axis labels. */
function formatDate(ms: number): string {
  return formatSavedAt(ms).slice(0, 10);
}

interface Project {
  name: string;
  note?: string;
  /** Whether this project's health comparison graphs are shown. */
  showHealthGraphs: boolean;
  /** Analyses in this project, newest first. */
  items: SavedMeta[];
  /** Sort key: most recent activity (latest analysis, else project creation). */
  activity: number;
}

/**
 * Merge persisted projects with grouped analyses so empty projects still show,
 * ordered by most recent activity.
 */
function buildProjects(items: SavedMeta[], projects: ProjectRecord[]): Project[] {
  const byName = new Map<string, Project>();
  for (const project of projects) {
    byName.set(project.name, {
      name: project.name,
      note: project.note,
      showHealthGraphs: project.showHealthGraphs,
      items: [],
      activity: project.createdAt,
    });
  }
  for (const item of items) {
    const existing = byName.get(item.projectName);
    if (existing) {
      existing.items.push(item); // items arrive newest-first
      existing.activity = Math.max(existing.activity, item.savedAt);
    } else {
      byName.set(item.projectName, {
        name: item.projectName,
        showHealthGraphs: true,
        items: [item],
        activity: item.savedAt,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.activity - a.activity);
}

/** Toggle an id in a selection capped at two — drops the oldest when full. */
function toggleSelection(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  return [...selected, id].slice(-2);
}

/**
 * Landing screen shown when no analysis is loaded: projects, each expandable to
 * reveal its analysis history. Add analyses per project, open one by clicking,
 * or tick two and Compare.
 */
export function SavedAnalysesDashboard() {
  const savedItems = useStore((s) => s.savedItems);
  const projects = useStore((s) => s.projects);
  const refreshSaved = useStore((s) => s.refreshSaved);
  const compareAnalyses = useStore((s) => s.compareAnalyses);
  const startNewProject = useStore((s) => s.startNewProject);
  const recentlyAddedId = useStore((s) => s.recentlyAddedId);
  const clearRecentlyAdded = useStore((s) => s.clearRecentlyAdded);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  const grouped = useMemo(() => buildProjects(savedItems, projects), [savedItems, projects]);

  // Drop selections whose analysis no longer exists (e.g. after a delete).
  useEffect(() => {
    setSelected((sel) => sel.filter((id) => savedItems.some((i) => i.id === id)));
  }, [savedItems]);

  if (grouped.length === 0) return <EmptyState />;

  function toggle(id: string) {
    setSelected((sel) => toggleSelection(sel, id));
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-heading">
          <h2>Projects</h2>
          <p className="subtle">
            Add analyses to a project to build its history — when adding, you can select several XML
            files at once (hold ⌘ or Ctrl while clicking). Click one to reopen it, or tick two to compare.
          </p>
        </div>
        <button className="primary" onClick={startNewProject}>
          + New project
        </button>
      </header>
      <div className="project-list">
        {grouped.map((project) => (
          <ProjectRow key={project.name} project={project} selected={selected} onToggle={toggle} recentlyAddedId={recentlyAddedId} clearRecentlyAdded={clearRecentlyAdded} />
        ))}
      </div>

      {selected.length === 2 && (
        <div className="compare-bar">
          <span>2 analyses selected</span>
          <div className="compare-bar-actions">
            <button onClick={() => setSelected([])}>Clear</button>
            <button
              className="primary"
              onClick={() => {
                const [first, second] = selected;
                if (first && second) void compareAnalyses(first, second);
              }}
            >
              Compare
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  selected,
  onToggle,
  recentlyAddedId,
  clearRecentlyAdded,
}: {
  project: Project;
  selected: string[];
  onToggle: (id: string) => void;
  recentlyAddedId: string | null;
  clearRecentlyAdded: () => void;
}) {
  const hasNew = recentlyAddedId != null && project.items.some((i) => i.id === recentlyAddedId);
  const [expanded, setExpanded] = useState(hasNew);
  const loadDocuments = useStore((s) => s.loadDocuments);
  const removeProject = useStore((s) => s.removeProject);
  const openEdit = useStore((s) => s.openEdit);
  const setShowHealthGraphs = useStore((s) => s.setShowHealthGraphs);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFilesChosen(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const docs = await readSourceDocs(fileList);
    if (inputRef.current) inputRef.current.value = ""; // allow re-picking the same file
    void loadDocuments(docs, project.name);
  }

  const count = project.items.length;

  return (
    <section className="project">
      <div className="project-head">
        <button className="project-head-main" onClick={() => setExpanded((v) => !v)}>
          <span className={`fchevron${expanded ? " open" : ""}`}>›</span>
          <span className="project-name">{project.name}</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xml"
          multiple
          hidden
          onChange={(e) => void onFilesChosen(e.target.files)}
        />
        <Menu
          label="Project actions"
          items={[
            { label: "Add analysis", onSelect: () => inputRef.current?.click() },
            ...(count >= 2
              ? [
                {
                  label: project.showHealthGraphs ? "Hide health graphs" : "Show health graphs",
                  onSelect: () => void setShowHealthGraphs(project.name, !project.showHealthGraphs),
                },
              ]
              : []),
            {
              label: "Rename",
              onSelect: () => openEdit({ target: { kind: "project-rename", name: project.name }, initialValue: project.name }),
            },
            {
              label: project.note ? "Edit note" : "Add note",
              onSelect: () => openEdit({ target: { kind: "project-note", name: project.name }, initialValue: project.note ?? "" }),
            },
            { label: "Delete", danger: true, onSelect: () => void removeProject(project.name) },
          ]}
        />
      </div>
      {project.note && <p className="entity-note">{project.note}</p>}
      {expanded &&
        (count === 0 ? (
          <p className="project-empty">
            No analyses yet — use “Add analysis” to load a Save a Copy as XML file (exported
            with “Include details for analysis tools” enabled).
          </p>
        ) : (
          <>
            {project.showHealthGraphs && <ProjectHealth items={project.items} />}
            <ul className="snapshot-list">
              {project.items.map((item) => (
                <AnalysisRow
                  key={item.id}
                  item={item}
                  checked={selected.includes(item.id)}
                  onToggle={onToggle}
                  isNew={item.id === recentlyAddedId}
                  clearRecentlyAdded={clearRecentlyAdded}
                />
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}

function AnalysisRow({
  item,
  checked,
  onToggle,
  isNew,
  clearRecentlyAdded,
}: {
  item: SavedMeta;
  checked: boolean;
  onToggle: (id: string) => void;
  isNew?: boolean;
  clearRecentlyAdded?: () => void;
}) {
  const openSaved = useStore((s) => s.openSaved);
  const removeSaved = useStore((s) => s.removeSaved);
  const openEdit = useStore((s) => s.openEdit);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!isNew) return;
    rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = setTimeout(() => clearRecentlyAdded?.(), 2000);
    return () => clearTimeout(t);
  }, [isNew, clearRecentlyAdded]);

  return (
    <li ref={rowRef} className={`snapshot${isNew ? " snapshot-new" : ""}`} onClick={() => void openSaved(item.id)}>
      <input
        type="checkbox"
        className="snapshot-check"
        checked={checked}
        title="Select to compare"
        aria-label="Select to compare"
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(item.id)}
      />
      <div className="snapshot-main">
        <span className="snapshot-name">{item.name}</span>
        <span className="snapshot-files" title={item.fileNames.join(", ")}>
          {item.fileNames.join(", ") || "—"}
        </span>
        {item.note && <span className="entity-note snapshot-note">{item.note}</span>}
      </div>
      <span className="snapshot-date">{formatSavedAt(item.savedAt)}</span>
      <Menu
        label="Analysis actions"
        items={[
          {
            label: "Rename",
            onSelect: () => openEdit({ target: { kind: "analysis-rename", id: item.id }, initialValue: item.name }),
          },
          {
            label: item.note ? "Edit note" : "Add note",
            onSelect: () => openEdit({ target: { kind: "analysis-note", id: item.id }, initialValue: item.note ?? "" }),
          },
          { label: "Delete", danger: true, onSelect: () => void removeSaved(item.id) },
        ]}
      />
    </li>
  );
}

/** A health metric tracked across a project's analyses. */
interface MetricDef {
  key: string;
  label: string;
  /** Lower is better (a maintenance risk), so a rising trend reads as "worse". */
  risk: boolean;
  /** CSS color (a palette var) for this metric's line/sparkline. */
  color: string;
  get: (m: SavedMeta) => number;
}

/** Everything a user might want to track over a project's lifetime — risks first
 * (broken/orphaned/unstored), then the global-state and size metrics. */
const HEALTH_METRICS: MetricDef[] = [
  { key: "broken", label: "Broken refs", risk: true, color: "var(--high)", get: (m) => m.brokenCount },
  { key: "unreferenced", label: "Unreferenced", risk: true, color: "var(--warn)", get: (m) => m.unreferencedCount },
  { key: "unstored", label: "Unstored calcs", risk: true, color: "var(--warn)", get: (m) => m.unstoredCalculationCount },
  { key: "globalFields", label: "Global fields", risk: false, color: "var(--accent)", get: (m) => m.globalFieldCount },
  { key: "globalVars", label: "Global vars", risk: false, color: "var(--accent)", get: (m) => m.globalVariableCount },
  { key: "objects", label: "Objects", risk: false, color: "var(--accent)", get: (m) => m.objectCount },
  { key: "references", label: "References", risk: false, color: "var(--accent)", get: (m) => m.referenceCount },
];

interface Pt {
  /** Index within the full (sorted) analysis timeline, so gaps keep their place. */
  i: number;
  t: number;
  v: number;
  name: string;
}

/** Values of a metric across the sorted analyses. */
function series(sorted: SavedMeta[], get: (m: SavedMeta) => number): Pt[] {
  return sorted.map((m, i) => ({ i, t: m.savedAt, v: get(m), name: m.name }));
}

/** Inline style carrying the per-metric color as a CSS custom property. */
function metricStyle(color: string): React.CSSProperties {
  return { ["--metric"]: color } as React.CSSProperties;
}

/**
 * A project's analysis-health dashboard: a tile per tracked metric (current value,
 * trend delta, and a sparkline), and a larger chart for the selected metric over
 * time. Every metric is read from the saved summaries — no heavy data is loaded.
 * Needs at least two analyses to show a trend.
 */
function ProjectHealth({ items }: { items: SavedMeta[] }) {
  const sorted = useMemo(() => [...items].sort((a, b) => a.savedAt - b.savedAt), [items]);
  const [selected, setSelected] = useState("broken");
  if (sorted.length < 2) return null;

  const denom = sorted.length - 1;
  const def = HEALTH_METRICS.find((m) => m.key === selected) ?? HEALTH_METRICS[0]!;

  return (
    <div className="health">
      <div className="health-cards">
        {HEALTH_METRICS.map((m) => (
          <MetricCard
            key={m.key}
            def={m}
            sorted={sorted}
            denom={denom}
            selected={m.key === selected}
            onSelect={setSelected}
          />
        ))}
      </div>
      <MetricChart def={def} sorted={sorted} denom={denom} />
    </div>
  );
}

function MetricCard({
  def,
  sorted,
  denom,
  selected,
  onSelect,
}: {
  def: MetricDef;
  sorted: SavedMeta[];
  denom: number;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const pts = useMemo(() => series(sorted, def.get), [sorted, def]);
  const last = pts[pts.length - 1] ?? null;
  const prev = pts.length > 1 ? pts[pts.length - 2]! : null;
  const delta = last && prev ? last.v - prev.v : 0;
  const SW = 120;
  const SH = 26;

  return (
    <button
      type="button"
      className={`metric-card${selected ? " selected" : ""}`}
      style={metricStyle(def.color)}
      disabled={!last}
      onClick={() => onSelect(def.key)}
    >
      <span className="metric-label">{def.label}</span>
      <span className="metric-value">{last ? last.v.toLocaleString() : "—"}</span>
      {delta !== 0 && <DeltaChip delta={delta} risk={def.risk} />}
      {pts.length > 1 && (
        <svg className="metric-spark" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" aria-hidden>
          <path d={sparkPath(pts, denom, SW, SH)} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </button>
  );
}

function DeltaChip({ delta, risk }: { delta: number; risk: boolean }) {
  const tone = !risk ? "neutral" : delta > 0 ? "worse" : "better";
  return (
    <span className={`metric-delta ${tone}`}>
      {delta > 0 ? "▲" : "▼"} {delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString()}
    </span>
  );
}

/** A min-max-normalized sparkline path over the shared timeline (x = analysis
 * index, so all metrics line up in time). */
function sparkPath(pts: Pt[], denom: number, w: number, h: number): string {
  const max = Math.max(1, ...pts.map((p) => p.v));
  const x = (i: number) => (denom === 0 ? w / 2 : (i / denom) * w);
  const y = (v: number) => h - (v / max) * h;
  return monotonePath(pts.map((p) => ({ x: x(p.i), y: y(p.v) })));
}

/**
 * "Nice" y-axis ticks for a count: a 0-based scale whose step is a round
 * 1/2/5 × 10ⁿ value (so 10s, 20s, 50s, 100s, 1000s…), with the top tick rounded
 * up to cover the data. Steps never go below 1, since these are whole counts.
 */
function niceAxis(maxValue: number, intervals = 3): { ticks: number[]; top: number } {
  if (maxValue <= 0) return { ticks: [0, 1], top: 1 };
  const rawStep = maxValue / intervals;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, Math.round(niceNorm * mag));
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { ticks, top };
}

/**
 * A smooth path through points using monotone cubic interpolation
 * (Fritsch–Carlson). Points must be x-increasing. Unlike a plain Catmull-Rom
 * spline it never overshoots the data, so the line/area stay within the values
 * (no dips below the baseline between two equal points).
 */
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  const p = (i: number) => `${pts[i]!.x.toFixed(2)},${pts[i]!.y.toFixed(2)}`;
  if (n === 1) return `M${p(0)}`;
  if (n === 2) return `M${p(0)} L${p(1)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]!.x - pts[i]!.x;
    slope[i] = (pts[i + 1]!.y - pts[i]!.y) / dx[i]!;
  }
  const m: number[] = new Array(n);
  m[0] = slope[0]!;
  m[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1]! * slope[i]! <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i]! + dx[i - 1]!;
      const w2 = dx[i]! + 2 * dx[i - 1]!;
      m[i] = (w1 + w2) / (w1 / slope[i - 1]! + w2 / slope[i]!);
    }
  }

  let d = `M${p(0)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i]!.x + dx[i]! / 3;
    const c1y = pts[i]!.y + (m[i]! * dx[i]!) / 3;
    const c2x = pts[i + 1]!.x - dx[i]! / 3;
    const c2y = pts[i + 1]!.y - (m[i + 1]! * dx[i]!) / 3;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p(i + 1)}`;
  }
  return d;
}

function MetricChart({ def, sorted, denom }: { def: MetricDef; sorted: SavedMeta[]; denom: number }) {
  const pts = useMemo(() => series(sorted, def.get), [sorted, def]);
  const gradId = "mc-grad-" + useId().replace(/:/g, "");
  if (pts.length < 2) {
    return <div className="metric-chart-empty subtle">Not enough history for “{def.label}” yet.</div>;
  }

  const W = 620;
  const H = 184;
  const padL = 42;
  const padR = 18;
  const padT = 22;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const { ticks, top: maxY } = niceAxis(Math.max(0, ...pts.map((p) => p.v)));

  const x = (i: number) => padL + (denom === 0 ? innerW / 2 : (i / denom) * innerW);
  const y = (v: number) => padT + innerH - (v / maxY) * innerH;
  const xy = pts.map((p) => ({ x: x(p.i), y: y(p.v) }));
  const line = monotonePath(xy);
  const area = `${line} L${xy[xy.length - 1]!.x.toFixed(2)},${padT + innerH} L${xy[0]!.x.toFixed(2)},${padT + innerH} Z`;

  const last = pts[pts.length - 1]!;
  const lastX = x(last.i);
  const lastY = y(last.v);
  // Keep the value callout off the dot/line: above the point when there's room,
  // otherwise below; and just inside the right edge so it never sits on the dot.
  const labelAbove = lastY - 14 >= padT;
  const labelY = labelAbove ? lastY - 11 : lastY + 18;
  const atRightEdge = last.i === denom;
  const labelX = atRightEdge ? lastX - 8 : lastX;

  return (
    <div className="metric-chart" style={metricStyle(def.color)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="metric-chart-svg" role="img" aria-label={`${def.label} over time`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--metric)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--metric)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((v) => (
          <g key={v}>
            <line className="mc-grid" x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} vectorEffect="non-scaling-stroke" />
            <text className="mc-axis" x={padL - 8} y={y(v) + 3} textAnchor="end">
              {v.toLocaleString()}
            </text>
          </g>
        ))}

        <path className="mc-area" d={area} fill={`url(#${gradId})`} />
        <path className="mc-line" d={line} fill="none" vectorEffect="non-scaling-stroke" />

        {pts.map((p, k) => {
          const isLast = k === pts.length - 1;
          return (
            <g key={k} className="mc-point">
              {isLast && <circle className="mc-halo" cx={x(p.i)} cy={y(p.v)} r={7} />}
              <circle className={isLast ? "mc-dot last" : "mc-dot"} cx={x(p.i)} cy={y(p.v)} r={isLast ? 4 : 3} />
              {/* generous invisible hit target for the tooltip */}
              <circle className="mc-hit" cx={x(p.i)} cy={y(p.v)} r={9}>
                <title>{`${p.name}: ${p.v.toLocaleString()} — ${formatDate(p.t)}`}</title>
              </circle>
            </g>
          );
        })}

        {/* current value, called out clear of the last point */}
        <text className="mc-value" x={labelX} y={labelY} textAnchor={atRightEdge ? "end" : "middle"}>
          {last.v.toLocaleString()}
        </text>

        <text className="mc-axis" x={padL} y={H - 9} textAnchor="start">
          {formatDate(sorted[0]!.savedAt)}
        </text>
        <text className="mc-axis" x={W - padR} y={H - 9} textAnchor="end">
          {formatDate(sorted[sorted.length - 1]!.savedAt)}
        </text>
      </svg>
    </div>
  );
}


function EmptyState() {
  const startNewProject = useStore((s) => s.startNewProject);
  return (
    <div className="empty-state">
      <PlaybackVideo />
      <p style={{ maxWidth: 460, lineHeight: 1.6 }}>
        Analyze FileMaker "Save a Copy as XML" files to explore structure,
        dependencies, call chains, and maintenance risks. Nothing leaves your machine —
        all parsing happens locally.
      </p>
      <p className="subtle" style={{ maxWidth: 460, lineHeight: 1.6 }}>
        When exporting from FileMaker, enable{" "}
        <strong>“Include details for analysis tools”</strong> in the Save a Copy as XML
        dialog — otherwise references inside calculations and scripts can’t be resolved.
      </p>
      <p className="subtle">Create a project to get started, then add analyses to it.</p>
      <button className="primary" onClick={startNewProject}>
        + New project
      </button>
    </div>
  );
}
