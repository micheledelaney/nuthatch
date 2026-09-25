import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** A hamburger button that opens a small dropdown of actions. Closes on outside
 * click or Escape. Clicks are isolated so it can live inside clickable rows. */
export function Menu({ items, label = "Actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className="menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <line x1="2.5" y1="4" x2="13.5" y2="4" />
            <line x1="2.5" y1="8" x2="13.5" y2="8" />
            <line x1="2.5" y1="12" x2="13.5" y2="12" />
          </g>
        </svg>
      </button>
      {open && (
        <div className="menu-popup" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item${item.danger ? " danger" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
