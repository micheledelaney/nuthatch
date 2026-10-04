import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "@/components/a11y";
import { SHORTCUTS } from "./objectInfo";

/** The shortcut table, shared by the ? overlay and the welcome screen. */
export function ShortcutList() {
  return (
    <dl className="wb-shortcuts">
      {SHORTCUTS.map((s) => (
        <div key={s.description} className="wb-shortcut">
          <dt>
            {s.combos.map((combo, i) => (
              <span key={combo.join("+")} className="wb-combo">
                {i > 0 && <span className="wb-or">/</span>}
                {combo.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            ))}
          </dt>
          <dd>{s.description}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "?" overlay listing every Browse shortcut. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalFocus<HTMLDivElement>();
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay wb-overlay" onMouseDown={onClose}>
      <div className="popover modal wb-help" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} onMouseDown={(e) => e.stopPropagation()}>
        <h3 id={titleId}>Keyboard shortcuts</h3>
        <ShortcutList />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
