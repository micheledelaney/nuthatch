import { useEffect, useMemo, useState } from "react";
import { OBJECT_TYPE_META, type ObjectType } from "@/types/ddr";
import { useStore } from "@/state/store";
import type { Comparison } from "@/state/store";
import {
  diffAnalyses,
  buildCountsByType,
  DEFAULT_DIFF_OPTIONS,
  excludedTypes,
  matchFilesByName,
  lineDiff,
  type DiffOptions,
  type ObjectChange,
} from "@/core/analysis/diff";
import { TypePill } from "@/components/TypePill";

function formatSavedAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A change's owning file uid, derived from `${fileUid}:${type}:${id}`. */
function fileUidOfChange(uid: string): string {
  return uid.split(":")[0] ?? "";
}

/** Side-by-side comparison of two analyses, oldest → newest. */
export function ComparisonView() {
  const comparison = useStore((s) => s.comparison);
  const openSaved = useStore((s) => s.openSaved);
  const openObject = useStore((s) => s.openObject);
  const opts = useStore((s) => s.diffOptions);
  const setOpts = useStore((s) => s.setDiffOptions);
  const [fileFilter, setFileFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<ObjectType | "all">("all");

  const diff = useMemo(() => {
    if (!comparison) return null;
    return diffAnalyses(
      comparison.resultA,
      comparison.resultB,
      comparison.a.brokenCount,
      comparison.b.brokenCount,
      opts,
    );
  }, [comparison, opts]);

  // Reset any file selection whenever the comparison changes or "diff by file id"
  // is toggled, so a stale filter can't silently narrow a comparison it no longer
  // applies to.
  useEffect(() => {
    setFileFilter("all");
    setTypeFilter("all");
  }, [comparison, opts.diffByFileId]);

  // Files matched by name between the two sides — not by fileUid, since that's
  // just a load-order index ("F0", "F1", ...) that can differ between two
  // independently-loaded analyses even for the same file (e.g. a 2-file analysis
  // vs. a 4-file one, where their shared file isn't first on both sides).
  const fileMatches = useMemo(() => {
    if (!comparison || !opts.diffByFileId) return [];
    return matchFilesByName(comparison.resultA, comparison.resultB);
  }, [comparison, opts.diffByFileId]);

  // Per-file breakdown for the file filter dropdown and the clickable summary row.
  // diffAnalyses (with diffByFileId on) rewrites each matched file's B-side objects
  // onto its A-side fileUid, so every change's uid carries the A-side fileUid —
  // key the summary the same way, and keep bFileUid around to filter B's raw
  // objects in countsByType below (B's own objects still use B's own fileUid).
  const fileOptions = useMemo(() => {
    if (!diff) return [];
    const counts = new Map<string, { added: number; removed: number; changed: number }>();
    const ensure = (fileUid: string) => {
      let c = counts.get(fileUid);
      if (!c) counts.set(fileUid, (c = { added: 0, removed: 0, changed: 0 }));
      return c;
    };
    diff.added.forEach((c) => ensure(fileUidOfChange(c.uid)).added++);
    diff.removed.forEach((c) => ensure(fileUidOfChange(c.uid)).removed++);
    diff.changed.forEach((c) => ensure(fileUidOfChange(c.uid)).changed++);
    return fileMatches
      .map((m) => ({
        fileUid: m.aFileUid,
        bFileUid: m.bFileUid,
        fileName: m.name,
        ...(counts.get(m.aFileUid) ?? { added: 0, removed: 0, changed: 0 }),
      }))
      .sort((x, y) => x.fileName.localeCompare(y.fileName));
  }, [diff, fileMatches]);

  // "By type" breakdown scoped to the selected file — falls back to the diff's
  // overall counts when no file is selected. A's and B's raw objects are filtered
  // by their OWN fileUid for the matched file, which can differ between sides.
  const countsByType = useMemo(() => {
    if (!diff || !comparison) return [];
    if (fileFilter === "all") return diff.countsByType;
    const match = fileOptions.find((f) => f.fileUid === fileFilter);
    if (!match) return diff.countsByType;
    const inFile = (uid: string) => fileUidOfChange(uid) === fileFilter;
    const excluded = excludedTypes(opts);
    return buildCountsByType(
      comparison.resultA.objects.filter((o) => o.fileUid === match.fileUid && !excluded.has(o.type)),
      comparison.resultB.objects.filter((o) => o.fileUid === match.bFileUid && !excluded.has(o.type)),
      diff.added.filter((c) => inFile(c.uid)),
      diff.removed.filter((c) => inFile(c.uid)),
      diff.changed.filter((c) => inFile(c.uid)),
    );
  }, [diff, comparison, fileFilter, fileOptions, opts]);

  if (!comparison || !diff) return null;

  // Open an object from a change row: load the analysis it lives in (the baseline
  // "a" for removed items, the comparison "b" otherwise), then focus the object.
  const openIn = (uid: string, side: "a" | "b") => {
    void openSaved(comparison[side].id).then(() => openObject(uid));
  };

  const filterChanges = (items: ObjectChange[]): ObjectChange[] =>
    items.filter(
      (item) =>
        (fileFilter === "all" || fileUidOfChange(item.uid) === fileFilter) &&
        (typeFilter === "all" || item.type === typeFilter),
    );
  const filteredAdded = filterChanges(diff.added);
  const filteredRemoved = filterChanges(diff.removed);
  const filteredRenamed = filterChanges(diff.renamed);
  const filteredChanged = filterChanges(diff.changed);

  const jumpToFile = (fileUid: string, section: "added" | "removed" | "changed") => {
    setFileFilter(fileUid);
    requestAnimationFrame(() => {
      document.getElementById(`diff-section-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="comparison">
      <header className="comparison-header">
        <div className="comparison-pair">
          <AnalysisTag comparison={comparison} side="a" />
          <span className="comparison-arrow">→</span>
          <AnalysisTag comparison={comparison} side="b" />
        </div>
        <DiffSettingsPopover opts={opts} onChange={setOpts} />
      </header>

      {comparison.versionWarning && (
        <div className="comparison-warning" role="note">
          <span className="comparison-warning-icon" aria-hidden>
            ⚠
          </span>
          <span>
            These analyses come from different FileMaker versions (
            <strong>{comparison.versionWarning.a}</strong> →{" "}
            <strong>{comparison.versionWarning.b}</strong>). Some differences may be cosmetic rather
            than real changes — for example, script keyword casing can differ between versions
            (“Not” vs “not”), which shows up as a change even though the logic is identical.
          </span>
        </div>
      )}

      {fileOptions.length > 1 && (
        <section className="file-summary-row">
          {fileOptions.map((f) => (
            <FileSummaryCard
              key={f.fileUid}
              file={f}
              active={fileFilter === f.fileUid}
              onSelectFile={() => setFileFilter(f.fileUid)}
              onJump={(section) => jumpToFile(f.fileUid, section)}
            />
          ))}
        </section>
      )}

      {fileOptions.length > 1 && (
        <div className="file-filter-row">
          <select
            className="file-filter-select"
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
            aria-label="Filter diff by file"
          >
            <option value="all">All files</option>
            {fileOptions.map((f) => (
              <option key={f.fileUid} value={f.fileUid}>
                {f.fileName}
              </option>
            ))}
          </select>
        </div>
      )}

      <h3 className="comparison-section-title">By type</h3>
      <table className="comparison-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Net</th>
            <th>Added</th>
            <th>Removed</th>
            <th>Changed</th>
          </tr>
        </thead>
        <tbody>
          {countsByType.map((row) => (
            <tr key={row.type}>
              <td>{OBJECT_TYPE_META[row.type].plural}</td>
              <td className={row.b - row.a !== 0 ? "count-changed" : "count-zero"}>
                {row.b - row.a === 0 ? "—" : `${row.b - row.a > 0 ? "+" : "−"}${Math.abs(row.b - row.a).toLocaleString()}`}
              </td>
              <td className={row.added ? "count-added" : "count-zero"}>{row.added || "—"}</td>
              <td className={row.removed ? "count-removed" : "count-zero"}>{row.removed || "—"}</td>
              <td className={row.changed ? "count-changed" : "count-zero"}>{row.changed || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="type-filter-row">
        <select
          className="type-filter-select"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as ObjectType | "all")}
          aria-label="Filter diff by object type"
        >
          <option value="all">All object types</option>
          {(Object.keys(OBJECT_TYPE_META) as ObjectType[]).map((t) => (
            <option key={t} value={t}>
              {OBJECT_TYPE_META[t].plural}
            </option>
          ))}
        </select>
      </div>

      <div className="change-groups">
        <ChangeList id="diff-section-added" title="Added" tone="added" items={filteredAdded} side="b" openIn={openIn} />
        <ChangeList id="diff-section-removed" title="Removed" tone="removed" items={filteredRemoved} side="a" openIn={openIn} />
        <ChangeList title="Renamed" tone="renamed" items={filteredRenamed} side="b" openIn={openIn} renamed />
      </div>

      {filteredChanged.length > 0 && (
        <section className="changed-section" id="diff-section-changed">
          <h3 className="comparison-section-title">
            Changed <span className="change-count">{filteredChanged.length}</span>
          </h3>
          <p className="subtle">Click an object to see exactly what changed (removed lines in red, added in green).</p>
          <div className="changed-list">
            {filteredChanged.map((item) => (
              <ChangedItem key={item.uid} item={item} openIn={openIn} />
            ))}
          </div>
        </section>
      )}

      {filteredAdded.length === 0 &&
        filteredRemoved.length === 0 &&
        filteredRenamed.length === 0 &&
        filteredChanged.length === 0 && (
          <p className="subtle">
            {fileFilter === "all" && typeFilter === "all"
              ? "No object-level differences between these two analyses."
              : "No object-level differences match the current filters."}
          </p>
        )}
    </div>
  );
}

function AnalysisTag({ comparison, side }: { comparison: Comparison; side: "a" | "b" }) {
  const meta = comparison[side];
  return (
    <span className="comparison-tag">
      <span className="comparison-tag-project">{meta.projectName}</span>
      <span className="comparison-tag-name">{meta.name}</span>
      <span className="comparison-tag-date">{formatSavedAt(meta.savedAt)}</span>
    </span>
  );
}

/** A per-file card showing added/removed/changed counts for that file. Clicking the
 * card selects it in the file filter; clicking a count also jumps to that section. */
function FileSummaryCard({
  file,
  active,
  onSelectFile,
  onJump,
}: {
  file: { fileUid: string; fileName: string; added: number; removed: number; changed: number };
  active: boolean;
  onSelectFile: () => void;
  onJump: (section: "added" | "removed" | "changed") => void;
}) {
  const stat = (label: string, value: number, tone: "added" | "removed" | "changed") => (
    <button
      type="button"
      className={`file-summary-stat file-summary-${tone}`}
      disabled={value === 0}
      onClick={(e) => {
        e.stopPropagation();
        onJump(tone);
      }}
    >
      <span className="file-summary-num">{value || "—"}</span>
      <span className="file-summary-label">{label}</span>
    </button>
  );
  return (
    <div
      className={`file-summary-card${active ? " file-summary-active" : ""}`}
      onClick={onSelectFile}
      title={file.fileName}
    >
      <div className="file-summary-name ellipsis">{file.fileName}</div>
      <div className="file-summary-stats">
        {stat("Added", file.added, "added")}
        {stat("Removed", file.removed, "removed")}
        {stat("Changed", file.changed, "changed")}
      </div>
    </div>
  );
}

function ChangeList({
  id,
  title,
  tone,
  items,
  side,
  openIn,
  renamed,
}: {
  id?: string;
  title: string;
  tone: "added" | "removed" | "renamed" | "changed";
  items: ObjectChange[];
  /** Which analysis these items live in, for opening them on click. */
  side: "a" | "b";
  openIn: (uid: string, side: "a" | "b") => void;
  renamed?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="change-group-block" id={id}>
      <h3 className="comparison-section-title">
        {title} <span className="change-count">{items.length}</span>
      </h3>
      <section className={`change-group change-${tone}`}>
        <ul>
          {items.map((item) =>
            renamed ? (
              // Two equal columns: the old name (baseline "a") then the new ("b").
              <li key={item.uid} className="change-rename">
                <button className="change-name change-link" onClick={() => openIn(item.uid, "a")} title={item.previousName}>
                  <TypePill type={item.type} short />
                  <span className="ellipsis">{item.previousName}</span>
                </button>
                <span className="change-rename-arrow" aria-hidden>→</span>
                <button className="change-name change-link" onClick={() => openIn(item.uid, "b")} title={item.name}>
                  <span className="ellipsis">{item.name}</span>
                </button>
              </li>
            ) : (
              <li key={item.uid}>
                <button className="change-name change-link" onClick={() => openIn(item.uid, side)} title={item.name}>
                  <TypePill
                    type={item.type}
                    short
                    label={item.isSeparator ? "Sep" : undefined}
                    color={item.isSeparator ? "var(--type-separator)" : undefined}
                  />
                  <span className="ellipsis">{item.name}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      </section>
    </div>
  );
}

function DiffSettingsPopover({ opts, onChange }: { opts: DiffOptions; onChange: (o: DiffOptions) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (key: keyof DiffOptions) => onChange({ ...opts, [key]: !opts[key] });
  const isDefault = (Object.keys(DEFAULT_DIFF_OPTIONS) as (keyof DiffOptions)[]).every(
    (k) => opts[k] === DEFAULT_DIFF_OPTIONS[k],
  );
  return (
    <div className="diff-settings-wrap">
      <button
        className={`diff-settings-btn${!isDefault ? " diff-settings-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Diff options"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
          <rect x="1" y="2"    width="12" height="1.5" rx="0.75"/>
          <rect x="1" y="6.25" width="12" height="1.5" rx="0.75"/>
          <rect x="1" y="10.5" width="12" height="1.5" rx="0.75"/>
          <circle cx="4"  cy="2.75"  r="2"/>
          <circle cx="10" cy="7"     r="2"/>
          <circle cx="5"  cy="11.25" r="2"/>
        </svg>
        Diff options
      </button>
      {open && (
        <>
          <div className="diff-settings-overlay" onClick={() => setOpen(false)} />
          <div className="diff-settings-pop">
            <div className="diff-settings-title">Include in comparison</div>
            <label className="diff-settings-row">
              <input type="checkbox" checked={opts.includeHash} onChange={() => toggle("includeHash")} />
              <span>
                <strong>hash</strong>
                <span className="diff-settings-hint"> — FileMaker-computed element hash (may include UUIDs)</span>
              </span>
            </label>
            <label className="diff-settings-row">
              <input
                type="checkbox"
                checked={opts.includeSerialNextValue}
                onChange={() => toggle("includeSerialNextValue")}
              />
              <span>
                <strong>Next serial value</strong>
                <span className="diff-settings-hint"> — serial field counters (advance as records are created)</span>
              </span>
            </label>
            <label className="diff-settings-row">
              <input
                type="checkbox"
                checked={opts.includeModificationInfo}
                onChange={() => toggle("includeModificationInfo")}
              />
              <span>
                <strong>Modification info</strong>
                <span className="diff-settings-hint"> — last modified by/account/timestamp</span>
              </span>
            </label>
            <div className="diff-settings-title">Object types</div>
            <label className="diff-settings-row">
              <input type="checkbox" checked={opts.includeAccounts} onChange={() => toggle("includeAccounts")} />
              <span>
                <strong>Accounts</strong>
                <span className="diff-settings-hint"> — when off, accounts are left out of the comparison</span>
              </span>
            </label>
            <label className="diff-settings-row">
              <input type="checkbox" checked={opts.includeValueLists} onChange={() => toggle("includeValueLists")} />
              <span>
                <strong>Value lists</strong>
                <span className="diff-settings-hint"> — when off, value lists are left out of the comparison</span>
              </span>
            </label>
            <div className="diff-settings-title">Scope</div>
            <label className="diff-settings-row">
              <input type="checkbox" checked={opts.diffByFileId} onChange={() => toggle("diffByFileId")} />
              <span>
                <strong>Diff by file id</strong>
                <span className="diff-settings-hint">
                  {" "}
                  — only compare files present on both sides; files unique to one side are excluded entirely
                </span>
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/** A changed object that expands to a unified line diff of its content; the name
 * opens the object in the inspector (analysis B, the "after" side) and the A/B
 * buttons open it in either analysis specifically. */
function ChangedItem({
  item,
  openIn,
}: {
  item: ObjectChange;
  openIn: (uid: string, side: "a" | "b") => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = open ? lineDiff(item.before ?? "", item.after ?? "") : [];

  return (
    <div className="changed-item">
      <div className="changed-item-head" onClick={() => setOpen((v) => !v)}>
        <span className={`fchevron${open ? " open" : ""}`}>›</span>
        <TypePill type={item.type} short />
        <button
          className="change-name change-link"
          onClick={(e) => {
            e.stopPropagation();
            openIn(item.uid, "b");
          }}
          title={item.name}
        >
          {item.name}
        </button>
        <span className="changed-item-sides">
          <button
            className="changed-item-side"
            onClick={(e) => {
              e.stopPropagation();
              openIn(item.uid, "a");
            }}
            title="Open in analysis A (before)"
          >
            A
          </button>
          <button
            className="changed-item-side"
            onClick={(e) => {
              e.stopPropagation();
              openIn(item.uid, "b");
            }}
            title="Open in analysis B (after)"
          >
            B
          </button>
        </span>
      </div>
      {open && (
        <pre className="linediff">
          {lines.map((line, i) => (
            <div key={i} className={`diff-line ${line.kind}`}>
              <span className="diff-gutter">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              {line.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
