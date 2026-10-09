/**
 * What the app shows for the model's references, on the test solution (the
 * appended FM 26 build) and on small hand-built models for what it lacks: the
 * model's own resolution — never an id looked up in the wrong file — and rows
 * that say how, where and whether an object is used.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { decodeFile } from "@/state/loadFiles";
import { refLabel, refStatus } from "@/core/model/refStatus";
import { buildDependencyView, type DependencyEdge } from "@/core/analysis/dependencies";
import { buildCallChain } from "@/core/analysis/callChain";
import { buildRelationshipGraph } from "@/core/analysis/relationshipGraph";
import { buildAiExport } from "@/core/export/aiExport";
import { applyNavFilters, chipGroupsFor, NO_FILTERS } from "@/components/browseA/filters";
import { GlanceSection } from "@/components/browseA/Glance";
import { GroupedRefList } from "@/components/ObjectColumn";
import type { FmObject, ObjectType, ParseResult, RawReference, SolutionModel } from "@/types/ddr";

const DIR = fileURLToPath(new URL("./fixtures/test-solution/XML FM26/APPENDED TESTS/", import.meta.url));

function read(name: string): string {
  const bytes = readFileSync(DIR + name);
  return decodeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

const MAIN = read("TEST_MAIN.xml");
const EXT = read("TEST_EXT.xml");
const parsed = parseDocuments([
  { name: "TEST_MAIN.xml", content: MAIN },
  { name: "TEST_EXT.xml", content: EXT },
]);
const model = buildModel(parsed);

function find(m: SolutionModel, type: ObjectType, name: string, file = "TEST_MAIN"): FmObject {
  const found = m.objects.find((o) => o.type === type && o.name === name && o.fileName === file);
  if (!found) throw new Error(`no ${type} ${name} in ${file}`);
  return found;
}

/** The text a reader sees: the markup without tags, HTML-unescaped once. */
function visibleText(node: ReactElement): string {
  const html: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
  return renderToStaticMarkup(node)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => html[e]!)
    .replace(/\s+/g, " ")
    .trim();
}

