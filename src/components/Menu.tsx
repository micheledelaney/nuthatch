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
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening puts focus on the first item.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  /** Arrow keys, Home and End move between items; Tab leaves the menu. */
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === "Tab") return setOpen(false);
    const entries = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const last = entries.length - 1;
    const next = e.key === "ArrowDown" ? (at + 1) % entries.length : e.key === "ArrowUp" ? (at + last) % entries.length : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    entries[next]?.focus();
  }

  return (
    <div className="menu" ref={ref}>
      <button
        ref={triggerRef}
        className="icon-btn"
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
        <div className="popover menu-popup" role="menu" onClick={(e) => e.stopPropagation()} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`row${item.danger ? " danger" : ""}`}
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
