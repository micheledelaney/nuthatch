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
          className={`wb-icon-btn${pinned ? " on" : ""}`}
          title={pinned ? "Unpin" : "Pin to shelf"}
          onClick={() => togglePin(uid)}
        >
          {pinned ? "★" : "☆"}
        </button>
        {isSplit ? (
          <button type="button" className="wb-icon-btn" title="Swap panes" onClick={swapPanes}>
            ⇄
          </button>
        ) : (
          <button type="button" className="wb-icon-btn" title="Open in split pane" onClick={() => openInPane("secondary", uid)}>
            ◫
          </button>
        )}
        <button type="button" className="wb-icon-btn" title="Close pane" onClick={() => closePane(side)}>
          ×
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
