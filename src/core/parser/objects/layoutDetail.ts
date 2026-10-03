import type { LayoutObjectInfo, LayoutPart, ObjectDetail } from "@/types/ddr";
import type { FileIndex, StepTexts } from "../context";
import { asArray, attr, child, children, displayText, findElement, isRecord, textAttr, uuidText } from "../xmlUtils";
import { MISSING_FIELD_TOKEN } from "../sentinels";
import { calculationText } from "../calcText";
import { BUTTON_ACTION_TAGS, calcOf, qualifiedField, scriptTriggers, stripOuterQuotes } from "./common";
import { stepParams } from "./stepText";

export type LayoutDetail = Extract<ObjectDetail, { kind: "layout" }>;

/** A layout object as read: what it shows, the XML element it was read from,
 * and the objects nested in it (`info.children` holds their infos). */
export interface LayoutObjectNode {
  info: LayoutObjectInfo;
  element: Record<string, unknown>;
  children: LayoutObjectNode[];
}

/** A layout part with its objects as nodes. */
interface PartNodes extends Omit<LayoutPart, "objects"> {
  objects: LayoutObjectNode[];
}

/** A layout's detail with its objects as nodes, before they become objects of
 * their own (addLayoutObjects). */
export type LayoutNodes = Omit<LayoutDetail, "parts" | "offLayout"> & { parts: PartNodes[]; offLayout: LayoutObjectNode[] };

/**
 * Extract a layout's visible structure: its parts (Body/Header/…) and the
 * objects placed on each (fields, buttons, web viewers, …). Position and a bit
 * of readable content (a web-viewer URL, a button's label + action) are pulled
 * out so the inspector shows what the layout actually contains, not just which
 * table occurrence it is anchored to.
 */
export function layoutDetail(node: unknown, index: FileIndex): LayoutNodes | undefined {
  const partsList = child(node, "PartsList");
  if (!isRecord(node) || !isRecord(partsList)) return undefined;
  const rawParts = layoutParts(partsList, index);
  if (rawParts.length === 0) return undefined;
  const declaredWidth = num(attr(node, "width"));
  const { parts, offLayout } = splitOffLayout(rawParts, declaredWidth);
  const { width, height } = canvasSize(parts, declaredWidth);
  return { kind: "layout", width, height, triggers: scriptTriggers(node["ScriptTriggers"]), parts, offLayout };
}

/** The layout's parts, each with the objects placed on it. */
function layoutParts(partsList: Record<string, unknown>, index: FileIndex): PartNodes[] {
  const parts: PartNodes[] = [];
  for (const part of children(partsList, "Part")) {
    if (!isRecord(part)) continue;
    // The part's top offset (absolute) and height (size) live on its <Definition>.
    const def = child(part, "Definition");
    parts.push({
      type: attr(part, "type") ?? "Part",
      top: num(attr(def, "absolute")),
      height: num(attr(def, "size")),
      objects: layoutObjects(part["ObjectList"], index),
    });
  }
  return parts;
}

/** Objects sitting entirely to the right of the layout's real right edge (a
 * common "scratch area" habit), split out so they don't stretch the canvas. */
function splitOffLayout(rawParts: PartNodes[], declaredWidth: number): { parts: PartNodes[]; offLayout: LayoutObjectNode[] } {
  const offLayout: LayoutObjectNode[] = [];
  const parts = rawParts.map((part) => {
    if (declaredWidth <= 0) return part;
    const onLayout: LayoutObjectNode[] = [];
    for (const obj of part.objects) {
      if (obj.info.bounds && obj.info.bounds.left >= declaredWidth) offLayout.push(obj);
      else onLayout.push(obj);
    }
    return { ...part, objects: onLayout };
  });
  return { parts, offLayout };
}

/** Canvas = the declared layout box; fall back to the on-layout object extent
 * when the width attribute is missing. */
function canvasSize(parts: PartNodes[], declaredWidth: number): { width: number; height: number } {
  let width = declaredWidth;
  let height = parts.reduce((h, p) => Math.max(h, p.top + p.height), 0);
  if (width <= 0 || height <= 0) {
    for (const part of parts) {
      for (const { info } of part.objects) {
        if (!info.bounds) continue;
        width = Math.max(width, info.bounds.right);
        height = Math.max(height, info.bounds.bottom);
      }
    }
  }
  return { width, height };
}

/** The objects on one layout part (or inside a portal / tab panel / group …). */
function layoutObjects(container: unknown, index: FileIndex): LayoutObjectNode[] {
  return children(container, "LayoutObject")
    .filter(isRecord)
    .map((obj) => layoutObjectNode(obj, index));
}

