import { version as NUTHATCH_VERSION } from "../../../package.json";
import { OBJECT_TYPE_META, objectLabel } from "@/types/ddr";
import { chainTops } from "@/core/analysis/unusedChains";
import type { FmObject, FmReference, ObjectDetail, ObjectType, SolutionModel } from "@/types/ddr";

/**
 * "Export for AI": a compact, grep-friendly dump of a resolved solution, meant
 * to be dropped into a project folder so an AI coding assistant can answer
 * questions like "can I delete this?" from resolved references instead of
 * crawling hundreds of MB of raw XML.
 *
 * Pure: model in, files out. Writing them to disk is the caller's job.
 */

/** Folder the files are written into, inside whatever folder the user picks. */
export const AI_EXPORT_FOLDER = "nuthatch";

export interface ExportFile {
  /** File name within {@link AI_EXPORT_FOLDER}. */
  name: string;
  content: string;
}

export interface AiExportInfo {
  analysisName: string;
  projectName: string;
  /** Epoch millis the analysis was saved. */
  savedAt: number;
  /** Epoch millis of this export. */
  exportedAt: number;
}

const REF_COLUMNS = [
  "from_uid",
  "from_type",
  "from_name",
  "step",
  "kind",
  "status",
  "to_uid",
  "to_type",
  "to_name",
  "via_uid",
] as const;

export function buildAiExport(model: SolutionModel, info: AiExportInfo): ExportFile[] {
  const brokenFrom = new Set(model.brokenReferences.map((r) => r.fromUid));
  const unreferenced = new Set(model.unreferenced.map((o) => o.uid));
  const unusedChain = new Set(model.unusedChain.map((o) => o.uid));
  return [
    { name: "README.md", content: buildReadme(model, info) },
    { name: "objects.jsonl", content: model.objects.map((o) => exportObject(o, model, brokenFrom, unreferenced, unusedChain)).join("\n") + "\n" },
    { name: "refs.tsv", content: [REF_COLUMNS.join("\t"), ...model.references.map((r) => refRow(r, model))].join("\n") + "\n" },
    // Keeps the dump (which can include account names and emails) out of git
    // by default; the README explains how to opt in.
    { name: ".gitignore", content: "*\n" },
  ];
}

/** One object as a JSON line: identity, flags, and slimmed type-specific detail. */
function exportObject(
  o: FmObject,
  model: SolutionModel,
  brokenFrom: ReadonlySet<string>,
  unreferenced: ReadonlySet<string>,
  unusedChain: ReadonlySet<string>,
): string {
  const chain = unusedChain.has(o.uid) ? chainTops(model, o.uid) : null;
  const usedOnlyBy = chain ? (chain.tops.length > 0 ? chain.tops : chain.loop) : [];
  return JSON.stringify({
    uid: o.uid,
    type: o.type,
    name: objectLabel(o),
    file: o.fileName,
    parent: o.parentUid,
    folder: o.folder,
    order: o.order,
    separator: o.isSeparator || undefined,
    refsIn: model.inbound.get(o.uid)?.length ?? 0,
    refsOut: model.outbound.get(o.uid)?.length ?? 0,
    unreferenced: unreferenced.has(o.uid) || undefined,
    unusedChain: chain ? true : undefined,
    unusedLoop: chain && chain.tops.length === 0 ? true : undefined,
    usedOnlyBy: usedOnlyBy.length > 0 ? usedOnlyBy.map((u) => u.uid) : undefined,
    hasBrokenRefs: brokenFrom.has(o.uid) || undefined,
    relationshipDepth: o.relationshipDepth,
    // A layout object's attributes and text restate its detail (type, label,
    // position, bound names), so only the detail is kept.
    attributes: o.type === "layoutObject" ? undefined : o.attributes,
    detail: slimDetail(o.detail),
    text: TEXT_IN_DETAIL.has(o.detail?.kind ?? "") ? undefined : o.text || undefined,
  });
}

/** Detail kinds that already hold the object's readable text: script steps,
 * calculation bodies, and layout (object) names and labels. */
