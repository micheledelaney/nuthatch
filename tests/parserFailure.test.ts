/**
 * A file whose parse throws is reported and left out; the other files survive.
 */
import { describe, expect, it, vi } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import type { FileParse } from "@/core/parser/context";

vi.mock("@/core/parser/objects/scripts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/core/parser/objects/scripts")>();
  return {
    parseScripts: (containerNode: Record<string, unknown>, fp: FileParse) => {
      if (fp.file.name === "BAD") throw new Error("boom");
      original.parseScripts(containerNode, fp);
    },
  };
});

function doc(name: string): { name: string; content: string } {
  return {
    name: `${name}.xml`,
    content: `<FMSaveAsXML File="${name}.fmp12"><Structure><AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog></AddAction></Structure><DDR_INFO></DDR_INFO></FMSaveAsXML>`,
  };
}

describe("a file that fails to parse", () => {
  it("is reported and left out, and the other files are kept", () => {
    const result = parseDocuments([doc("BAD"), doc("GOOD")]);
    expect(result.errors).toEqual(["BAD.xml: parsing stopped and this file was left out — boom"]);
    expect(result.files.map((f) => f.name)).toEqual(["GOOD"]);
    expect(result.objects.filter((o) => o.type === "script").map((o) => `${o.fileName}:${o.name}`)).toEqual(["GOOD:S"]);
  });
});
