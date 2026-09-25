import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 220;
const MAX_WIDTH = 640;
/** Like VS Code's sash: dragging below half the minimum snaps the navigator shut. */
const COLLAPSE_BELOW = MIN_WIDTH / 2;
const STORAGE_KEY = "nuthatch.sidebarWidth";

/** Valid widths are 0 (collapsed) or MIN_WIDTH..MAX_WIDTH. */
function clampWidth(w: number): number {
  if (w < COLLAPSE_BELOW) return 0;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

function readStoredWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const width = Number(stored);
    return stored !== null && Number.isFinite(width) ? clampWidth(width) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function storeWidth(width: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Storage unavailable (private mode etc.) — the width just won't persist.
  }
}

/** Navigator width, remembered across sessions. Feed it to `--sidebar-w`. */
export function useSidebarWidth() {
  const [width, setWidth] = useState(readStoredWidth);
  useEffect(() => storeWidth(width), [width]);
  return [width, setWidth] as const;
}

/** Drag handle on the navigator's right edge. Stays grabbable when the navigator
 * is collapsed to 0, so it can be dragged back open. Double-click restores the
 * default width. */
export function SidebarResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setIsDragging(true);

      const onMove = (ev: PointerEvent) => onChange(clampWidth(startWidth + ev.clientX - startX));
      const onUp = () => {
        setIsDragging(false);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [width, onChange],
  );

  return (
    <div
      className={`sidebar-resizer${isDragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={MAX_WIDTH}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(DEFAULT_WIDTH)}
    />
  );
}
