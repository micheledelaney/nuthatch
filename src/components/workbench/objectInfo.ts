import type { FmObject, SolutionModel } from "@/types/ddr";

/** How far up the parent chain we look for context names. */
const MAX_ANCESTOR_DEPTH = 6;

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The platform's command modifier, as shown in shortcut hints. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/** Ancestors of `obj`, nearest first (a field's table, a layout object's
 * containers and layout, …). */
export function ancestorsOf(model: SolutionModel, obj: FmObject): FmObject[] {
  const out: FmObject[] = [];
  let uid = obj.parentUid;
  while (uid && out.length < MAX_ANCESTOR_DEPTH) {
    const parent = model.byUid.get(uid);
    if (!parent) break;
    out.push(parent);
    uid = parent.parentUid;
  }
  return out;
}

/** A short "where does this live" label: the owning table / layout /
 * occurrence, prefixed by the file when several files are loaded. */
export function parentContext(model: SolutionModel, obj: FmObject): string {
  const ancestors = ancestorsOf(model, obj);
  const layout = obj.type === "layoutObject" ? ancestors.find((a) => a.type === "layout") : undefined;
  const owner =
    layout?.name ??
    ancestors[0]?.name ??
    obj.attributes.tableOccurrence ??
    obj.attributes.baseTable ??
    "";
  const file = model.files.length > 1 && obj.type !== "file" ? obj.fileName : "";
  return [file, owner].filter(Boolean).join(" › ");
}

/** One shortcut row: alternative key combos (each a list of keys) + meaning. */
export interface Shortcut {
  combos: string[][];
  description: string;
}

export const SHORTCUTS: Shortcut[] = [
  { combos: [[MOD_LABEL, "K"]], description: "Command palette: search all objects" },
  { combos: [["⇧", "↵"]], description: "In the palette: open in the split pane" },
  { combos: [["↑"], ["↓"]], description: "Open the previous / next navigator row" },
  { combos: [["←"], [MOD_LABEL, "["]], description: "Back in the active pane" },
  { combos: [["→"], [MOD_LABEL, "]"]], description: "Forward in the active pane" },
  { combos: [["⇧", "click"]], description: "Open a reference in the other pane" },
  { combos: [["?"]], description: "Show this shortcut list" },
  { combos: [["Esc"]], description: "Close the palette or shortcut list" },
];
