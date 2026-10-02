import type { FmObject, JoinPredicate, RelationshipSide } from "@/types/ddr";
import { attr, child, children, isRecord, textAttr } from "../xmlUtils";

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
export function annotateRelationship(node: Record<string, unknown>, obj: FmObject): FmObject {
  const left = node["LeftTable"];
  const right = node["RightTable"];
  const leftToId = occurrenceId(left);
  const rightToId = occurrenceId(right);
  const predicates: JoinPredicate[] = children(node["JoinPredicateList"], "JoinPredicate")
    .filter(isRecord)
    .map((predicate) => {
      const type = attr(predicate, "type");
      return {
        leftField: fieldName(predicate["LeftField"]),
        operator: type == null ? "=" : (JOIN_OPERATORS[type] ?? type),
        rightField: fieldName(predicate["RightField"]),
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
      left: relationshipSide(left),
      right: relationshipSide(right),
    },
  };
}

/** The cascade/sort settings on one side of a relationship (the <LeftTable> /
 * <RightTable> wrapper carries them as attributes, with the sort flag nested). */
function relationshipSide(wrapper: unknown): RelationshipSide {
  return {
    cascadeCreate: attr(wrapper, "cascadeCreate") === "True",
    cascadeDelete: attr(wrapper, "cascadeDelete") === "True",
    sorted: attr(child(wrapper, "SortSpecification"), "value") === "True",
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

function fieldName(wrapper: unknown): string {
  return textAttr(child(wrapper, "FieldReference"), "name") ?? "";
}
