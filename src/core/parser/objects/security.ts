import type {
  FmObject,
  ObjectDetail,
  PrivilegeSetFieldAccess,
  PrivilegeSetObjectAccess,
  PrivilegeSetTableAccess,
} from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, children, collectText, enabledLabels, isRecord } from "../xmlUtils";
import { decodeEntities } from "../entities";
import { objectUid } from "../uid";
import { calculationText } from "./common";

// ---- accounts -----------------------------------------------------------------

/**
 * An <Account> carries no `name` attribute; its login name lives nested at
 * <Authentication><AccountName><INSECURE_TEXT>. Lift it to the object name so
 * accounts read as e.g. "User" rather than the "(account 4)" id fallback, and
 * surface the account's privilege set and description (both nested, not
 * attributes) so they appear in the inspector.
 */
export function annotateAccount(node: Record<string, unknown>, obj: FmObject): FmObject {
  // `enable="False"` marks a deactivated account.
  const a: Record<string, string> = { status: attr(node, "enable") === "False" ? "Inactive" : "Active" };
  const auth = child(node, "Authentication");
  // Account name: older exports nest it in <INSECURE_TEXT>, newer ones put it
  // directly in <AccountName>. collectText handles both shapes.
  const nameText = isRecord(auth) ? collectText(auth["AccountName"]).trim() : "";
  // A FileMaker-auth account with no stored password is a security risk.
  // (External-auth accounts legitimately have none, so they're excluded.) The
  // password lives in <INSECURE_PASSWORD> (older) or <PasswordEncrypted>
  // (newer), as direct text or a nested <Data>.
  if (isRecord(auth) && attr(node, "type") === "FileMaker") {
    a.password = collectText(auth["PasswordEncrypted"] ?? auth["INSECURE_PASSWORD"]).trim() ? "Yes" : "No";
  }
  // The granted privilege set is a nested <PrivilegeSetReference name=…>.
  const privName = attr(child(node, "PrivilegeSetReference"), "name");
  if (privName) a.privilegeSet = decodeEntities(privName);
  return {
    ...obj,
    ...(nameText ? { name: decodeEntities(nameText) } : {}),
    attributes: { ...obj.attributes, ...a, ...descriptionAttribute(node) },
  };
}

/** A nested <Description>, as an attribute. */
function descriptionAttribute(node: Record<string, unknown>): Record<string, string> {
  const description = collectText(node["Description"]).trim();
  return description ? { description: decodeEntities(description) } : {};
}

// ---- privilege sets -----------------------------------------------------------

/** The <Other> block's extended management privileges. */
const OTHER_PRIVILEGES: ReadonlyArray<readonly [string, string]> = [
  ["Print", "Printing"],
  ["Export", "Exporting"],
  ["manageDatabase", "Manage database"],
  ["manageCustomMenus", "Manage custom menus"],
  ["manageAccounts", "Manage accounts"],
  ["manageExtPrivs", "Manage extended privileges"],
  ["allowOverride", "Override data validation"],
  ["allowOpenQuickly", "Allow Open Quickly"],
  ["disconnectIdle", "Disconnect idle users"],
];

const RECORD_GRANT_VERBS = ["View", "Edit", "Create", "Delete"] as const;

/** Surface a privilege set's description and the access level it grants for each
 * object category (records, layouts, value lists, scripts) — all nested under
 * <access>, not attributes — plus its custom per-object grants as detail. */
export function annotatePrivilegeSet(node: Record<string, unknown>, obj: FmObject): FmObject {
  const described = { ...obj, attributes: { ...obj.attributes, ...descriptionAttribute(node) } };
  const access = child(node, "access");
  if (!isRecord(access)) return described;
  const detail = privilegeSetDetail(access);
  const a: Record<string, string> = {};
  const records = categoryAccess(access["Records"]);
  if (records) a.recordsAccess = records;
  const layouts = categoryAccess(access["Layouts"]);
  if (layouts) a.layoutsAccess = layouts;
  const valueLists = categoryAccess(access["ValueLists"]);
  if (valueLists) a.valueListsAccess = valueLists;
  const scripts = categoryAccess(access["Scripts"]);
  if (scripts) a.scriptsAccess = scripts;
  if (attr(access, "default") === "True") a.defaultPrivilegeSet = "Yes";

  // The <Other> block holds the extended management privileges and the menu
  // command level — none of which live in the per-category access nodes above.
  const other = child(access, "Other");
  if (isRecord(other)) {
    const granted = enabledLabels(other, OTHER_PRIVILEGES);
    if (granted.length) a.otherPrivileges = granted.join(", ");
    const commands = attr(other, "commands");
    if (commands) a.menuCommands = commands;
    if (attr(child(other, "Password"), "prohibitModification") === "True") a.passwordChange = "Prohibited";
  }
  return { ...described, ...(detail ? { detail } : {}), attributes: { ...described.attributes, ...a } };
}

/** The tables of a <Records><Custom> grant list (each with its View / Edit /
 * Create / Delete grants and field access). */
function customRecordTables(records: unknown): Record<string, unknown>[] {
  return children(child(child(records, "Custom"), "ObjectList"), "Table").filter(isRecord);
}

