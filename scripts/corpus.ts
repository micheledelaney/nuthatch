/**
 * Before/after check for parser changes, over the sample exports in files/
 * (gitignored) and the test-solution fixtures. Build it once per side, so each
 * bundle keeps the parser as it was when it was built:
 *
 *   npx esbuild scripts/corpus.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=<dir>/corpus.mjs
 *   node <dir>/corpus.mjs dump <outDir> [group…]       each group in a fresh process
 *   node <dir>/corpus.mjs compare <beforeDir> <afterDir>
 *
 * A dump holds, per group, every object and reference in emission order
 * (JSONL), and a summary: an order-sensitive hash of the whole parse result,
 * counts, parse errors, the report card, parse time, peak RSS during the parse,
 * and the heap the result retains once the source strings are dropped — next
 * to the heap the same result needs with every string copied fresh. The two
 * differ when model strings still share storage with (and so keep alive) the
 * decoded files.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import type { ParseResult } from "@/types/ddr";

const FIXTURES = "tests/fixtures/test-solution";
const MISMATCHES = "files/XML Mismatches";

/** Files loaded together, as the app would load them. */
const GROUPS: Record<string, () => string[]> = {
  "solution-final": () => ["files/SOLUTION final.xml"],
  solution: () => ["files/SOLUTION.xml"],
  SampleA: () => ["files/SampleA.xml", "files/SampleA Local File.xml"],
  "sample-a-prod": () => ["files/SAMPLE-A PROD/SampleA.xml", "files/SAMPLE-A PROD/SampleA Local File.xml"],
  "sample-b": () => ["files/SampleB.xml"],
  dev: () => xmlFilesIn(`${MISMATCHES}/Dev`),
  prod: () => xmlFilesIn(`${MISMATCHES}/Prod`),
  "fixture-fm26": () => [`${FIXTURES}/XML FM26/TEST_MAIN.xml`, `${FIXTURES}/XML FM26/TEST_EXT.xml`],
  "fixture-fm26-intact": () => [`${FIXTURES}/XML FM26/TEST_MAIN__intact.xml`, `${FIXTURES}/XML FM26/TEST_EXT__intact.xml`],
  "fixture-fm26-appended": () => [`${FIXTURES}/XML FM26/APPENDED TESTS/TEST_MAIN.xml`, `${FIXTURES}/XML FM26/APPENDED TESTS/TEST_EXT.xml`],
  "fixture-fm22": () => [`${FIXTURES}/XML FM22/TEST_MAIN.xml`, `${FIXTURES}/XML FM22/TEST_EXT.xml`],
  "fixture-fm21": () => [`${FIXTURES}/XML FM21/TEST_MAIN.xml`, `${FIXTURES}/XML FM21/TEST_EXT.xml`],
};

const MB = 1024 * 1024;

function xmlFilesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".xml")).sort().map((f) => join(dir, f)) : [];
}

/** A file decoded as the app decodes it, but with Buffer instead of TextDecoder,
 * which throws on UTF-16 input of 256 MiB or more (Orders.xml). */
function readExport(path: string): string {
  const bytes = readFileSync(path);
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.swap16().toString("utf16le") : bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // V8 keeps the subject of the last regex match alive; match something small.
  /x/.exec("x");
  gc();
  gc();
}

/** Every string in `result` copied fresh, sharing no storage with the source. */
function freshCopy(result: ParseResult): ParseResult {
  const copy = <T>(items: T[]): T[] => items.map((x) => JSON.parse(JSON.stringify(x)) as T);
  return { files: copy(result.files), objects: copy(result.objects), references: copy(result.references), errors: copy(result.errors) };
}