function layoutObjectNode(obj: Record<string, unknown>, index: FileIndex): LayoutObjectNode {
  const id = attr(obj, "id");
  const uuid = uuidText(obj);
  const hash = attr(obj, "hash");
  const type = attr(obj, "type") ?? "Object";
  const bounds = child(obj, "Bounds");
  // Per-object styling lives in <LocalCSS> as a CSS string; normalised to one
  // declaration per line so it displays cleanly and diffs line-by-line.
  const style = normalizeLocalCss(displayText(obj["LocalCSS"]));
  const label = behaviorLine(obj);
  // Text objects: the CDATA content (may contain <<merge fields>>).
  const text = !label && type === "Text" && isRecord(child(obj, "Text")) ? firstTextValue(child(obj, "Text")) : undefined;
  const info = label ?? text;
  const portal = child(obj, "Portal");
  const portalTo = child(portal, "TableOccurrenceReference");
  const portalOptions = child(portal, "Options");
  const kids = childObjects(obj, index);
  const triggers = scriptTriggers(obj["ScriptTriggers"]);
  const tooltip = calcOf(child(obj, "Tooltip"));
  const shown: LayoutObjectInfo = {
    type,
    name: panelLabel(obj) ?? textAttr(obj, "name") ?? "",
    ...(id ? { id } : {}),
    ...(uuid ? { uuid } : {}),
    ...(hash ? { hash } : {}),
    ...(isRecord(bounds)
      ? { bounds: { top: num(attr(bounds, "top")), left: num(attr(bounds, "left")), right: num(attr(bounds, "right")), bottom: num(attr(bounds, "bottom")) } }
      : {}),
    ...(style ? { style } : {}),
    ...(info ? { info } : {}),
    // Portal: the table occurrence it shows and its visible row count.
    ...(isRecord(portalTo) ? { portalTable: textAttr(portalTo, "name") ?? "" } : {}),
    ...(isRecord(portalOptions) ? { portalRows: num(attr(portalOptions, "show")) } : {}),
    ...(kids ? { children: kids.map((kid) => kid.info) } : {}),
    ...fieldBinding(obj, index),
    ...buttonAction(obj, index.stepTexts),
    // Object-level script triggers (separate from layout-level triggers).
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(tooltip ? { tooltip: stripOuterQuotes(tooltip) } : {}),
    ...conditions(obj),
  };
  return { info: shown, element: obj, children: kids ?? [] };
}

/** A Tab Panel / Slide Panel's label, from its <Calculation>. */
function panelLabel(obj: Record<string, unknown>): string | undefined {
  let label: string | undefined;
  for (const tag of ["TabPanel", "SlidePanel"]) {
    const text = calcOf(child(obj, tag));
    if (text) label = stripOuterQuotes(text);
  }
  return label;
}

/**
 * The objects nested in this one: a popover's contents, a button bar's segments
 * or a group's members, or the objects in a portal, a tab / slide control
 * (its panels), or a panel. The popover panel is a <LayoutObject
 * type="PopoverPanel"> under <PopoverButton> (or a bare <PopoverPanel>
 * element); either way the panel itself is skipped and its objects hang off the
 * button. Popovers, button bars and groups only count when they hold something.
 */
function childObjects(obj: Record<string, unknown>, index: FileIndex): LayoutObjectNode[] | undefined {
  const popover = child(obj, "PopoverButton");
  if (isRecord(popover)) {
    const panels = [
      ...asArray(popover["PopoverPanel"]),
      ...asArray(popover["LayoutObject"]).filter((lo) => attr(lo, "type") === "PopoverPanel"),
    ];
    const contents = panels.flatMap((panel) => (isRecord(panel) ? layoutObjects(panel["ObjectList"], index) : []));
    if (contents.length > 0) return contents;
  }
  for (const tag of ["ButtonBar", "GroupedButton"]) {
    const holder = child(obj, tag);
    const members = isRecord(holder) ? layoutObjects(holder["ObjectList"], index) : [];
    if (members.length > 0) return members;
  }
  const holder = ["SlidePanel", "TabPanel", "SlideControl", "TabControl", "Portal"].map((tag) => child(obj, tag)).find(isRecord);
  return holder ? layoutObjects(holder["ObjectList"], index) : undefined;
}

/**
 * Field binding: "TO::FieldName" for edit boxes, drop-downs, etc. When the bound
 * field was since deleted, FileMaker omits <FieldReference> entirely (no name is
 * recoverable from this node) — flagged the same way a broken reference reads
 * anywhere else in the app. A field object's attached value list (drop-down,
 * checkbox set, …) lives as a sibling of <FieldReference> under <Display>.
 */
function fieldBinding(obj: Record<string, unknown>, index: FileIndex): Partial<LayoutObjectInfo> {
  const fieldNode = child(obj, "Field");
  if (!isRecord(fieldNode)) return {};
  const fieldRef = child(fieldNode, "FieldReference");
  const vlRef = child(child(fieldNode, "Display"), "ValueListReference");
  const vlId = attr(vlRef, "id");
  return {
    fieldRef: qualifiedField(fieldRef, index) || MISSING_FIELD_TOKEN,
    ...(vlId ? { valueListRef: { id: vlId, name: textAttr(vlRef, "name") ?? "" } } : {}),
  };
}

/** What a button (or grouped button — Group and Grouped Button share the
 * <GroupedButton> wrapper) does: the script it performs, or else its single
 * action step. */
