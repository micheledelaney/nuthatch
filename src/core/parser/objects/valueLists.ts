import type { FmObject, ObjectDetail, ValueListFieldSource } from "@/types/ddr";
import type { FileIndex, FileParse } from "../context";
import { attr, child, displayText, isRecord, textAttr } from "../xmlUtils";
import { UNKNOWN_TARGET } from "../sentinels";
import { collectCatalogItems, firstBlockByOwner } from "../catalogWalk";
import { scanRefs } from "../refs/scanRefs";
import { qualifiedField } from "./common";

/**
 * Where each value list's contents (custom values, "from field" binding) live:
 * FM 22 exports keep them in OptionsForValueLists (keyed back to the value list
 * by reference) — this map; FM 26 exports inline them on the ValueListCatalog
 * entry that becomes the object — null.
 */
export function valueListContents(containerNode: Record<string, unknown>): Map<string, Record<string, unknown>> | null {
  const blocks = collectCatalogItems(containerNode["OptionsForValueLists"], "ValueList");
  return blocks.length === 0 ? null : firstBlockByOwner(blocks, "ValueListReference");
}

/** The block holding a value list's contents (see valueListContents). */
function contentsOf(item: Record<string, unknown>, obj: FmObject, contents: Map<string, Record<string, unknown>> | null) {
  return contents ? contents.get(obj.id) : item;
}

/** Surface a value list's source kind (Custom, Field, …), which lives in a
 * nested <Source value=…> element, and its contents as detail. */
export function annotateValueList(
  item: Record<string, unknown>,
  obj: FmObject,
  contents: Map<string, Record<string, unknown>> | null,
  index: FileIndex,
): FmObject {
  const source = attr(child(item, "Source"), "value");
  const block = contentsOf(item, obj, contents);
  return {
    ...obj,
    attributes: { ...obj.attributes, ...(source ? { source } : {}) },
    ...(block ? { detail: valueListDetail(block, index) } : {}),
  };
}

/**
 * A value list's dependencies: its <Field> binding (never the leading
 * <ValueListReference> of an OptionsForValueLists block — that's the binding
 * key, not a dependency), and the value list in another file it takes its
 * values from (Source = External).
 */
export function addValueListRefs(
  fp: FileParse,
  item: Record<string, unknown>,
  obj: FmObject,
  contents: Map<string, Record<string, unknown>> | null,
): void {
  const block = contentsOf(item, obj, contents);
  if (!block) return;
  scanRefs(fp, activeValueListField(block["Field"]), obj);
  addExternalValueListSource(fp, block, obj.uid);
}

/** A value list's <Field> binding minus the occurrence of "Include only related
 * values" when that option is off. (A <SecondaryField> is always in use — see
 * fieldSource — so it's kept.) */
function activeValueListField(field: unknown): unknown {
  if (!isRecord(field)) return field;
  const { ShowRelated, ...rest } = field;
  return {
    ...rest,
    ...(ShowRelated != null && attr(child(field, "ShowRelated"), "value") === "True" ? { ShowRelated } : {}),
  };
}

/**
 * The cross-file dependency of a "use values from another file's value list"
 * (Source = External) value list. The external value list lives under
 * <External>, named by a sibling <DataSourceReference>. With a data source it
 * resolves against that loaded file (best-effort when not loaded); with the data
 * source gone (a dead external link) it's force-broken, since it can never
 * resolve locally. FileMaker renders the external name as "Unknown" when it
 * can't resolve it at export, but the id + data source are enough to resolve it.
 */
function addExternalValueListSource(fp: FileParse, block: Record<string, unknown>, ownerUid: string): void {
  const external = child(block, "External");
  if (!isRecord(external)) return;
  const vlRef = child(external, "ValueListReference");
  const extId = attr(vlRef, "id");
  if (extId == null) return;
  const dsRef = child(external, "DataSourceReference");
  const dataSource = textAttr(dsRef, "name");
  fp.references.push({
    fromUid: ownerUid,
    toType: "valueList",
    toId: extId,
    toName: textAttr(vlRef, "name") ?? "",
    kind: "valueList",
    ...(dataSource ? { toFileName: dataSource } : { forceBroken: true }),
  });
  // The data source itself is a dependency too (it lists this value list among
  // its users). A nameless one was deleted.
  const dsId = attr(dsRef, "id");
  if (dsId == null) return;
  fp.references.push({
    fromUid: ownerUid,
    toType: "externalDataSource",
    toId: dsId,
    toName: dataSource || UNKNOWN_TARGET,
    kind: "externalDataSource",
    ...(dataSource ? {} : { forceBroken: true }),
  });
}

/**
 * A value list's full contents: a custom list carries its literal values in
 * <CustomValues><Text>; a "from field" list carries its field binding in <Field>.
 */
function valueListDetail(block: Record<string, unknown>, index: FileIndex): ObjectDetail {
  const source = attr(child(block, "Source"), "value") ?? "";
  const customNode = child(block, "CustomValues");
  const customText = isRecord(customNode) ? displayText(customNode["Text"]) : "";
  // FileMaker stores custom values CR-separated (the XML parser turns line
  // endings into "\n"); a blank line is a divider.
  const customValues = customText ? customText.replace(/\n+$/, "").split("\n") : [];
  return { kind: "valueList", source, customValues, field: fieldSource(block["Field"], index) };
}

/** The field binding of a "from field" value list. */
function fieldSource(node: unknown, index: FileIndex): ValueListFieldSource | undefined {
  const primary = child(node, "PrimaryField");
  if (!isRecord(node) || !isRecord(primary)) return undefined;

  // A <SecondaryField> is always in use: unchecking "Also display values from
  // second field" removes the element. Its `show` (the opposite of the primary
  // field's) records "Show values only from second field".
  const secondaryWrap = child(node, "SecondaryField");
  const secondaryField = isRecord(secondaryWrap) ? qualifiedField(secondaryWrap["FieldReference"], index) : undefined;
  const showOnlySecondary = isRecord(secondaryWrap) && attr(secondaryWrap, "show") === "True";

  const showRelated = child(node, "ShowRelated");
  const showRelatedFrom =
    isRecord(showRelated) && attr(showRelated, "value") === "True" ? textAttr(child(showRelated, "TableOccurrenceReference"), "name") : undefined;

  return {
    primaryField: qualifiedField(primary["FieldReference"], index),
    sort: attr(primary, "sort") === "True",
    ...(secondaryField ? { secondaryField } : {}),
    ...(showOnlySecondary ? { showOnlySecondary } : {}),
    ...(showRelatedFrom ? { showRelatedFrom } : {}),
  };
}
