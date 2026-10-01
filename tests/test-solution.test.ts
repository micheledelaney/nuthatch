/**
 * The test-solution fixture: two FileMaker files built to tests/fixtures/
 * test-solution/BUILD.md, exported before ("intact") and after ("final") their
 * DEL_… objects were deleted. Each scenario parses the exports and compares the
 * result with the expected output in that folder (expected-intact.json /
 * expected.json), check by check.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildChecks, loadOracle, type AttributeOverrides } from "./support/checks";
import { loadSnapshot, type Snapshot } from "./support/snapshot";

const DIR = fileURLToPath(new URL("./fixtures/test-solution/", import.meta.url));

/** What FileMaker 21 legitimately exports differently from the expected output. */
const FM21: AttributeOverrides = {
  // Lowered from 22.0 so FileMaker 21 could open the file for this export.
  "MAIN:file:TEST_MAIN": { minimumVersion: "18.0" },
  // FileMaker 21 has no "Manage database" / "Manage custom menus" privileges.
  "MAIN:privilegeSet:PS_Other": {
    otherPrivileges:
      "Printing, Exporting, Manage accounts, Manage extended privileges, Override data validation, Allow Open Quickly, Disconnect idle users",
  },
};

/** Exports per FileMaker version, in "XML FM26/", "XML FM22/" and "XML FM21/". The
 * same build must give the same model whichever version exported it, apart from
 * the listed version differences. */
const SCENARIOS: { name: string; oracle: string; files: string[]; mainAlone: boolean; overrides?: AttributeOverrides }[] = [
  { name: "FM26 intact: TEST_MAIN + TEST_EXT", oracle: "expected-intact.json", files: ["XML FM26/TEST_MAIN__intact.xml", "XML FM26/TEST_EXT__intact.xml"], mainAlone: false },
  { name: "FM26 intact: TEST_MAIN alone", oracle: "expected-intact.json", files: ["XML FM26/TEST_MAIN__intact.xml"], mainAlone: true },
  { name: "FM26 final: TEST_MAIN + TEST_EXT", oracle: "expected.json", files: ["XML FM26/TEST_MAIN.xml", "XML FM26/TEST_EXT.xml"], mainAlone: false },
  { name: "FM26 final: TEST_MAIN alone", oracle: "expected.json", files: ["XML FM26/TEST_MAIN.xml"], mainAlone: true },
  { name: "FM22 final: TEST_MAIN + TEST_EXT", oracle: "expected.json", files: ["XML FM22/TEST_MAIN.xml", "XML FM22/TEST_EXT.xml"], mainAlone: false },
  { name: "FM22 final: TEST_MAIN alone", oracle: "expected.json", files: ["XML FM22/TEST_MAIN.xml"], mainAlone: true },
  { name: "FM21 final: TEST_MAIN + TEST_EXT", oracle: "expected.json", files: ["XML FM21/TEST_MAIN.xml", "XML FM21/TEST_EXT.xml"], mainAlone: false, overrides: FM21 },
  { name: "FM21 final: TEST_MAIN alone", oracle: "expected.json", files: ["XML FM21/TEST_MAIN.xml"], mainAlone: true, overrides: FM21 },
];

/** Checks that fail until a pinned item in BUILD.md ▸ To do is done. They run as
 * expected failures, so a fix makes them fail here — then remove the entry. */
const PINNED: Record<string, string> = {
  "attributes: EXT:file:TEST_EXT": "auto-login label (BUILD.md ▸ To do)",
};

for (const scenario of SCENARIOS) {
  const paths = scenario.files.map((f) => DIR + f);

  describe.skipIf(!paths.every((p) => existsSync(p)))(scenario.name, () => {
    const oracle = loadOracle(DIR + scenario.oracle, scenario.overrides);
    let snapshot: Snapshot | undefined;
    beforeAll(() => {
      snapshot = loadSnapshot(paths, new Set(oracle.ignoredTypes ?? []));
    });

    for (const check of buildChecks(oracle, () => snapshot!, scenario.mainAlone)) {
      const run = () => expect(check.failures()).toEqual([]);
      if (PINNED[check.name]) it.fails(`${check.name} — pinned: ${PINNED[check.name]}`, run);
      else it(check.name, run);
    }
  });
}
