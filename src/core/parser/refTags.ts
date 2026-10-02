import type { ObjectType } from "@/types/ddr";
import { GO_TO_LAYOUT_STEP, SET_FIELD_STEP, isPerformScriptStep } from "./stepNames";

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
  // The built-in PSEUDO_MENU_SETS entries are pseudo references and are
  // skipped by scanRefs.
  CustomMenuSetReference: "customMenuSet",
  // External table occurrences, cross-file steps (Perform Script, Go to Related
  // Record, Open File, …), and external value lists all name the external data
  // source they go through.
  DataSourceReference: "externalDataSource",
};

/**
 * Refine the edge "kind" of a script step's own target — the script a Perform
 * Script runs, the layout a Go to Layout goes to, the field a Set Field sets —
 * from the step's name. Falls back to the target type. Not for what the step's
 * calculations read: those are plain uses (scanRefs scans them with
 * `inChunkList`).
 */
export function edgeKind(targetType: ObjectType, stepName: string | undefined): string {
  if (stepName == null) return targetType;
  if (targetType === "script" && isPerformScriptStep(stepName)) return "performScript";
  if (targetType === "layout" && stepName === GO_TO_LAYOUT_STEP) return "goToLayout";
  if (targetType === "field" && stepName === SET_FIELD_STEP) return "setField";
  return targetType;
}