const TEXT_IN_DETAIL: ReadonlySet<string> = new Set(["script", "calculation", "layout", "layoutObject"]);

/** Drop the display-only bulk (styling, drawn layout map) from the detail. */
function slimDetail(detail: ObjectDetail | undefined): object | undefined {
  if (!detail) return undefined;
  if (detail.kind === "layoutObject") {
    const { style: _style, ...rest } = detail;
    return rest;
  }
  if (detail.kind === "layout") {
    // Each placed object is exported as its own layoutObject line, so the
    // layout keeps only its size, triggers, and part bands.
    return {
      kind: "layout",
      width: detail.width,
      height: detail.height,
      triggers: detail.triggers,
      parts: detail.parts.map((p) => ({ type: p.type, top: p.top, height: p.height })),
    };
  }
  return detail;
}

function refRow(r: FmReference, model: SolutionModel): string {
  const from = model.byUid.get(r.fromUid);
  const status = r.broken ? "broken" : r.toUid ? (r.disabled ? "disabled" : "ok") : "unresolved";
  return [
    r.fromUid,
    from?.type ?? "",
    from ? objectLabel(from) : "",
    r.fromStep ?? "",
    r.kind,
    status,
    r.toUid ?? "",
    r.toType,
    r.toName,
    r.viaUid ?? "",
  ]
    .map((v) => tsvCell(String(v)))
    .join("\t");
}

/** Keep one reference per line: tabs and newlines inside names become spaces. */
function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ");
}

