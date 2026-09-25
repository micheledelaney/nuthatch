import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/state/store";
import { objectLabel, type FmObject } from "@/types/ddr";
import { TypePill } from "@/components/TypePill";
import { refStatsFor } from "@/components/browseA/refStats";
import { runQuery, tokenize, tokenLabel, type Token } from "./query";
import { parentContext } from "./objectInfo";

/** Cap on rendered result rows; the header still reports the true total. */
const RESULT_LIMIT = 80;

/**
 * ⌘K palette: fuzzy name search over every object, narrowed by typed filter
 * tokens. A recognised token becomes a chip as soon as it's followed by a
 * space; ⌫ in an empty input removes the last chip. Rendered into
 * document.body so it centres over the whole viewport.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const model = useStore((s) => s.model);
  const recent = useStore((s) => s.recent);
  const openObject = useStore((s) => s.openObject);
  const openInPane = useStore((s) => s.openInPane);

  const [chips, setChips] = useState<Token[]>([]);
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const deferredText = useDeferredValue(text);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { rows, total, isRecent } = useMemo(() => {
    if (!model) return { rows: [] as FmObject[], total: 0, isRecent: false };
    const live = tokenize(deferredText);
    const tokens = [...chips, ...live.tokens];
    if (tokens.length === 0 && !live.free.trim()) {
      const recentObjs = recent.map((u) => model.byUid.get(u)).filter((o): o is FmObject => !!o);
      return { rows: recentObjs, total: recentObjs.length, isRecent: true };
    }
    const { results, total: t } = runQuery(model, tokens, live.free, RESULT_LIMIT);
    return { rows: results.map((r) => r.obj), total: t, isRecent: false };
  }, [model, chips, deferredText, recent]);

  useEffect(() => setSel(0), [rows]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!model) return null;

  const onChange = (value: string) => {
    // Move completed (space-terminated) tokens out of the text into chips.
    const { tokens, free } = tokenize(value, true);
    if (tokens.length === 0) return setText(value);
    setChips((prev) => [...prev, ...tokens]);
    setText(free ? `${free} ` : "");
  };

  const open = (obj: FmObject | undefined, inSplit: boolean) => {
    if (!obj) return;
    if (inSplit) openInPane("secondary", obj.uid);
    else openObject(obj.uid);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (rows.length ? (s + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(rows[sel], e.shiftKey);
    } else if (e.key === "Backspace" && text === "" && chips.length > 0) {
      e.preventDefault();
      setChips((prev) => prev.slice(0, -1));
    }
  };

  return createPortal(
    <div className="modal-overlay wb-overlay" onMouseDown={onClose}>
      <div className="wb-palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="wb-palette-input" onClick={() => inputRef.current?.focus()}>
          <SearchIcon />
          {chips.map((c, i) => (
            <span key={`${c.raw}-${i}`} className={`wb-chip wb-chip-${c.kind}`}>
              {tokenLabel(c)}
              <button
                type="button"
                aria-label={`Remove ${tokenLabel(c)}`}
                onClick={() => setChips((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            placeholder={chips.length ? "" : "Search objects…  try type:script is:unreferenced"}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="wb-palette-meta">
          {isRecent ? "Recently opened" : `${total.toLocaleString()} match${total === 1 ? "" : "es"}`}
          {!isRecent && total > rows.length && ` · showing ${rows.length}`}
        </div>
        <div className="wb-palette-results" ref={listRef}>
          {rows.length === 0 && (
            <div className="wb-palette-empty">{isRecent ? "Nothing opened yet. Start typing." : "No matches."}</div>
          )}
          {rows.map((obj, i) => {
            const stats = refStatsFor(model, obj.uid);
            return (
              <div
                key={obj.uid}
                data-index={i}
                className={`wb-result${i === sel ? " active" : ""}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={(e) => open(obj, e.shiftKey)}
              >
                <TypePill type={obj.type} short />
                <span className="wb-result-name ellipsis">{objectLabel(obj)}</span>
                <span className="wb-result-ctx ellipsis">{parentContext(model, obj)}</span>
                <span className="wb-counts" title="Inbound ← / outbound → references">
                  ←{stats.inbound} →{stats.outbound}
                </span>
              </div>
            );
          })}
        </div>
        <div className="wb-palette-hint">
          <span>
            <code>type:script</code> <code>table:Invoices</code> <code>is:broken|unreferenced|calc|unstored|global</code>{" "}
            <code>refs&gt;20</code>
          </span>
          <span className="wb-hint-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>⇧</kbd>
            <kbd>↵</kbd> split <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="wb-search-icon">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  );
}
