/**
 * A file whose parse throws is reported and left out; the other files survive.
 */
import { describe, expect, it, vi } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";

vi.mock("@/core/parser/objects/scripts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/parser/objects/scripts")>();
  return {
    parseScripts: (...args: Parameters<typeof original.parseScripts>) => {
      if (args[0].file.name === "BAD") throw new Error("boom");
      original.parseScripts(...args);
    },
  };
});

vi.mock("@/core/parser/objects/deferredLayouts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/parser/objects/deferredLayouts")>();
  return {
    ...original,
    // Runs once the layout's objects and their references were added.
    addDeferredLayoutRefs: (...args: Parameters<typeof original.addDeferredLayoutRefs>) => {
      if (args[2].name === "BAD") throw new Error("boom");
      original.addDeferredLayoutRefs(...args);
    },
  };
});

function doc(name: string): { name: string; content: string } {
  return {
    name: `${name}.xml`,
    content: `<FMSaveAsXML File="${name}.fmp12"><Structure><AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog></AddAction></Structure><DDR_INFO></DDR_INFO></FMSaveAsXML>`,
  };
}

describe("a truncated file", () => {
  const full =
    `<?xml version="1.0" encoding="UTF-8"?><FMSaveAsXML File="CUT.fmp12"><Structure><AddAction>` +
    `<ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>` +
    `<LayoutCatalog><Layout id="1" name="L1"></Layout><Layout id="2" name="L2"></Layout></LayoutCatalog>` +
    `</AddAction></Structure><DDR_INFO><Script><ObjectList></ObjectList></Script></DDR_INFO></FMSaveAsXML>\n`;
  const cutAfter = (marker: string): string => full.slice(0, full.indexOf(marker) + marker.length);
  const incomplete = "CUT.xml: the file is incomplete — it ends before </FMSaveAsXML> (an interrupted export or copy), so it was left out. Export or copy it again.";

  it("is reported as incomplete and left out when the cut lands in its layouts", () => {
    // Read leniently, this cut would keep the script and silently lose every layout.
    const result = parseDocuments([{ name: "CUT.xml", content: cutAfter(`name="L1">`) }, doc("GOOD")]);
    expect(result.errors).toEqual([incomplete]);
    expect(result.files.map((f) => f.name)).toEqual(["GOOD"]);
  });

  it("is reported as incomplete when the cut lands in DDR_INFO", () => {
    const result = parseDocuments([{ name: "CUT.xml", content: cutAfter("<ObjectList>") }]);
    expect(result.errors).toEqual([incomplete]);
    expect(result.files).toEqual([]);
  });

  it("reads a complete file with whitespace after its closing tag", () => {
    const result = parseDocuments([{ name: "CUT.xml", content: full }]);
    expect(result.errors).toEqual([]);
    expect(result.objects.filter((o) => o.type === "layout").map((o) => o.name)).toEqual(["L1", "L2"]);
  });
});

describe("a layout that fails to parse", () => {
  const layout = (id: string, name: string): string =>
    `<Layout id="${id}" name="${name}"><PartsList><Part type="Body"><Definition absolute="0" size="100"></Definition><ObjectList>` +
    `<LayoutObject id="1" type="Button" name="b"><Button><action><Step id="1" name="Perform Script" enable="True"><ParameterValues><Parameter type="List"><List>` +
    `<ScriptReference id="1" name="S"></ScriptReference></List></Parameter></ParameterValues></Step></action></Button></LayoutObject>` +
    `</ObjectList></Part></PartsList></Layout>`;
  const content =
    `<FMSaveAsXML File="MAIN.fmp12"><Structure><AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>` +
    `<LayoutCatalog>${layout("1", "BAD")}${layout("2", "GOOD")}</LayoutCatalog></AddAction></Structure><DDR_INFO></DDR_INFO></FMSaveAsXML>`;

  it("is reported and left out with everything it added, and the rest of the file is kept", () => {
    const result = parseDocuments([{ name: "MAIN.xml", content }]);
    expect(result.errors).toEqual(["MAIN: layout “BAD” could not be read and was skipped — boom"]);
    expect(result.objects.filter((o) => o.type === "layout").map((o) => `${o.name} ${o.order}`)).toEqual(["GOOD 0"]);
    expect(result.objects.filter((o) => o.type === "layoutObject").map((o) => o.uid)).toEqual(["F0:layoutObject:2.1"]);
    expect(result.references.filter((r) => r.fromUid.includes(":layout")).map((r) => r.fromUid)).toEqual(["F0:layoutObject:2.1", "F0:layout:2"]);
    expect(result.objects.some((o) => o.type === "script")).toBe(true);
  });
});

describe("a file that fails to parse", () => {
  it("is reported and left out, and the other files are kept", () => {
    const result = parseDocuments([doc("BAD"), doc("GOOD")]);
    expect(result.errors).toEqual(["BAD.xml: parsing stopped and this file was left out — boom"]);
    expect(result.files.map((f) => f.name)).toEqual(["GOOD"]);
    expect(result.objects.filter((o) => o.type === "script").map((o) => `${o.fileName}:${o.name}`)).toEqual(["GOOD:S"]);
  });
});
