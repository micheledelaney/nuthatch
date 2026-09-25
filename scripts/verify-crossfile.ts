import { readFileSync } from "node:fs";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";

/** Decode a file buffer honoring its BOM (mirrors the browser Toolbar logic). */
function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString("utf16le");
  return buf.toString("utf8");
}

const paths = process.argv.slice(2);
const docs = paths.map((p) => ({ name: p, content: decode(readFileSync(p)) }));

const t0 = Date.now();
const model = buildModel(parseDocuments(docs));
console.log(`parsed + analyzed ${paths.length} file(s) in ${Date.now() - t0} ms`);
console.log("files:", model.files.map((f) => `${f.uid}=${f.name}`));
console.log("objects:", model.objects.length, "references:", model.references.length);
console.log("broken references:", model.brokenReferences.length);

const brokenByType: Record<string, number> = {};
for (const r of model.brokenReferences) brokenByType[r.toType] = (brokenByType[r.toType] ?? 0) + 1;
console.log("broken by target type:", brokenByType);

// Resolved references that cross a file boundary (source file != target file).
let crossResolved = 0;
for (const r of model.references) {
  if (!r.toUid) continue;
  if (r.fromUid.split(":")[0] !== r.toUid.split(":")[0]) crossResolved++;
}
console.log("resolved references that cross a file boundary:", crossResolved);

// Break broken refs down by originating file + show a few samples per type.
const brokenByFile: Record<string, number> = {};
for (const r of model.brokenReferences) {
  const f = model.byUid.get(r.fromUid.split(":")[0] + ":file:" + r.fromUid.split(":")[0]);
  const key = `${r.fromUid.split(":")[0]} (${f?.name ?? "?"})`;
  brokenByFile[key] = (brokenByFile[key] ?? 0) + 1;
}
console.log("broken by originating file:", brokenByFile);
for (const type of ["field", "script"]) {
  const samples = model.brokenReferences.filter((r) => r.toType === type).slice(0, 3);
  for (const r of samples) {
    const from = model.byUid.get(r.fromUid);
    console.log(`  broken ${type}: [${from?.fileName}] ${from?.type} "${from?.name}" -> ${r.toName} (id ${r.toId})`);
  }
}
