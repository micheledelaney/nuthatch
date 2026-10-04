import type { FmObject } from "@/types/ddr";
import type { FileParse, TextScan } from "../context";
import { attr, cdataText, child, children, displayText, enabledLabels, findElement, isRecord, textAttr, uuidText } from "../xmlUtils";
import { objectUid } from "../uid";
import { collectCatalogItems } from "../catalogWalk";
import { scanRefs } from "../refs/scanRefs";
import { newObject } from "./catalogItems";
import { isPerformScriptStep, stepNodes } from "../steps";
import { calcOf } from "./common";
import { literalText } from "../calcText";
import { actionScanTexts } from "./stepText";

const MENU_MODES: ReadonlyArray<readonly [string, string]> = [
  ["browseMode", "browse"],
  ["findMode", "find"],
  ["previewMode", "preview"],
];

const MENU_ITEM_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["name", "Name"],
  ["action", "Action"],
  ["Shortcut", "Shortcut"],
];

/** Surface a custom menu's standard base menu (the one it overrides), its
 * developer comment, and the FileMaker modes it installs in. */
export function annotateCustomMenu(node: Record<string, unknown>, obj: FmObject): FmObject {
  const a: Record<string, string> = {};
  // The base menu the custom menu is derived from is <BaseMenu> (DDR) or <Base>.
  const baseName = textAttr(child(node, "BaseMenu"), "name") ?? textAttr(child(node, "Base"), "name");
  if (baseName) a.basedOn = baseName;
  const comment = displayText(node["Comment"]);
  if (comment) a.comment = comment;
  const options = child(node, "Options");
  const modes = isRecord(options) ? enabledLabels(options, MENU_MODES) : [];
  if (modes.length) a.installsIn = modes.join(", ");
  const install = installCondition(node);
  if (install) a.installCondition = install;
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}

/** The calculation that gates a menu / menu item's installation
 * (<Conditions><Install><Calculation>), or "" when it is the trivial always-on
 * condition. */
function installCondition(node: Record<string, unknown>): string {
  const calc = calcOf(child(child(node, "Conditions"), "Install"));
  return calc && calc !== "1" ? calc : "";
}

/** Surface a custom menu set's developer comment and how many menus it contains
 * (the member menus themselves are emitted as references). */
export function annotateCustomMenuSet(node: Record<string, unknown>, obj: FmObject): FmObject {
  const a: Record<string, string> = {};
  const comment = textAttr(node, "comment");
  if (comment) a.comment = comment;
  const count = attr(child(node, "CustomMenuList"), "membercount");
  if (count) a.menus = count;
  const sourceUuid = displayText(node["SourceUUID"]);
  if (sourceUuid) a.sourceUuid = sourceUuid;
  return { ...obj, attributes: { ...obj.attributes, ...a } };
}

/**
 * Custom menu items live nested inside each <CustomMenu>'s <MenuItemList>, not in
 * a catalog of their own, so the generic catalog pass can't reach them. Each
 * <CustomMenuItem> carries no `id` (only `hash` + `index`), so build it directly,
 * namespacing the uid by the owning menu's id and using `index` as the per-menu
 * id. The item's name comes from whichever it is: a built-in <Command>, a
 * <CustomMenuReference> submenu, or a Perform Script step's <ScriptReference>;
 * separators are kept (in order) and flagged like the script/layout dividers.
 */
export function parseCustomMenuItems(fp: FileParse, containerNode: Record<string, unknown>, scans: TextScan[]): void {
  for (const menu of collectCatalogItems(containerNode["CustomMenuCatalog"], "CustomMenu")) {
    const menuId = attr(menu, "id");
    const list = child(menu, "MenuItemList");
    if (!isRecord(menu) || menuId == null || !isRecord(list)) continue;
    const menuUid = objectUid(fp.file.uid, "customMenu", menuId);
    const menuName = textAttr(menu, "name") ?? "";
    let order = 0;
    const indexCounts = new Map<string, number>();
    for (const item of children(list, "CustomMenuItem")) {
      if (!isRecord(item)) continue;
      // FileMaker writes an `index` on every item. One without goes by its
      // position, kept apart from the indexes so it can't take another item's;
      // one whose index another item already has gets a `#N` suffix, as a
      // repeated layout-object uid does, so neither collapses onto the other.
      const index = attr(item, "index") ?? `pos${order}`;
      const repeats = indexCounts.get(index) ?? 0;
      indexCounts.set(index, repeats + 1);
      const id = repeats > 0 ? `${index}#${repeats}` : index;
      const isSeparator = attr(item, "isSeparatorItem") === "True";
      const uid = objectUid(fp.file.uid, "customMenuItem", `${menuId}.${id}`);
      const obj = newObject(fp.file, {
        uid,
        type: "customMenuItem",
        id,
        name: menuItemName(item),
        parentUid: menuUid,
        attributes: menuItemAttributes(item, menuName),
        text: displayText(item),
        order: order++,
        ...(isSeparator ? { isSeparator: true } : {}),
      });
      fp.objects.push(obj);
      // Its action step's rendered text too: as in a script's step, a target
      // FileMaker blanked to `<FieldReference id="0">` shows only there.
      const stepText = actionScanTexts(menuItemSteps(item), fp.index.stepTexts);
      scans.push({ obj, text: [cdataText(item), ...stepText].join("\n"), source: item });
      if (isSeparator) continue;
      // A menu item exists only as part of its menu, so the menu is what
      // "references" it — a containment edge (menu -> item) so the item lists
      // its menu under "Referenced by". toId mirrors the item's uid id part so
      // buildModel resolves it. The menu's view shows these in its dedicated
      // "Menu items" section, not its outbound list.
      fp.references.push({ fromUid: menuUid, toType: "customMenuItem", toId: `${menuId}.${id}`, toName: obj.name, kind: "menuItem" });
      // The script a menu item performs and the submenu it opens.
      scanRefs(fp, item, obj);
    }
  }
}

