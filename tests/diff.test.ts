import { describe, expect, it } from "vitest";
import { diffAnalyses, lineDiff } from "@/core/analysis/diff";
import type { FmObject, LayoutPart, LayoutTriggerInfo, ObjectDetail, ParseResult, SortField } from "@/types/ddr";

/** Object 1 of the given type in file F0 ("MAIN"), or the file object itself. */
function object(type: FmObject["type"], detail: ObjectDetail, extra: Partial<FmObject> = {}): FmObject {
  const id = type === "file" ? "F0" : "1";
  return { uid: `F0:${type}:${id}`, type, id, name: "X", fileUid: "F0", fileName: "MAIN", attributes: {}, text: "", detail, ...extra };
}

/** The uids the comparison reports as changed between two versions of one object. */
function changed(before: FmObject, after: FmObject): string[] {
  const solution = (obj: FmObject): ParseResult => ({ files: [{ uid: "F0", name: "MAIN", source: "MAIN.xml" }], objects: [obj], references: [], errors: [] });
  return diffAnalyses(solution(before), solution(after), 0, 0).changed.map((c) => c.uid);
}

const trigger = (modes: string[], parameterFieldName?: string): LayoutTriggerInfo => ({
  action: "OnObjectEnter",
  scriptName: "S",
  modes,
  ...(parameterFieldName ? { parameterFieldName } : {}),
});
const sorted = (field: string): SortField[] => [{ field, order: "Ascending" }];
const script: ObjectDetail = { kind: "script", steps: [] };
const layout = (parts: LayoutPart[]): ObjectDetail => ({ kind: "layout", width: 100, height: 100, triggers: [], parts, offLayout: [] });
const part = (type: string, top: number, height: number): LayoutPart => ({ type, top, height, objects: [] });
const relationship = (sortFields: SortField[]): ObjectDetail => ({
  kind: "relationship",
  leftTable: "A",
  rightTable: "B",
  predicates: [],
  right: { cascadeCreate: false, cascadeDelete: false, sorted: true, sortFields },
});

describe("what a comparison sees", () => {
  it("a file trigger added", () => {
    expect(changed(object("file", { kind: "file", triggers: [] }), object("file", { kind: "file", triggers: [trigger(["Browse"])] }))).toEqual(["F0:file:F0"]);
  });

  it("a script moved to another folder, but not within its folder", () => {
    expect(changed(object("script", script, { folder: "A" }), object("script", script, { folder: "B" }))).toEqual(["F0:script:1"]);
    expect(changed(object("script", script, { order: 1 }), object("script", script, { order: 2 }))).toEqual([]);
  });

  it("a file access entry's access type and self-authorization", () => {
    const entry = (accessType: string, selfAuthorized: string) =>
      object("fileAccess", script, { detail: undefined, attributes: { accessType, selfAuthorized } });
    expect(changed(entry("Local", "Yes"), entry("External", "Yes"))).toEqual(["F0:fileAccess:1"]);
    expect(changed(entry("Local", "Yes"), entry("Local", "No"))).toEqual(["F0:fileAccess:1"]);
  });

  it("a relationship side's sort order", () => {
    expect(changed(object("relationship", relationship(sorted("B::a"))), object("relationship", relationship(sorted("B::b"))))).toEqual(["F0:relationship:1"]);
  });

  it("a portal's sort order", () => {
    const portal = (portalSort: SortField[]): ObjectDetail => ({ kind: "layoutObject", loType: "Portal", portalTable: "B", portalSort });
    expect(changed(object("layoutObject", portal(sorted("B::a"))), object("layoutObject", portal(sorted("B::b"))))).toEqual(["F0:layoutObject:1"]);
  });

  it("a field object's value list", () => {
    const field = (name: string): ObjectDetail => ({ kind: "layoutObject", loType: "Field", valueListRef: { id: "1", name } });
    expect(changed(object("layoutObject", field("A")), object("layoutObject", field("B")))).toEqual(["F0:layoutObject:1"]);
  });

  it("an object trigger's modes and field parameter", () => {
    const field = (t: LayoutTriggerInfo): ObjectDetail => ({ kind: "layoutObject", loType: "Field", triggers: [t] });
    expect(changed(object("layoutObject", field(trigger(["Browse"]))), object("layoutObject", field(trigger(["Browse", "Find"]))))).toEqual(["F0:layoutObject:1"]);
    expect(changed(object("layoutObject", field(trigger(["Browse"]))), object("layoutObject", field(trigger(["Browse"], "T::a"))))).toEqual(["F0:layoutObject:1"]);
  });

  it("a layout part added or resized", () => {
    const body = layout([part("Body", 0, 100)]);
    expect(changed(object("layout", body), object("layout", layout([part("Header", 0, 40), part("Body", 40, 60)])))).toEqual(["F0:layout:1"]);
    expect(changed(object("layout", body), object("layout", layout([part("Body", 0, 120)])))).toEqual(["F0:layout:1"]);
  });

  it("each layout object setting once", () => {
    // As the parser writes it: these settings both as attributes and in the detail.
    const button = (tooltip: string): FmObject =>
      object(
        "layoutObject",
        { kind: "layoutObject", loType: "Button", info: `"Go"`, tooltip, conditionalFormats: ["T::a > 1"], conditionalFormatStyles: ["color: red"] },
        { attributes: { loType: "Button", label: "Go", tooltip, conditionalFormats: "T::a > 1" } },
      );
    const solution = (obj: FmObject): ParseResult => ({ files: [{ uid: "F0", name: "MAIN", source: "MAIN.xml" }], objects: [obj], references: [], errors: [] });
    const [change] = diffAnalyses(solution(button("Old")), solution(button("New")), 0, 0).changed;
    expect(lineDiff(change!.before!, change!.after!).filter((l) => l.kind !== "context")).toEqual([
      { kind: "removed", text: "tooltip: Old" },
      { kind: "added", text: "tooltip: New" },
    ]);
    expect(change!.after!.split("\n").filter((l) => l.includes("T::a > 1"))).toEqual(["conditional format: T::a > 1"]);
    expect(change!.after!.split("\n").filter((l) => l.includes("Go"))).toEqual([`info: "Go"`]);
  });
});
