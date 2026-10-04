import type { ChartInfo, ChartSeries, LayoutObjectInfo, LayoutPart, ObjectDetail, TableViewColumn } from "@/types/ddr";
import type { FileIndex } from "../context";
import { asArray, attr, child, children, displayText, findElement, isRecord, textAttr, uuidText } from "../xmlUtils";
import { MISSING_FIELD_TOKEN } from "../sentinels";
import { ownValue } from "../ownValue";
import { calculationText, literalText } from "../calcText";
import { BUTTON_ACTION_TAGS, calcOf, fieldRefState, qualifiedField, scriptTriggers, sortFields } from "./common";
import { actionScanTexts, stepParams } from "./stepText";

export type LayoutDetail = Extract<ObjectDetail, { kind: "layout" }>;

/** A layout object as read: what it shows, the XML element it was read from,
 * and the objects nested in it (`info.children` holds their infos) — plus
 * what the text-based passes read of it beside its element. */
export interface LayoutObjectNode {
  info: LayoutObjectInfo;
  element: Record<string, unknown>;
  children: LayoutObjectNode[];
  /** The placeholder of a field binding whose field is gone (see missingBinding). */
  missingBinding?: string;
  /** Its button action step as FileMaker rendered it (see actionScanTexts). */
  actionText?: string;
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
  const tableView = tableViewColumns(node, index);
  return {
    kind: "layout",
    width,
    height,
    triggers: scriptTriggers(node["ScriptTriggers"]),
    parts,
    offLayout,
    ...(tableView.length > 0 ? { tableView } : {}),
  };
}

/** The layout's parts, each with the objects placed on it. */
function layoutParts(partsList: Record<string, unknown>, index: FileIndex): PartNodes[] {
  const parts: PartNodes[] = [];
  for (const part of children(partsList, "Part")) {
    if (!isRecord(part)) continue;
    // The part's top offset (absolute) and height (size) live on its <Definition>.
    const def = child(part, "Definition");
    const kind = attr(part, "kind");
    const type = ownValue(PART_KINDS, kind) ?? attr(part, "type") ?? "Part";
    const breakField = kind === "3" || kind === "5" ? partBreakField(def, index) : undefined;
    parts.push({
      type,
      top: num(attr(def, "absolute")),
      height: num(attr(def, "size")),
      ...(breakField ? { breakField } : {}),
      objects: layoutObjects(part["ObjectList"], index),
    });
  }
  return parts;
}

/** Part names by the part's `kind`. FM 21 and FM 22 write a trailing
 * sub-summary (kind 5) as `type="Trailing Grand Summary"`, so the kind is what
 * tells them apart; an unlisted kind goes by its `type`. */
const PART_KINDS: Readonly<Record<string, string>> = {
  "0": "Title Header",
  "1": "Header",
  "2": "Leading Grand Summary",
  "3": "Leading Sub-summary",
  "4": "Body",
  "5": "Trailing Sub-summary",
  "6": "Trailing Grand Summary",
  "7": "Footer",
  "8": "Title Footer",
  "12": "Top Navigation",
  "13": "Bottom Navigation",
};

/** A sub-summary part's "when sorted by" field, from its <Definition>
 * (`id="0"` with no name is no field). */
function partBreakField(def: unknown, index: FileIndex): string | undefined {
  const ref = child(def, "FieldReference");
  if (!isRecord(ref) || (attr(ref, "id") === "0" && !textAttr(ref, "name"))) return undefined;
  return qualifiedField(ref, index) || undefined;
}

