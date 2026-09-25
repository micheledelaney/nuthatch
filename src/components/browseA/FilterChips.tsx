import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import type { FmObject, ObjectType, SolutionModel } from "@/types/ddr";
import { chipCounts, chipGroupsFor, type NavFilterKey, type NavFilters } from "./filters";

/** Store setter for each chip group. Casts are safe: each group's option values
 * come from that filter's own value set (see chipGroupsFor). */
function filterSetters(): Record<NavFilterKey, (value: string) => void> {
  const s = useStore.getState();
  return {
    field: (v) => s.setNavFieldFilter(v as NavFilters["field"]),
    dataType: (v) => s.setNavDataType(v),
    rel: (v) => s.setNavRelFilter(v as NavFilters["rel"]),
    account: (v) => s.setNavAccountFilter(v as NavFilters["account"]),
    accountPw: (v) => s.setNavAccountPw(v as NavFilters["accountPw"]),
    accountPriv: (v) => s.setNavAccountPriv(v),
    privCap: (v) => s.setNavPrivCap(v as NavFilters["privCap"]),
    ref: (v) => s.setNavRefFilter(v as NavFilters["ref"]),
    layout: (v) => s.setNavLayoutFilter(v as NavFilters["layout"]),
    loType: (v) => s.setNavLayoutObjectType(v),
    loFilter: (v) => s.setNavLayoutObjectFilter(v as NavFilters["loFilter"]),
  };
}

/**
 * Toggleable filter chips with faceted counts, replacing the navigator's
 * sub-filter dropdowns. One selection per group (matching the store's
 * single-value filters); clicking the active chip clears its group.
 */
export function FilterChips({
  model,
  base,
  type,
  filters,
}: {
  model: SolutionModel;
  base: FmObject[];
  type: ObjectType | "all";
  filters: NavFilters;
}) {
  const setters = filterSetters();
  const groups = useMemo(() => chipGroupsFor(model, type), [model, type]);
  const counts = useMemo(
    () => chipCounts(model, base, type, filters, groups),
    [model, base, type, filters, groups],
  );
  if (groups.length === 0) return null;

  const anyActive = groups.some((g) => filters[g.key] !== "all");

  return (
    <div className="chip-bar">
      {groups.map((g) => (
        <div className="chip-group" key={g.key}>
          <span className="chip-group-label">{g.label}</span>
          {g.options.map((opt) => {
            const active = filters[g.key] === opt.value;
            const n = counts.get(`${g.key}:${opt.value}`) ?? 0;
            return (
              <button
                key={opt.value}
                type="button"
                className={`chip${active ? " active" : ""}${opt.tone ? ` tone-${opt.tone}` : ""}${n === 0 && !active ? " empty" : ""}`}
                onClick={() => setters[g.key](active ? "all" : opt.value)}
                title={active ? `Clear “${opt.label}”` : `Show only ${opt.label.toLowerCase()}`}
              >
                {opt.label}
                <span className="chip-count">{n}</span>
              </button>
            );
          })}
        </div>
      ))}
      {anyActive && (
        <button
          type="button"
          className="chip-clear"
          onClick={() => groups.forEach((g) => setters[g.key]("all"))}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

/** A filter-icon button beside the navigator search that opens every chip
 * group in a popover. The icon lights up while any filter is active, so a
 * narrowed list is never a surprise. Closes on outside click or Esc. */
export function FilterMenu(props: {
  model: SolutionModel;
  base: FmObject[];
  type: ObjectType | "all";
  filters: NavFilters;
}) {
  const { model, type, filters } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => chipGroupsFor(model, type), [model, type]);
  const activeCount = groups.filter((g) => filters[g.key] !== "all").length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (groups.length === 0) return null;

  const label = activeCount > 0 ? `Filters (${activeCount} active)` : "Filters";
  return (
    <div className="filter-menu" ref={rootRef}>
      <button
        type="button"
        className={`filter-btn${activeCount > 0 ? " active" : ""}${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-label={label}
        aria-expanded={open}
      >
        <FilterIcon />
      </button>
      {open && (
        <div className="filter-popover" role="dialog" aria-label="Filters">
          <FilterChips {...props} />
        </div>
      )}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
