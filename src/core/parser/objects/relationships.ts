import type { FmObject, JoinPredicate, RelationshipSide } from "@/types/ddr";
import type { FileIndex } from "../context";
import { attr, child, children, isRecord, textAttr } from "../xmlUtils";
import { ownValue } from "../ownValue";
import { fieldRefName, sortFields } from "./common";

// Keys match the `type` attribute FileMaker writes on <JoinPredicate>.
// Confirmed from DDR output: Equal, NotEqual, LessOrEqual, GreaterOrEqual,
// CartesianProduct, Less, Greater. The LessThan / GreaterThan spellings are
// mapped too, in case FileMaker emits them; any other type shows as written.
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

/** A relationship's table occurrences and join predicates, as detail. */
export function annotateRelationship(node: Record<string, unknown>, obj: FmObject, index: FileIndex): FmObject {
  const left = node["LeftTable"];
  const right = node["RightTable"];
  const leftToId = occurrenceId(left);
  const rightToId = occurrenceId(right);
  const predicates: JoinPredicate[] = children(node["JoinPredicateList"], "JoinPredicate")
    .filter(isRecord)
    .map((predicate) => {
      const type = attr(predicate, "type");
      return {
        leftField: fieldName(predicate["LeftField"], index),
        operator: type == null ? "=" : (ownValue(JOIN_OPERATORS, type) ?? type),
        rightField: fieldName(predicate["RightField"], index),
      };
    });
  return {
    ...obj,
    detail: {
      kind: "relationship",
      leftTable: occurrenceName(left),
      rightTable: occurrenceName(right),
      ...(leftToId != null ? { leftToId } : {}),
      ...(rightToId != null ? { rightToId } : {}),
      predicates,
      left: relationshipSide(left, index),
      right: relationshipSide(right, index),
    },
  };
}

/** The cascade/sort settings on one side of a relationship (the <LeftTable> /
 * <RightTable> wrapper carries them as attributes, with the sort nested). */
function relationshipSide(wrapper: unknown, index: FileIndex): RelationshipSide {
  const sort = child(wrapper, "SortSpecification");
  const fields = sortFields(sort, index);
  return {
    cascadeCreate: attr(wrapper, "cascadeCreate") === "True",
    cascadeDelete: attr(wrapper, "cascadeDelete") === "True",
    sorted: attr(sort, "value") === "True",
    ...(fields.length > 0 ? { sortFields: fields } : {}),
  };
}

/** The TO name from a LeftTable/RightTable wrapper. */
function occurrenceName(wrapper: unknown): string {
  return textAttr(child(wrapper, "TableOccurrenceReference"), "name") ?? "";
}

/** The TO id from a LeftTable/RightTable wrapper (the endpoint occurrence's id,
 * unique within the relationship's own file). */
function occurrenceId(wrapper: unknown): string | undefined {
  return attr(child(wrapper, "TableOccurrenceReference"), "id");
}

/** A predicate side's field (see fieldRefName), "" when it names none. */
function fieldName(wrapper: unknown, index: FileIndex): string {
  const ref = child(wrapper, "FieldReference");
  return isRecord(ref) ? fieldRefName(ref, index) : "";
}
