import type { FmObject, ObjectType } from "@/types/ddr";
import type { FileParse, TextScan } from "../context";
import { cdataText, isRecord } from "../xmlUtils";
import { collectCatalogItems } from "../catalogWalk";
import { occurrenceSource } from "../occurrences";
import { scanRefs } from "../refs/scanRefs";
import { makeObject } from "./catalogItems";
import { addCustomFunctionCalcRefs, annotateCustomFunction, customFunctionCalcs, customFunctionScanText } from "./customFunctions";
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
  annotate?: (item: Item, obj: FmObject) => FmObject;
  /** What to scan for the item's own references: the whole item unless given;
   * "none" when nothing in it is a dependency. */
  scan?: "none" | ((item: Item) => unknown);
  /** References recorded after the scan, from outside the item's own element
   * scan (a separately stored formula, the sets granting a privilege, …). */
  addRefs?: (item: Item, obj: FmObject) => void;
  /** The text the text-based passes read for the item, when it isn't the CDATA
   * of what `scan` reads (of the whole item, for "none"): a formula stored
   * apart from the item. */
  text?: (item: Item, obj: FmObject) => string;
  /** The XML `text` reads, when it reaches outside the item. */
  textSource?: (item: Item, obj: FmObject) => unknown;
  /** `annotate` sets the object's searchable text itself, so the item's full
   * text isn't built only to be replaced. */
  annotateSetsText?: true;
}

/** The catalogs, in the order their objects are emitted. Missing catalogs are
 * skipped. A table, not logic: one entry per catalog. */
function catalogSpecs(fp: FileParse, containerNode: Record<string, unknown>): CatalogSpec[] {
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
    { catalogKey: "AccountsCatalog", itemTag: "Account", type: "account", annotate: annotateAccount, annotateSetsText: true },
    {
      catalogKey: "TableOccurrenceCatalog",
      itemTag: "TableOccurrence",
      type: "tableOccurrence",
      // Every occurrence with an id is in the file index, which already read its source.
      annotate: (item, obj) => annotateTableOccurrence(item, obj, fp.index.toById.get(obj.id) ?? occurrenceSource(item, fp.index.dataSourceIds)),
    },
    {
      catalogKey: "RelationshipCatalog",
      itemTag: "Relationship",
      type: "relationship",
      annotate: (item, obj) => annotateRelationship(item, obj, fp.index),
    },
    {
      catalogKey: "ValueListCatalog",
      itemTag: "ValueList",
      type: "valueList",
      annotate: (item, obj) => annotateValueList(item, obj, valueLists, fp.index),
      // Only the in-effect parts of its contents are dependencies (addValueListRefs).
      scan: "none",
      addRefs: (item, obj) => addValueListRefs(fp, item, obj, valueLists),
    },
    {
      catalogKey: "CustomFunctionsCatalog",
      itemTag: "CustomFunction",
      type: "customFunction",
      annotate: (item, obj) => annotateCustomFunction(item, obj, cfCalcs),
      addRefs: (_item, obj) => addCustomFunctionCalcRefs(fp, obj, cfCalcs),
      text: (item, obj) => customFunctionScanText(item, obj, cfCalcs),
      textSource: (item, obj) => [item, cfCalcs.get(obj.id)],
    },
    {
      catalogKey: "ExtendedPrivilegesCatalog",
      itemTag: "ExtendedPrivilege",
      type: "extendedPrivilege",
      annotate: annotateExtendedPrivilege,
      scan: "none",
      addRefs: (item, obj) => addExtendedPrivilegeGrants(fp, item, obj),
    },
    {
      catalogKey: "FileAccessCatalog",
      itemTag: "Authorization",
      type: "fileAccess",
      annotate: annotateFileAccess,
      scan: "none",
      annotateSetsText: true,
    },
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
      // its install condition is the menu's own calc — for the text passes too,
      // or a placeholder in an item's calc would flag the menu as well.
      scan: (item) => item["Conditions"],
    },
    { catalogKey: "ThemeCatalog", itemTag: "Theme", type: "theme", annotate: annotateTheme, scan: "none", annotateSetsText: true },
  ];
}

/** Every object of the catalogs in catalogSpecs, with its references. */
export function parseCatalogs(fp: FileParse, containerNode: Record<string, unknown>, scans: TextScan[]): void {
  for (const spec of catalogSpecs(fp, containerNode)) {
    for (const item of collectCatalogItems(containerNode[spec.catalogKey], spec.itemTag)) {
      const base = makeObject(fp, item, spec.type, undefined, undefined, spec.annotateSetsText ? "" : undefined);
      if (!base || !isRecord(item)) continue;
      const obj = spec.annotate ? spec.annotate(item, base) : base;
      fp.objects.push(obj);
      // The text passes read what the element scan reads, so a placeholder
      // in a part the scan leaves out flags nothing.
      const scanned = typeof spec.scan === "function" ? spec.scan(item) : item;
      scans.push({ obj, text: spec.text ? spec.text(item, obj) : cdataText(scanned), source: spec.textSource ? spec.textSource(item, obj) : item });
      if (spec.scan !== "none") scanRefs(fp, scanned, obj);
      spec.addRefs?.(item, obj);
    }
  }
}
