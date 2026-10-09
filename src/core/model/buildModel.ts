import type {
  FmObject,
  FmReference,
  ObjectType,
  ParseResult,
  RawReference,
  SolutionModel,
  UsageMark,
} from "@/types/ddr";
import { ORPHAN_CANDIDATE_TYPES, isBrokenTableOccurrence } from "@/types/ddr";
import { buildReportCard } from "@/core/analysis/reportCard";
import { brokenSources, countsAsUse } from "@/core/analysis/dependencies";
import { findUnusedChains } from "@/core/analysis/unusedChains";
import { resolveMarks } from "@/core/analysis/usageMarks";
import { longestPrefixName } from "@/core/identifiers";
import { buildDataSourceIndex, type DataSourceIndex } from "./dataSources";

/**
 * Reference target types resolved by simple (file, type, id) lookup and flagged
 * broken when missing. Fields are handled separately (resolveFieldReference)
 * because their ids are unique only per base table and need occurrence context.
 */
const RESOLVABLE: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "script",
  "layout",
  "table",
  "tableOccurrence",
  "valueList",
  "customFunction",
  "externalDataSource",
  "customMenuSet",
]);

/**
 * Turn a flat ParseResult into a fully indexed, analyzed SolutionModel, with
 * the project's usage marks applied. Pure and synchronous — fast even for
 * large solutions.
 */
export function buildModel(parsed: ParseResult, marks: readonly UsageMark[] = []): SolutionModel {
  const byUid = new Map<string, FmObject>();
  for (const obj of parsed.objects) byUid.set(obj.uid, obj);

  // Calculation fields get their relationship depth on a copy: the parse
  // result itself is left as it was.
  const depths = relationshipDepths(parsed, byUid);
  const objects = parsed.objects.map((obj) => {
    const relationshipDepth = depths.get(obj.uid);
    if (relationshipDepth == null) return obj;
    const withDepth = { ...obj, relationshipDepth };
    byUid.set(obj.uid, withDepth);
    return withDepth;
  });

  const references = resolveReferences(parsed, byUid);

  const outbound = new Map<string, FmReference[]>();
  const inbound = new Map<string, FmReference[]>();
  for (const ref of references) {
    push(outbound, ref.fromUid, ref);
    if (ref.toUid) push(inbound, ref.toUid, ref);
  }

  const brokenReferences = references.filter((r) => r.broken);

  return withUsageMarks(
    {
      files: parsed.files,
      objects,
      byUid,
      references,
      outbound,
      inbound,
      brokenReferences,
      parseErrors: parsed.errors,
    },
    marks,
  );
}

/** A model before the parts that depend on usage marks. */
type ResolvedModel = Omit<SolutionModel, "unreferenced" | "unusedChain" | "usageMarks" | "reportCard">;

/**
 * The model with `marks` applied: marked objects count as in use, so they and
 * everything they reach leave the unreferenced list and the unused chains.
 * Recomputes only what marks affect, so marking an object doesn't re-resolve
 * the solution's references.
 */
export function withUsageMarks(model: ResolvedModel, marks: readonly UsageMark[]): SolutionModel {
  const usageMarks = resolveMarks(model.objects, marks);
  const marked = new Set(usageMarks.keys());
  const unreferenced = findUnreferenced(model.objects, model.inbound, model.byUid).filter((o) => !marked.has(o.uid));
  const unusedChain = findUnusedChains(model.objects, model.outbound, model.byUid, unreferenced, marked);
  const reportCard = buildReportCard(
    model,
    model.references,
    brokenSources(model),
    unreferenced,
    unusedChain,
    marked.size,
  );
  return { ...model, unreferenced, unusedChain, usageMarks, reportCard };
}

/**
 * Where the base table a table occurrence reads from actually lives. For a local
 * occurrence that is its own file; for an external occurrence it is the data
 * source's file — resolved to a real file uid only when that file is also loaded
 * (otherwise `fileLoaded` is false and references through it stay best-effort).
 */
interface OccurrenceTarget {
  fileUid: string;
  baseTableId: string;
  external: boolean;
  fileLoaded: boolean;
}

