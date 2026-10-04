import { useContext, useId, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { isBrokenTableOccurrence, objectLabel, type FmObject, type SolutionModel } from "@/types/ddr";
import { buildDependencyView } from "@/core/analysis/dependencies";
import { buildCallChain } from "@/core/analysis/callChain";
import { isUnusedSource } from "@/core/analysis/unusedChains";
import {
  CallTreeNode,
  Detail,
  DetailsProps,
  GroupedRefList,
  OccurrenceRelationships,
  Section,
  refIndexFor,
} from "../ObjectColumn";
import { TypePill } from "../TypePill";
import { isInUnusedChain, isUnreferenced } from "./filters";
import { factsFor } from "./facts";
import { refStatsFor } from "./refStats";
import { Glance, GlanceSection } from "./Glance";
import { PaneNavContext } from "../workbench/paneNav";
import { pressable, onTabListKeyDown } from "../a11y";

/** Rows shown per tab before "Show more" — a tab is the whole view, so it can
 * afford far more than the old side-by-side widgets. */
const TAB_PREVIEW_LIMIT = 200;

type Tab = "definition" | "usedBy" | "uses" | "calls";

/**
 * The object page: the name and flags, then tabs (Details, Used by, Uses,
 * Calls — short so they fit a split pane). The pane's history bar above it is the only breadcrumb.
 * Every link inside navigates forward from this page's trail position.
 */
export function ObjectPage({ uid, index }: { uid: string; index: number }) {
  const model = useStore((s) => s.model);
  const highlight = useStore((s) => s.highlight);
  const navigateFrom = useStore((s) => s.navigateFrom);
  const showGraphFor = useStore((s) => s.showGraphFor);
  // A workbench pane may take over navigation (e.g. ⇧-click → other pane).
  const paneGo = useContext(PaneNavContext);
  const panelId = useId();
  const [tab, setTab] = useState<Tab>("definition");

  const view = useMemo(() => (model ? buildDependencyView(model, uid) : null), [model, uid]);
  const obj = model?.byUid.get(uid);
  const chain = useMemo(
    () => (model && obj?.type === "script" ? buildCallChain(model, uid) : null),
    [model, obj, uid],
  );

  if (!model) return null;
  if (!obj || !view) return <div className="object-page">Object not found.</div>;

  const go = paneGo ?? ((targetUid: string, rowKey: string) => navigateFrom(index, targetUid, rowKey));
  // Menu->item containment edges show as the menu's children instead.
  const outbound = view.outbound.filter((e) => e.ref.kind !== "menuItem");
  const inbound = view.inbound;
  const brokenCount = refStatsFor(model, uid).broken;
  const callCount = chain?.children.length ?? 0;
  const isUnused = (u: string) => isUnusedSource(model, u);

  const facts = factsFor({
    brokenCount,
    unreferenced: isUnreferenced(model, obj),
    unusedChain: isInUnusedChain(model, obj),
    selfBroken: isBrokenTableOccurrence(obj),
  });

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "definition", label: "Details" },
    { id: "usedBy", label: "Used by", count: inbound.length },
    { id: "uses", label: "Uses", count: outbound.length },
  ];
  if (obj.type === "script") tabs.push({ id: "calls", label: "Calls", count: callCount });

  return (
    <div className="object-page">
      <header className="op-header">
        <Glance
          obj={obj}
          model={model}
          facts={facts}
          actions={
            obj.type === "tableOccurrence" && (
              <button
                className="icon-btn graph-jump-btn"
                title="Show in relationship graph"
                aria-label="Show in relationship graph"
                onClick={() => showGraphFor(uid)}
              >
                <GraphIcon />
              </button>
            )
          }
        />
        <div className="tabs op-tabs" role="tablist" aria-label="Sections" onKeyDown={onTabListKeyDown}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${panelId}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${panelId}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="op-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="detail-body op-body" role="tabpanel" id={`${panelId}-panel`} aria-labelledby={`${panelId}-${tab}`}>
        {tab === "definition" && (
          <DefinitionTab obj={obj} model={model} onGo={go} scrollToStep={highlight && highlight.uid === uid ? highlight.step : null} />
        )}
        {tab === "usedBy" && (
          <div className="op-tab-panel">
            <GroupedRefList edges={inbound} side="from" onGo={go} byUid={model.byUid} previewLimit={TAB_PREVIEW_LIMIT} isUnused={isUnused} />
          </div>
        )}
        {tab === "uses" && (
          <div className="op-tab-panel">
            <GroupedRefList edges={outbound} side="to" onGo={go} byUid={model.byUid} previewLimit={TAB_PREVIEW_LIMIT} />
          </div>
        )}
        {tab === "calls" && (
          <div className="op-tab-panel">
            {chain && callCount > 0 ? (
              <ul className="tree" style={{ paddingLeft: 0 }}>
                <CallTreeNode node={chain} path="" onGo={go} isRoot isUnused={isUnused} />
              </ul>
            ) : (
              <div className="subtle indent">This script doesn't call any other scripts.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Details tab: At a glance first, then the type-specific detail (steps,
 * calc, layout, …), then children, then the full property sheet. */
function DefinitionTab({
  obj,
  model,
  onGo,
  scrollToStep,
}: {
  obj: FmObject;
  model: SolutionModel;
  onGo: (uid: string, rowKey: string) => void;
  scrollToStep: number | null;
}) {
  const uid = obj.uid;
  const childTitle = obj.type === "table" ? "Fields" : obj.type === "customMenu" ? "Menu items" : null;
  const children = childTitle
    ? model.objects.filter((o) => o.parentUid === uid).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [];
  const brokenSteps = new Set<number>();
  for (const ref of model.outbound.get(uid) ?? []) {
    if (ref.broken && ref.fromStep != null) brokenSteps.add(ref.fromStep);
  }

  return (
    <>
      <GlanceSection obj={obj} model={model} onGo={onGo} />
      {obj.type === "tableOccurrence" ? (
        <OccurrenceRelationships model={model} toUid={uid} onGo={onGo} />
      ) : obj.detail ? (
        <Detail
          detail={obj.detail}
          owner={obj}
          model={model}
          onGo={onGo}
          brokenSteps={brokenSteps}
          scrollToStep={scrollToStep}
        />
      ) : null}

      {childTitle && children.length > 0 && (
        <Section title={childTitle} count={children.filter((c) => !c.isSeparator).length}>
          <ul className="ref-list">
            {children.map((child) =>
              child.isSeparator ? (
                <li key={child.uid} className="ref-divider" aria-hidden />
              ) : (
                <li key={child.uid}>
                  <div className="row" {...pressable(() => onGo(child.uid, child.uid))} title={objectLabel(child)}>
                    <TypePill type={child.type} short />
                    <span className="ellipsis">{child.name}</span>
                  </div>
                </li>
              ),
            )}
          </ul>
        </Section>
      )}

      <DetailsProps obj={obj} model={model} refIndex={refIndexFor(model, uid)} onGo={onGo} />
    </>
  );
}

/** Three linked nodes: the relationship graph. */
function GraphIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M6.6 5.1 4.4 10.4M9.4 5.1l2.2 5.3M5.6 12.5h4.8" />
      <circle cx="8" cy="3.5" r="2" />
      <circle cx="3.5" cy="12.5" r="2" />
      <circle cx="12.5" cy="12.5" r="2" />
    </svg>
  );
}
