/**
 * Checks on the test-solution fixture that its oracle (expected*.json) can't
 * express: the oracle compares each build with its own expected output, folds
 * a custom menu and its items together ("M_Custom/**"), and matches the
 * privilege-set field lists only partially.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { splitLayoutCatalog } from "@/core/parser/objects/layoutStream";
import { decodeFile } from "@/state/loadFiles";
import type { ParseResult, PrivilegeSetFieldAccess } from "@/types/ddr";

const DIR = fileURLToPath(new URL("./fixtures/test-solution/", import.meta.url));

/** A fixture export decoded the way the app does it (FM 22 exports are UTF-16). */
function read(file: string): string {
  const bytes = readFileSync(DIR + file);
  return decodeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

function parse(...files: string[]): ParseResult {
  return parseDocuments(files.map((f) => ({ name: basename(f), content: read(f) })));
}

describe("uids from the intact build to the final one", () => {
  it("stay the same for every object both builds have", () => {
    // Usage marks are stored by uid (without its file part), so an object must
    // keep its uid when other objects are deleted around it. An object is the
    // same one in both builds when its file, type, container and name are, and
    // no other object shares them.
    const byIdentity = (result: ParseResult): Map<string, string[]> => {
      const byUid = new Map(result.objects.map((o) => [o.uid, o]));
      const out = new Map<string, string[]>();
      for (const o of result.objects) {
        const key = `${o.fileName} ${o.type} ${byUid.get(o.parentUid ?? "")?.name ?? ""} ▸ ${o.name}`;
        out.set(key, [...(out.get(key) ?? []), o.uid.slice(o.uid.indexOf(":") + 1)]);
      }
      return out;
    };
    const intact = byIdentity(parse("XML FM26/TEST_MAIN__intact.xml", "XML FM26/TEST_EXT__intact.xml"));
    const final = byIdentity(parse("XML FM26/TEST_MAIN.xml", "XML FM26/TEST_EXT.xml"));
    const both = [...intact].filter(([key, uids]) => uids.length === 1 && final.get(key)?.length === 1);
    expect(both.length).toBeGreaterThan(250);
    expect(both.filter(([key, [uid]]) => final.get(key)![0] !== uid).map(([key, [uid]]) => `${key}: ${uid} → ${final.get(key)![0]}`)).toEqual([]);
  });
});

describe("the appended build's custom menu", () => {
  it("has no broken reference of its own; the items it holds have theirs", () => {
    const model = buildModel(parse("XML FM26/APPENDED TESTS/TEST_MAIN.xml", "XML FM26/APPENDED TESTS/TEST_EXT.xml"));
    const menu = model.objects.find((o) => o.type === "customMenu" && o.name === "M_Custom")!;
    const brokenFrom = (uids: Set<string>): string[] => [
      ...new Set(model.brokenReferences.filter((r) => uids.has(r.fromUid)).map((r) => model.byUid.get(r.fromUid)!.name)),
    ];
    expect(brokenFrom(new Set([menu.uid]))).toEqual([]);
    const items = new Set(model.objects.filter((o) => o.parentUid === menu.uid).map((o) => o.uid));
    expect(brokenFrom(items)).toEqual(["Deleted script item", "TO_Main::f_Text & TO_Child::<Field Missing>"]);
  });
});

describe("a layout catalog read in the parsed tree", () => {
  // A <ModifyAction> ahead of the catalog keeps it from being cut out and
  // streamed (findLayoutCatalogBounds), so the same export can be read both ways.
  const inTree = (xml: string): string => {
    const at = xml.indexOf("<LayoutCatalog", xml.indexOf("<Structure"));
    return `${xml.slice(0, at)}<ModifyAction></ModifyAction>${xml.slice(at)}`;
  };

  it.each([
    ["XML FM26/TEST_MAIN__intact.xml", "XML FM26/TEST_EXT__intact.xml"],
    ["XML FM26/TEST_MAIN.xml", "XML FM26/TEST_EXT.xml"],
    ["XML FM26/APPENDED TESTS/TEST_MAIN.xml", "XML FM26/APPENDED TESTS/TEST_EXT.xml"],
    ["XML FM22/TEST_MAIN.xml", "XML FM22/TEST_EXT.xml"],
    ["XML FM21/TEST_MAIN.xml", "XML FM21/TEST_EXT.xml"],
  ])("reads the same as the streamed one: %s", (...files) => {
    const streamed = files.map((f) => ({ name: basename(f), content: read(f) }));
    const tree = streamed.map((d) => ({ ...d, content: inTree(d.content) }));
    expect(tree.map((d) => splitLayoutCatalog(d.content).layoutCatalog)).toEqual(files.map(() => undefined));
    expect(streamed.every((d) => splitLayoutCatalog(d.content).layoutCatalog != null)).toBe(true);
    expect(parseDocuments(tree)).toEqual(parseDocuments(streamed));
  });
});

describe("file access entries", () => {
  it("say whether each is local or external, and whether it is the file itself", () => {
    const entries = parse("XML FM26/TEST_EXT.xml")
      .objects.filter((o) => o.type === "fileAccess")
      .map((o) => `${o.id}: ${o.attributes.accessType} ${o.attributes.selfAuthorized}`);
    expect(entries).toEqual(["1: Local Yes", "2: External Yes", "3: Local No", "4: External No"]);
  });
});

describe("privilege-set field access", () => {
  const mainFields = (file: string): PrivilegeSetFieldAccess[] => {
    const detail = parse(file).objects.find((o) => o.type === "privilegeSet" && o.name === "PS_CustomRecords")?.detail;
    if (detail?.kind !== "privilegeSet") throw new Error("no privilege-set detail");
    return detail.tables.find((t) => t.table === "T_Main")?.fields ?? [];
  };
  const sorted = (fields: PrivilegeSetFieldAccess[]): string[] => fields.map((f) => `${f.field}: ${f.access}`).sort();

  it("lists every field the same way whichever version exported it", () => {
    expect(sorted(mainFields("XML FM22/TEST_MAIN.xml"))).toEqual(sorted(mainFields("XML FM26/TEST_MAIN.xml")));
  });

  it("reads FM 21's grants on deleted fields as missing fields, not as the new-fields default", () => {
    // FM 21 keeps a grant on a deleted field, its name blank; FM 26 drops it.
    const fm21 = mainFields("XML FM21/TEST_MAIN.xml");
    expect(sorted(fm21.filter((f) => f.field !== "<Field Missing>"))).toEqual(sorted(mainFields("XML FM26/TEST_MAIN.xml")));
    expect(fm21.filter((f) => f.field === "<Field Missing>")).toHaveLength(2);
  });
});
