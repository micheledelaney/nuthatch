/**
 * Find in a script: a search field for the Script steps header, and the
 * highlighting of its matches in the steps. Matches are found in the text as
 * rendered and tinted with boxes drawn behind it, so links, field references
 * and syntax colours stay as they are.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SearchIcon } from "./workbench/CommandPalette";

/** The search a ScriptWorkspace shows: the query, which match is current, and
 * where to report how many matches there are. */
export interface FindState {
  query: string;
  /** The match moved to with Enter or the arrows; null while typing. */
  current: number | null;
  onCount: (count: number) => void;
}

/** Where each occurrence of `query` sits in `text`, as [start, end): plain
 * text, not case-sensitive. A blank query matches nothing. */
export function matchOffsets(text: string, query: string): [number, number][] {
  if (query.trim() === "") return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

/** The node and offset of position `pos` in text split over `nodes`, which
 * start at `starts`. An end position stays at the end of the node before. */
function locate(nodes: Text[], starts: number[], pos: number, isEnd: boolean): [Text, number] {
  let k = 0;
  while (k + 1 < nodes.length && (isEnd ? starts[k + 1]! < pos : starts[k + 1]! <= pos)) k++;
  return [nodes[k]!, pos - starts[k]!];
}

/** A range for every match in each line's text as shown. A match never spans
 * two lines. */
function findRanges(lines: Iterable<HTMLElement>, query: string): Range[] {
  const ranges: Range[] = [];
  for (const line of lines) {
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      starts.push(text.length);
      nodes.push(node as Text);
      text += (node as Text).data;
    }
    for (const [start, end] of matchOffsets(text, query)) {
      const range = document.createRange();
      range.setStart(...locate(nodes, starts, start, false));
      range.setEnd(...locate(nodes, starts, end, true));
      ranges.push(range);
    }
  }
  return ranges;
}

/** Draw a tint behind each match: one rectangle per line a match covers,
 * placed in `layer` (laid over `box`, under the text). The current match gets
 * the stronger tint. */
function drawMarks(layer: HTMLElement, box: HTMLElement, ranges: Range[], current: number) {
  const origin = box.getBoundingClientRect();
  const marks = ranges.flatMap((range, i) =>
    [...range.getClientRects()].map((rect) => {
      const mark = document.createElement("div");
      mark.className = i === current ? "sw-find-mark is-current" : "sw-find-mark";
      mark.style.left = `${Math.round(rect.left - origin.left)}px`;
      mark.style.top = `${Math.round(rect.top - origin.top)}px`;
      mark.style.width = `${Math.round(rect.width)}px`;
      mark.style.height = `${Math.round(rect.height)}px`;
      return mark;
    }),
  );
  layer.replaceChildren(...marks);
}

/** Tint the matches of `find` in the lines under `root` (picked by
 * `lineSelector`) on `layer`, report their count, and scroll to the current
 * one when it changes. The tints are plain boxes drawn here rather than CSS
 * highlights, which Safari leaves partly painted when they change. */
export function useFindHighlights(
  root: RefObject<HTMLElement | null>,
  layer: RefObject<HTMLElement | null>,
  lineSelector: string,
  find?: FindState,
) {
  const shown = useRef<{ query?: string; current?: number | null }>({});
  const redraw = useRef<() => void>(() => {});

  // After every render: the steps' text may have changed (a long step
  // expanded, another script shown), so the matches are found again.
  useLayoutEffect(() => {
    const box = root.current;
    const marks = layer.current;
    if (!box || !marks) return;
    const found = find?.query.trim() ? findRanges(box.querySelectorAll<HTMLElement>(lineSelector), find.query) : [];
    find?.onCount(found.length);
    const current = find?.current != null && find.current < found.length ? find.current : -1;
    redraw.current = () => drawMarks(marks, box, found, current);
    redraw.current();
    // Scroll only when the current match changes (Enter, the arrows), not on
    // every render or while typing.
    if (current >= 0 && (shown.current.query !== find?.query || shown.current.current !== find?.current)) {
      found[current]!.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
    shown.current = { query: find?.query, current: find?.current };
  });

  // Text rewraps when the pane is resized: the boxes follow.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const observer = new ResizeObserver(() => redraw.current());
    observer.observe(box);
    return () => observer.disconnect();
  }, [root]);
}

/** "12 matches" until Enter or an arrow picks one, then "3 of 12". */
function countLabel(count: number, active: number | null): string {
  if (count === 0) return "No matches";
  if (active == null) return count === 1 ? "1 match" : `${count} matches`;
  return `${active + 1} of ${count}`;
}

/** The find state for one script, and its search field. */
export function useScriptFind() {
  const [query, setQuery] = useState("");
  // No current match while typing: the first Enter (or ↓) goes to the first
  // match, ↑ to the last.
  const [current, setCurrent] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const active = current != null && count ? current % count : null;
  const move = (by: number) => {
    if (!count) return;
    if (active == null) setCurrent(by > 0 ? 0 : count - 1);
    else setCurrent((active + by + count) % count);
  };
  const search = (text: string) => {
    setQuery(text);
    setCurrent(null);
  };
  const hasQuery = query.trim() !== "";

  const field = (
    <div className="sw-find">
      {/* Left of the field, so the field sits flush with the steps' right edge;
          always laid out, hidden until there's a search, so nothing moves. */}
      <span className={`sw-find-results${hasQuery ? "" : " is-idle"}`} aria-hidden={!hasQuery}>
        <span className="sw-find-count" aria-live="polite">
          {hasQuery && countLabel(count, active)}
        </span>
        <button
          type="button"
          className="glyph-btn"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={!count}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="glyph-btn"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={!count}
          onClick={() => move(1)}
        >
          ↓
        </button>
      </span>
      <label className="nav-search has-query" title="Find in this script">
        <SearchIcon />
        <input
          type="search"
          value={query}
          placeholder="Find"
          aria-label="Find in this script"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              move(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              search("");
            }
          }}
        />
      </label>
    </div>
  );

  return { field, find: { query, current: active, onCount: setCount } satisfies FindState };
}
