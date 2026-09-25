import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, type PaneSide } from "@/state/store";
import { objectLabel } from "@/types/ddr";
import { TypePill } from "../TypePill";

/** A history snapshot kept when the user steps back, so they can step forward again. */
interface Ahead {
  trail: string[];
  keys: string[];
}

const EMPTY: string[] = [];

/** Whether `prefix` is a (non-strict) prefix of `full`. */
function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.length <= full.length && prefix.every((u, i) => full[i] === u);
}

/**
 * The slim history bar at the top of a Browse pane: back/forward buttons plus
 * the pane's history as clickable crumbs, then the pane's own action buttons
 * (`children`). The primary pane's history is the store `trail`, the secondary
 * pane's is `split`. Back is ← / ⌘[ and forward → / ⌘] (only for the active pane).
 * Forward history lives here, not in the store: stepping back remembers the
 * longer history, and forward replays it while the current one is its prefix.
 */
export function HistoryBar({
  side,
  isActive,
  children,
}: {
  side: PaneSide;
  /** Whether the arrow keys and ⌘[ / ⌘] act on this pane. */
  isActive: boolean;
  children?: React.ReactNode;
}) {
  const model = useStore((s) => s.model);
  const history = useStore((s) => (side === "primary" ? s.trail : s.split ?? EMPTY));
  const trailKeys = useStore((s) => (side === "primary" ? s.trailKeys : EMPTY));
  const truncatePane = useStore((s) => s.truncatePane);
  const navigateFrom = useStore((s) => s.navigateFrom);
  const openInPane = useStore((s) => s.openInPane);
  const [ahead, setAhead] = useState<Ahead | null>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  const canForward = !!ahead && ahead.trail.length > history.length && isPrefix(history, ahead.trail);
  const canBack = history.length > 1;

  /** Jump to history position `index`, remembering what's ahead. */
  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= history.length - 1) return;
      setAhead((prev) => (prev && isPrefix(history, prev.trail) ? prev : { trail: history, keys: trailKeys }));
      truncatePane(side, index);
    },
    [history, trailKeys, side, truncatePane],
  );

  const back = useCallback(() => goTo(history.length - 2), [goTo, history.length]);

  const forward = useCallback(() => {
    if (!canForward || !ahead) return;
    const next = ahead.trail[history.length];
    if (!next) return;
    if (side === "primary") navigateFrom(history.length - 1, next, ahead.keys[history.length] ?? "");
    else openInPane(side, next);
  }, [canForward, ahead, history.length, side, navigateFrom, openInPane]);

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if (isArrow && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const el = e.target as HTMLElement;
        if (el?.tagName === "TEXTAREA" || el?.tagName === "SELECT") return;
        // In a text box, only act once the caret can't move any further that way.
        if (el?.tagName === "INPUT") {
          const input = el as HTMLInputElement;
          const edge = e.key === "ArrowLeft" ? 0 : input.value.length;
          if (input.selectionStart !== edge || input.selectionEnd !== edge) return;
        }
        e.preventDefault();
        if (e.key === "ArrowLeft") back();
        else forward();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        e.preventDefault();
        back();
      } else if (e.key === "]") {
        e.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, back, forward]);

  // Keep the newest crumb in view as the history grows.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [history]);

  if (!model) return null;

  return (
    <div className="history-bar">
      <button type="button" className="hb-nav" onClick={back} disabled={!canBack} title="Back (← or ⌘[)">
        ‹
      </button>
      <button type="button" className="hb-nav" onClick={forward} disabled={!canForward} title="Forward (→ or ⌘])">
        ›
      </button>
      <div className="hb-crumbs" ref={crumbsRef}>
        {history.map((uid, i) => {
          const obj = model.byUid.get(uid);
          const current = i === history.length - 1;
          return (
            <span key={`${uid}-${i}`} className="hb-crumb-wrap">
              {i > 0 && <span className="hb-sep">›</span>}
              <button
                type="button"
                className={`hb-crumb${current ? " current" : ""}`}
                onClick={() => goTo(i)}
                title={obj ? objectLabel(obj) : uid}
              >
                {obj && <TypePill type={obj.type} short />}
                <span className="ellipsis">{obj ? objectLabel(obj) : "(missing)"}</span>
              </button>
            </span>
          );
        })}
      </div>
      {children && <div className="hb-actions">{children}</div>}
    </div>
  );
}
