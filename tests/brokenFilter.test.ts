/**
 * The navigator's Broken filter must be offered for every type that can hold a
 * broken reference, so a type whose rail tile shows the broken dot can also be
 * filtered to its broken objects.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { brokenSources } from "@/core/analysis/dependencies";
import { decodeFile } from "@/state/loadFiles";
import { BROKEN_ELIGIBLE } from "@/components/browseA/filters";

const DIR = fileURLToPath(new URL("./fixtures/test-solution/", import.meta.url));

function read(file: string): string {
  const bytes = readFileSync(DIR + file);
  return decodeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe("Broken filter eligibility", () => {
  it.each([
    ["FM26", ["XML FM26/TEST_MAIN.xml", "XML FM26/TEST_EXT.xml"]],
    ["FM26 appended", ["XML FM26/APPENDED TESTS/TEST_MAIN.xml", "XML FM26/APPENDED TESTS/TEST_EXT.xml"]],
  ])("covers every type with a broken source (%s)", (_label, files) => {
    const model = buildModel(parseDocuments(files.map((f) => ({ name: basename(f), content: read(f) }))));
    const types = new Set([...brokenSources(model)].map((uid) => model.byUid.get(uid)?.type));
    expect(types.size).toBeGreaterThan(0);
    const missing = [...types].filter((t) => !t || !BROKEN_ELIGIBLE.has(t));
    expect(missing).toEqual([]);
  });
});
