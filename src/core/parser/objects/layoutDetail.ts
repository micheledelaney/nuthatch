import type { LayoutObjectInfo, LayoutPart, ObjectDetail } from "@/types/ddr";
import { asArray, attr, child, children, collectText, displayText, findElement, isRecord, textAttr, uuidText } from "../xmlUtils";
import { MISSING_FIELD_TOKEN } from "../sentinels";
import { BUTTON_ACTION_TAGS, calcOf, calculationText, qualifiedField, scriptTriggers, stripOuterQuotes } from "./common";
import { stepParams } from "./stepText";

export type LayoutDetail = Extract<ObjectDetail, { kind: "layout" }>;

/** Each extracted layout object's own XML element. */
export type LayoutObjectSources = Map<LayoutObjectInfo, Record<string, unknown>>;

interface DetailContext {
  stepTextByHash: ReadonlyMap<string, string>;
  sources: LayoutObjectSources;
}

/**
 * Extract a layout's visible structure: its parts (Body/Header/…) and the
 * objects placed on each (fields, buttons, web viewers, …). Position and a bit
 * of readable content (a web-viewer URL, a button's label + action) are pulled
 * out so the inspector shows what the layout actually contains, not just which
 * table occurrence it is anchored to.
 */
export function layoutDetail(
  node: unknown,
  stepTextByHash: ReadonlyMap<string, string>,
): { detail: LayoutDetail; sources: LayoutObjectSources } | undefined {
  const partsList = child(node, "PartsList");
  if (!isRecord(node) || !isRecord(partsList)) return undefined;
  const cx: DetailContext = { stepTextByHash, sources: new Map() };
  const rawParts = layoutParts(partsList, cx);
  if (rawParts.length === 0) return undefined;
  const declaredWidth = num(attr(node, "width"));
  const { parts, offLayout } = splitOffLayout(rawParts, declaredWidth);
  const { width, height } = canvasSize(parts, declaredWidth);
  return {
    detail: { kind: "layout", width, height, triggers: scriptTriggers(node["ScriptTriggers"]), parts, offLayout },
    sources: cx.sources,
  };
}

/** The layout's parts, each with the objects placed on it. */
function layoutParts(partsList: Record<string, unknown>, cx: DetailContext): LayoutPart[] {
  const parts: LayoutPart[] = [];
  for (const part of children(partsList, "Part")) {
    if (!isRecord(part)) continue;
    // The part's top offset (absolute) and height (size) live on its <Definition>.
    const def = child(part, "Definition");
    parts.push({
      type: attr(part, "type") ?? "Part",
      top: num(attr(def, "absolute")),
      height: num(attr(def, "size")),
      objects: layoutObjects(part["ObjectList"], cx),
    });
  }
  return parts;
}

/** Objects sitting entirely to the right of the layout's real right edge (a
 * common "scratch area" habit), split out so they don't stretch the canvas. */
function splitOffLayout(rawParts: LayoutPart[], declaredWidth: number): { parts: LayoutPart[]; offLayout: LayoutObjectInfo[] } {
  const offLayout: LayoutObjectInfo[] = [];
  const parts = rawParts.map((part) => {
    if (declaredWidth <= 0) return part;
    const onLayout: LayoutObjectInfo[] = [];
    for (const obj of part.objects) {
      if (obj.bounds && obj.bounds.left >= declaredWidth) offLayout.push(obj);
      else onLayout.push(obj);
    }
    return { ...part, objects: onLayout };
  });
  return { parts, offLayout };
}

/** Canvas = the declared layout box; fall back to the on-layout object extent
 * when the width attribute is missing. */
function canvasSize(parts: LayoutPart[], declaredWidth: number): { width: number; height: number } {
  let width = declaredWidth;
  let height = parts.reduce((h, p) => Math.max(h, p.top + p.height), 0);
  if (width <= 0 || height <= 0) {
    for (const part of parts) {
      for (const obj of part.objects) {
        if (!obj.bounds) continue;
        width = Math.max(width, obj.bounds.right);
        height = Math.max(height, obj.bounds.bottom);
      }
    }
  }
  return { width, height };
}

/** The objects on one layout part (or inside a portal / tab panel / group …). */
function layoutObjects(container: unknown, cx: DetailContext): LayoutObjectInfo[] {
  return children(container, "LayoutObject")
    .filter(isRecord)
    .map((obj) => {
      const info = layoutObjectInfo(obj, cx);
      cx.sources.set(info, obj);
      return info;
    });
}