/** The formulas behind a privilege set's "Limited" record access — each custom
 * table grant whose View / Edit / Create / Delete is gated by a calculation.
 * They aren't grants but dependencies: they call fields and functions. */
export function recordAccessCalcs(node: Record<string, unknown>): unknown[] {
  const calcs: unknown[] = [];
  for (const table of customRecordTables(child(child(node, "access"), "Records"))) {
    for (const verb of RECORD_GRANT_VERBS) {
      for (const grant of children(table, verb)) {
        if (isRecord(grant) && attr(grant, "access") === "Calculation") calcs.push(...children(grant, "Calculation"));
      }
    }
  }
  return calcs;
}

/** A permission category's summary. Custom privileges carry no
 * View/Create/Edit/Delete attributes on the category node itself (those live
 * per table / per object under <Custom>, see privilegeSetDetail), so
 * accessLevel() would read them as granting nothing — call out "Custom"
 * instead, plus ", Create" when new objects of that kind may be created. */
function categoryAccess(node: unknown): string {
  if (attr(node, "Custom") !== "True") return accessLevel(node);
  return attr(child(node, "Custom"), "Create") === "True" ? "Custom, Create" : "Custom";
}

/** Summarize a permission category node, e.g. <Records Create="True" Edit="True">
 * → "Create, Edit" and <Layouts View="ReadOnly"> → "View: ReadOnly". */
function accessLevel(node: unknown): string {
  if (!isRecord(node)) return "";
  const parts: string[] = [];
  const view = attr(node, "View");
  if (view && view !== "None") parts.push(`View: ${view}`);
  for (const verb of ["Create", "Edit", "Delete"]) {
    if (attr(node, verb) === "True") parts.push(verb);
  }
  return parts.length ? parts.join(", ") : "None";
}

/**
 * Extract a privilege set's custom privileges from its `<access>` node: the
 * per-table (and, when defined, per-field) record access from
 * `<Records Custom="True"><Custom><ObjectList><Table>…`, and the per-object
 * grants of any Custom layout / script / value-list category. Each `<Table>`
 * carries View/Edit/Create/Delete access plus a `<Fields>` summary that expands
 * into per-`<Field>` grants only when that table's field access is itself
 * "Custom" — otherwise every field shares the one grant. Undefined when no
 * category is Custom.
 */
function privilegeSetDetail(accessNode: Record<string, unknown>): ObjectDetail | undefined {
  const tables = customTableAccess(accessNode["Records"]);
  const layouts = customObjectAccess(accessNode["Layouts"], LAYOUT_GRANTS);
  const scripts = customObjectAccess(accessNode["Scripts"], SCRIPT_GRANTS);
  const valueLists = customObjectAccess(accessNode["ValueLists"], VALUE_LIST_GRANTS);
  if (tables.length === 0 && !layouts && !scripts && !valueLists) return undefined;
  return {
    kind: "privilegeSet",
    tables,
    ...(layouts ? { layouts } : {}),
    ...(scripts ? { scripts } : {}),
    ...(valueLists ? { valueLists } : {}),
  };
}

/** How one Custom category (<Layouts>, <Scripts>, <ValueLists>) lists its
 * per-object grants: `<Custom><ObjectList><Layout access records type>
 * <LayoutReference/>…`, with `type="New"` for the new-objects default. */
interface ObjectGrantSpec {
  itemTag: string;
  refTag: string;
  newLabel: string;
  /** Label for `access="ReadOnly"`, which FileMaker words per category. */
  readOnlyLabel: string;
}

const LAYOUT_GRANTS: ObjectGrantSpec = {
  itemTag: "Layout",
  refTag: "LayoutReference",
  newLabel: "(new layouts)",
  readOnlyLabel: "View only",
};
const SCRIPT_GRANTS: ObjectGrantSpec = {
  itemTag: "Script",
  refTag: "ScriptReference",
  newLabel: "(new scripts)",
  readOnlyLabel: "Executable only",
};
// No sample export has custom value-list privileges; assumed to follow the
// layout/script shape.
const VALUE_LIST_GRANTS: ObjectGrantSpec = {
  itemTag: "ValueList",
  refTag: "ValueListReference",
  newLabel: "(new value lists)",
  readOnlyLabel: "View only",
};

/** The per-object grants of a category whose access is Custom, or undefined
 * when it isn't Custom. */
function customObjectAccess(categoryNode: unknown, spec: ObjectGrantSpec): PrivilegeSetObjectAccess[] | undefined {
  const node = Array.isArray(categoryNode) ? categoryNode[0] : categoryNode;
  if (!isRecord(node) || attr(node, "Custom") !== "True") return undefined;
  return children(child(child(node, "Custom"), "ObjectList"), spec.itemTag)
    .filter(isRecord)
    .map((item) => {
      const records = attr(item, "records");
      return {
        name: attr(item, "type") === "New" ? spec.newLabel : decodeEntities(attr(child(item, spec.refTag), "name") ?? ""),
        access: objectGrantLabel(attr(item, "access"), spec.readOnlyLabel),
        ...(records != null ? { records: objectGrantLabel(records, "View only") } : {}),
      };
    });
}

