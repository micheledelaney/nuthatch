import type { FmObject, ObjectType, ParseResult, RawReference } from "@/types/ddr";
import { OBJECT_TYPE_META, objectLabel } from "@/types/ddr";

/**
 * Compare two parsed analyses of (presumably) the same solution over time.
 *
 * Object identity is the globally-unique `uid` (`fileUid:type:id`), which is
 * stable across exports as long as the same files are loaded in the same
 * order — FileMaker's internal ids don't change between exports. A renamed
 * object therefore keeps its uid (so we can report the rename); an object whose
 * uid is absent on one side is a genuine add/remove.
 */

export interface ObjectChange {
  uid: string;
  type: ObjectType;
  /** Current name (B for added/renamed/changed; the lost name for removed). */
  name: string;
  /** Previous name, only set for renames. */
  previousName?: string;
  /** Readable content before/after — only set for `changed` items. */
  before?: string;
  after?: string;
  /** A script/layout/menu divider (obj.isSeparator), not a real object — shown
   * with its own pill instead of its type's, since FileMaker doesn't keep a
   * separator's id stable across exports and reordering alone can churn it. */
  isSeparator?: boolean;
}

/** A line in a unified diff. */
export interface DiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface TypeDelta {
  type: ObjectType;
  a: number;
  b: number;
  added: number;
  removed: number;
  changed: number;
}

export interface AnalysisDiff {
  objectCountA: number;
  objectCountB: number;
  referenceCountA: number;
  referenceCountB: number;
  brokenCountA: number;
  brokenCountB: number;
  /** Per-type counts on both sides, in display order, where either side is > 0. */
  countsByType: TypeDelta[];
  added: ObjectChange[];
  removed: ObjectChange[];
  /** Same uid, different name. */
  renamed: ObjectChange[];
  /** Same uid, different searchable content (calc/script/layout text). */
  changed: ObjectChange[];
}

const TYPE_ORDER = Object.keys(OBJECT_TYPE_META) as ObjectType[];
const TYPE_INDEX = new Map(TYPE_ORDER.map((t, i) => [t, i]));

/** Sort by type display order, then name, for stable readable lists. */
function compareChanges(a: ObjectChange, b: ObjectChange): number {
  const byType = (TYPE_INDEX.get(a.type) ?? 0) - (TYPE_INDEX.get(b.type) ?? 0);
  return byType !== 0 ? byType : a.name.localeCompare(b.name);
}

/** Display name for a change row: fields are qualified as `Table::Field` (their
 * base table is `parentUid`), everything else uses its normal label. */
function displayLabel(obj: FmObject, byUid: Map<string, FmObject>): string {
  if (obj.type === "field" && obj.parentUid) {
    const table = byUid.get(obj.parentUid);
    if (table) return `${table.name}::${obj.name}`;
  }
  return objectLabel(obj);
}

function tallyByType(objects: FmObject[]): Map<ObjectType, number> {
  const counts = new Map<ObjectType, number>();
  for (const obj of objects) counts.set(obj.type, (counts.get(obj.type) ?? 0) + 1);
  return counts;
}

function tallyChangesByType(list: ObjectChange[]): Map<ObjectType, number> {
  const counts = new Map<ObjectType, number>();
  for (const c of list) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return counts;
}

/** Per-type A/B counts plus added/removed/changed, for whatever object and change
 * lists are passed in — the whole diff by default, or one file's slice of it (so
 * the UI can show a "by type" breakdown scoped to a single file). */
export function buildCountsByType(
  aObjects: FmObject[],
  bObjects: FmObject[],
  added: ObjectChange[],
  removed: ObjectChange[],
  changed: ObjectChange[],
): TypeDelta[] {
  const aCounts = tallyByType(aObjects);
  const bCounts = tallyByType(bObjects);
  const addedByType = tallyChangesByType(added);
  const removedByType = tallyChangesByType(removed);
  const changedByType = tallyChangesByType(changed);
  return TYPE_ORDER.map((type) => ({
    type,
    a: aCounts.get(type) ?? 0,
    b: bCounts.get(type) ?? 0,
    added: addedByType.get(type) ?? 0,
    removed: removedByType.get(type) ?? 0,
    changed: changedByType.get(type) ?? 0,
  })).filter((d) => d.a > 0 || d.b > 0);
}

/** A UUID anywhere in an object's searchable text (e.g. `<UUID>` elements). It's a
 * stable identifier FileMaker keeps for reference mapping, but it differs between
 * separately-evolved files (dev vs prod), so comparing it makes otherwise-identical
 * objects read as "changed". We strip it from the diff content ONLY — the model,
 * search index, and reference resolution still carry the real UUIDs. */
const UUID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;

