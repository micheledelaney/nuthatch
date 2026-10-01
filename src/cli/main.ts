import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { version as NUTHATCH_VERSION } from "../../package.json";
import { AI_EXPORT_FOLDER, buildAiExport } from "@/core/export/aiExport";
import { buildModel } from "@/core/model/buildModel";
import { parseDocuments } from "@/core/parser/parseDdr";
import { decodeFile } from "@/state/loadFiles";

/**
 * Command-line entry point: the same parse → model → "Export for AI" pipeline
 * the app runs, without the app. Bundled and compiled into a standalone
 * executable by scripts/build-cli.mjs.
 */

const USAGE = `Usage: nuthatch export-ai <file.xml>... [options]

Parse FileMaker "Save a Copy as XML" exports and write the AI-readable
analysis into <out>/${AI_EXPORT_FOLDER}/ (overwriting an earlier export).

Options:
  -o, --out <dir>       Folder to export into (default: current folder)
  -n, --name <name>     Analysis name (default: the first file's name)
  -p, --project <name>  Project name (default: the analysis name)
  -h, --help            Show this help
  -v, --version         Show the version`;

class UsageError extends Error {}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      name: { type: "string", short: "n" },
      project: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) return console.log(USAGE);
  if (values.version) return console.log(NUTHATCH_VERSION);

  const [command, ...paths] = positionals;
  if (command !== "export-ai") throw new UsageError(command ? `Unknown command: ${command}` : "Missing command.");
  if (paths.length === 0) throw new UsageError("No XML files given.");
  for (const path of paths) checkXmlPath(path);

  exportAi(paths, {
    outDir: resolve(values.out ?? "."),
    analysisName: values.name ?? basename(paths[0]!, extname(paths[0]!)),
    projectName: values.project,
  });
}

/** Fail with a readable message before parsing, instead of a raw ENOENT/EISDIR. */
function checkXmlPath(path: string): void {
  if (!existsSync(path)) throw new UsageError(`File not found: ${path}`);
  if (statSync(path).isDirectory()) {
    throw new UsageError(`${path} is a folder, not an XML file. To choose where to export, use --out ${path}`);
  }
}

interface ExportOptions {
  outDir: string;
  analysisName: string;
  projectName: string | undefined;
}

function exportAi(paths: string[], options: ExportOptions): void {
  const docs = paths.map((path) => ({ name: basename(path), content: decodeFile(readBuffer(path)) }));
  const result = parseDocuments(docs);
  for (const error of result.errors) console.error(`warning: ${error}`);

  const now = Date.now();
  const files = buildAiExport(buildModel(result), {
    analysisName: options.analysisName,
    projectName: options.projectName ?? options.analysisName,
    savedAt: now,
    exportedAt: now,
  });

  const target = join(options.outDir, AI_EXPORT_FOLDER);
  mkdirSync(target, { recursive: true });
  for (const file of files) writeFileSync(join(target, file.name), file.content);

  console.log(`Exported ${result.objects.length} objects and ${result.references.length} references to ${target}`);
  console.log(`Add "FileMaker analysis data is in ${AI_EXPORT_FOLDER}/ — read ${AI_EXPORT_FOLDER}/README.md first." to the project's CLAUDE.md or AGENTS.md so AI assistants find it.`);
}

/** Read a file as a standalone ArrayBuffer (a Node Buffer may be a view into a shared pool). */
function readBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const isUsage = err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
  console.error(`nuthatch: ${err instanceof Error ? err.message : String(err)}`);
  if (isUsage) console.error(`\n${USAGE}`);
  process.exit(1);
}
