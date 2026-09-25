import { OBJECT_TYPE_META, type ObjectType } from "@/types/ddr";
import { typeColor } from "./typeStyle";

/** Compact codes used by the short pill variant. */
export const SHORT_LABEL: Record<ObjectType, string> = {
  file: "F",
  table: "T",
  field: "Fld",
  tableOccurrence: "TO",
  relationship: "Rel",
  layout: "L",
  script: "S",
  valueList: "VL",
  customFunction: "CF",
  account: "Acct",
  privilegeSet: "PS",
  extendedPrivilege: "XP",
  fileAccess: "FA",
  externalDataSource: "EDS",
  customMenuSet: "CMS",
  customMenu: "CM",
  customMenuItem: "CMI",
  theme: "Thm",
  globalVariable: "$$",
  layoutObject: "Obj",
};

/** A small colored pill labeling an object's type. `short` renders a compact
 * code (S, T, TO, …) for use in dense lists; otherwise the full label. */
export function TypePill({
  type,
  label,
  short,
  color: colorOverride,
}: {
  type: ObjectType;
  label?: string;
  short?: boolean;
  color?: string;
}) {
  const color = colorOverride ?? typeColor(type);
  const text = label ?? (short ? SHORT_LABEL[type] : OBJECT_TYPE_META[type].label);
  return (
    <span
      className={`type-pill${short ? " short" : ""}`}
      style={{ color, borderColor: color }}
      title={OBJECT_TYPE_META[type].label}
    >
      {text}
    </span>
  );
}