/** A per-object grant: ReadWrite → "Modifiable", ReadOnly → the category's
 * read-only wording, anything else (NoAccess) → "No access". */
function objectGrantLabel(raw: string | undefined, readOnlyLabel: string): string {
  if (raw === "ReadWrite") return "Modifiable";
  if (raw === "ReadOnly") return readOnlyLabel;
  return "No access";
}

/** Custom record access (`<Records Custom="True">`): one row per table, or none
 * when record access isn't Custom. */
function customTableAccess(recordsNode: unknown): PrivilegeSetTableAccess[] {
  if (!isRecord(recordsNode) || attr(recordsNode, "Custom") !== "True") return [];
  return customRecordTables(recordsNode).map((table) => {
    const baseTableName = attr(child(table, "BaseTableReference"), "name");
    const view = child(table, "View");
    const edit = child(table, "Edit");
    const del = child(table, "Delete");
    const viewCondition = recordGrantCondition(view);
    const editCondition = recordGrantCondition(edit);
    const deleteCondition = recordGrantCondition(del);
    return {
      table: baseTableName ? decodeEntities(baseTableName) : "(new tables)",
      view: recordGrantLabel(attr(view, "access")),
      edit: recordGrantLabel(attr(edit, "access")),
      create: recordGrantLabel(attr(child(table, "Create"), "access")),
      delete: recordGrantLabel(attr(del, "access")),
      ...(viewCondition ? { viewCondition } : {}),
      ...(editCondition ? { editCondition } : {}),
      ...(deleteCondition ? { deleteCondition } : {}),
      ...tableFieldsAccess(table["Fields"]),
    };
  });
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
 * Not entity-decoded, like other calculation bodies (see decodeEntities). */
function recordGrantCondition(node: unknown): string | undefined {
  if (!isRecord(node) || attr(node, "access") !== "Calculation") return undefined;
  return calculationText(child(node, "Calculation")) || undefined;
}

/** The `<Fields access=…>` summary for one table, expanded into per-field
 * grants when it is "Custom" — or, as FM 21 writes custom access, when a
 * per-field list follows another summary. */
function tableFieldsAccess(fieldsWrapper: unknown): { fieldsAccess: string; fields?: PrivilegeSetFieldAccess[] } {
  const node = Array.isArray(fieldsWrapper) ? fieldsWrapper[0] : fieldsWrapper;
  const raw = attr(node, "access");
  const fieldNodes = children(node, "Field");
  if (raw !== "Custom" && fieldNodes.length === 0) return { fieldsAccess: fieldsSummaryLabel(raw) };
  const fields = fieldNodes.filter(isRecord).map((field) => {
    const name = attr(child(field, "FieldReference"), "name");
    return { field: name ? decodeEntities(name) : "(new fields)", access: singleFieldGrantLabel(attr(field, "access")) };
  });
  return { fieldsAccess: "Custom", fields };
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

// ---- extended privileges ------------------------------------------------------

/** Surface an extended privilege's description (a nested <Description>). */
export function annotateExtendedPrivilege(node: Record<string, unknown>, obj: FmObject): FmObject {
  return { ...obj, attributes: { ...obj.attributes, ...descriptionAttribute(node) } };
}

/**
 * An extended privilege names the privilege sets that grant it via a nested
 * <ObjectList> of <PrivilegeSetReference>. The natural edge runs the other way —
 * a privilege set *grants* the extended privilege — so emit privilegeSet ->
 * extendedPrivilege edges (using each reference's `id` as the set's uid). That
 * makes the granting sets show as the extended privilege's inbound references,
 * and the extended privilege show among each set's outbound references.
 */
export function addExtendedPrivilegeGrants(node: Record<string, unknown>, obj: FmObject, fp: FileParse): void {
  for (const ref of children(child(node, "ObjectList"), "PrivilegeSetReference")) {
    const id = attr(ref, "id");
    if (id == null) continue;
    fp.references.push({
      fromUid: objectUid(fp.file.uid, "privilegeSet", id),
      toType: "extendedPrivilege",
      toId: obj.id,
      toName: obj.name,
      kind: "extendedPrivilege",
    });
  }
}

// ---- file access --------------------------------------------------------------

/**
 * A <Authorization> (an authorized client file) carries no `name`; its label is a
 * nested <Display> CDATA. Lift it to the object name, and reset the text to that
 * label so the embedded <Authentication> credential hash stays out of the body.
 * The nested <Source> records who first authorized the file and when.
 */
export function annotateFileAccess(node: Record<string, unknown>, obj: FmObject): FmObject {
  const display = collectText(node["Display"]).trim();
  const name = display ? decodeEntities(display) : obj.name;
  const source = child(node, "Source");
  const account = attr(source, "CreationAccountName");
  const created = attr(source, "CreationTimestamp");
  return {
    ...obj,
    name,
    text: name,
    attributes: {
      ...obj.attributes,
      ...(account ? { authorizedBy: decodeEntities(account) } : {}),
      ...(created ? { authorizedOn: created } : {}),
    },
  };
}
