import type { ObjectType } from "@/types/ddr";

/** Map each object type to a CSS color variable used for its dot/badge. */
export function typeColor(type: ObjectType): string {
  switch (type) {
    case "file":
      return "var(--type-file)";
    case "table":
    case "tableOccurrence":
      return "var(--type-table)";
    case "field":
      return "var(--type-field)";
    case "script":
      return "var(--type-script)";
    case "layout":
    case "layoutObject":
      return "var(--type-layout)";
    case "relationship":
      return "var(--type-relationship)";
    case "valueList":
      return "var(--type-value-list)";
    case "customFunction":
      return "var(--type-custom-function)";
    case "account":
      return "var(--type-account)";
    case "privilegeSet":
      return "var(--type-privilege-set)";
    case "extendedPrivilege":
      return "var(--type-extended-privilege)";
    case "fileAccess":
      return "var(--type-file-access)";
    case "externalDataSource":
      return "var(--type-data-source)";
    case "customMenuSet":
      return "var(--type-menu-set)";
    case "customMenu":
      return "var(--type-menu)";
    case "customMenuItem":
      return "var(--type-menu-item)";
    case "theme":
      return "var(--type-theme)";
    case "globalVariable":
      return "var(--type-global-variable)";
    default:
      return "var(--type-default)";
  }
}
