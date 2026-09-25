import type { ObjectType } from "@/types/ddr";

/**
 * FMSaveAsXML element tag -> referenced object type.
 *
 * The "Save a Copy as XML" format (<FMSaveAsXML>) uses an explicit *Reference
 * tag family for all dependencies, which keeps references cleanly separate from
 * the object definitions that share names like <Script>/<Field>.
 */
export const FMSAVEAS_REF_TAGS: Readonly<Record<string, ObjectType>> = {
  ScriptReference: "script",
  // The script a "Perform Script on Server with Callback" step runs when the
  // server script finishes.
  CallbackScriptReference: "script",
  LayoutReference: "layout",
  ValueListReference: "valueList",
  FieldReference: "field",
  BaseTableReference: "table",
  TableOccurrenceReference: "tableOccurrence",
  CustomFunctionReference: "customFunction",
  // A menu set lists its member menus, and a submenu item points at its submenu,
  // both via <CustomMenuReference>; layouts/menus only ever reference real catalog
  // menus, so these resolve cleanly without broken-edge noise.
  CustomMenuReference: "customMenu",
  // Each layout names the theme it uses via <LayoutThemeReference>.
  LayoutThemeReference: "theme",
  // Each account names the privilege set it's granted via <PrivilegeSetReference>.
  PrivilegeSetReference: "privilegeSet",
  // Layouts, Install Menu Set steps, and File Options name a custom menu set.
  // The built-in "[File Default]" / "[Standard FileMaker Menus]" entries are
  // pseudo references and are skipped by scanRefs.
  CustomMenuSetReference: "customMenuSet",
  // External table occurrences, cross-file steps (Perform Script, Go to Related
  // Record, Open File, …), and external value lists all name the external data
  // source they go through.
  DataSourceReference: "externalDataSource",
};

/** Built-in menu-set names that aren't objects in the file's catalog. */
export const PSEUDO_MENU_SETS: ReadonlySet<string> = new Set(["[File Default]", "[Standard FileMaker Menus]"]);

/**
 * Refine the edge "kind" for display, based on the containing script step's
 * name and the target type. Falls back to the target type.
 */
export function edgeKind(targetType: ObjectType, stepName: string | undefined): string {
  const step = (stepName ?? "").toLowerCase();
  if (targetType === "script" && step.includes("perform script")) return "performScript";
  if (targetType === "layout" && step.includes("go to layout")) return "goToLayout";
  if (targetType === "field" && step.includes("set field")) return "setField";
  return targetType;
}