/** Each row of a reference list as a reader sees it, after its type pill. */
function rows(edges: DependencyEdge[], side: "from" | "to", m: SolutionModel = model): string[] {
  const html = renderToStaticMarkup(<GroupedRefList edges={edges} side={side} onGo={() => {}} byUid={m.byUid} previewLimit={1000} />);
  return html
    .split("<li")
    .slice(1)
    .map((li) => li.slice(li.indexOf(">") + 1, li.indexOf("</li>")).replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
    .map((text) => text.replace(/\s+/g, " ").trim().replace(/^\S+ /, ""));
}

const glance = (obj: FmObject, m: SolutionModel = model) => visibleText(<GlanceSection obj={obj} model={m} onGo={() => {}} />);

function obj(type: ObjectType, uid: string, name: string, extra: Partial<FmObject> = {}): FmObject {
  const [fileUid, , id] = uid.split(":") as [string, string, string];
  return { uid, type, id, name, fileUid, fileName: fileUid === "F0" ? "MAIN" : "EXT", attributes: {}, text: "", ...extra };
}

describe("an external occurrence's base table", () => {
  it("is the table in its data source's file, at a glance", () => {
    // E_Table is table 129 in TEST_EXT; T_Main is table 129 in TEST_MAIN.
    const text = glance(find(model, "tableOccurrence", "TO_Ext"));
    expect(text).toContain("E_Table");
    expect(text).not.toContain("T_Main");
  });

  it("isn't counted among the occurrences of the local table with the same id", () => {
    expect(/Occurrences (\d+)/.exec(glance(find(model, "table", "T_Main")))?.[1]).toBe("2");
    expect(/Occurrences (\d+)/.exec(glance(find(model, "table", "E_Table", "TEST_EXT")))?.[1]).toBe("2");
  });

  it("gives its graph box the key fields of that table", () => {
    // Suppose E_Table had a key named like a T_Main field, joined in R3 as well:
    // the box still lists both keys, from E_Table.
    const eField = find(model, "field", "e_Field", "TEST_EXT");
    const r3 = model.objects.find((o) => o.detail?.kind === "relationship" && o.detail.rightTable === "TO_Ext")!;
    const detail = r3.detail;
    if (detail?.kind !== "relationship") throw new Error("R3 has no detail");
    const predicates = [...detail.predicates, { leftField: "f_Text", operator: "=", rightField: "f_Text" }];
    const objects = model.objects.map((o) =>
      o.uid === eField.uid ? { ...o, name: "f_Text" } : o.uid === r3.uid ? { ...r3, detail: { ...detail, predicates } } : o,
    );
    const box = buildRelationshipGraph({ ...model, objects })
      .flatMap((g) => g.nodes)
      .find((n) => n.name === "TO_Ext");
    expect(box?.fields).toEqual(["e_ID", "f_Text"]);
  });
});

describe("the relationship graph", () => {
  it("marks the occurrences whose base table is gone", () => {
    const nodes = buildRelationshipGraph(model).flatMap((g) => g.nodes);
    const broken = nodes.filter((n) => n.broken).map((n) => n.name);
    expect(broken.sort()).toEqual(["TO_Broken", "TO_DelDS"]);
  });
});

describe("Used by rows", () => {
  it("name a referencing field by its own table, not by the occurrence it reads through", () => {
    const shown = rows(buildDependencyView(model, find(model, "field", "g_Val").uid)!.inbound, "from");
    expect(shown.some((r) => r.includes("T_Main::c_Deep"))).toBe(true);
    expect(shown.some((r) => r.includes("TO_Grand::c_Deep"))).toBe(false);
  });

  it("say when a row comes only from a disabled step", () => {
    const disabled = buildDependencyView(model, find(model, "script", "S_OnlyDisabled").uid)!.inbound;
    expect(disabled.map((e) => e.disabled)).toEqual([true]);
    expect(rows(disabled, "from")).toEqual(["S_Main Disabled"]);
    // Any other row stays unmarked, a recursive function's call of itself too.
    const recursive = buildDependencyView(model, find(model, "customFunction", "CF_Recursive").uid)!.inbound;
    expect(rows(recursive, "from")).toEqual(["CF_Recursive"]);
    expect(buildDependencyView(model, find(model, "script", "S_Sub").uid)!.inbound.every((e) => !e.disabled)).toBe(true);
  });
});

describe("References rows", () => {
  it("read a deleted occurrence in a formula as FileMaker writes it", () => {
    const ref = model.outbound.get(find(model, "field", "c_DelTO").uid)!.find((r) => r.broken)!;
    expect(refLabel(ref, model.byUid)).toBe("<Table Missing>::<Field Missing>");
  });
});

describe("the call tree", () => {
  it("marks a call in a disabled step", () => {
    const calls = buildCallChain(model, find(model, "script", "S_Main").uid)!.children;
    const call = (name: string) => calls.filter((c) => c.name === name).map((c) => c.disabled);
    expect(call("S_OnlyDisabled")).toEqual([true]);
    expect(call("S_Sub")).toEqual([false, false]);
  });
});

describe("a field name read from calculation text", () => {
  // TEST_EXT exported after e_Field was renamed: c_Ext reads it by id, c_Fallback
  // (empty chunk list) only by the name in its text.
  const renamed = buildModel(
    parseDocuments([
      { name: "TEST_MAIN.xml", content: MAIN },
      { name: "TEST_EXT.xml", content: EXT.replaceAll('name="e_Field"', 'name="e_Renamed"') },
    ]),
  );
  const throughExt = (field: string) =>
    renamed.outbound.get(find(renamed, "field", field).uid)!.find((r) => r.toType === "field" && r.viaUid?.endsWith(":1065094"))!;

  it("is unmatched, not in an unloaded file, when its loaded file has no such field", () => {
    expect(refStatus(throughExt("c_Ext"), renamed.byUid)).toBe("ok");
    expect(refStatus(throughExt("c_Fallback"), renamed.byUid)).toBe("unmatched");
    const shown = rows(buildDependencyView(renamed, find(renamed, "field", "c_Fallback").uid)!.outbound, "to", renamed);
    expect(shown).toContain("TO_Ext::e_Field Unmatched");
  });

  it("is still unmatched in the AI export, and external when its file isn't loaded", () => {
    const tsv = buildAiExport(renamed, { analysisName: "a", projectName: "p", savedAt: 0, exportedAt: 0 }).find((f) => f.name === "refs.tsv")!;
    const row = tsv.content.split("\n").find((l) => l.includes("\tc_Fallback\t") && l.includes("\te_Field\t"))!;
    expect(row.split("\t")[5]).toBe("unmatched");
    const alone = buildModel(parseDocuments([{ name: "TEST_MAIN.xml", content: MAIN }]));
    const ref = alone.outbound.get(find(alone, "field", "c_Fallback").uid)!.find((r) => r.toType === "field" && r.toName === "e_Field")!;
    expect(refStatus(ref, alone.byUid)).toBe("external");
  });
});

describe("buildModel", () => {
  it("leaves the parse result as it was", () => {
    expect(parsed.objects.find((o) => o.name === "c_Deep")?.relationshipDepth).toBeUndefined();
    expect(find(model, "field", "c_Deep").relationshipDepth).toBe(2);
  });
});

describe("a button that runs a script in another file", () => {
  // Script 1 exists in both files: the button runs EXT's.
  const result: ParseResult = {
    files: [
      { uid: "F0", name: "MAIN", source: "MAIN.xml" },
      { uid: "F1", name: "EXT", source: "EXT.xml" },
    ],
    objects: [
      obj("script", "F0:script:1", "S_Local"),
      obj("script", "F1:script:1", "S_Remote"),
      obj("externalDataSource", "F0:externalDataSource:1", "DS", { attributes: { path: "file:EXT" } }),
      obj("layout", "F0:layout:1", "L"),
      obj("layoutObject", "F0:layoutObject:1.1", "Button", {
        parentUid: "F0:layout:1",
        attributes: { loType: "Button" },
        detail: { kind: "layoutObject", loType: "Button", scriptRef: { id: "1", name: "S_Remote" } },
      }),
    ],
    references: [{ fromUid: "F0:layoutObject:1.1", toType: "script", toId: "1", toName: "S_Remote", kind: "script", toFileName: "DS" }],
    errors: [],
  };
  const buttonModel = buildModel(result);

  it("is bound to that file's script, at a glance", () => {
    const text = glance(buttonModel.byUid.get("F0:layoutObject:1.1")!, buttonModel);
    expect(text).toContain("S_Remote");
    expect(text).not.toContain("S_Local");
  });
});

describe("the Broken filter", () => {
  // A privilege set's record-access calc and a custom menu's install condition
  // that name a deleted field.
  const deleted = (fromUid: string): RawReference => ({
    fromUid,
    toType: "field",
    toId: "<missing>",
    toName: "<Field Missing>",
    kind: "field",
    forceBroken: true,
  });
  const objects = [
    obj("privilegeSet", "F0:privilegeSet:4", "PS_Broken"),
    obj("privilegeSet", "F0:privilegeSet:5", "PS_Fine"),
    obj("customMenu", "F0:customMenu:30", "M_Broken"),
    obj("customMenu", "F0:customMenu:31", "M_Fine"),
  ];
  const m = buildModel({
    files: [{ uid: "F0", name: "MAIN", source: "MAIN.xml" }],
    objects,
    references: [deleted("F0:privilegeSet:4"), deleted("F0:customMenu:30")],
    errors: [],
  });

  it("finds privilege sets and custom menus with broken references", () => {
    for (const type of ["privilegeSet", "customMenu"] as const) {
      const listed = applyNavFilters(m, m.objects.filter((o) => o.type === type), type, { ...NO_FILTERS, ref: "broken" });
      expect(listed.map((o) => o.name)).toEqual([type === "privilegeSet" ? "PS_Broken" : "M_Broken"]);
      expect(chipGroupsFor(m, type).find((g) => g.key === "ref")?.options.map((o) => o.value)).toContain("broken");
    }
  });
});