function resolveReferences(parsed: ParseResult, byUid: Map<string, FmObject>): FmReference[] {
  const sources = buildDataSourceIndex(parsed.objects, parsed.files);
  const occByUid = mapOccurrences(parsed.objects, sources);
  const fieldsByTable = mapFieldsByTable(parsed.objects);

  return parsed.references.map((raw) => {
    const fileUid = raw.fromUid.split(":")[0] ?? "";

    // The DDR explicitly marked the target deleted (e.g. a `<Field Missing>`
    // placeholder in a calculation), so it is broken regardless of lookup.
    // The occurrence (viaToId) survives the field deletion, so resolve it here
    // too — keeps the occurrence clickable inline (a broken reference has no
    // target, so it's in no object's inbound references).
    if (raw.forceBroken) {
      const viaUid = raw.viaToId != null ? `${fileUid}:tableOccurrence:${raw.viaToId}` : undefined;
      return { ...base(raw), toUid: null, broken: true, ...(viaUid ? { viaUid } : {}) };
    }

    if (raw.toType === "field") {
      return resolveFieldReference(raw, fileUid, byUid, occByUid, fieldsByTable, sources);
    }
    if (raw.toType === "table") {
      return resolveTableReference(raw, fileUid, byUid, occByUid);
    }

    // A reference into an external file (e.g. Perform Script in another file)
    // resolves against that file when loaded; if it isn't, treat it as external
    // (best-effort, never broken) rather than a broken same-file reference.
    if (raw.toFileName != null) {
      const targetFileUid = sources.fileFor(fileUid, raw.toFileName);
      if (targetFileUid == null) return { ...base(raw), toUid: null, broken: false };
      // Empty toId: script was unknown at DDR export time (external file not open).
      // The file reference is still valid — show as an external leaf, not broken.
      if (!raw.toId) return { ...base(raw), toUid: null, broken: false };
      const externalUid = `${targetFileUid}:${raw.toType}:${raw.toId}`;
      const found = byUid.has(externalUid);
      return { ...base(raw), toUid: found ? externalUid : null, broken: !found && RESOLVABLE.has(raw.toType) };
    }

    const targetUid = `${fileUid}:${raw.toType}:${raw.toId}`;
    const resolved = byUid.get(targetUid);
    const isResolvable = RESOLVABLE.has(raw.toType);
    return {
      ...base(raw),
      toUid: resolved ? targetUid : null,
      // Only flag as broken when we expected to resolve it within the file.
      broken: !resolved && isResolvable,
    };
  });
}

/**
 * Resolve a base-table reference. When it originates from a table occurrence we
 * resolve against the occurrence's real base-table file — which may be another
 * loaded file (cross-file). A reference into a file the user has not loaded is
 * external, so best-effort (never broken).
 */
function resolveTableReference(
  raw: RawReference,
  sourceFileUid: string,
  byUid: Map<string, FmObject>,
  occByUid: Map<string, OccurrenceTarget>,
): FmReference {
  const from = byUid.get(raw.fromUid);
  const occ = from?.type === "tableOccurrence" ? occByUid.get(from.uid) : undefined;
  if (occ?.external && !occ.fileLoaded) {
    return { ...base(raw), toUid: null, broken: false };
  }
  const fileUid = occ ? occ.fileUid : sourceFileUid;
  const targetUid = `${fileUid}:table:${raw.toId}`;
  const resolved = byUid.has(targetUid);
  return { ...base(raw), toUid: resolved ? targetUid : null, broken: !resolved };
}

/**
 * Resolve a field reference through the table occurrence it reads from. The
 * occurrence is looked up within the *referencing* file (so same-named
 * occurrences in different files never cross-contaminate), then the field is
 * resolved in the occurrence's base-table file — local or, for an external
 * occurrence, another loaded file. A field on an external/unparsed table (its
 * file not loaded, or no usable occurrence context) stays best-effort.
 */
