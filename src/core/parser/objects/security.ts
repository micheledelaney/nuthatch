import type {
  FmObject,
  ObjectDetail,
  PrivilegeSetFieldAccess,
  PrivilegeSetObjectAccess,
  PrivilegeSetTableAccess,
} from "@/types/ddr";
import type { FileParse } from "../context";
import { attr, child, children, displayText, enabledLabels, isRecord, textAttr, withoutKey } from "../xmlUtils";
import { objectUid } from "../uid";
import { MISSING_FIELD_TOKEN, UNKNOWN_TARGET } from "../sentinels";
import { ownValue } from "../ownValue";
import { calcOf } from "./common";

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
  // directly in <AccountName>. displayText handles both shapes.
  const nameText = isRecord(auth) ? displayText(auth["AccountName"]) : "";
  // A FileMaker-auth account with no stored password is a security risk.
  // (External-auth accounts legitimately have none, so they're excluded.) The
  // password lives in <INSECURE_PASSWORD> (older) or <PasswordEncrypted>
  // (newer), as direct text or a nested <Data>.
  if (isRecord(auth) && attr(node, "type") === "FileMaker") {
    a.password = displayText(auth["PasswordEncrypted"] ?? auth["INSECURE_PASSWORD"]) ? "Yes" : "No";
  }
  // The granted privilege set is a nested <PrivilegeSetReference name=…>.
  const privName = textAttr(child(node, "PrivilegeSetReference"), "name");
  if (privName) a.privilegeSet = privName;
  return {
    ...obj,
    ...(nameText ? { name: nameText } : {}),
    // Searchable text without <Authentication>: it holds the stored password
    // (salt + hash, or in older exports <INSECURE_PASSWORD>), which must stay
    // out of search, diffs and the AI export. Only the account name is kept.
    text: displayText([isRecord(auth) ? auth["AccountName"] : undefined, withoutKey(node, "Authentication")]),
    attributes: { ...obj.attributes, ...a, ...descriptionAttribute(node) },
  };
}

/** A nested <Description>, as an attribute. */
function descriptionAttribute(node: Record<string, unknown>): Record<string, string> {
  const description = displayText(node["Description"]);
  return description ? { description } : {};
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

/** The permission categories under <access>: [element, attribute key]. */
const ACCESS_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ["Records", "recordsAccess"],
  ["Layouts", "layoutsAccess"],
  ["ValueLists", "valueListsAccess"],
  ["Scripts", "scriptsAccess"],
];

/** The grants on one <Records> table row, each possibly gated by a calculation. */
const RECORD_GRANT_VERBS = ["View", "Edit", "Create", "Delete"] as const;

/** The grants a permission category node itself summarizes, besides View. */
const CATEGORY_GRANT_VERBS = ["Create", "Edit", "Delete"] as const;

/** Surface a privilege set's description and the access level it grants for each
 * object category (records, layouts, value lists, scripts) — all nested under
 * <access>, not attributes — plus its custom per-object grants as detail. */
