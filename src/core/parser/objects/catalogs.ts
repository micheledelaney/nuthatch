import type { FmObject, ObjectType } from "@/types/ddr";
import type { FileParse } from "../context";
import { isRecord } from "../xmlUtils";
import { scanRefs } from "../refs/scanRefs";
import { collectCatalogItems, makeObject } from "./catalogItems";
import { addCustomFunctionCalcRefs, annotateCustomFunction, customFunctionCalcs } from "./customFunctions";
import { annotateExternalDataSource } from "./dataSources";
import { annotateCustomMenu, annotateCustomMenuSet } from "./menus";
import { annotateRelationship } from "./relationships";
import {
  addExtendedPrivilegeGrants,
  annotateAccount,
  annotateExtendedPrivilege,
  annotateFileAccess,
  annotatePrivilegeSet,
  recordAccessCalcs,
} from "./security";
import { annotateTableOccurrence } from "./tableOccurrences";
import { annotateTheme } from "./themes";
import { addValueListRefs, annotateValueList, valueListContents } from "./valueLists";

type Item = Record<string, unknown>;

/** A catalog whose items map directly to objects. */
interface CatalogSpec {
  catalogKey: string;
  itemTag: string;
  type: ObjectType;
  /** The object with its type-specific attributes and detail. */
  annotate?: (item: Item, obj: FmObject, fp: FileParse) => FmObject;
  /** What to scan for the item's own references: the whole item unless given;
   * "none" when nothing in it is a dependency. */
  scan?: "none" | ((item: Item) => unknown);
  /** References recorded after the scan, from outside the item's own element
   * scan (a separately stored formula, the sets granting a privilege, …). */
  addRefs?: (item: Item, obj: FmObject, fp: FileParse) => void;
}

/** The catalogs, in the order their objects are emitted. Missing catalogs are
 * skipped. */
function catalogSpecs(containerNode: Record<string, unknown>): CatalogSpec[] {
  const valueLists = valueListContents(containerNode);
  const cfCalcs = customFunctionCalcs(containerNode);
  return [
    {
      catalogKey: "PrivilegeSetsCatalog",
      itemTag: "PrivilegeSet",
      type: "privilegeSet",
      annotate: annotatePrivilegeSet,
      // A privilege set's per-object grants aren't dependencies, but the formulas
      // behind its "Limited" record access are: they call fields and functions.
      scan: recordAccessCalcs,
    },
    { catalogKey: "AccountsCatalog", itemTag: "Account", type: "account", annotate: annotateAccount },
    { catalogKey: "TableOccurrenceCatalog", itemTag: "TableOccurrence", type: "tableOccurrence", annotate: annotateTableOccurrence },
    { catalogKey: "RelationshipCatalog", itemTag: "Relationship", type: "relationship", annotate: annotateRelationship },
    {
      catalogKey: "ValueListCatalog",
      itemTag: "ValueList",
      type: "valueList",
      annotate: (item, obj) => annotateValueList(item, obj, valueLists),
      // Only the in-effect parts of its contents are dependencies (addValueListRefs).
      scan: "none",
      addRefs: (item, obj, fp) => addValueListRefs(fp, item, obj, valueLists),
    },
    {
      catalogKey: "CustomFunctionsCatalog",
      itemTag: "CustomFunction",
      type: "customFunction",
      annotate: (item, obj) => annotateCustomFunction(item, obj, cfCalcs),
      addRefs: (_item, obj, fp) => addCustomFunctionCalcRefs(fp, obj, cfCalcs),
    },
    {
      catalogKey: "ExtendedPrivilegesCatalog",
      itemTag: "ExtendedPrivilege",
      type: "extendedPrivilege",
      annotate: annotateExtendedPrivilege,
      scan: "none",
      addRefs: addExtendedPrivilegeGrants,
    },
    { catalogKey: "FileAccessCatalog", itemTag: "Authorization", type: "fileAccess", annotate: annotateFileAccess, scan: "none" },
    {
      catalogKey: "ExternalDataSourceCatalog",
      itemTag: "ExternalDataSource",
      type: "externalDataSource",
      annotate: annotateExternalDataSource,
      scan: "none",
    },
    { catalogKey: "CustomMenuSetCatalog", itemTag: "CustomMenuSet", type: "customMenuSet", annotate: annotateCustomMenuSet },
    {
      catalogKey: "CustomMenuCatalog",
      itemTag: "CustomMenu",
      type: "customMenu",
      annotate: annotateCustomMenu,
      // A custom menu's items are scanned on their own (parseCustomMenuItems);
      // its install condition is the menu's own calc.
      scan: (item) => item["Conditions"],
    },
    { catalogKey: "ThemeCatalog", itemTag: "Theme", type: "theme", annotate: annotateTheme, scan: "none" },
  ];
}

/** Every object of the catalogs in catalogSpecs, with its references. */
export function parseCatalogs(containerNode: Record<string, unknown>, fp: FileParse): void {
  for (const spec of catalogSpecs(containerNode)) {
    for (const item of collectCatalogItems(containerNode[spec.catalogKey], spec.itemTag)) {
      const base = makeObject(item, spec.type, fp);
      if (!base || !isRecord(item)) continue;
      const obj = spec.annotate ? spec.annotate(item, base, fp) : base;
      fp.objects.push(obj);
      if (spec.scan !== "none") scanRefs(fp, spec.scan ? spec.scan(item) : item, obj);
      spec.addRefs?.(item, obj, fp);
    }
  }
}