function resolveFieldReference(
  raw: RawReference,
  sourceFileUid: string,
  byUid: Map<string, FmObject>,
  occByUid: Map<string, OccurrenceTarget>,
  fieldsByTable: Map<string, Map<string, FmObject>>,
  sources: DataSourceIndex,
): FmReference {
  // The occurrence is looked up within the referencing file, so same-named
  // occurrences in different files never cross-contaminate.
  const viaOccUid = raw.viaToId != null ? `${sourceFileUid}:tableOccurrence:${raw.viaToId}` : undefined;
  const occ = viaOccUid != null ? occByUid.get(viaOccUid) : undefined;
  if (raw.byName) {
    // A name recovered from calc text: the longest field of the occurrence's base
    // table that the text starts with. Heuristic, so no match is simply
    // unresolved — never broken; when the occurrence's file is loaded, that
    // no-match is `unmatched` (the file is there, the name isn't).
    const fields = occ?.fileLoaded ? fieldsByTable.get(`${occ.fileUid}:table:${occ.baseTableId}`) : undefined;
    const name = fields ? longestPrefixName(raw.toName, fields.keys()) : undefined;
    const field = name != null ? fields?.get(name) : undefined;
    const via = viaOccUid ? { viaUid: viaOccUid } : {};
    if (field) return { ...base(raw), toId: field.id, toName: field.name, toUid: field.uid, broken: false, ...via };
    const viaObj = viaOccUid != null ? byUid.get(viaOccUid) : undefined;
    const unmatched = viaObj != null && sources.fileForOccurrence(viaObj) != null;
    return { ...base(raw), toUid: null, broken: false, ...via, ...(unmatched ? { unmatched: true } : {}) };
  }
  if (occ && !(occ.external && !occ.fileLoaded)) {
    const targetUid = `${occ.fileUid}:field:${occ.baseTableId}.${raw.toId}`;
    const resolved = byUid.has(targetUid);
    return { ...base(raw), toUid: resolved ? targetUid : null, broken: !resolved, viaUid: viaOccUid };
  }
  // An external occurrence whose file isn't loaded, so the field can't be
  // looked up — but FileMaker had that file open at export (the occurrence has
  // its base table recorded) and still left the field's name blank: it was
  // deleted (`TO::<Field Missing>`), as the parser reads it.
  if (occ && raw.toName === "") return { ...base(raw), toUid: null, broken: true, viaUid: viaOccUid };
  // No usable occurrence context. A field reference that names its base table
  // directly (e.g. a summary field summarizing a field in its own table)
  // resolves within the referencing file's matching base table.
  if (raw.viaBaseTableId != null) {
    const targetUid = `${sourceFileUid}:field:${raw.viaBaseTableId}.${raw.toId}`;
    return { ...base(raw), toUid: byUid.has(targetUid) ? targetUid : null, broken: !byUid.has(targetUid), viaUid: viaOccUid };
  }
  // The occurrence the field is read through is unusable: either gone entirely —
  // a `<Table Missing>` sentinel (id "-1"), so it never appears in the model — or
  // present but itself broken (external, base table gone via an `<unknown>` data
  // source, so it never entered occByUid). Either way the field is definitively
  // unreachable, not merely unloaded, so flag it broken (this is what makes a
  // relationship / script joining through a dead occurrence read as broken). A
  // valid external occurrence whose file simply isn't loaded keeps `broken: false`.
  const viaObj = viaOccUid != null ? byUid.get(viaOccUid) : undefined;
  const brokenVia = viaOccUid != null && (viaObj == null || isBrokenTableOccurrence(viaObj));
  return { ...base(raw), toUid: null, broken: brokenVia, viaUid: viaOccUid };
}

/**
 * Index table occurrences by their (globally unique) uid, resolving each to the
 * file + base-table its fields actually live in. Built from occurrence objects —
 * annotated by the parser with baseTableId and, when external, the data source
 * and base-table UUID — so an external occurrence maps to the loaded file that
 * holds its base table (see buildDataSourceIndex).
 */
function mapOccurrences(objects: FmObject[], sources: DataSourceIndex): Map<string, OccurrenceTarget> {
  const byUid = new Map<string, OccurrenceTarget>();
  for (const obj of objects) {
    if (obj.type !== "tableOccurrence") continue;
    const baseTableId = obj.attributes.baseTableId;
    if (baseTableId == null) continue;

    const external = obj.attributes.type === "External" || obj.attributes.externalDataSource != null;
    const targetFileUid = external ? sources.fileForOccurrence(obj) : obj.fileUid;
    byUid.set(obj.uid, {
      fileUid: targetFileUid ?? obj.fileUid,
      baseTableId,
      external,
      fileLoaded: targetFileUid != null,
    });
  }
  return byUid;
}