function layoutObjectInfo(obj: Record<string, unknown>, cx: DetailContext): LayoutObjectInfo {
  const id = attr(obj, "id");
  const uuid = uuidText(obj);
  const hash = attr(obj, "hash");
  const type = attr(obj, "type") ?? "Object";
  const bounds = child(obj, "Bounds");
  // Per-object styling lives in <LocalCSS> as a CSS string; normalised to one
  // declaration per line so it displays cleanly and diffs line-by-line.
  const style = normalizeLocalCss(collectText(obj["LocalCSS"]));
  const label = behaviorLine(obj);
  // Text objects: the CDATA content (may contain <<merge fields>>).
  const text = !label && type === "Text" && isRecord(child(obj, "Text")) ? firstTextValue(child(obj, "Text")) : undefined;
  const info = label ?? text;
  const portal = child(obj, "Portal");
  const portalTo = child(portal, "TableOccurrenceReference");
  const portalOptions = child(portal, "Options");
  const kids = childObjects(obj, cx);
  const triggers = scriptTriggers(obj["ScriptTriggers"]);
  const tooltip = calcOf(child(obj, "Tooltip"));
  return {
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
    ...(kids ? { children: kids } : {}),
    ...fieldBinding(obj),
    ...buttonAction(obj, cx.stepTextByHash),
    // Object-level script triggers (separate from layout-level triggers).
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(tooltip ? { tooltip: stripOuterQuotes(tooltip) } : {}),
    ...conditions(obj),
  };
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
 * The objects nested in this one: a portal's fields, a tab / slide control's
 * panels, a panel's objects, a group's members, a button bar's segments, and a
 * popover's contents. The popover panel is a <LayoutObject type="PopoverPanel">
 * under <PopoverButton> (or a bare <PopoverPanel> element); either way the panel
 * itself is skipped and its objects hang off the button. Groups, button bars,
 * and popovers only count when they hold something.
 */
function childObjects(obj: Record<string, unknown>, cx: DetailContext): LayoutObjectInfo[] | undefined {
  let kids: LayoutObjectInfo[] | undefined;
  for (const tag of ["Portal", "TabControl", "SlideControl", "TabPanel", "SlidePanel"]) {
    const holder = child(obj, tag);
    if (isRecord(holder)) kids = layoutObjects(holder["ObjectList"], cx);
  }
  for (const tag of ["GroupedButton", "ButtonBar"]) {
    const holder = child(obj, tag);
    const members = isRecord(holder) ? layoutObjects(holder["ObjectList"], cx) : [];
    if (members.length > 0) kids = members;
  }
  const popover = child(obj, "PopoverButton");
  if (isRecord(popover)) {
    const panels = [
      ...asArray(popover["PopoverPanel"]),
      ...asArray(popover["LayoutObject"]).filter((lo) => attr(lo, "type") === "PopoverPanel"),
    ];
    const contents = panels.flatMap((panel) => (isRecord(panel) ? layoutObjects(panel["ObjectList"], cx) : []));
    if (contents.length > 0) kids = contents;
  }
  return kids;
}

/**
 * Field binding: "TO::FieldName" for edit boxes, drop-downs, etc. When the bound
 * field was since deleted, FileMaker omits <FieldReference> entirely (no name is
 * recoverable from this node) — flagged the same way a broken reference reads
 * anywhere else in the app. A field object's attached value list (drop-down,
 * checkbox set, …) lives as a sibling of <FieldReference> under <Display>.
 */
function fieldBinding(obj: Record<string, unknown>): Partial<LayoutObjectInfo> {
  const fieldNode = child(obj, "Field");
  if (!isRecord(fieldNode)) return {};
  const fieldRef = child(fieldNode, "FieldReference");
  const vlRef = child(child(fieldNode, "Display"), "ValueListReference");
  const vlId = attr(vlRef, "id");
  return {
    fieldRef: qualifiedField(fieldRef) || MISSING_FIELD_TOKEN,
    ...(vlId ? { valueListRef: { id: vlId, name: textAttr(vlRef, "name") ?? "" } } : {}),
  };
}

/** What a button (or grouped button — Group and Grouped Button share the
 * <GroupedButton> wrapper) does: the script it performs, or else its single
 * action step. */
function buttonAction(
  obj: Record<string, unknown>,
  stepTextByHash: ReadonlyMap<string, string>,
): Pick<LayoutObjectInfo, "scriptRef" | "actionStep"> {
  let scriptRef: LayoutObjectInfo["scriptRef"];
  let actionStep: LayoutObjectInfo["actionStep"];
  for (const tag of BUTTON_ACTION_TAGS) {
    const button = child(obj, tag);
    if (scriptRef || !isRecord(button)) continue;
    scriptRef = extractScriptRef(button["action"]);
    if (!scriptRef) actionStep = actionStepOf(button["action"], stepTextByHash) ?? actionStep;
  }
  return { ...(scriptRef ? { scriptRef } : {}), ...(actionStep ? { actionStep } : {}) };
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
    return label ? `"${label}"` : undefined;
  }
  return undefined;
}

/** Script reference navigation target: id, name, UUID from an <action> element. */
function extractScriptRef(action: unknown): LayoutObjectInfo["scriptRef"] {
  const sr = child(asArray(action)[0], "ScriptReference");
  if (!isRecord(sr)) return undefined;
  const name = textAttr(sr, "name") ?? "";
  return name || attr(sr, "id") ? { id: attr(sr, "id"), name, uuid: attr(sr, "UUID") } : undefined;
}

/** A button's single action step (<action><Step name="...">), which single-step
 * buttons use instead of a <ScriptReference>. */
function actionStepOf(action: unknown, stepTextByHash: ReadonlyMap<string, string>): LayoutObjectInfo["actionStep"] {
  const step = child(asArray(action)[0], "Step");
  if (!isRecord(step)) return undefined;
  const name = textAttr(step, "name") ?? "";
  return name ? { name, params: stepParams(step, name, stepTextByHash) } : undefined;
}

/** A styled label's text: the first non-empty <StyledText><Data> under `node`,
 * not the surrounding <Options>/formatting nodes a broader <Text> search would
 * also pick up. */
function firstTextValue(node: unknown): string | undefined {
  const data = findElement(node, "Data", (el) => displayText(el) !== "");
  return data == null ? undefined : displayText(data);
}
