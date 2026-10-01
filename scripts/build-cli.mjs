// Build the standalone `nuthatch` command-line executable:
//   1. bundle src/cli/main.ts (and the shared src/core parser) into one CommonJS file;
//   2. compile it into a Node single executable application (no Node needed to run it),
//      based on the official Node binary for the running version — package-manager
//      builds (e.g. Homebrew's) lack the SEA fuse and can't be used as the base;
//   3. on macOS, ad-hoc sign it — injecting the bundle invalidates Node's signature.
// Output: dist-cli/nuthatch
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const OUT_DIR = "dist-cli";
const BUNDLE = `${OUT_DIR}/nuthatch.cjs`;
const EXECUTABLE = `${OUT_DIR}/nuthatch`;
const SEA_CONFIG = `${OUT_DIR}/sea-config.json`;
const NODE_CACHE_DIR = "node_modules/.cache/nuthatch-cli";
// Large DDR exports (hundreds of MB) outgrow Node's default ~4 GB heap.
const MAX_HEAP_MB = 8192;

/** Download (once) and verify the official Node binary matching this Node's version. */
async function officialNode() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Building the CLI on ${process.platform} is not supported yet.`);
  }
  const dist = `node-${process.version}-${process.platform}-${process.arch}`;
  const binary = `${NODE_CACHE_DIR}/${dist}/node`;
  if (existsSync(binary)) return binary;

  const baseUrl = `https://nodejs.org/dist/${process.version}`;
  const archive = `${dist}.tar.gz`;
  console.log(`Downloading ${baseUrl}/${archive}`);
  const [tarball, sums] = await Promise.all([fetchOk(`${baseUrl}/${archive}`), fetchOk(`${baseUrl}/SHASUMS256.txt`)]);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  const expected = (await sums.text()).split("\n").find((line) => line.endsWith(`  ${archive}`))?.split("  ")[0];
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${archive}`);

  mkdirSync(`${NODE_CACHE_DIR}/${dist}`, { recursive: true });
  const archivePath = `${NODE_CACHE_DIR}/${archive}`;
  writeFileSync(archivePath, bytes);
  execFileSync("tar", ["-xzf", archivePath, "-C", `${NODE_CACHE_DIR}/${dist}`, "--strip-components=2", `${dist}/bin/node`]);
  return binary;
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response;
}

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: BUNDLE,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  logLevel: "warning",
});

writeFileSync(
  SEA_CONFIG,
  JSON.stringify({
    main: BUNDLE,
    output: EXECUTABLE,
    executable: await officialNode(),
    disableExperimentalSEAWarning: true,
    execArgv: [`--max-old-space-size=${MAX_HEAP_MB}`],
  }),
);
execFileSync(process.execPath, ["--build-sea", SEA_CONFIG], { stdio: "inherit" });

if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", "--force", EXECUTABLE], { stdio: "inherit" });
}

console.log(`Built ${EXECUTABLE}`);