function buttonAction(
  obj: Record<string, unknown>,
  stepTexts: StepTexts,
): Pick<LayoutObjectInfo, "scriptRef" | "actionStep"> {
  const button = BUTTON_ACTION_TAGS.map((tag) => child(obj, tag)).find(isRecord);
  if (!button) return {};
  const scriptRef = extractScriptRef(button["action"]);
  if (scriptRef) return { scriptRef };
  const actionStep = actionStepOf(button["action"], stepTexts);
  return actionStep ? { actionStep } : {};
}

/** Hide-object-when and conditional-formatting calculations:
 * <Conditions><Hide findMode=…><Calculation> and
 * <Conditions><Formatting><Condition><Calculation>. */
function conditions(obj: Record<string, unknown>): Pick<LayoutObjectInfo, "hideWhen" | "hideInFind" | "conditionalFormats"> {
  const conditionsNode = child(obj, "Conditions");
  if (!isRecord(conditionsNode)) return {};
  const hide = child(conditionsNode, "Hide");
  const hideWhen = calcOf(hide);
  const formats = children(child(conditionsNode, "Formatting"), "Condition")
    .map((c) => calcOf(c))
    .filter((c) => c !== "");
  return {
    ...(hideWhen ? { hideWhen, ...(attr(hide, "findMode") === "True" ? { hideInFind: true } : {}) } : {}),
    ...(formats.length > 0 ? { conditionalFormats: formats } : {}),
  };
}

/** Parse a numeric attribute, defaulting to 0 when missing/non-numeric. */
function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise a `<LocalCSS>` blob into a stable, readable, line-oriented form:
 * one `selector {` / `  prop: value;` / `}` per line. FileMaker writes each
 * object's styling (fill/text/border colors, font family & size, shadows, …) as
 * a single CSS string with one or more selector blocks; the values are concrete
 * (no UUIDs), so the normalised form is stable across environments and diffs
 * cleanly line-by-line. Returns "" when there is no styling.
 */
function normalizeLocalCss(raw: string): string {
  if (!raw || !raw.includes("{")) return "";
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const selector = m[1]!.trim().replace(/\s+/g, " ");
    const decls = m[2]!
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !/:\s*$/.test(d)); // drop empty declarations like "direction: "
    if (!selector || decls.length === 0) continue;
    out.push(`${selector} {`);
    for (const d of decls) out.push(`  ${d};`);
    out.push("}");
  }
  return out.join("\n");
}

/** Readable behavior for an object: a web-viewer's URL, or a button's (grouped
 * button's, popover button's) label. Other objects carry no extra line. The
 * script a button runs is stored separately as scriptRef, so the UI can render
 * it as a navigable link. */
function behaviorLine(obj: Record<string, unknown>): string | undefined {
  const webViewer = child(child(obj, "External"), "WebViewer");
  if (isRecord(webViewer)) {
    const url = calculationText(findElement(webViewer, "Calculation"));
    return url ? `URL: ${url}` : undefined;
  }
  for (const tag of [...BUTTON_ACTION_TAGS, "PopoverButton"]) {
    const button = child(obj, tag);
    if (!isRecord(button)) continue;
    const label = firstTextValue(button["Label"]);
    if (label) return `"${label}"`;
    // A calculated label (<Label><Calculation>) that is one string literal is a
    // static label, already quoted. One that computes its text is left out: as
    // the object's name it would read as code.
    const formula = calcOf(button["Label"]).trim();
    return STRING_LITERAL_RE.test(formula) ? formula : undefined;
  }
  return undefined;
}

/** A formula that is nothing but one string literal (`"Save"`, with `\"` escapes). */
const STRING_LITERAL_RE = /^"(?:[^"\\]|\\[\s\S])*"$/;

/** Script reference navigation target: id, name, UUID from an <action> element. */
function extractScriptRef(action: unknown): LayoutObjectInfo["scriptRef"] {
  const sr = child(asArray(action)[0], "ScriptReference");
  if (!isRecord(sr)) return undefined;
  const name = textAttr(sr, "name") ?? "";
  return name || attr(sr, "id") ? { id: attr(sr, "id"), name, uuid: attr(sr, "UUID") } : undefined;
}

/** A button's single action step (<action><Step name="...">), which single-step
 * buttons use instead of a <ScriptReference>. */
function actionStepOf(action: unknown, stepTexts: StepTexts): LayoutObjectInfo["actionStep"] {
  const step = child(asArray(action)[0], "Step");
  if (!isRecord(step)) return undefined;
  const name = textAttr(step, "name") ?? "";
  return name ? { name, params: stepParams(step, name, stepTexts) } : undefined;
}

/** A styled label's text: the first non-empty <StyledText><Data> under `node`,
 * not the surrounding <Options>/formatting nodes a broader <Text> search would
 * also pick up. */
function firstTextValue(node: unknown): string | undefined {
  const data = findElement(node, "Data", (el) => displayText(el) !== "");
  return data == null ? undefined : displayText(data);
}
