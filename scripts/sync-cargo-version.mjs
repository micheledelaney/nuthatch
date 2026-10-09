// Copies the version in package.json into src-tauri/Cargo.toml and Cargo.lock.
// npm runs it during `npm version <x.y.z>` (the "version" script), before the
// release commit, so all three files carry the same number. tauri.conf.json
// reads its version from package.json itself.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARGO_TOML = join(ROOT, "src-tauri", "Cargo.toml");
const CARGO_LOCK = join(ROOT, "src-tauri", "Cargo.lock");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Replaces the first match of `pattern` in `file`, or stops the release. */
function replaceIn(file, pattern, replacement) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`No package version found in ${file}`);
  writeFileSync(file, text.replace(pattern, replacement));
}

// The first version line in Cargo.toml is the [package] one.
replaceIn(CARGO_TOML, /^version = ".*"$/m, `version = "${version}"`);
replaceIn(CARGO_LOCK, /^(name = "nuthatch"\nversion = )".*"$/m, `$1"${version}"`);
console.log(`Cargo.toml and Cargo.lock set to ${version}`);