/** Fields by their base table's uid, then by name (for name-based references). */
function mapFieldsByTable(objects: FmObject[]): Map<string, Map<string, FmObject>> {
  const byTable = new Map<string, Map<string, FmObject>>();
  for (const obj of objects) {
    if (obj.type !== "field" || !obj.parentUid) continue;
    const fields = byTable.get(obj.parentUid) ?? new Map<string, FmObject>();
    if (!fields.has(obj.name)) fields.set(obj.name, obj);
    byTable.set(obj.parentUid, fields);
  }
  return byTable;
}

/**
 * Each calculation field's uid → how deep through the relationship graph its
 * references reach (max relationship hops from the field's context
 * occurrence to any occurrence it reads a field through). The occurrence graph
 * is built once from relationship→occurrence edges; BFS distances are cached per
 * context occurrence, so thousands of calc fields share a handful of searches.
 */
function relationshipDepths(parsed: ParseResult, byUid: Map<string, FmObject>): Map<string, number> {
  // Occurrence adjacency: every relationship links its two table occurrences.
  const relOccs = new Map<string, string[]>();
  for (const raw of parsed.references) {
    if (raw.toType !== "tableOccurrence") continue;
    if (byUid.get(raw.fromUid)?.type !== "relationship") continue;
    const fileUid = raw.fromUid.split(":")[0] ?? "";
    const list = relOccs.get(raw.fromUid) ?? [];
    list.push(`${fileUid}:tableOccurrence:${raw.toId}`);
    relOccs.set(raw.fromUid, list);
  }
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const occs of relOccs.values()) {
    for (let i = 0; i < occs.length; i++) {
      for (let j = i + 1; j < occs.length; j++) link(occs[i]!, occs[j]!);
    }
  }

  // Field references that read through an occurrence, grouped by source field.
  const refsByField = new Map<string, RawReference[]>();
  for (const raw of parsed.references) {
    if (raw.toType !== "field" || raw.viaToId == null) continue;
    const list = refsByField.get(raw.fromUid) ?? [];
    list.push(raw);
    refsByField.set(raw.fromUid, list);
  }

  // BFS hop-distance from a source occurrence to every reachable occurrence, cached.
  const distCache = new Map<string, Map<string, number>>();
  const distFrom = (src: string): Map<string, number> => {
    const cached = distCache.get(src);
    if (cached) return cached;
    const dist = new Map<string, number>([[src, 0]]);
    const queue = [src];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      const d = dist.get(cur)!;
      for (const nb of adj.get(cur) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          queue.push(nb);
        }
      }
    }
    distCache.set(src, dist);
    return dist;
  };

  // Every calculation field gets a depth — 0 when it stays in its own table,
  // otherwise the deepest relationship hop it reaches through. (Summary fields
  // summarize a field in their own table, so depth is never meaningful for them.)
  const depths = new Map<string, number>();
  for (const field of parsed.objects) {
    if (field.type !== "field" || field.detail?.kind !== "calculation") continue;
    const refs = refsByField.get(field.uid);
    const ctx = field.attributes.calcContextToId;
    let max = 0;
    if (refs && ctx != null) {
      const fileUid = field.uid.split(":")[0] ?? "";
      const dist = distFrom(`${fileUid}:tableOccurrence:${ctx}`);
      for (const r of refs) {
        const d = dist.get(`${fileUid}:tableOccurrence:${r.viaToId}`);
        if (d != null && d > max) max = d;
      }
    }
    depths.set(field.uid, max);
  }
  return depths;
}

function base(raw: RawReference) {
  return {
    fromUid: raw.fromUid,
    toType: raw.toType,
    toId: raw.toId,
    toName: raw.toName,
    kind: raw.kind,
    ...(raw.fromStep != null ? { fromStep: raw.fromStep } : {}),
    ...(raw.disabled ? { disabled: true } : {}),
  };
}

function findUnreferenced(
  objects: FmObject[],
  inbound: Map<string, FmReference[]>,
  byUid: Map<string, FmObject>,
): FmObject[] {
  return objects.filter(
    (obj) =>
      !obj.isSeparator &&
      ORPHAN_CANDIDATE_TYPES.has(obj.type) &&
      !(inbound.get(obj.uid) ?? []).some((ref) => countsAsUse(ref, obj.uid, byUid)),
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