function countBy<T>(items: readonly T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function buildReadme(model: SolutionModel, info: AiExportInfo): string {
  const typeCounts = countBy(model.objects, (o) => o.type)
    .map(([t, n]) => `| \`${t}\` | ${OBJECT_TYPE_META[t as ObjectType]?.label ?? t} | ${n} |`)
    .join("\n");
  const kindCounts = countBy(model.references, (r) => r.kind)
    .map(([k, n]) => `\`${k}\` (${n})`)
    .join(", ");
  const files = model.files
    .map((f) => `- \`${f.uid}\` = **${f.name}** (from \`${f.source}\`${f.version ? `, FileMaker ${f.version}` : ""})`)
    .join("\n");
  const card = model.reportCard;

  return `# FileMaker solution analysis (nuthatch export)

Machine-readable dump of a FileMaker solution, produced by nuthatch ${NUTHATCH_VERSION}
from "Save a Copy as XML" exports. All references are already resolved, so
dependency questions ("what uses X?", "can I delete X?") are a lookup in
\`refs.tsv\` rather than a search through the raw XML.

- **Analysis:** ${info.analysisName} (project: ${info.projectName})
- **Analysis saved:** ${new Date(info.savedAt).toISOString()}
- **Exported:** ${new Date(info.exportedAt).toISOString()}
- **Objects:** ${model.objects.length} · **References:** ${model.references.length} · **Broken references:** ${model.brokenReferences.length}
- **Unreferenced objects:** ${card.unreferencedCount} · **Used only by unreferenced objects:** ${card.unusedChainCount}

This is a snapshot. If the FileMaker solution has changed since the date
above, re-export the XML, re-analyze it in nuthatch, and export again.

## Files

${files}

Files not listed here were not loaded. References into them show as
\`unresolved\` (or broken), and anything *they* reference is invisible here.

## uids

Every object has a globally unique \`uid\` of the form \`<file>:<type>:<id>\`,
e.g. \`F0:script:1056\`. Layout objects are namespaced by their layout:
\`F0:layoutObject:<layoutId>.<objectId>\`. Fields are namespaced by their table.

## objects.jsonl

One JSON object per line:

- \`uid\`, \`type\`, \`name\`, \`file\`; \`parent\` is the containing object's uid
  (a field's table, a layout object's layout, …); \`folder\` is the Script
  Workspace / catalog folder path.
- \`refsIn\` / \`refsOut\`: number of references to / from this object.
- \`unreferenced: true\`: nothing in the loaded files references it.
- \`unusedChain: true\`: something references it, but only unused objects (an
  unreferenced one, or another object in the chain), e.g. a script called only by
  an unreferenced script. \`usedOnlyBy\` lists the unreferenced objects at the top
  of its chain: if those really are unused, so is this. With \`unusedLoop: true\`
  it's in a loop of objects that only use each other, and \`usedOnlyBy\` lists the
  others. Layouts and scripts shown in FileMaker's menus count as in use, so they
  never start a chain.
- \`hasBrokenRefs: true\`: it references something that no longer exists.
- \`attributes\`: raw attributes from the XML element (field type, storage, …).
- \`detail\`: type-specific structure. Scripts: \`steps\` with \`index\`, \`name\`,
  \`enabled\`, and \`params\` (FileMaker's own step text). Calculated fields and
  custom functions: \`body\`. Layout objects: \`loType\`, \`fieldRef\`, \`scriptRef\`,
  \`triggers\`, \`tooltip\`, \`hideWhen\`, \`conditionalFormats\`, \`bounds\`, … Relationships: \`predicates\` and cascade settings.
- \`text\`: readable content for types without a structured body.

| type | label | count |
| --- | --- | --- |
${typeCounts}

## refs.tsv

Tab-separated, one reference per line, with a header row:

| column | meaning |
| --- | --- |
| \`from_uid\`, \`from_type\`, \`from_name\` | the object holding the reference |
| \`step\` | 1-based step index, when the reference is in a step: of a script, or of a button's or custom menu item's action |
| \`kind\` | how it references, e.g. \`performScript\`, \`trigger\`, \`field\`, \`goToLayout\` |
| \`status\` | \`ok\`, \`disabled\` (in a disabled script step), \`broken\` (target gone), or \`unresolved\` (target in a file that wasn't loaded) |
| \`to_uid\`, \`to_type\`, \`to_name\` | the target (\`to_uid\` is empty when broken or unresolved) |
| \`via_uid\` | for field references: the table occurrence the field is read through |

A layout object's references (its field, button action, tooltip,
hide-object-when, conditional formatting, …) are listed under the object, and
again under its **layout** (\`from_type\` = \`layout\`), which lists everything on
it — there without a \`step\`, and once per distinct use. The calculation text
itself is on the object's \`detail\` in \`objects.jsonl\`.

Reference kinds in this export: ${kindCounts}.

## Recipes

\`\`\`sh
# Find an object's uid by name
grep -F '"name":"Invoices"' objects.jsonl | cut -c1-200

# Everything that references it (the "can I delete this?" question)
awk -F'\\t' '$7=="F0:script:1056"' refs.tsv

# Everything it references
awk -F'\\t' '$1=="F0:script:1056"' refs.tsv

# All broken references
awk -F'\\t' '$6=="broken"' refs.tsv

# Unreferenced scripts
grep '"type":"script"' objects.jsonl | grep '"unreferenced":true' | jq -r .name

# Objects used only by unused objects, and what their chain hangs from
grep '"unusedChain":true' objects.jsonl | jq -c '{name, usedOnlyBy}'
\`\`\`

## Before concluding something is safe to delete

\`refs.tsv\` holds every reference FileMaker records by id. It cannot see:

- names used as **text**: inside \`ExecuteSQL\` queries, \`GetFieldName\` /
  \`Evaluate\` strings, or a \`Perform Script\` by calculated name;
- references from **files not loaded** into this analysis (see Files above);
- anything outside FileMaker (Data API / OData clients, server schedules,
  other apps, plug-ins).

So also \`grep -F\` the name across \`objects.jsonl\`. A clean result means
"no references found", not "safe". An \`unusedChain\` object inherits all of
this from the objects in its \`usedOnlyBy\`: check those first.

## Privacy and git

This export can contain account names, email addresses (\`lastModifiedAccount\`),
and calculation logic. The \`.gitignore\` in this folder keeps it out of git; delete
that file if you do want to commit the export.
`;
}
