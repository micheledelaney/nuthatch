import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, child, children, collectElements, collectText, findElement, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { edgeKind } from "../refTags";
import { UNKNOWN_TARGET } from "../sentinels";
import { namesCurrentFile } from "../refs/scanRefs";
import { collectCatalogItems } from "./catalogItems";

/** A button (or grouped button) whose action targets a layout FM 22 names only
 * in <ModifyAction>. */
export interface DeferredButton {
  /** The layout object's id (unique within its layout in every sample). */
  id: string;
  uuid: string;
  steps: DeferredLayoutStep[];
}

interface DeferredLayoutStep {
  /** Which action the step belongs to: "Button" or "GroupedButton". */
  owner: string;
  /** 0-based position within that action. */
  index: number;
  stepName: string;
  layoutId: string;
  layoutName: string;
}

const BUTTON_ACTION_KEYS = ["Button", "GroupedButton"] as const;

/**
 * FM 22 exports write layouts in two passes: <AddAction> defines them, then
 * <ModifyAction> fills in each button's layout target. When that target is a
 * layout in another file, the AddAction step keeps only the data source
 * (<LayoutReferenceContainer External="True"><DataSourceReference>), so the
 * layout's id is recorded only here. Its `name`, though, is whatever layout has
 * that id in the *current* file — FileMaker's own step text reads "Using
 * layout: <unknown>" — so only the id identifies the target. ModifyAction lists
 * every such object flat under its layout, whatever its nesting in AddAction.
 */
export function deferredLayoutTargets(modifyAction: unknown): Map<string, DeferredButton[]> {
  const byLayout = new Map<string, DeferredButton[]>();
  for (const action of asArray(modifyAction)) {
    for (const layout of collectCatalogItems(child(action, "LayoutCatalog"), "Layout")) {
      if (!isRecord(layout)) continue;
      const layoutId = attr(child(layout, "LayoutReference"), "id");
      if (layoutId == null) continue;
      const buttons = collectElements(layout, "LayoutObjectReference").flatMap((node) => deferredButton(node));
      if (buttons.length === 0) continue;
      const list = byLayout.get(layoutId);
      if (list) list.push(...buttons);
      else byLayout.set(layoutId, buttons);
    }
  }
  return byLayout;
}

function deferredButton(node: Record<string, unknown>): DeferredButton[] {
  const id = attr(node, "id");
  const steps = buttonSteps(node).flatMap(({ owner, index, step }) => {
    const target = findElement(step, "LayoutReference");
    const layoutId = attr(target, "id");
    if (layoutId == null) return [];
    return [{ owner, index, stepName: attr(step, "name") ?? "", layoutId, layoutName: decodeEntities(attr(target, "name") ?? "") }];
  });
  return id != null && steps.length > 0 ? [{ id, uuid: uuidText(node), steps }] : [];
}

function uuidText(node: Record<string, unknown>): string {
  return collectText(node["UUID"]).trim();
}

/** The action steps of a layout object's button / grouped button, in order. */
function buttonSteps(node: Record<string, unknown>): { owner: string; index: number; step: Record<string, unknown> }[] {
  return BUTTON_ACTION_KEYS.flatMap((owner) =>
    children(child(child(node, owner), "action"), "Step")
      .filter(isRecord)
      .map((step, index) => ({ owner, index, step })),
  );
}

/**
 * Emit the layout references FM 22 records only in <ModifyAction> (see
 * deferredLayoutTargets): join each deferred button to its AddAction object by
 * id (and UUID, if the id is ambiguous), and each step by position and name.
 * The reference comes from the layout, like the ones the layout-level scan
 * emits, and resolves in the file the AddAction step's data source names.
 * Steps whose AddAction copy already names the layout are left to that scan.
 */
export function addDeferredLayoutRefs(fp: FileParse, layout: unknown, layoutObj: FmObject): void {
  const deferred = fp.deferredLayoutTargets.get(layoutObj.id);
  if (!deferred) return;
  const objects = collectElements(layout, "LayoutObject");
  for (const button of deferred) {
    const byId = objects.filter((o) => attr(o, "id") === button.id);
    const matches = byId.length > 1 ? byId.filter((o) => uuidText(o) === button.uuid) : byId;
    const [match] = matches;
    if (matches.length !== 1 || !match) continue;
    const steps = buttonSteps(match);
    for (const target of button.steps) {
      const step = steps.find((s) => s.owner === target.owner && s.index === target.index)?.step;
      if (!step || attr(step, "name") !== target.stepName || findElement(step, "LayoutReference") != null) continue;
      const container = findElement(step, "LayoutReferenceContainer");
      const dataSource = child(container, "DataSourceReference");
      const fileName = decodeEntities(attr(dataSource, "name") ?? "");
      const isExternal = dataSource != null && !namesCurrentFile(attr(dataSource, "id"), fileName);
      // Marked external but with no data source: the target file is unknown, and
      // resolving it here would land on an unrelated local layout.
      if (!isExternal && attr(container, "External") === "True") continue;
      fp.references.push({
        fromUid: layoutObj.uid,
        toType: "layout",
        toId: target.layoutId,
        // An external target's recorded name is a local lookup (see
        // deferredLayoutTargets); resolution goes by id.
        toName: isExternal ? UNKNOWN_TARGET : target.layoutName,
        kind: edgeKind("layout", target.stepName),
        fromStep: target.index + 1,
        ...(isExternal ? { toFileName: fileName } : {}),
        ...(attr(step, "enable") === "False" ? { disabled: true } : {}),
      });
    }
  }
}