export interface DiffOptions {
  /** Include FileMaker-computed `hash` attributes in the diff content. The hash
   * on LayoutObject embeds UUIDs and often differs between environments even
   * when nothing changed; on other elements it may be more reliable. Off by default. */
  includeHash: boolean;
  /** Restrict the comparison to files present, by matching name, on both sides —
   * objects belonging to a file that exists on only one side (or whose name
   * doesn't match its counterpart) are excluded from the diff entirely, not
   * reported as added/removed. Off by default, comparing every object regardless
   * of which file it came from. */
  diffByFileId: boolean;
  /** Include a serial field's next value in the diff. It's a live counter that
   * advances as records are created, so it diverges naturally between copies of
   * a file — off by default so that difference isn't reported as a change. */
  includeSerialNextValue: boolean;
  /** Include modification-tracking attributes (`lastModifiedAt`, `lastModifiedBy`,
   * `lastModifiedAccount`, `modifications`) in the diff. These diverge naturally
   * between environments even when nothing meaningful changed — off by default. */
  includeModificationInfo: boolean;
  /** Include accounts in the comparison. When off, account objects are dropped
   * from both sides before diffing — they never appear as added/removed/changed
   * or in the counts. On by default. */
  includeAccounts: boolean;
  /** Include value lists in the comparison. When off, value-list objects are
   * dropped from both sides before diffing. On by default. */
  includeValueLists: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  includeHash: false,
  diffByFileId: true,
  includeSerialNextValue: false,
  includeModificationInfo: false,
  includeAccounts: true,
  includeValueLists: true,
};

/** Object types the options leave out of the comparison entirely. */
export function excludedTypes(opts: DiffOptions): Set<ObjectType> {
  const s = new Set<ObjectType>();
  if (!opts.includeAccounts) s.add("account");
  if (!opts.includeValueLists) s.add("valueList");
  return s;
}

export interface FileMatch {
  name: string;
  aFileUid: string;
  bFileUid: string;
}

/** Match files between two parses by NAME. `fileUid` ("F0", "F1", ...) is only a
 * load-order index within a single parse — the same file can land on a different
 * fileUid on each side (e.g. comparing a 2-file analysis against a 4-file one,
 * where the file they share isn't loaded first on both). Only the name reliably
 * identifies "the same file" across two independently-loaded analyses. */
export function matchFilesByName(a: ParseResult, b: ParseResult): FileMatch[] {
  const bByName = new Map(b.files.map((f) => [f.name, f.uid]));
  const matches: FileMatch[] = [];
  for (const f of a.files) {
    const bFileUid = bByName.get(f.name);
    if (bFileUid !== undefined) matches.push({ name: f.name, aFileUid: f.uid, bFileUid });
  }
  return matches;
}

const fileUidOfUid = (uid: string): string => uid.slice(0, uid.indexOf(":"));

/** Rewrite a `${fileUid}:...` id's fileUid prefix, keeping the rest untouched. */
function rewriteFileUid(id: string, oldFileUid: string, newFileUid: string): string {
  return newFileUid + id.slice(oldFileUid.length);
}

/**
 * Restrict both sides to files present, by name, on both — and rewrite B's
 * matched-file objects/references onto A's fileUid for that file. The two sides
 * can legitimately disagree on which fileUid a shared file got (different file
 * count, different load order), so without this a shared file's objects would
 * carry different uids on each side and never match up. This only affects the
 * comparison's working copy — the real model everything else in the app uses is
 * untouched.
 */
function scopeAndAlignByFile(
  a: ParseResult,
  b: ParseResult,
): { scopedA: { objects: FmObject[]; references: RawReference[] }; scopedB: { objects: FmObject[]; references: RawReference[] } } {
  const matches = matchFilesByName(a, b);
  const aFileUids = new Set(matches.map((m) => m.aFileUid));
  const bToA = new Map(matches.map((m) => [m.bFileUid, m.aFileUid]));

  const scopedA = {
    objects: a.objects.filter((o) => aFileUids.has(o.fileUid)),
    references: a.references.filter((r) => aFileUids.has(fileUidOfUid(r.fromUid))),
  };

  const scopedBObjects: FmObject[] = [];
  for (const o of b.objects) {
    const newFileUid = bToA.get(o.fileUid);
    if (newFileUid === undefined) continue;
    // The file object itself is self-referential (`uid` is `${fileUid}:file:${fileUid}`,
    // `id` is the fileUid too) — rewriting just the uid's prefix would leave the
    // trailing fileUid and `id` stale, so replace both wholesale for this one type.
    scopedBObjects.push(
      o.type === "file"
        ? { ...o, uid: `${newFileUid}:file:${newFileUid}`, fileUid: newFileUid, id: newFileUid }
        : {
            ...o,
            uid: rewriteFileUid(o.uid, o.fileUid, newFileUid),
            fileUid: newFileUid,
            parentUid: o.parentUid ? rewriteFileUid(o.parentUid, o.fileUid, newFileUid) : o.parentUid,
          },
    );
  }
  const scopedBReferences: RawReference[] = [];
  for (const r of b.references) {
    const oldFileUid = fileUidOfUid(r.fromUid);
    const newFileUid = bToA.get(oldFileUid);
    if (newFileUid === undefined) continue;
    scopedBReferences.push({ ...r, fromUid: rewriteFileUid(r.fromUid, oldFileUid, newFileUid) });
  }

  return { scopedA, scopedB: { objects: scopedBObjects, references: scopedBReferences } };
}

