import { useContext, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { isBrokenTableOccurrence, objectLabel, type FmObject, type SolutionModel } from "@/types/ddr";
import { buildDependencyView } from "@/core/analysis/dependencies";
import { buildCallChain } from "@/core/analysis/callChain";
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
import { isUnreferenced } from "./filters";
import { factsFor } from "./facts";
import { Glance } from "./Glance";
import { PaneNavContext } from "../workbench/paneNav";

/** Rows shown per tab before "Show more" — a tab is the whole view, so it can
 * afford far more than the old side-by-side widgets. */
const TAB_PREVIEW_LIMIT = 200;

type Tab = "definition" | "usedBy" | "uses" | "calls";

/**
 * The object page: the At a glance card (name, type, key attributes, flags), then tabs (Definition, Referenced
 * by, References, Call chain). The pane's history bar above it is the only breadcrumb.
 * Every link inside navigates forward from this page's trail position.
 */
export function ObjectPage({ uid, index }: { uid: string; index: number }) {
  const model = useStore((s) => s.model);
  const highlight = useStore((s) => s.highlight);
  const navigateFrom = useStore((s) => s.navigateFrom);
  const showGraphFor = useStore((s) => s.showGraphFor);
  // A workbench pane may take over navigation (e.g. ⇧-click → other pane).
  const paneGo = useContext(PaneNavContext);
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
  const brokenCount = outbound.filter((e) => e.ref.broken).length;
  const callCount = chain?.children.length ?? 0;

  const facts = factsFor({
    brokenCount,
    unreferenced: isUnreferenced(model, obj),
    selfBroken: isBrokenTableOccurrence(obj),
  });

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "definition", label: "Details" },
    { id: "usedBy", label: "Referenced by", count: inbound.length },
    { id: "uses", label: "References", count: outbound.length },
  ];
  if (obj.type === "script") tabs.push({ id: "calls", label: "Call chain", count: callCount });

  return (
    <div className="object-page">
      <header className="op-header">
        <Glance
          obj={obj}
          model={model}
          facts={facts}
          onGo={go}
          actions={
            obj.type === "tableOccurrence" && (
              <button className="graph-jump-btn" title="Show in relationship graph" onClick={() => showGraphFor(uid)}>
                Show in graph
              </button>
            )
          }
        />
        <div className="op-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`op-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="op-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="detail-body op-body">
        {tab === "definition" && (
          <DefinitionTab obj={obj} model={model} onGo={go} scrollToStep={highlight && highlight.uid === uid ? highlight.step : null} />
        )}
        {tab === "usedBy" && (
          <div className="op-tab-panel">
            <GroupedRefList edges={inbound} side="from" onGo={go} byUid={model.byUid} previewLimit={TAB_PREVIEW_LIMIT} />
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
                <CallTreeNode node={chain} path="" onGo={go} isRoot />
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

/** Details tab: the type-specific detail first (steps, calc, layout, …),
 * then children, then the full property sheet. */
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
                <li key={child.uid} onClick={() => onGo(child.uid, child.uid)} title={objectLabel(child)}>
                  <TypePill type={child.type} short />
                  <span className="ellipsis">{child.name}</span>
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