function menuItemAttributes(item: Record<string, unknown>, menuName: string): Record<string, string> {
  const a: Record<string, string> = { menu: menuName, itemType: menuItemKind(item) };
  const itemHash = attr(item, "hash");
  if (itemHash) a.hash = itemHash;
  const shortcut = menuItemShortcut(item);
  if (shortcut) a.shortcut = shortcut;
  const install = installCondition(item);
  if (install) a.installCondition = install;
  // Which parts of the base command the item overrides (<Override name action
  // Shortcut>), e.g. "Name, Shortcut".
  const overrides = enabledLabels(child(item, "Override"), MENU_ITEM_OVERRIDES).join(", ");
  if (overrides) a.overrides = overrides;
  const uuid = uuidText(item);
  if (uuid) a.uuid = uuid;
  return a;
}

/** Best label for a custom menu item: its custom title, a built-in command, a
 * submenu it opens, or the script it performs; falls back to a generic
 * separator/item label. */
function menuItemName(item: Record<string, unknown>): string {
  if (attr(item, "isSeparatorItem") === "True") return "—";
  // A custom title (Override name) is a calculation, usually a quoted literal;
  // a computed one shows as its formula.
  const formula = calcOf(child(item, "Name"));
  const title = literalText(formula) ?? formula;
  if (title) return title;
  const command = textAttr(child(item, "Command"), "name");
  if (command) return command;
  const submenu = textAttr(child(item, "CustomMenuReference"), "name");
  if (submenu) return submenu;
  const scriptName = performedScriptName(item);
  if (scriptName) return `Perform Script: ${scriptName}`;
  return "(menu item)";
}

/** What a menu item does, for the inspector: a divider, a submenu, a built-in
 * command, a performed script, or some other custom action. */
function menuItemKind(item: Record<string, unknown>): string {
  if (attr(item, "isSeparatorItem") === "True") return "Separator";
  if (attr(item, "isSubMenuItem") === "True" || item["CustomMenuReference"]) return "Submenu";
  // By its action's step, so an item whose script was deleted still counts.
  if (menuItemSteps(item).some((step) => isPerformScriptStep(attr(step, "name") ?? ""))) return "Performs script";
  // A Perform Script or untitled custom item carries an empty <Command id="0">.
  const command = child(item, "Command");
  if (textAttr(command, "name") || (attr(command, "id") ?? "0") !== "0") return "Command";
  return "Custom";
}

/** A menu item's action steps: FM 22 / 26 wrap them in <action>, FM 21 puts
 * them on the item itself. */
function menuItemSteps(item: Record<string, unknown>): Record<string, unknown>[] {
  return [...stepNodes(child(item, "action")), ...stepNodes(item)];
}

/** A menu item's keyboard shortcut, as the raw key/modifier codes FileMaker
 * records (e.g. "key 79, modifier 4"); only present when one is assigned. */
function menuItemShortcut(item: Record<string, unknown>): string | undefined {
  const sc = child(item, "Shortcut");
  const key = attr(sc, "key");
  if (!key) return undefined;
  const modifier = attr(sc, "modifier");
  return modifier ? `key ${key}, modifier ${modifier}` : `key ${key}`;
}

/** The script a menu item's Perform Script step runs (its <ScriptReference>
 * sits inside the step's parameter list). */
function performedScriptName(item: Record<string, unknown>): string {
  return textAttr(findElement(item, "ScriptReference"), "name") ?? "";
}