/** Build the per-call noise set from options.
 * Always excluded:
 * - `id` / `name`: identity, not content (`name` is tracked separately as a rename)
 * - `uuid` / `baseTableUuid`: environment-specific identifiers */
function buildNoise(opts: DiffOptions): Set<string> {
  const s = new Set(["id", "name", "uuid", "baseTableUuid"]);
  if (!opts.includeHash) s.add("hash");
  // A serial field's next value is a live counter that advances as records are
  // created, so it diverges naturally between copies of a file — excluded unless
  // the user opts in (it's still shown in the inspector regardless).
  if (!opts.includeSerialNextValue) s.add("serialNextValue");
  // Modification tracking diverges naturally between environments even when
  // nothing meaningful changed — excluded unless the user opts in.
  if (!opts.includeModificationInfo) {
    s.add("lastModifiedAt");
    s.add("lastModifiedBy");
    s.add("lastModifiedAccount");
    s.add("modifications");
  }
  return s;
}

/**
 * A stable, line-oriented snapshot of an object's meaningful content for
 * diffing.
 *
 * The attribute section is fully generic — every key the parser lifted into
 * `obj.attributes` is included, minus the noise set above, sorted for
 * stability. No per-type hardcoding is needed there because the parser already
 * normalises everything into a flat string map.
 *
 * The detail section handles things that live in nested XML and are NOT
 * reflected as element attributes: script steps, calc bodies, relationship
 * predicates, value-list entries, layout dimensions/triggers, layout-object
 * bindings.
 */
function contentOf(obj: FmObject, noise: Set<string>): string {
  const parts: string[] = [];

  // Generic attribute snapshot — stable key order, noise excluded.
  for (const k of Object.keys(obj.attributes).sort()) {
    if (!noise.has(k)) parts.push(`${k}: ${obj.attributes[k]}`);
  }

  // Structured detail: nested-XML content not present in element attributes.
  const d = obj.detail;
  if (d?.kind === "script") {
    parts.push(
      ...d.steps.map((s) => `${s.enabled ? "" : "// "}${s.name}${s.params ? ` [ ${s.params} ]` : ""}`)
    );
  } else if (d?.kind === "calculation") {
    if (d.signature) parts.push(`signature: ${d.signature}`);
    parts.push(d.body);
  } else if (d?.kind === "summary") {
    parts.push(`${d.operation} ${d.fields.join(", ")}`);
  } else if (d?.kind === "relationship") {
    parts.push(...d.predicates.map((p) => `${p.leftField} ${p.operator} ${p.rightField}`));
    if (d.left)  parts.push(`left: create=${d.left.cascadeCreate} delete=${d.left.cascadeDelete} sorted=${d.left.sorted}`);
    if (d.right) parts.push(`right: create=${d.right.cascadeCreate} delete=${d.right.cascadeDelete} sorted=${d.right.sorted}`);
  } else if (d?.kind === "valueList") {
    // `source` is already in attributes; push the values and field binding.
    parts.push(...d.customValues);
    if (d.field) {
      parts.push(`field: ${d.field.primaryField}`);
      if (d.field.sort)            parts.push(`sort: true`);
      if (d.field.secondaryField)  parts.push(`display: ${d.field.secondaryField}`);
      if (d.field.showRelatedFrom) parts.push(`relatedFrom: ${d.field.showRelatedFrom}`);
    }
  } else if (d?.kind === "layout") {
    parts.push(`size: ${d.width}×${d.height}`);
    for (const t of d.triggers) {
      const modes = t.modes.length ? ` [${t.modes.join(", ")}]` : "";
      const param = t.parameter ? ` param: ${t.parameter}` : "";
      const field = t.parameterFieldName ? ` paramField: ${t.parameterFieldName}` : "";
      parts.push(`trigger: ${t.action} → ${t.scriptName}${modes}${param}${field}`);
    }
  } else if (d?.kind === "layoutObject") {
    parts.push(`type: ${d.loType}`);
    if (d.fieldRef)    parts.push(`field: ${d.fieldRef}`);
    if (d.scriptRef)   parts.push(`script: ${d.scriptRef.name}`);
    if (d.actionStep)  parts.push(`action: ${d.actionStep.name}${d.actionStep.params ? ` [ ${d.actionStep.params} ]` : ""}`);
    if (d.portalTable) parts.push(`portal: ${d.portalTable}${d.portalRows != null ? ` (${d.portalRows} rows)` : ""}`);
    if (d.info)        parts.push(`info: ${d.info}`);
    if (d.tooltip)     parts.push(`tooltip: ${d.tooltip}`);
    if (d.style)       parts.push("style:", ...d.style.split("\n").map((l) => `  ${l}`));
    for (const t of d.triggers ?? []) {
      parts.push(`trigger: ${t.action} → ${t.scriptName}${t.parameter ? ` param: ${t.parameter}` : ""}`);
    }
  } else if (d?.kind === "privilegeSet") {
    for (const t of d.tables) {
      const view = t.viewCondition ? `${t.view} (${t.viewCondition})` : t.view;
      const edit = t.editCondition ? `${t.edit} (${t.editCondition})` : t.edit;
      const del = t.deleteCondition ? `${t.delete} (${t.deleteCondition})` : t.delete;
      parts.push(`${t.table}: view=${view} edit=${edit} create=${t.create} delete=${del} fields=${t.fieldsAccess}`);
      for (const f of t.fields ?? []) {
        parts.push(`  ${t.table}.${f.field}: ${f.access}`);
      }
    }
  } else {
    // No structured detail (globalVariable, table, file, …): include any text
    // content the parser collected from child text nodes, UUID-stripped.
    if (obj.text) parts.push(obj.text.replace(UUID_RE, ""));
  }

  return parts.join("\n");
}

