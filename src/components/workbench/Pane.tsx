import { useCallback, useRef } from "react";
import { useStore, type PaneSide } from "@/state/store";
import { HistoryBar } from "@/components/browseA/HistoryBar";
import { ObjectPage } from "@/components/browseA/ObjectPage";
import { PaneNavContext } from "./paneNav";

const EMPTY: string[] = [];

/**
 * One Browse pane: a history bar (crumbs + pin, split / swap, close) over the
 * object page. The primary pane's history is the store `trail`; the secondary
 * pane's is `split`. ⇧-click on any reference inside the pane opens it in the
 * other pane.
 */
export function Pane({
  side,
  isSplit,
  isActive,
  onActivate,
}: {
  side: PaneSide;
  isSplit: boolean;
  /** Whether this pane receives ⌘[ / ⌘]. */
  isActive: boolean;
  onActivate: (side: PaneSide) => void;
}) {
  const history = useStore((s) => (side === "primary" ? s.trail : s.split ?? EMPTY));
  const pins = useStore((s) => s.pins);
  const navigateFrom = useStore((s) => s.navigateFrom);
  const openInPane = useStore((s) => s.openInPane);
  const closePane = useStore((s) => s.closePane);
  const swapPanes = useStore((s) => s.swapPanes);
  const togglePin = useStore((s) => s.togglePin);
  const shiftRef = useRef(false);

  const other: PaneSide = side === "primary" ? "secondary" : "primary";
  const lastIndex = history.length - 1;
  const uid = history[lastIndex];

  // Navigation for the ObjectPage inside this pane. The capture-phase click
  // handler below records ⇧ just before the row's own onClick calls this.
  const go = useCallback(
    (target: string, rowKey: string) => {
      if (shiftRef.current) {
        shiftRef.current = false;
        openInPane(other, target);
      } else if (side === "primary") {
        navigateFrom(lastIndex, target, rowKey);
      } else {
        openInPane("secondary", target);
      }
    },
    [side, other, lastIndex, navigateFrom, openInPane],
  );

  if (!uid) return null;
  const pinned = pins.includes(uid);

  return (
    <div
      className={`wb-pane${isSplit && isActive ? " active" : ""}`}
      onClickCapture={(e) => {
        shiftRef.current = e.shiftKey;
      }}
      onMouseDownCapture={(e) => {
        onActivate(side);
        // Keep ⇧-click on a link from extending a text selection.
        if (e.shiftKey && (e.target as Element).closest("li, button")) e.preventDefault();
      }}
      onFocusCapture={() => onActivate(side)}
    >
      <HistoryBar side={side} isActive={isActive}>
        <button
          type="button"
          className={`icon-btn${pinned ? " active" : ""}`}
          title={pinned ? "Unpin" : "Pin to shelf"}
          aria-label="Pin to shelf"
          aria-pressed={pinned}
          onClick={() => togglePin(uid)}
        >
          <StarIcon filled={pinned} />
        </button>
        {isSplit ? (
          <button type="button" className="icon-btn" title="Swap panes" aria-label="Swap panes" onClick={swapPanes}>
            <SwapIcon />
          </button>
        ) : (
          <button type="button" className="icon-btn" title="Open in split pane" aria-label="Open in split pane" onClick={() => openInPane("secondary", uid)}>
            <SplitIcon />
          </button>
        )}
        <button type="button" className="icon-btn" title="Close pane" aria-label="Close pane" onClick={() => closePane(side)}>
          <CloseIcon />
        </button>
      </HistoryBar>
      <div className="wb-pane-body">
        <PaneNavContext.Provider value={go}>
          <ObjectPage key={`${uid}-${lastIndex}`} uid={uid} index={lastIndex} />
        </PaneNavContext.Provider>
      </div>
    </div>
  );
}

/** The pin star, drawn rather than typed: the ☆/★ glyphs come from a fallback
 * font whose metrics leave them off-centre in a round button. */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.6l1.95 4.1 4.45.55-3.28 3.08.85 4.42L8 11.58l-3.97 2.17.85-4.42L1.6 6.25l4.45-.55z" />
    </svg>
  );
}

/** The close cross, drawn at the star's weight so the pane's buttons read
 * as one set. */
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

/** Open in a split pane: a window with a divider, at the star's weight. */
function SplitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  );
}

/** Swap the two panes: arrows both ways, at the star's weight. */
function SwapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5.5h10M10.5 3l2.5 2.5-2.5 2.5M13 10.5H3M5.5 8 3 10.5 5.5 13" />
    </svg>
  );
}
