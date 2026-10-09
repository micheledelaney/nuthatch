import { version as NUTHATCH_VERSION } from "../../../package.json";
import { OBJECT_TYPE_META, objectLabel } from "@/types/ddr";
import { chainTops } from "@/core/analysis/unusedChains";
import { brokenSources } from "@/core/analysis/dependencies";
import { USAGE_REASON_LABELS } from "@/core/analysis/usageMarks";
import { refLabel, refStatus } from "@/core/model/refStatus";
import { scriptChecksRan, shownScriptChecksByScript } from "@/core/scriptAnalysis/analyze";
import { plainText, type ScriptFinding } from "@/core/scriptAnalysis/findings";
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
  const brokenFrom = brokenSources(model);
  const unreferenced = new Set(model.unreferenced.map((o) => o.uid));
  const unusedChain = new Set(model.unusedChain.map((o) => o.uid));
  const checks = shownScriptChecksByScript(model);
  return [
    { name: "README.md", content: buildReadme(model, info, checks) },
    { name: "objects.jsonl", content: model.objects.map((o) => exportObject(o, model, brokenFrom, unreferenced, unusedChain, checks)).join("\n") + "\n" },
    { name: "refs.tsv", content: [REF_COLUMNS.join("\t"), ...model.references.map((r) => refRow(r, model))].join("\n") + "\n" },
    // Written even when empty, so it replaces an earlier export's.
    { name: "script-checks.jsonl", content: scriptCheckLines(model, checks) },
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
  checks: ReadonlyMap<string, readonly ScriptFinding[]>,
): string {
  const chain = unusedChain.has(o.uid) ? chainTops(model, o.uid) : null;
  const usedOnlyBy = chain ? (chain.tops.length > 0 ? chain.tops : chain.loop) : [];
  const mark = model.usageMarks.get(o.uid);
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
    markedUsed: mark ? { reason: USAGE_REASON_LABELS[mark.reason], note: mark.note } : undefined,
    hasBrokenRefs: brokenFrom.has(o.uid) || undefined,
    scriptChecks: checks.get(o.uid)?.length,
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

/** Drop the display-only bulk (styling — an object's own and its conditional
 * formats' — and the drawn layout map) from the detail. */
function slimDetail(detail: ObjectDetail | undefined): object | undefined {
  if (!detail) return undefined;
  if (detail.kind === "layoutObject") {
    const { style: _style, conditionalFormatStyles: _conditionalFormatStyles, ...rest } = detail;
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
      parts: detail.parts.map((p) => ({ type: p.type, top: p.top, height: p.height, ...(p.breakField ? { breakField: p.breakField } : {}) })),
      ...(detail.tableView ? { tableView: detail.tableView } : {}),
    };
  }
  return detail;
}

/** The reference's status column: the app's status (see refStatus — a field
 * name read from calculation text that matched no field of a loaded file is
 * `unmatched`), with a disabled step's resolved reference as `disabled`. */
function refRowStatus(r: FmReference, model: SolutionModel): string {
  const status = refStatus(r, model.byUid);
  return status === "ok" && r.disabled ? "disabled" : status;
}

/** The target's name; when FileMaker left it blank, the app's label for it
 * (e.g. `<Value List Missing>`). A field's is just the field part, since the
 * occurrence is in `via_uid`. */
function refRowName(r: FmReference, model: SolutionModel): string {
  if (r.toName) return r.toName;
  if (r.toType !== "field") return refLabel(r, model.byUid);
  const target = r.toUid ? model.byUid.get(r.toUid) : undefined;
  if (target?.name) return target.name;
  const status = refStatus(r, model.byUid);
  return status === "broken" ? "<Field Missing>" : status === "unverifiable" ? "<File Missing>" : `(field ${r.toId})`;
}