function dumpGroup(outDir: string, group: string): void {
  const paths = GROUPS[group]!();
  if (paths.length === 0 || !paths.every((p) => existsSync(p))) {
    console.log(`${group}: skipped (files missing)`);
    return;
  }
  collectGarbage();
  const heapBefore = process.memoryUsage().heapUsed;
  let docs: { name: string; content: string }[] | null = paths.map((p) => ({ name: p.split("/").pop()!, content: readExport(p) }));
  const t0 = performance.now();
  let result: ParseResult | null = parseDocuments(docs);
  const parseMs = Math.round(performance.now() - t0);
  const parseRssMB = Math.round((process.resourceUsage().maxRSS * 1024) / MB);
  docs = null;
  collectGarbage();
  const retainedMB = Math.round((process.memoryUsage().heapUsed - heapBefore) / MB);
  const fresh = freshCopy(result);
  result = null;
  collectGarbage();
  const freshMB = Math.round((process.memoryUsage().heapUsed - heapBefore) / MB);

  const dir = join(outDir, group);
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256");
  const lines = (items: unknown[]): string => {
    const out = items.map((x) => JSON.stringify(x));
    for (const line of out) hash.update(line + "\n");
    return out.join("\n") + "\n";
  };
  lines(fresh.files);
  writeFileSync(join(dir, "objects.jsonl"), lines(fresh.objects));
  writeFileSync(join(dir, "references.jsonl"), lines(fresh.references));
  lines(fresh.errors);

  const model = buildModel(fresh);
  const { countsByType: _counts, riskFlags: _flags, ...reportCard } = model.reportCard;
  const summary = {
    files: paths,
    sha256: hash.digest("hex"),
    objects: fresh.objects.length,
    references: fresh.references.length,
    errors: fresh.errors,
    model: { references: model.references.length, broken: model.brokenReferences.length, reportCard },
    parseMs,
    retainedMB,
    freshMB,
    /** Peak RSS by the end of the parse (reading the files included). */
    parseRssMB,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${group}: ${summary.objects} objects, ${summary.references} refs, ${summary.errors.length} errors, parse ${parseMs} ms, retained ${retainedMB} MB (fresh ${freshMB} MB), peak RSS ${parseRssMB} MB`);
}

/** Each group in a process of its own, for a clean peak-RSS reading and room
 * for the largest groups (Dev, Prod). */
function dump(outDir: string, groups: string[]): void {
  for (const group of groups.length ? groups : Object.keys(GROUPS)) {
    if (!GROUPS[group]) {
      console.log(`${group}: no such group (${Object.keys(GROUPS).join(", ")})`);
      continue;
    }
    const run = spawnSync(process.execPath, ["--max-old-space-size=12288", process.argv[1]!, "dump-group", outDir, group], { stdio: "inherit" });
    if (run.status !== 0) console.log(`${group}: failed (exit ${run.status})`);
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** How the objects of one group changed, by uid. */
function compareObjects(before: string[], after: string[]): string[] {
  const parse = (lines: string[]) => new Map(lines.map((l) => [(JSON.parse(l) as { uid: string }).uid, l]));
  const a = parse(before);
  const b = parse(after);
  const out: string[] = [];
  const removed = [...a.keys()].filter((u) => !b.has(u));
  const added = [...b.keys()].filter((u) => !a.has(u));
  const changed = [...a.keys()].filter((u) => b.has(u) && a.get(u) !== b.get(u));
  if (removed.length) out.push(`  objects removed: ${removed.length}, e.g. ${removed.slice(0, 5).join(", ")}`);
  if (added.length) out.push(`  objects added: ${added.length}, e.g. ${added.slice(0, 5).join(", ")}`);
  if (changed.length) {
    const fields = new Map<string, number>();
    for (const u of changed) {
      const x = JSON.parse(a.get(u)!) as Record<string, unknown>;
      const y = JSON.parse(b.get(u)!) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) fields.set(k, (fields.get(k) ?? 0) + 1);
      }
    }
    out.push(`  objects changed: ${changed.length} (fields: ${[...fields].map(([k, n]) => `${k} ${n}`).join(", ")}), e.g. ${changed.slice(0, 5).join(", ")}`);
  }
  if (!removed.length && !added.length && !changed.length && before.join("\n") !== after.join("\n")) out.push("  objects reordered");
  return out;
}

/** How the references of one group changed, as multisets. */
function compareReferences(before: string[], after: string[]): string[] {
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const diff = (x: Map<string, number>, y: Map<string, number>) => [...x].flatMap(([l, n]) => Array<string>(Math.max(0, n - (y.get(l) ?? 0))).fill(l));
  const removed = diff(a, b);
  const added = diff(b, a);
  const out: string[] = [];
  for (const [label, refs] of [["removed", removed], ["added", added]] as const) {
    if (!refs.length) continue;
    out.push(`  references ${label}: ${refs.length}`);
    for (const r of refs.slice(0, 8)) out.push(`    ${r}`);
  }
  if (!removed.length && !added.length && before.join("\n") !== after.join("\n")) out.push("  references reordered");
  return out;
}

function compare(beforeDir: string, afterDir: string): void {
  for (const group of Object.keys(GROUPS)) {
    const sa = join(beforeDir, group, "summary.json");
    const sb = join(afterDir, group, "summary.json");
    if (!existsSync(sa) || !existsSync(sb)) continue;
    const a = JSON.parse(readFileSync(sa, "utf8"));
    const b = JSON.parse(readFileSync(sb, "utf8"));
    const perf = `parse ${a.parseMs} → ${b.parseMs} ms, retained ${a.retainedMB} → ${b.retainedMB} MB (fresh ${b.freshMB}), peak RSS ${a.parseRssMB} → ${b.parseRssMB} MB`;
    if (a.sha256 === b.sha256) {
      console.log(`${group}: identical · ${perf}`);
      continue;
    }
    console.log(`${group}: CHANGED · ${perf}`);
    if (JSON.stringify(a.errors) !== JSON.stringify(b.errors)) console.log(`  errors: ${JSON.stringify(a.errors)} → ${JSON.stringify(b.errors)}`);
    if (JSON.stringify(a.model) !== JSON.stringify(b.model)) console.log(`  model: ${JSON.stringify(a.model)} → ${JSON.stringify(b.model)}`);
    const read = (dir: string, file: string) => readLines(join(dir, group, file));
    for (const line of compareObjects(read(beforeDir, "objects.jsonl"), read(afterDir, "objects.jsonl"))) console.log(line);
    for (const line of compareReferences(read(beforeDir, "references.jsonl"), read(afterDir, "references.jsonl"))) console.log(line);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "dump" && args[0]) dump(args[0], args.slice(1));
else if (command === "dump-group" && args[0] && args[1]) dumpGroup(args[0], args[1]);
else if (command === "compare" && args[0] && args[1]) compare(args[0], args[1]);
else console.log("usage: corpus.mjs dump <outDir> [group…] | compare <beforeDir> <afterDir>");
