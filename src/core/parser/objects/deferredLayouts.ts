import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { asArray, attr, child, collectElements, findElement, isRecord, textAttr, uuidText } from "../xmlUtils";
import { edgeKind } from "../refTags";
import { UNKNOWN_TARGET, namesCurrentFile } from "../sentinels";
import { collectCatalogItems } from "../catalogWalk";
import { pushRef } from "../refs/refBuilders";
import { stepNodes } from "../steps";
import { BUTTON_ACTION_TAGS } from "./common";

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
    return [{ owner, index, stepName: attr(step, "name") ?? "", layoutId, layoutName: textAttr(target, "name") ?? "" }];
  });
  return id != null && steps.length > 0 ? [{ id, uuid: uuidText(node), steps }] : [];
}

/** The action steps of a layout object's button / grouped button, in order. */
function buttonSteps(node: Record<string, unknown>): { owner: string; index: number; step: Record<string, unknown> }[] {
  return BUTTON_ACTION_TAGS.flatMap((owner) => stepNodes(child(child(node, owner), "action")).map((step, index) => ({ owner, index, step })));
}

/**
 * Emit the layout references FM 22 records only in <ModifyAction> (see
 * deferredLayoutTargets): join each deferred button to its AddAction object by
 * id (and UUID, if the id is ambiguous), and each step by position and name.
 * The reference comes from the button itself (its layout gets a copy, like
 * of every reference its objects record), and resolves in the file the
 * AddAction step's data source names.
 * Steps whose AddAction copy already names the layout are left to that scan.
 */
export function addDeferredLayoutRefs(
  fp: FileParse,
  layout: unknown,
  layoutObj: FmObject,
  uidOfElement: ReadonlyMap<Record<string, unknown>, string>,
): void {
  const deferred = fp.deferredLayoutTargets.get(layoutObj.id);
  if (!deferred) return;
  const objectsById = layoutObjectsById(layout);
  for (const button of deferred) {
    const byId = objectsById.get(button.id) ?? [];
    const matches = byId.length > 1 ? byId.filter((o) => uuidText(o) === button.uuid) : byId;
    const [match] = matches;
    if (matches.length !== 1 || !match) continue;
    const steps = buttonSteps(match);
    for (const target of button.steps) {
      const step = steps.find((s) => s.owner === target.owner && s.index === target.index)?.step;
      if (!step || attr(step, "name") !== target.stepName || findElement(step, "LayoutReference") != null) continue;
      const container = findElement(step, "LayoutReferenceContainer");
      const dataSource = child(container, "DataSourceReference");
      const fileName = textAttr(dataSource, "name") ?? "";
      const isExternal = dataSource != null && !namesCurrentFile(attr(dataSource, "id"), fileName);
      // Marked external but with no data source: the target file is unknown, and
      // resolving it here would land on an unrelated local layout.
      if (!isExternal && attr(container, "External") === "True") continue;
      const ref = {
        toType: "layout" as const,
        toId: target.layoutId,
        // An external target's recorded name is a local lookup (see
        // deferredLayoutTargets); resolution goes by id.
        toName: isExternal ? UNKNOWN_TARGET : target.layoutName,
        kind: edgeKind("layout", target.stepName),
        ...(isExternal ? { toFileName: fileName } : {}),
      };
      const site = { stepIndex: target.index + 1, disabled: attr(step, "enable") === "False" };
      pushRef(fp.references, { fromUid: uidOfElement.get(match) ?? layoutObj.uid, ...ref }, site);
    }
  }
}

/** The layout's objects (at any depth) by id. */
function layoutObjectsById(layout: unknown): Map<string, Record<string, unknown>[]> {
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const obj of collectElements(layout, "LayoutObject")) {
    const id = attr(obj, "id");
    if (id == null) continue;
    const list = byId.get(id);
    if (list) list.push(obj);
    else byId.set(id, [obj]);
  }
  return byId;
}