function refRow(r: FmReference, model: SolutionModel): string {
  const from = model.byUid.get(r.fromUid);
  return [
    r.fromUid,
    from?.type ?? "",
    from ? objectLabel(from) : "",
    r.fromStep ?? "",
    r.kind,
    refRowStatus(r, model),
    r.toUid ?? "",
    r.toType,
    refRowName(r, model),
    // A deleted occurrence (FileMaker's `<Table Missing>`) isn't in the model.
    r.viaUid && model.byUid.has(r.viaUid) ? r.viaUid : "",
  ]
    .map((v) => tsvCell(String(v)))
    .join("\t");
}

/** One JSON line per finding the app shows (see shownScriptChecksByScript):
 * scripts in the objects' order, each one's findings in step order. */
function scriptCheckLines(model: SolutionModel, checks: ReadonlyMap<string, readonly ScriptFinding[]>): string {
  const lines = model.objects.flatMap((o) =>
    (checks.get(o.uid) ?? []).map((f) =>
      JSON.stringify({
        uid: o.uid,
        script: objectLabel(o),
        rule: f.rule,
        certainty: f.certainty,
        step: f.step,
        lastStep: f.lastStep,
        title: plainText(f.title),
        detail: plainText(f.detail),
      }),
    ),
  );
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
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

function buildReadme(model: SolutionModel, info: AiExportInfo, checks: ReadonlyMap<string, readonly ScriptFinding[]>): string {
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
  const checksRan = scriptChecksRan(model);
  const findingCount = [...checks.values()].reduce((sum, findings) => sum + findings.length, 0);
  const checksLine = checksRan
    ? `**Scripts flagged by script checks:** ${checks.size} (${findingCount} ${findingCount === 1 ? "finding" : "findings"})`
    : "**Script checks:** not run (see script-checks.jsonl below)";

  return `# FileMaker solution analysis (nuthatch export)

Machine-readable dump of a FileMaker solution, produced by nuthatch ${NUTHATCH_VERSION}
from "Save a Copy as XML" exports. All references are already resolved, so
dependency questions ("what uses X?", "can I delete X?") are a lookup in
\`refs.tsv\` rather than a search through the raw XML.

- **Analysis:** ${info.analysisName} (project: ${info.projectName})
- **Analysis saved:** ${new Date(info.savedAt).toISOString()}
- **Exported:** ${new Date(info.exportedAt).toISOString()}
- **Objects:** ${model.objects.length} · **References:** ${model.references.length} · **Broken references:** ${model.brokenReferences.length} (in ${card.brokenReferenceCount} objects)
- **Unreferenced objects:** ${card.unreferencedCount} · **Used only by unreferenced objects:** ${card.unusedChainCount}
- ${checksLine}

This is a snapshot. If the FileMaker solution has changed since the date
above, re-export the XML, re-analyze it in nuthatch, and export again.

## Files

${files}

Files not listed here were not loaded. References into them show as
\`external\` (or broken), and anything *they* reference is invisible here.

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
- \`markedUsed\`: someone marked it as used in nuthatch, with their \`reason\` (e.g.
  "Server schedule") and \`note\`. That's their knowledge of something the XML
  can't show, not a reference: it keeps the object, and everything it uses, out
  of \`unreferenced\` and \`unusedChain\`.
- \`hasBrokenRefs: true\`: it references something that no longer exists.
- \`scriptChecks\`: on a script, how many findings the script checks have in its
  steps (listed in \`script-checks.jsonl\`).
- \`attributes\`: raw attributes from the XML element (field type, storage, …).
- \`detail\`: type-specific structure. Scripts: \`steps\` with \`index\`, \`name\`,
  \`enabled\`, and \`params\` (FileMaker's own step text). Calculated fields and
  custom functions: \`body\`. Summary fields: \`operation\`, \`fields\`, \`sortedBy\`,
  \`weightedBy\`, \`restartsEachGroup\`. Lookups: \`source\`, \`startingFrom\`,
  \`ifNoMatch\`, \`skipEmpty\`. Layouts: \`parts\` (a sub-summary's \`breakField\`),
  \`tableView\` columns. Layout objects: \`loType\`, \`fieldRef\`, \`scriptRef\`,
  \`scriptParameter\`, \`valueListRef\`, \`actionStep\` (a button's single step),
  \`triggers\`, \`tooltip\`, \`placeholder\`, \`hideWhen\` (\`hideInFind\`: also in
  Find mode), \`conditionalFormats\`, \`portalSort\`, \`portalFilter\`,
  \`popoverTitle\`, \`chart\`, \`bounds\`, … Relationships: \`predicates\` and cascade settings.
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
| \`status\` | \`ok\`; \`disabled\` (in a disabled script step); \`broken\` (target gone); \`external\` (target in a file that wasn't loaded); \`unverifiable\` (a field FileMaker left nameless behind an occurrence whose file wasn't available at export: no one can tell whether it exists); \`unmatched\` (a field name read from calculation text that matches no field of the loaded file) |
| \`to_uid\`, \`to_type\`, \`to_name\` | the target (\`to_uid\` is empty unless \`ok\` or \`disabled\`). Where FileMaker left the name blank, \`to_name\` is FileMaker's placeholder, e.g. \`<Field Missing>\`, \`<Value List Missing>\`, \`<File Missing>\` |
| \`via_uid\` | for field references: the table occurrence the field is read through (empty when that occurrence was deleted) |

A layout object's references (its field, button action, tooltip,
hide-object-when, conditional formatting, …) are listed under the object only
(\`from_type\` = \`layoutObject\`); its layout, up its \`parent\` chain, lists
just what the layout itself uses. The calculation text itself is on the
object's \`detail\` in \`objects.jsonl\`.

Reference kinds in this export: ${kindCounts}.

## script-checks.jsonl

${
  checksRan
    ? `What nuthatch's script checks found in the scripts' steps, one finding per
line: the same findings the app lists in a script's Script checks section.`
    : `Empty: the script checks weren't run, because this analysis was saved before
nuthatch had them. Re-analyze the XML to get them. Until then, the empty file
doesn't mean the scripts are fine.`
}

- \`uid\`, \`script\`: the script.
- \`step\` (and \`lastStep\`, for a run of steps): 1-based, as \`index\` in the
  script's \`detail.steps\` in \`objects.jsonl\`.
- \`rule\`: which check (below). \`certainty\`: \`fact\` (what the steps say) or
  \`likely\` (a defect unless something the export can't show makes up for it).
- \`title\`, \`detail\`: what's wrong and why, as the app words it.

| rule | finds |
| --- | --- |
| \`unreachable-steps\` | steps no path reaches: after an Exit Script or Halt Script, an If whose every branch stops the script, or a Loop with no way out |
| \`unset-variable\` | a \`$variable\` the script reads but never sets: not in a step, a \`Let\`, or a custom function it calls |
| \`unrelated-set-field\` | a Set Field into an occurrence unrelated to the layout the script is on at that step (known from the buttons and triggers that run it, and its Go to Layout steps) |
| \`unpassed-parameter-key\` | a JSON key the script reads from \`Get ( ScriptParameter )\` that none of its callers passes |
| \`unreturned-result-key\` | a JSON key read from \`Get ( ScriptResult )\` that the script performed before it never returns |
| \`result-before-call\` | \`Get ( ScriptResult )\` read before the script has performed any other |

Confirm a \`likely\` finding before changing anything. Common deliberate cases:
a debug switch set only by a disabled step, or by hand in the Data Viewer; an
optional parameter key; a caller the export can't see (a server schedule, a file
that isn't loaded, a call by name).

No finding doesn't mean a script is fine. Only literal JSON keys are compared,
the flow checks skip scripts with a disabled If or Loop step, and findings that
are often deliberate (a variable set but never read, a passed key the script
never reads) are left out.

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

# What the script checks found in a script
grep -F '"uid":"F0:script:1056"' script-checks.jsonl | jq -r '"step \\(.step): \\(.title). \\(.detail)"'

# Scripts the script checks flagged
jq -r .script script-checks.jsonl | sort -u
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
