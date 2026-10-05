import type { FmObject } from "@/types/ddr";

export const FIELD_KIND_LABEL: Record<string, string> = { Normal: "Normal", Calculated: "Calculation", Summary: "Summary" };
export const DATA_TYPE_LABEL: Record<string, string> = { Binary: "Container" };

/** A field's kind and data type, e.g. "Calculation · Number". */
export function fieldKindAndType(a: FmObject["attributes"]): string {
  return [
    a.fieldtype && (FIELD_KIND_LABEL[a.fieldtype] ?? a.fieldtype),
    a.datatype && (DATA_TYPE_LABEL[a.datatype] ?? a.datatype),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One line for a field list: kind and data type, then only the storage
 * options that are switched on (global, unstored, container, repetitions, index). */
export function fieldSummary(a: FmObject["attributes"]): string {
  return [
    fieldKindAndType(a),
    a.global === "Yes" && "Global",
    a.unstored === "Yes" && "Unstored",
    a.containerStorage && a.containerStorage.split(" · ")[0],
    a.repetitions && `${a.repetitions} repetitions`,
    a.indexing && `Index: ${a.indexing}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
