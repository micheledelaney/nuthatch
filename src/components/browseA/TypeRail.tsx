import { useMemo } from "react";
import { useStore } from "@/state/store";
import { OBJECT_TYPE_META, type ObjectType, type SolutionModel } from "@/types/ddr";
import { SHORT_LABEL } from "../TypePill";
import { typeColor } from "../typeStyle";
import { brokenSourcesFor } from "./refStats";

/** Compact rail captions (the full plural is the tooltip). */
const RAIL_LABEL: Partial<Record<ObjectType, string>> = {
  tableOccurrence: "TOs",
  layoutObject: "Objects",
  valueList: "Value lists",
  customFunction: "Functions",
  privilegeSet: "Priv. sets",
  extendedPrivilege: "Ext. privs",
  externalDataSource: "Sources",
  customMenuSet: "Menu sets",
  customMenu: "Menus",
  customMenuItem: "Menu items",
  globalVariable: "Globals",
};

export interface TypeSummary {
  type: ObjectType;
  count: number;
  /** Objects of this type with at least one broken outbound reference. */
  broken: number;
}

/** Per-type object counts (separators excluded) and broken-source counts, in
 * the canonical navigator order, for types that have any objects. */
export function summarizeTypes(model: SolutionModel): TypeSummary[] {
  const counts = new Map<ObjectType, number>();
  for (const o of model.objects) {
    if (o.isSeparator) continue;
    counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
  }
  const broken = new Map<ObjectType, number>();
  for (const uid of brokenSourcesFor(model)) {
    const o = model.byUid.get(uid);
    if (o) broken.set(o.type, (broken.get(o.type) ?? 0) + 1);
  }
  return (Object.keys(OBJECT_TYPE_META) as ObjectType[])
    .filter((t) => (counts.get(t) ?? 0) > 0)
    .map((t) => ({ type: t, count: counts.get(t) ?? 0, broken: broken.get(t) ?? 0 }));
}

/** The far-left type rail: "All" plus one entry per populated object type.
 * Selecting an entry sets the navigator's type filter. */
export function TypeRail() {
  const model = useStore((s) => s.model);
  const navType = useStore((s) => s.navType);
  const setNavType = useStore((s) => s.setNavType);
  const summaries = useMemo(() => (model ? summarizeTypes(model) : []), [model]);
  if (!model) return null;

  const anyBroken = summaries.some((s) => s.broken > 0);

  return (
    <nav className="type-rail" aria-label="Object types">
      <RailEntry
        glyph="∗"
        color="var(--text)"
        label="All"
        title="All object types"
        broken={anyBroken}
        active={navType === "all"}
        onClick={() => setNavType("all")}
      />
      {summaries.map((s) => (
        <RailEntry
          key={s.type}
          glyph={SHORT_LABEL[s.type]}
          color={typeColor(s.type)}
          label={RAIL_LABEL[s.type] ?? OBJECT_TYPE_META[s.type].plural}
          title={`${OBJECT_TYPE_META[s.type].plural} · ${s.count}${s.broken ? ` · ${s.broken} with broken references` : ""}`}
          broken={s.broken > 0}
          active={navType === s.type}
          onClick={() => setNavType(s.type)}
        />
      ))}
    </nav>
  );
}

function RailEntry({
  glyph,
  color,
  label,
  title,
  broken,
  active,
  onClick,
}: {
  glyph: string;
  color: string;
  label: string;
  title: string;
  broken: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`rail-entry${active ? " active" : ""}`} onClick={onClick} title={title}>
      <span className="rail-glyph" style={{ color, borderColor: color }}>
        {glyph}
        {broken && <span className="rail-broken-dot" aria-label="Has broken references" />}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}