/** The columns of a layout's Table View setup (FM 26 <TableView>), in order. */
function tableViewColumns(node: Record<string, unknown>, index: FileIndex): TableViewColumn[] {
  return children(child(child(node, "TableView"), "ObjectList"), "TableViewLayoutObject")
    .filter(isRecord)
    .map((column) => ({
      field: qualifiedField(child(column, "FieldReference"), index) || textAttr(column, "name") || MISSING_FIELD_TOKEN,
      width: num(attr(column, "width")),
      hidden: attr(column, "hidden") === "True",
    }));
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
  const portalSort = sortFields(child(portal, "SortSpecification"), index);
  // The filter formula is kept whether or not "Filter portal records" is on —
  // which the <Options> bitmask may record (unconfirmed), so it isn't read.
  const portalFilter = calcOf(portal);
  const portalInitialRow = attr(portalOptions, "index");
  const chart = chartInfo(obj);
  const popoverTitle = popoverTitleOf(obj);
  const kids = childObjects(obj, index);
  const triggers = scriptTriggers(obj["ScriptTriggers"]);
  const tooltip = calcOf(child(obj, "Tooltip"));
  // A computed tooltip shows as its formula.
  const shownTooltip = literalText(tooltip) ?? tooltip;
  const action = buttonAction(obj);
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
    // Portal: the table occurrence it shows, its visible row count and its sort.
    ...(isRecord(portalTo) ? { portalTable: textAttr(portalTo, "name") ?? "" } : {}),
    ...(isRecord(portalOptions) ? { portalRows: num(attr(portalOptions, "show")) } : {}),
    ...(portalSort.length > 0 ? { portalSort } : {}),
    ...(portalFilter ? { portalFilter } : {}),
    ...(portalInitialRow != null ? { portalInitialRow: num(portalInitialRow) } : {}),
    ...(popoverTitle ? { popoverTitle } : {}),
    ...(chart ? { chart } : {}),
    ...(kids ? { children: kids.map((kid) => kid.info) } : {}),
    ...fieldBinding(obj, index),
    ...(action.scriptRef ? { scriptRef: action.scriptRef } : {}),
    ...(action.scriptParameter ? { scriptParameter: action.scriptParameter } : {}),
    ...(action.step ? { actionStep: { name: action.step.name, params: stepParams(action.step.node, action.step.name, index.stepTexts) } } : {}),
    // Object-level script triggers (separate from layout-level triggers).
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(shownTooltip ? { tooltip: shownTooltip } : {}),
    ...fieldPlaceholder(obj),
    ...conditions(obj),
  };
  const missing = missingBinding(obj, index);
  const actionText = action.step ? actionScanTexts([action.step.node], index.stepTexts).join("\n") : "";
  return {
    info: shown,
    element: obj,
    children: kids ?? [],
    ...(missing ? { missingBinding: missing } : {}),
    ...(actionText ? { actionText } : {}),
  };
}