export function annotatePrivilegeSet(node: Record<string, unknown>, obj: FmObject): FmObject {
  const described = { ...obj, attributes: { ...obj.attributes, ...descriptionAttribute(node) } };
  const access = child(node, "access");
  if (!isRecord(access)) return described;
  const detail = privilegeSetDetail(access);
  const a: Record<string, string> = {};
  for (const [element, key] of ACCESS_CATEGORIES) {
    const level = categoryAccess(child(access, element));
    if (level) a[key] = level;
  }
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
  for (const verb of CATEGORY_GRANT_VERBS) {
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
  const tables = customTableAccess(child(accessNode, "Records"));
  const layouts = customObjectAccess(child(accessNode, "Layouts"), LAYOUT_GRANTS);
  const scripts = customObjectAccess(child(accessNode, "Scripts"), SCRIPT_GRANTS);
  const valueLists = customObjectAccess(child(accessNode, "ValueLists"), VALUE_LIST_GRANTS);
  if (tables.length === 0 && !layouts && !scripts && !valueLists) return undefined;
  return {
    kind: "privilegeSet",
    tables,
    ...(layouts ? { layouts } : {}),
    ...(scripts ? { scripts } : {}),
    ...(valueLists ? { valueLists } : {}),
  };
}

/** Whether a grant row is the default for objects created later — `type="New"`,
 * with no reference — rather than one for an object that exists, or did: a
 * row whose object was deleted keeps its reference with the name blank (FM 21;
 * FM 26 drops the row). */
function isNewObjectsGrant(row: unknown): boolean {
  return attr(row, "type") === "New";
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
  if (!isRecord(categoryNode) || attr(categoryNode, "Custom") !== "True") return undefined;
  return children(child(child(categoryNode, "Custom"), "ObjectList"), spec.itemTag)
    .filter(isRecord)
    .map((item) => {
      const records = attr(item, "records");
      return {
        name: isNewObjectsGrant(item) ? spec.newLabel : textAttr(child(item, spec.refTag), "name") || UNKNOWN_TARGET,
        access: grantLabel({ ...OBJECT_GRANT_LABELS, ReadOnly: spec.readOnlyLabel }, attr(item, "access"), "No access"),
        ...(records != null ? { records: grantLabel(OBJECT_GRANT_LABELS, records, "No access") } : {}),
      };
    });
}

/** Custom record access (`<Records Custom="True">`): one row per table, or none
 * when record access isn't Custom. */
function customTableAccess(recordsNode: unknown): PrivilegeSetTableAccess[] {
  if (!isRecord(recordsNode) || attr(recordsNode, "Custom") !== "True") return [];
  return customRecordTables(recordsNode).map((table) => {
    const baseTableName = textAttr(child(table, "BaseTableReference"), "name");
    const view = child(table, "View");
    const edit = child(table, "Edit");
    const del = child(table, "Delete");
    const viewCondition = recordGrantCondition(view);
    const editCondition = recordGrantCondition(edit);
    const deleteCondition = recordGrantCondition(del);
    return {
      table: isNewObjectsGrant(table) ? "(new tables)" : baseTableName || UNKNOWN_TARGET,
      view: grantLabel(RECORD_GRANT_LABELS, attr(view, "access"), "No"),
      edit: grantLabel(RECORD_GRANT_LABELS, attr(edit, "access"), "No"),
      create: grantLabel(RECORD_GRANT_LABELS, attr(child(table, "Create"), "access"), "No"),
      delete: grantLabel(RECORD_GRANT_LABELS, attr(del, "access"), "No"),
      ...(viewCondition ? { viewCondition } : {}),
      ...(editCondition ? { editCondition } : {}),
      ...(deleteCondition ? { deleteCondition } : {}),
      ...tableFieldsAccess(child(table, "Fields")),
    };
  });
}

/** A per-object grant (layouts, scripts, value lists); ReadOnly is worded per
 * category (ObjectGrantSpec.readOnlyLabel), anything else is "No access". */
const OBJECT_GRANT_LABELS: Readonly<Record<string, string>> = { ReadWrite: "Modifiable", ReadOnly: "View only" };
/** View/Edit/Create/Delete on a `<Records>` table row: a calculated condition is
 * "Limited", anything else (NoAccess) "No". */
const RECORD_GRANT_LABELS: Readonly<Record<string, string>> = { ReadWrite: "Yes", Calculation: "Limited" };
/** A table's `<Fields access>` summary; anything else is "None". */
const FIELDS_SUMMARY_LABELS: Readonly<Record<string, string>> = { ReadWrite: "All", ReadOnly: "View only", Custom: "Custom" };
/** One field's grant under a Custom `<Fields>`; anything else is "None". */
const FIELD_GRANT_LABELS: Readonly<Record<string, string>> = { ReadWrite: "Edit", ReadOnly: "View only" };

function grantLabel(labels: Readonly<Record<string, string>>, raw: string | undefined, fallback: string): string {
  return ownValue(labels, raw) ?? fallback;
}

/** The formula behind a "Limited" (Calculation) grant on a View/Edit/Delete
 * node, e.g. <View access="Calculation"><Calculation><Text>…</Text></Calculation></View>.
 * Not entity-decoded, like other calculation bodies (see decodeEntities). */
function recordGrantCondition(node: unknown): string | undefined {
  if (attr(node, "access") !== "Calculation") return undefined;
  return calcOf(node) || undefined;
}

/** The `<Fields access=…>` summary for one table, expanded into per-field
 * grants when it is "Custom" — or, as FM 21 writes custom access, when a
 * per-field list follows another summary. */
function tableFieldsAccess(node: unknown): { fieldsAccess: string; fields?: PrivilegeSetFieldAccess[] } {
  const raw = attr(node, "access");
  const fieldNodes = children(node, "Field");
  if (raw !== "Custom" && fieldNodes.length === 0) return { fieldsAccess: grantLabel(FIELDS_SUMMARY_LABELS, raw, "None") };
  const fields = fieldNodes.filter(isRecord).map((field) => ({
    field: isNewObjectsGrant(field) ? "(new fields)" : textAttr(child(field, "FieldReference"), "name") || MISSING_FIELD_TOKEN,
    access: grantLabel(FIELD_GRANT_LABELS, attr(field, "access"), "None"),
  }));
  return { fieldsAccess: "Custom", fields };
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
export function addExtendedPrivilegeGrants(fp: FileParse, node: Record<string, unknown>, obj: FmObject): void {
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
 * The nested <Source> records who first authorized the file and when. `type`
 * is Local or External, and `self="True"` marks the file authorizing itself —
 * requiring authorization adds one such entry per type, both under its own name.
 */
export function annotateFileAccess(node: Record<string, unknown>, obj: FmObject): FmObject {
  const name = displayText(node["Display"]) || obj.name;
  const source = child(node, "Source");
  const account = textAttr(source, "CreationAccountName");
  const created = attr(source, "CreationTimestamp");
  const accessType = attr(node, "type");
  return {
    ...obj,
    name,
    text: name,
    attributes: {
      ...obj.attributes,
      ...(accessType ? { accessType } : {}),
      selfAuthorized: attr(node, "self") === "True" ? "Yes" : "No",
      ...(account ? { authorizedBy: account } : {}),
      ...(created ? { authorizedOn: created } : {}),
    },
  };
}
