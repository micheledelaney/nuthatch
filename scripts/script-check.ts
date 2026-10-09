/**
 * Prototype script checks (src/core/scriptAnalysis) over FileMaker "Save a
 * Copy as XML" exports, loaded together as the app would load them:
 *
 *   npx vite-node --config vite.config.ts scripts/script-check.ts <file.xml>…
 *
 * Prints each finding under its file and script (or layout object), then the
 * checks it left out and why.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { analyzeScripts } from "@/core/scriptAnalysis/analyze";
import { plainText, type ScriptFinding } from "@/core/scriptAnalysis/findings";
import { layoutOf, type SolutionModel } from "@/types/ddr";

/** A file decoded as the app decodes it, but with Buffer instead of
 * TextDecoder, which throws on UTF-16 input of 256 MiB or more. */
function readExport(path: string): string {
  const bytes = readFileSync(path);
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.swap16().toString("utf16le") : bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function main(paths: string[]): void {
  if (paths.length === 0) {
    console.error("Usage: npx vite-node --config vite.config.ts scripts/script-check.ts <file.xml>…");
    process.exit(1);
  }
  const started = Date.now();
  const parsed = parseDocuments(paths.map((path) => ({ name: basename(path), content: readExport(path) })));
  for (const error of parsed.errors) console.error(`warning: ${error}`);
  const model = buildModel(parsed);
  const analysis = analyzeScripts({ model, irs: model.scriptSteps });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  printFindings(model, analysis.findings);
  console.log(`\n${analysis.findings.length} findings in ${analysis.scriptCount} scripts (${seconds} s).`);
  printCounts(analysis.findings);
  printSkipped(model, analysis.skipped);
}

function printFindings(model: SolutionModel, findings: readonly ScriptFinding[]): void {
  const order = new Map(model.objects.map((obj, i) => [obj.uid, i]));
  const byOwner = new Map<string, ScriptFinding[]>();
  for (const finding of findings) (byOwner.get(finding.uid) ?? byOwner.set(finding.uid, []).get(finding.uid)!).push(finding);
  const owners = [...byOwner.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const uid of owners) {
    console.log(`\n${ownerLabel(model, uid)}`);
    for (const f of byOwner.get(uid)!.sort((a, b) => (a.step ?? 0) - (b.step ?? 0))) {
      const at = f.step != null ? `step ${f.step}` : "";
      console.log(`  ${at.padEnd(9)} ${f.certainty.padEnd(8)} ${f.rule.padEnd(22)} ${plainText(f.title)}. ${plainText(f.detail)}`);
    }
  }
}

function ownerLabel(model: SolutionModel, uid: string): string {
  const obj = model.byUid.get(uid);
  if (!obj) return uid;
  const layout = obj.type === "layoutObject" ? layoutOf(obj, model.byUid) : null;
  const where = layout ? `layout ${layout.name} ▸ ${obj.name}` : `${obj.type} ${obj.name}`;
  return `${obj.fileName} ▸ ${where}`;
}

function printCounts(findings: readonly ScriptFinding[]): void {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(`${f.rule} (${f.certainty})`, (counts.get(`${f.rule} (${f.certainty})`) ?? 0) + 1);
  for (const [label, count] of [...counts].sort()) console.log(`  ${String(count).padStart(5)}  ${label}`);
}

function printSkipped(model: SolutionModel, skipped: ReturnType<typeof analyzeScripts>["skipped"]): void {
  if (skipped.length === 0) return;
  console.log(`\nLeft out:`);
  const byReason = new Map<string, string[]>();
  for (const s of skipped) {
    const key = `${s.check}: ${s.reason.replace(/step \d+/g, "step N")}`;
    (byReason.get(key) ?? byReason.set(key, []).get(key)!).push(model.byUid.get(s.uid)?.name ?? s.uid);
  }
  for (const [reason, scripts] of byReason) {
    const shown = scripts.slice(0, 5).join(", ");
    console.log(`  ${String(scripts.length).padStart(5)}  ${reason} — ${shown}${scripts.length > 5 ? ", …" : ""}`);
  }
}

main(process.argv.slice(2));