/** A Tab Panel / Slide Panel's label, from its <Calculation>. */
function panelLabel(obj: Record<string, unknown>): string | undefined {
  let label: string | undefined;
  for (const tag of ["TabPanel", "SlidePanel"]) {
    const text = calcOf(child(obj, tag));
    const shown = literalText(text) ?? text;
    if (shown) label = shown;
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
  const contents = popoverPanels(obj).flatMap((panel) => layoutObjects(panel["ObjectList"], index));
  if (contents.length > 0) return contents;
  for (const tag of ["ButtonBar", "GroupedButton"]) {
    const holder = child(obj, tag);
    const members = isRecord(holder) ? layoutObjects(holder["ObjectList"], index) : [];
    if (members.length > 0) return members;
  }
  const holder = ["SlidePanel", "TabPanel", "SlideControl", "TabControl", "Portal"].map((tag) => child(obj, tag)).find(isRecord);
  return holder ? layoutObjects(holder["ObjectList"], index) : undefined;
}

/** A popover button's panels: <LayoutObject type="PopoverPanel"> under its
 * <PopoverButton>, or a bare <PopoverPanel> element there (FM 21). */
function popoverPanels(obj: Record<string, unknown>): Record<string, unknown>[] {
  const popover = child(obj, "PopoverButton");
  if (!isRecord(popover)) return [];
  return [
    ...asArray(popover["PopoverPanel"]),
    ...asArray(popover["LayoutObject"]).filter((lo) => attr(lo, "type") === "PopoverPanel"),
  ].filter(isRecord);
}

/** A popover's title, from its panel's <Title> calculation; a static title
 * reads as its text, like a button label. */
function popoverTitleOf(obj: Record<string, unknown>): string | undefined {
  for (const panel of popoverPanels(obj)) {
    const title = calculationText(child(panel, "Title"));
    if (title) return literalText(title) ?? title;
  }
  return undefined;
}

/** A field object's placeholder text (Inspector ▸ Data ▸ Placeholder text):
 * <Field><Display><Placeholder findMode>, a calculation shown like a tooltip. */
function fieldPlaceholder(obj: Record<string, unknown>): Pick<LayoutObjectInfo, "placeholder" | "placeholderInFind"> {
  const placeholder = child(child(child(obj, "Field"), "Display"), "Placeholder");
  const formula = calcOf(placeholder);
  if (!formula) return {};
  return { placeholder: literalText(formula) ?? formula, ...(attr(placeholder, "findMode") === "True" ? { placeholderInFind: true } : {}) };
}

/** A chart's series lists, with the axis letter each is shown by. */
const CHART_SERIES_LISTS = [
  ["XSeriesList", "X"],
  ["YSeriesList", "Y"],
  ["WSeriesList", "W"],
  ["ZSeriesList", "Z"],
] as const;

/** A chart title (the chart's, an axis's or a series'): <Title><Text><Calculation>,
 * a static one read as its text. */
function chartTitle(owner: unknown): string | undefined {
  const formula = calculationText(child(child(child(owner, "Title"), "Text"), "Calculation"));
  return formula ? (literalText(formula) ?? formula) : undefined;
}

/**
 * A chart object's setup (<External type="CHRT"><Chart>): its type, the records
 * it charts, and the formulas behind its titles and series. FileMaker often
 * leaves a series' <Value> empty — FM 22 exports even the whole <Chart> — so
 * a chart's data fields can be missing from the export.
 */
function chartInfo(obj: Record<string, unknown>): ChartInfo | undefined {
  const chart = child(child(obj, "External"), "Chart");
  if (!isRecord(chart)) return undefined;
  const type = displayText(child(child(chart, "Visual"), "Type"));
  const source = child(chart, "SeriesSource");
  const dataSource = textAttr(source, "source");
  const groups = displayText(child(source, "ShowRecordGroupDataWhenSorted"));
  const axis = (list: string) => child(child(child(chart, "ChartAxis"), list), "Axis");
  const title = chartTitle(chart);
  const xAxisTitle = chartTitle(axis("XAxisList"));
  const yAxisTitle = chartTitle(axis("YAxisList"));
  const series: ChartSeries[] = CHART_SERIES_LISTS.flatMap(([list, letter]) =>
    children(child(child(chart, "ChartSeries"), list), "Series").flatMap((s) => {
      const value = calcOf(child(s, "Value"));
      const seriesTitle = chartTitle(s);
      return value || seriesTitle ? [{ axis: letter, ...(value ? { value } : {}), ...(seriesTitle ? { title: seriesTitle } : {}) }] : [];
    }),
  );
  return {
    ...(type ? { type } : {}),
    ...(dataSource ? { dataSource } : {}),
    ...(groups ? { groupsWhenSorted: groups === "True" } : {}),
    ...(title ? { title } : {}),
    ...(xAxisTitle ? { xAxisTitle } : {}),
    ...(yAxisTitle ? { yAxisTitle } : {}),
    series,
  };
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

/**
 * The placeholder FileMaker shows for a field binding whose field is gone —
 * `<Field Missing>`, after its occurrence when it names one — for the
 * text-based passes, which read it as they read one in a calc. Read from the
 * XML, apart from the binding's label (fieldBinding), so how the label reads
 * can't change what's flagged. The element scan skips a binding left as
 * `<FieldReference id="0" name="">` or without one at all, so this is all that
 * flags it. Undefined when the field is there or can't be verified.
 */
function missingBinding(obj: Record<string, unknown>, index: FileIndex): string | undefined {
  const fieldNode = child(obj, "Field");
  if (!isRecord(fieldNode)) return undefined;
  const ref = child(fieldNode, "FieldReference");
  if (!isRecord(ref)) return MISSING_FIELD_TOKEN;
  if (fieldRefState(ref, index) !== "deleted") return undefined;
  const to = textAttr(child(ref, "TableOccurrenceReference"), "name");
  return to ? `${to}::${MISSING_FIELD_TOKEN}` : MISSING_FIELD_TOKEN;
}

/** What a button (or grouped button — Group and Grouped Button share the
 * <GroupedButton> wrapper) does: the script it performs and the parameter it
 * passes, or else its single action step. */
interface ButtonAction {
  scriptRef?: LayoutObjectInfo["scriptRef"];
  scriptParameter?: string;
  step?: { node: Record<string, unknown>; name: string };
}

function buttonAction(obj: Record<string, unknown>): ButtonAction {
  const button = BUTTON_ACTION_TAGS.map((tag) => child(obj, tag)).find(isRecord);
  if (!button) return {};
  const scriptRef = extractScriptRef(button["action"]);
  // The parameter is the <Calculation> beside the <ScriptReference>. A deleted
  // script loses its <ScriptReference> but keeps the parameter.
  const scriptParameter = calcOf(asArray(button["action"])[0]);
  const parameter = scriptParameter ? { scriptParameter } : {};
  if (scriptRef) return { scriptRef, ...parameter };
  const step = actionStepOf(button["action"]);
  return step ? { step } : parameter;
}

/** Hide-object-when and conditional-formatting calculations:
 * <Conditions><Hide findMode=…><Calculation> and
 * <Conditions><Formatting><Condition><Calculation>, with each condition's
 * <LocalCSS>. */
function conditions(obj: Record<string, unknown>): Pick<LayoutObjectInfo, "hideWhen" | "hideInFind" | "conditionalFormats"> {
  const conditionsNode = child(obj, "Conditions");
  if (!isRecord(conditionsNode)) return {};
  const hide = child(conditionsNode, "Hide");
  const hideWhen = calcOf(hide);
  // Each condition's formula — FileMaker writes one for a "Value is …"
  // condition too — and the formatting it applies (its <LocalCSS>).
  const formats = children(child(conditionsNode, "Formatting"), "Condition")
    .map((c) => ({ formula: calcOf(c), style: normalizeLocalCss(displayText(child(c, "LocalCSS"))) }))
    .filter((c) => c.formula !== "");
  const styles = formats.map((c) => c.style);
  return {
    ...(hideWhen ? { hideWhen, ...(attr(hide, "findMode") === "True" ? { hideInFind: true } : {}) } : {}),
    ...(formats.length > 0 ? { conditionalFormats: formats.map((c) => c.formula) } : {}),
    ...(styles.some((style) => style !== "") ? { conditionalFormatStyles: styles } : {}),
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
    // static label, quoted like one. One that computes its text is left out: as
    // the object's name it would read as code.
    const literal = literalText(calcOf(button["Label"]));
    return literal ? `"${literal}"` : undefined;
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
function actionStepOf(action: unknown): ButtonAction["step"] {
  const node = child(asArray(action)[0], "Step");
  if (!isRecord(node)) return undefined;
  const name = textAttr(node, "name") ?? "";
  return name ? { node, name } : undefined;
}

/** A styled label's text: the first non-empty <StyledText><Data> under `node`,
 * not the surrounding <Options>/formatting nodes a broader <Text> search would
 * also pick up. */
function firstTextValue(node: unknown): string | undefined {
  const data = findElement(node, "Data", (el) => displayText(el) !== "");
  return data == null ? undefined : displayText(data);
}
