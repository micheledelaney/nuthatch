import type {
  JoinPredicate,
  LayoutObjectInfo,
  LayoutPart,
  LayoutTriggerInfo,
  ObjectDetail,
  PrivilegeSetFieldAccess,
  PrivilegeSetTableAccess,
  RelationshipSide,
  ScriptStep,
  ValueListFieldSource,
} from "@/types/ddr";
import { ATTR_PREFIX, asArray, attr, collectText, isRecord } from "./xmlUtils";
import { decodeEntities } from "./entities";

// Keys match the `type` attribute FileMaker writes on <JoinPredicate>.
// Confirmed from DDR output: Equal, NotEqual, LessOrEqual, GreaterOrEqual,
// CartesianProduct. Strict < / > don't appear in sample DDRs; both plausible
// spellings are mapped so they render correctly whichever FileMaker emits.
const JOIN_OPERATORS: Readonly<Record<string, string>> = {
  Equal: "=",
  NotEqual: "≠",
  Less: "<",
  LessThan: "<",
  LessOrEqual: "≤",
  Greater: ">",
  GreaterThan: ">",
  GreaterOrEqual: "≥",
  CartesianProduct: "×",
};

/** Build the ordered step list shown in a script's inspector. */
export function scriptSteps(
  stepsContainer: unknown,
  stepTextByUuid: Map<string, string>,
): ScriptStep[] {
  const steps: ScriptStep[] = [];
  let index = 0;
  for (const step of asArray(isRecord(stepsContainer) ? stepsContainer["Step"] : undefined)) {
    if (!isRecord(step)) continue;
    index += 1;
    const name = attr(step, "name") ?? "(step)";
    steps.push({
      index,
      name,
      enabled: (attr(step, "enable") ?? "True") !== "False",
      params: stepParams(step, name, stepTextByUuid),
    });
  }
  return steps;
}

/**
 * The step's display parameters, taken from FileMaker's pre-rendered
 * <DDR_INFO><Script><ObjectList> StepText (located via the step's
 * <DDRREF kind="StepText"> pointer). The step name is already rendered into
 * that text, so strip the leading "Name " (or "# " for comment steps) — the UI
 * shows the name separately. CR/LF in the source (e.g. between Import Records
 * field mappings, or between a multi-bracket step's bracket groups) are kept
 * as newlines so the rendered step preserves FileMaker's layout.
 */