/**
 * Unified line diff via longest-common-subsequence. Inputs are small (script
 * steps, calc lines), so the O(m·n) table is cheap.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: "removed", text: a[i++]! });
  while (j < n) out.push({ kind: "added", text: b[j++]! });
  return out;
}

export function diffAnalyses(
  a: ParseResult,
  b: ParseResult,
  brokenCountA: number,
  brokenCountB: number,
  opts: DiffOptions = DEFAULT_DIFF_OPTIONS,
): AnalysisDiff {
  const noise = buildNoise(opts);
  const byFile = opts.diffByFileId ? scopeAndAlignByFile(a, b) : { scopedA: a, scopedB: b };
  const excluded = excludedTypes(opts);
  const withoutExcluded = <T extends { objects: FmObject[] }>(side: T): T =>
    excluded.size ? { ...side, objects: side.objects.filter((o) => !excluded.has(o.type)) } : side;
  const scopedA = withoutExcluded(byFile.scopedA);
  const scopedB = withoutExcluded(byFile.scopedB);
  const aByUid = new Map(scopedA.objects.map((o) => [o.uid, o]));
  const bByUid = new Map(scopedB.objects.map((o) => [o.uid, o]));

  const added: ObjectChange[] = [];
  const removed: ObjectChange[] = [];
  const renamed: ObjectChange[] = [];
  const changed: ObjectChange[] = [];

  for (const obj of scopedB.objects) {
    const prior = aByUid.get(obj.uid);
    if (!prior) {
      added.push({ uid: obj.uid, type: obj.type, name: displayLabel(obj, bByUid), isSeparator: obj.isSeparator });
      continue;
    }
    if (obj.isSeparator) continue; // matched pair, same divider — no content to compare
    if (prior.name !== obj.name) {
      renamed.push({
        uid: obj.uid,
        type: obj.type,
        name: displayLabel(obj, bByUid),
        previousName: displayLabel(prior, aByUid),
      });
    }
    const before = contentOf(prior, noise);
    const after = contentOf(obj, noise);
    if (before !== after) {
      changed.push({ uid: obj.uid, type: obj.type, name: displayLabel(obj, bByUid), before, after });
    }
  }
  for (const obj of scopedA.objects) {
    if (!bByUid.has(obj.uid)) {
      removed.push({ uid: obj.uid, type: obj.type, name: displayLabel(obj, aByUid), isSeparator: obj.isSeparator });
    }
  }

  return {
    objectCountA: scopedA.objects.length,
    objectCountB: scopedB.objects.length,
    referenceCountA: scopedA.references.length,
    referenceCountB: scopedB.references.length,
    brokenCountA,
    brokenCountB,
    countsByType: buildCountsByType(scopedA.objects, scopedB.objects, added, removed, changed),
    added: added.sort(compareChanges),
    removed: removed.sort(compareChanges),
    renamed: renamed.sort(compareChanges),
    changed: changed.sort(compareChanges),
  };
}