function stepParams(
  step: Record<string, unknown>,
  name: string,
  stepTextByUuid: Map<string, string>,
): string {
  const uuid = findStepTextUuid(step);
  const raw = uuid == null ? undefined : stepTextByUuid.get(uuid);
  if (raw == null) return "";
  // Normalise the raw StepText into just the bracketed parameters:
  //   1. CR/LF entities → real newlines (decodeEntities would otherwise collapse
  //      them to spaces, flattening Import Records' per-mapping layout).
  //   2. Decode the rest of the entities (curly quotes, &quot;, &amp; …).
  //   3. Drop a leading `// ` — FileMaker prefixes a disabled step's StepText
  //      with this, but the line already wears the `disabled` class.
  //   4. Drop the step name prefix (or `#` for comments) — ScriptWorkspace
  //      renders the name in a separate span next to params.
  //   5. Collapse newlines that sit *between* bracket groups to a single
  //      space, so steps like `Adjust Window\n[ Resize to fit ]` and
  //      `Go to Related Record [ … ]\n[ Show only related records ]` render
  //      on one line. Newlines INSIDE brackets (Import/Export's per-mapping
  //      layout) survive — the depth tracker only flattens at depth 0.
  const decoded = decodeEntities(raw.replace(/&#(?:13|10|x[Aa]|x[Dd]);/g, "\n")).trim();
  const undisabled = decoded.replace(/^\/\/\s*/, "");
  const stripped = name.startsWith("#")
    ? undisabled.replace(/^#\s*/, "")
    : undisabled.startsWith(name)
      ? undisabled.slice(name.length).replace(/^\s+/, "")
      : undisabled;
  const base = flattenNewlinesOutsideBrackets(stripped);

  // Insert Text omits the text value from StepText — append it from ParameterValues.
  if (name === "Insert Text") {
    const text = insertTextValue(step);
    if (text) return base ? `${base} [ Text: "${text}" ]` : `[ Text: "${text}" ]`;
  }

  return base;
}

/** Decode FileMaker's {{charN}} attribute encoding to the actual character. */
function decodeFmChars(s: string): string {
  return s.replace(/{{char(\d+)}}/g, (_, n: string) => {
    const code = parseInt(n, 10);
    if (code === 13 || code === 10) return "\n";
    if (code < 0x20) return " ";
    try { return String.fromCodePoint(code); } catch { return ""; }
  });
}

/** Extract the literal text value from an Insert Text step's ParameterValues. */
function insertTextValue(step: Record<string, unknown>): string | undefined {
  const pv = asArray(step["ParameterValues"])[0];
  if (!isRecord(pv)) return undefined;
  for (const param of asArray(pv["Parameter"])) {
    if (!isRecord(param) || attr(param, "type") !== "Text") continue;
    const textEl = asArray(param["Text"])[0];
    if (!isRecord(textEl)) continue;
    const raw = attr(textEl, "value");
    if (raw == null) return undefined;
    return decodeFmChars(raw);
  }
  return undefined;
}

/** Replace newlines (and surrounding whitespace) with a single space whenever
 * they sit at bracket depth 0 — i.e. between `]` and the next `[`, or before
 * the first `[`. Newlines inside `[ … ]` survive, so Import / Export Records'
 * per-mapping layout is preserved. */
function flattenNewlinesOutsideBrackets(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[") {
      depth++;
      out += c;
      continue;
    }
    if (c === "]") {
      depth = Math.max(0, depth - 1);
      out += c;
      continue;
    }
    if (depth === 0 && (c === "\n" || c === "\r")) {
      // Collapse a run of whitespace including the newline into one space.
      while (i + 1 < text.length && /\s/.test(text[i + 1]!)) i++;
      if (out.length > 0 && out[out.length - 1] !== " ") out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

/** A step's StepText pointer: the hash attribute on its `<DDRREF kind="StepText">`. */
function findStepTextUuid(step: Record<string, unknown>): string | undefined {
  for (const ref of asArray(step["DDRREF"])) {
    if (!isRecord(ref) || attr(ref, "kind") !== "StepText") continue;
    const hash = attr(ref, "hash");
    if (typeof hash === "string") return hash;
  }
  return undefined;
}

/** Extract structured detail for a custom function (signature + calculation). */
export function customFunctionDetail(node: unknown): ObjectDetail | undefined {
  if (!isRecord(node)) return undefined;
  const signature = collectText(node["Display"]).trim() || (attr(node, "name") ?? "");
  const body = calculationText(node["Calculation"]);
  return { kind: "calculation", signature, body };
}

/** Extract the table occurrences and join predicates of a relationship. */
export function relationshipDetail(node: unknown): ObjectDetail | undefined {
  if (!isRecord(node)) return undefined;
  const leftTable = occurrenceName(node["LeftTable"]);
  const rightTable = occurrenceName(node["RightTable"]);
  const leftToId = occurrenceId(node["LeftTable"]);
  const rightToId = occurrenceId(node["RightTable"]);

  const predicates: JoinPredicate[] = [];
  const list = node["JoinPredicateList"];
  for (const predicate of asArray(isRecord(list) ? list["JoinPredicate"] : undefined)) {
    if (!isRecord(predicate)) continue;
    predicates.push({
      leftField: fieldName(predicate["LeftField"]),
      operator: JOIN_OPERATORS[attr(predicate, "type") ?? ""] ?? "=",
      rightField: fieldName(predicate["RightField"]),
    });
  }
  return {
    kind: "relationship",
    leftTable,
    rightTable,
    ...(leftToId != null ? { leftToId } : {}),
    ...(rightToId != null ? { rightToId } : {}),
    predicates,
    left: relationshipSide(node["LeftTable"]),
    right: relationshipSide(node["RightTable"]),
  };
}

/**
 * Extract a privilege set's per-table (and, when defined, per-field) custom
 * record access from `<Records Custom="True"><Custom><ObjectList><Table>…`.
 * Each `<Table>` carries View/Edit/Create/Delete access plus a `<Fields>`
 * summary that expands into per-`<Field>` grants only when that table's field
 * access is itself "Custom" — otherwise every field shares the one grant.
 */
export function privilegeSetDetail(recordsNode: unknown): ObjectDetail | undefined {
  if (!isRecord(recordsNode) || attr(recordsNode, "Custom") !== "True") return undefined;
  const custom = asArray(recordsNode["Custom"])[0];
  const list = isRecord(custom) ? custom["ObjectList"] : undefined;
  const tables: PrivilegeSetTableAccess[] = [];
  for (const table of asArray(isRecord(list) ? list["Table"] : undefined)) {
    if (!isRecord(table)) continue;
    const baseTableName = attr(asArray(table["BaseTableReference"])[0], "name");
    const view = asArray(table["View"])[0];
    const edit = asArray(table["Edit"])[0];
    const create = asArray(table["Create"])[0];
    const del = asArray(table["Delete"])[0];
    tables.push({
      table: baseTableName ? decodeEntities(baseTableName) : "(new tables)",
      view: recordGrantLabel(attr(view, "access")),
      edit: recordGrantLabel(attr(edit, "access")),
      create: recordGrantLabel(attr(create, "access")),
      delete: recordGrantLabel(attr(del, "access")),
      ...(recordGrantCondition(view) ? { viewCondition: recordGrantCondition(view) } : {}),
      ...(recordGrantCondition(edit) ? { editCondition: recordGrantCondition(edit) } : {}),
      ...(recordGrantCondition(del) ? { deleteCondition: recordGrantCondition(del) } : {}),
      ...tableFieldsAccess(table["Fields"]),
    });
  }
  return tables.length ? { kind: "privilegeSet", tables } : undefined;
}

/** View/Edit/Create/Delete grant on a `<Records>` table row: ReadWrite → "Yes",
 * a calculated condition → "Limited", anything else (NoAccess) → "No". */
function recordGrantLabel(raw: string | undefined): string {
  if (raw === "ReadWrite") return "Yes";
  if (raw === "Calculation") return "Limited";
  return "No";
}

/** The formula behind a "Limited" (Calculation) grant on a View/Edit/Delete
 * node, e.g. <View access="Calculation"><Calculation><Text>…</Text></Calculation></View>.
 * Left entity-encoded like other calculation bodies (e.g. detail.kind ===
 * "calculation"), decoded at the rendering site by Highlight/LinkedCode. */
function recordGrantCondition(node: unknown): string | undefined {
  if (!isRecord(node) || attr(node, "access") !== "Calculation") return undefined;
  const text = calculationText(asArray(node["Calculation"])[0]);
  return text || undefined;
}

/** The `<Fields access=…>` summary for one table, expanded into per-field
 * grants only when that summary is "Custom". */
function tableFieldsAccess(fieldsWrapper: unknown): { fieldsAccess: string; fields?: PrivilegeSetFieldAccess[] } {
  const node = asArray(fieldsWrapper)[0];
  const raw = attr(node, "access");
  const fieldsAccess = fieldsSummaryLabel(raw);
  if (raw !== "Custom" || !isRecord(node)) return { fieldsAccess };
  const fields: PrivilegeSetFieldAccess[] = [];
  for (const field of asArray(node["Field"])) {
    if (!isRecord(field)) continue;
    const name = attr(asArray(field["FieldReference"])[0], "name");
    fields.push({
      field: name ? decodeEntities(name) : "(new fields)",
      access: singleFieldGrantLabel(attr(field, "access")),
    });
  }
  return { fieldsAccess, fields };
}

function fieldsSummaryLabel(raw: string | undefined): string {
  if (raw === "ReadWrite") return "All";
  if (raw === "ReadOnly") return "View only";
  if (raw === "Custom") return "Custom";
  return "None";
}

function singleFieldGrantLabel(raw: string | undefined): string {
  if (raw === "ReadWrite") return "Edit";
  if (raw === "ReadOnly") return "View only";
  return "None";
}

/** The cascade/sort settings on one side of a relationship (the <LeftTable> /
 * <RightTable> wrapper carries them as attributes, with the sort flag nested). */
function relationshipSide(wrapper: unknown): RelationshipSide {
  if (!isRecord(wrapper)) return { cascadeCreate: false, cascadeDelete: false, sorted: false };
  return {
    cascadeCreate: attr(wrapper, "cascadeCreate") === "True",
    cascadeDelete: attr(wrapper, "cascadeDelete") === "True",
    sorted: attr(asArray(wrapper["SortSpecification"])[0], "value") === "True",
  };
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
  fileUid?: string,
  stepTextByUuid?: Map<string, string>,
): ObjectDetail | undefined {
  if (!isRecord(node)) return undefined;
  const partsList = asArray(node["PartsList"])[0];
  if (!isRecord(partsList)) return undefined;

  const rawParts: LayoutPart[] = [];
  for (const part of asArray(partsList["Part"])) {
    if (!isRecord(part)) continue;
    // The part's top offset (absolute) and height (size) live on its <Definition>.
    const def = asArray(part["Definition"])[0];
    rawParts.push({
      type: attr(part, "type") ?? "Part",
      top: num(attr(def, "absolute")),
      height: num(attr(def, "size")),
      objects: layoutObjects(part["ObjectList"], fileUid, stepTextByUuid),
    });
  }
  if (rawParts.length === 0) return undefined;

  // The layout's real right edge. Objects sitting entirely to the right of it (a
  // common "scratch area" habit) are split out so they don't stretch the canvas.
  const declaredWidth = num(attr(node, "width"));
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

  // Canvas = the declared layout box; fall back to the on-layout object extent
  // when the width attribute is missing.
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
  return { kind: "layout", width, height, triggers: layoutTriggers(node["ScriptTriggers"]), parts, offLayout };
}

/** The objects on one layout part (or inside a portal / tab panel). */
function layoutObjects(container: unknown, fileUid?: string, stepTextByUuid?: Map<string, string>): LayoutObjectInfo[] {
  const out: LayoutObjectInfo[] = [];
  for (const obj of asArray(isRecord(container) ? container["LayoutObject"] : undefined)) {
    if (!isRecord(obj)) continue;
    const objId = attr(obj, "id");
    const uuidEl = asArray(obj["UUID"])[0];
    const objUuid = isRecord(uuidEl) ? collectText(uuidEl) : typeof uuidEl === "string" ? uuidEl : undefined;
    const objUuidTrimmed = objUuid?.trim();
    const uid = fileUid && objId ? `${fileUid}:layoutObject:${objId}` : undefined;
    const objHash = attr(obj, "hash");
    const info: LayoutObjectInfo = {
      type: attr(obj, "type") ?? "Object",
      name: decodeEntities(attr(obj, "name") ?? ""),
      ...(objId ? { id: objId } : {}),
      ...(objUuidTrimmed ? { uuid: objUuidTrimmed } : {}),
      ...(objHash ? { hash: objHash } : {}),
      ...(uid ? { uid } : {}),
    };

    const bounds = asArray(obj["Bounds"])[0];
    if (isRecord(bounds)) {
      info.bounds = {
        top: num(attr(bounds, "top")),
        left: num(attr(bounds, "left")),
        right: num(attr(bounds, "right")),
        bottom: num(attr(bounds, "bottom")),
      };
    }

    // Per-object styling lives in <LocalCSS> as a CSS string; normalise it to one
    // declaration per line so it displays cleanly and diffs line-by-line.
    const css = normalizeLocalCss(collectText(obj["LocalCSS"]));
    if (css) info.style = css;

    const extra = layoutObjectInfo(obj);
    if (extra) info.info = extra;

    // Portal: table occurrence name + visible row count + fields inside
    const portal = asArray(obj["Portal"])[0];
    if (isRecord(portal)) {
      const toRef = asArray(portal["TableOccurrenceReference"])[0];
      if (isRecord(toRef)) info.portalTable = decodeEntities(attr(toRef, "name") ?? "");
      const portalOpts = asArray(portal["Options"])[0];
      if (isRecord(portalOpts)) info.portalRows = num(attr(portalOpts, "show"));
      info.children = layoutObjects(portal["ObjectList"], fileUid, stepTextByUuid);
    }

    // Tab Control / Slide Control: each panel becomes a child object
    const tabControl = asArray(obj["TabControl"])[0];
    if (isRecord(tabControl)) info.children = layoutObjects(tabControl["ObjectList"], fileUid, stepTextByUuid);
    const slideControl = asArray(obj["SlideControl"])[0];
    if (isRecord(slideControl)) info.children = layoutObjects(slideControl["ObjectList"], fileUid, stepTextByUuid);

    // Tab Panel / Slide Panel: label from its Calculation + nested objects
    const tabPanel = asArray(obj["TabPanel"])[0];
    if (isRecord(tabPanel)) {
      const label = calculationText(tabPanel["Calculation"]);
      if (label) info.name = stripOuterQuotes(label);
      info.children = layoutObjects(tabPanel["ObjectList"], fileUid, stepTextByUuid);
    }
    const slidePanel = asArray(obj["SlidePanel"])[0];
    if (isRecord(slidePanel)) {
      const label = calculationText(slidePanel["Calculation"]);
      if (label) info.name = stripOuterQuotes(label);
      info.children = layoutObjects(slidePanel["ObjectList"], fileUid, stepTextByUuid);
    }

    // Field binding: "TO::FieldName" for edit boxes, drop-downs, etc. When the
    // bound field was since deleted, FileMaker omits <FieldReference> entirely
    // (no name is recoverable from this node) — flag it the same way a broken
    // reference reads anywhere else in the app.
    const fieldNode = asArray(obj["Field"])[0];
    if (isRecord(fieldNode)) {
      const fRefNode = asArray(fieldNode["FieldReference"])[0];
      if (isRecord(fRefNode)) {
        const toRef = asArray(fRefNode["TableOccurrenceReference"])[0];
        const toName = isRecord(toRef) ? decodeEntities(attr(toRef, "name") ?? "") : "";
        const fName = decodeEntities(attr(fRefNode, "name") ?? "");
        // A deleted field can leave <FieldReference> in place with the TO still
        // named but its own `name` attribute empty — flag it same as a fully
        // absent reference below, instead of silently dropping the binding.
        info.fieldRef = fName
          ? toName ? `${toName}::${fName}` : fName
          : toName ? `${toName}::<Field Missing>` : "<Field Missing>";
        const fId = attr(fRefNode, "id");
        const toId = isRecord(toRef) ? attr(toRef, "id") : undefined;
        if (fId) info.fieldToId = fId;
        if (toId) info.fieldViaToId = toId;
      } else {
        info.fieldRef = "<Field Missing>";
      }
      // A field object's attached value list (drop-down, checkbox set, …) lives
      // as a sibling of <FieldReference> under <Display>, not nested inside it.
      const displayNode = asArray(fieldNode["Display"])[0];
      const vlRefNode = isRecord(displayNode) ? asArray(displayNode["ValueListReference"])[0] : undefined;
      const vlId = attr(vlRefNode, "id");
      if (vlId) info.valueListRef = { id: vlId, name: decodeEntities(attr(vlRefNode, "name") ?? "") };
    }

    // Text objects: surface the CDATA content (may contain <<merge fields>>)
    if (!extra && info.type === "Text") {
      const textNode = asArray(obj["Text"])[0];
      if (isRecord(textNode)) {
        const content = firstTextValue(textNode);
        if (content) info.info = content;
      }
    }

    // Group / Grouped Button: both use <GroupedButton> as the XML wrapper
    const groupedButton = asArray(obj["GroupedButton"])[0];
    if (isRecord(groupedButton)) {
      const children = layoutObjects(groupedButton["ObjectList"], fileUid, stepTextByUuid);
      if (children.length > 0) info.children = children;
      const sr = extractScriptRef(groupedButton["action"]);
      if (sr) info.scriptRef = sr;
      else appendActionStep(info, groupedButton["action"], stepTextByUuid);
    }

    // Button: script reference for navigation
    if (!info.scriptRef) {
      const buttonNode = asArray(obj["Button"])[0];
      if (isRecord(buttonNode)) {
        const sr = extractScriptRef(buttonNode["action"]);
        if (sr) info.scriptRef = sr;
        else appendActionStep(info, buttonNode["action"], stepTextByUuid);
      }
    }

    // Button Bar: segments become children
    const buttonBar = asArray(obj["ButtonBar"])[0];
    if (isRecord(buttonBar)) {
      const children = layoutObjects(buttonBar["ObjectList"], fileUid, stepTextByUuid);
      if (children.length > 0) info.children = children;
    }

    // Popover Button: objects inside the popover panel become children
    const popoverButtonNode = asArray(obj["PopoverButton"])[0];
    if (isRecord(popoverButtonNode)) {
      const panel = asArray(popoverButtonNode["PopoverPanel"])[0];
      if (isRecord(panel)) {
        const children = layoutObjects(panel["ObjectList"], fileUid, stepTextByUuid);
        if (children.length > 0) info.children = children;
      }
    }

    // Object-level script triggers (separate from layout-level triggers)
    const objTriggers = layoutTriggers(obj["ScriptTriggers"]);
    if (objTriggers.length > 0) info.triggers = objTriggers;

    // Tooltip calculation text
    const tooltipNode = asArray(obj["Tooltip"])[0];
    if (isRecord(tooltipNode)) {
      const tip = calculationText(tooltipNode["Calculation"]);
      if (tip) info.tooltip = stripOuterQuotes(tip);
    }

    out.push(info);
  }
  return out;
}

/** Strip a single layer of surrounding double-quotes (FileMaker wraps static
 * labels like `"Tab Name"` in quotes in the Calculation text). */
function stripOuterQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length > 2 ? s.slice(1, -1) : s;
}

/** Script triggers from a <ScriptTriggers> container — layout-level
 * (OnLayoutEnter, OnRecordLoad, …) or file-level (OnFirstWindowOpen, …); the
 * element shape is identical. */
export function layoutTriggers(container: unknown): LayoutTriggerInfo[] {
  const out: LayoutTriggerInfo[] = [];
  for (const trigger of asArray(isRecord(container) ? container["ScriptTrigger"] : undefined)) {
    if (!isRecord(trigger)) continue;
    const script = asArray(trigger["ScriptReference"])[0];
    const parameter = isRecord(script) ? calculationText(script["Calculation"]) : "";
    const info: LayoutTriggerInfo = {
      action: attr(trigger, "action") ?? "ScriptTrigger",
      id: attr(trigger, "id"),
      scriptName: decodeEntities(attr(script, "name") ?? ""),
      scriptId: attr(script, "id"),
      scriptUuid: attr(script, "UUID"),
      modes: triggerModes(trigger),
    };
    if (parameter) info.parameter = parameter;
    const parameterFieldName = attr(trigger, "scriptParameterFieldName");
    if (parameterFieldName) info.parameterFieldName = decodeEntities(parameterFieldName);
    out.push(info);
  }
  return out;
}

function triggerModes(trigger: Record<string, unknown>): string[] {
  const modes: [string, string][] = [
    ["browseMode", "Browse"],
    ["findMode", "Find"],
    ["previewMode", "Preview"],
  ];
  return modes.filter(([attrName]) => attr(trigger, attrName) === "True").map(([, label]) => label);
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

/** Readable behavior for an object: a web-viewer's URL, or a button's label and
 * the action it triggers. Other objects carry no extra line. */
function layoutObjectInfo(obj: Record<string, unknown>): string | undefined {
  const external = asArray(obj["External"])[0];
  const webViewer = isRecord(external) ? asArray(external["WebViewer"])[0] : undefined;
  if (isRecord(webViewer)) {
    const url = firstCalculationText(webViewer);
    return url ? `URL: ${url}` : undefined;
  }

  const button = asArray(obj["Button"])[0];
  if (isRecord(button)) return buttonLabel(button);

  // Grouped Button and Group share the <GroupedButton> wrapper
  const groupedButton = asArray(obj["GroupedButton"])[0];
  if (isRecord(groupedButton)) return buttonLabel(groupedButton);

  // Popover Button: show the popover's label
  const popoverButton = asArray(obj["PopoverButton"])[0];
  if (isRecord(popoverButton)) {
    const label = firstTextValue(popoverButton["Label"]);
    return label ? `"${label}"` : undefined;
  }

  return undefined;
}

/** Button label text only — script reference is stored separately as scriptRef
 * so the UI can render it as a navigable link. */
function buttonLabel(btnNode: Record<string, unknown>): string | undefined {
  const label = firstTextValue(btnNode["Label"]);
  return label ? `"${label}"` : undefined;
}

/** Script reference navigation target: id, name, UUID from an <action> element. */
function extractScriptRef(action: unknown): { id?: string; name: string; uuid?: string } | undefined {
  const act = asArray(action)[0];
  if (!isRecord(act)) return undefined;
  const sr = asArray(act["ScriptReference"])[0];
  if (!isRecord(sr)) return undefined;
  const name = decodeEntities(attr(sr, "name") ?? "");
  return name || attr(sr, "id") ? { id: attr(sr, "id"), name, uuid: attr(sr, "UUID") } : undefined;
}

/** Set actionStep from a button's <action><Step name="..."> when there is no script ref.
 * Single-step buttons use this element instead of <ScriptReference>. */
function appendActionStep(
  info: { actionStep?: { name: string; params: string } },
  action: unknown,
  stepTextByUuid?: Map<string, string>,
): void {
  const act = asArray(action)[0];
  if (!isRecord(act)) return;
  const step = asArray(act["Step"])[0];
  if (!isRecord(step)) return;
  const name = attr(step, "name");
  if (!name) return;
  const params = stepTextByUuid ? stepParams(step, name, stepTextByUuid) : "";
  info.actionStep = { name, params };
}

/** Depth-first search for the first <Calculation> body (its <Text>) under a node. */
function firstCalculationText(node: unknown): string | undefined {
  const text = firstChildText(node, "Calculation");
  return text || undefined;
}

/** A styled label's text: its <StyledText><Data> CDATA, not the surrounding
 * <Options>/formatting nodes a broader <Text> search would also pick up. */
function firstTextValue(node: unknown): string | undefined {
  const text = firstChildText(node, "Data");
  return text ? decodeEntities(text) : undefined;
}

/** Find the first descendant element named `tag` and return its concatenated
 * text, skipping FileMaker's internal DDRREF chunk pointers. */
function firstChildText(node: unknown, tag: string): string {
  if (Array.isArray(node)) {
    for (const el of node) {
      const found = firstChildText(el, tag);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(node)) return "";
  if (node[tag] != null) {
    const text = collectText(node[tag]).trim();
    if (text) return text;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(ATTR_PREFIX) || key === "#text" || key === "DDRREF") continue;
    const found = firstChildText(value, tag);
    if (found) return found;
  }
  return "";
}

/** The TO name from a LeftTable/RightTable wrapper. */
function occurrenceName(wrapper: unknown): string {
  if (!isRecord(wrapper)) return "";
  return attr(asArray(wrapper["TableOccurrenceReference"])[0], "name") ?? "";
}

/** The TO id from a LeftTable/RightTable wrapper (the endpoint occurrence's id,
 * unique within the relationship's own file). */
function occurrenceId(wrapper: unknown): string | undefined {
  if (!isRecord(wrapper)) return undefined;
  return attr(asArray(wrapper["TableOccurrenceReference"])[0], "id");
}

function fieldName(wrapper: unknown): string {
  if (!isRecord(wrapper)) return "";
  return attr(asArray(wrapper["FieldReference"])[0], "name") ?? "";
}

/**
 * Extract a value list's full contents from its <ValueList> block inside
 * OptionsForValueLists (the catalog entry only names it). A custom list carries
 * its literal values in <CustomValues><Text>; a "from field" list carries its
 * field binding in <Field>.
 */
export function valueListDetail(block: unknown): ObjectDetail | undefined {
  if (!isRecord(block)) return undefined;
  const source = attr(asArray(block["Source"])[0], "value") ?? "";

  const customNode = asArray(block["CustomValues"])[0];
  const customText = isRecord(customNode) ? collectText(customNode["Text"]) : "";
  // FileMaker stores custom values newline-separated; a blank line is a divider.
  const customValues = customText
    ? customText.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
    : [];

  return { kind: "valueList", source, customValues, field: fieldSource(block["Field"]) };
}

/** The field binding of a "from field" value list. */
function fieldSource(node: unknown): ValueListFieldSource | undefined {
  if (!isRecord(node)) return undefined;
  const primary = asArray(node["PrimaryField"])[0];
  if (!isRecord(primary)) return undefined;

  // show="False": "Also display values from second field" is unchecked, though
  // FileMaker keeps the field it last pointed at.
  const secondaryWrap = asArray(node["SecondaryField"])[0];
  const secondaryField = isRecord(secondaryWrap) && attr(secondaryWrap, "show") !== "False"
    ? qualifiedField(secondaryWrap["FieldReference"])
    : undefined;

  const showRelated = asArray(node["ShowRelated"])[0];
  const showRelatedFrom =
    isRecord(showRelated) && attr(showRelated, "value") === "True"
      ? decodeEntities(attr(asArray(showRelated["TableOccurrenceReference"])[0], "name") ?? "") ||
        undefined
      : undefined;

  return {
    primaryField: qualifiedField(primary["FieldReference"]),
    sort: attr(primary, "sort") === "True",
    secondaryField: secondaryField || undefined,
    showRelatedFrom,
  };
}

/** A "TableOccurrence::Field" label from a <FieldReference> (with its nested TO).
 * A deleted field can leave <FieldReference> in place with the TO still named
 * but its own `name` attribute empty — flag it the same way a broken reference
 * reads anywhere else in the app (see layoutObjects' fieldRef, above). */
export function qualifiedField(wrapper: unknown): string {
  const ref = asArray(wrapper)[0];
  if (!isRecord(ref)) return "";
  const to = decodeEntities(attr(asArray(ref["TableOccurrenceReference"])[0], "name") ?? "");
  const field = decodeEntities(attr(ref, "name") ?? "");
  return field ? (to ? `${to}::${field}` : field) : to ? `${to}::<Field Missing>` : "<Field Missing>";
}

/** Calculation text from a <Calculation> node (the formula lives in <Text>). */
export function calculationText(calc: unknown): string {
  if (!isRecord(calc)) return "";
  return (collectText(calc["Text"]) || collectText(calc)).trim();
}
