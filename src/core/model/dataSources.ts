import type { FmFile, FmObject } from "@/types/ddr";

/**
 * Which loaded file an external data source points at.
 *
 * A data source's NAME is whatever the developer typed in Manage External Data
 * Sources — "Local File", "Adressen 2", "Einzelauftragauftrag" — and often
 * differs from the file it opens, so matching it against loaded file names is
 * the last resort. In order of trust:
 *
 *   1. Base-table UUIDs. An external occurrence records its base table's UUID,
 *      which identifies that table in exactly one loaded file (unless two copies
 *      of the same file are loaded — then this step abstains).
 *   2. The data source's path list (`file:Adressen`, `fmnet:/host/Adressen`,
 *      `filemac:/HD/…/Adressen.fmp12`) — the file name at the end of each path.
 *   3. The data source's name.
 *
 * A variable path (`$$_path_local`) has no usable file name, so such a source
 * resolves through its occurrences' UUIDs or not at all.
 */
export interface DataSourceIndex {
  /** The loaded file a data source — named from within `fromFileUid` — opens. */
  fileFor(fromFileUid: string, dataSourceName: string): string | undefined;
  /** The loaded file holding an external occurrence's base table. */
  fileForOccurrence(occurrence: FmObject): string | undefined;
}

/** FileMaker file / data-source names match case-insensitively, ignoring the
 * `.fmp12` extension. */
export function normalizeFileName(name: string): string {
  return name.trim().toLowerCase().replace(/\.fmp12$/, "");
}

const PATH_PREFIX_RE = /^(?:file|filemac|filewin|filelinux|fmnet|fmp)\s*:/i;

/** The file names at the end of each entry of a data source's path list. */
function pathFileNames(pathList: string): string[] {
  const names: string[] = [];
  // Entries are newline-separated in the XML, which reaches us as spaces; split
  // on each entry's scheme prefix instead (paths themselves may contain spaces).
  for (const entry of pathList.split(/\s+(?=(?:file|filemac|filewin|filelinux|fmnet|fmp)\s*:)/i)) {
    const trimmed = entry.trim();
    if (!PATH_PREFIX_RE.test(trimmed)) continue;
    const last = trimmed.replace(PATH_PREFIX_RE, "").split("/").pop()?.trim();
    if (last) names.push(normalizeFileName(last));
  }
  return names;
}

export function buildDataSourceIndex(objects: readonly FmObject[], files: readonly FmFile[]): DataSourceIndex {
  const fileByName = new Map<string, string>();
  for (const f of files) fileByName.set(normalizeFileName(f.name), f.uid);

  const tableFilesByUuid = new Map<string, Set<string>>();
  const sourcesByKey = new Map<string, FmObject>();
  for (const o of objects) {
    if (o.type === "table" && o.attributes.uuid) {
      const set = tableFilesByUuid.get(o.attributes.uuid) ?? new Set<string>();
      set.add(o.fileUid);
      tableFilesByUuid.set(o.attributes.uuid, set);
    } else if (o.type === "externalDataSource") {
      sourcesByKey.set(sourceKey(o.fileUid, o.name), o);
    }
  }

  const byUuid = (occurrence: FmObject): string | undefined => {
    const uuid = occurrence.attributes.baseTableUuid;
    const candidates = uuid ? tableFilesByUuid.get(uuid) : undefined;
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  };

  // Votes from each data source's occurrences whose base table was found by UUID.
  const votes = new Map<string, Map<string, number>>();
  for (const o of objects) {
    const source = o.attributes.externalDataSource;
    if (o.type !== "tableOccurrence" || source == null) continue;
    const target = byUuid(o);
    if (target == null) continue;
    const key = sourceKey(o.fileUid, source);
    const tally = votes.get(key) ?? new Map<string, number>();
    tally.set(target, (tally.get(target) ?? 0) + 1);
    votes.set(key, tally);
  }

  const cache = new Map<string, string | undefined>();
  const fileFor = (fromFileUid: string, dataSourceName: string): string | undefined => {
    const key = sourceKey(fromFileUid, dataSourceName);
    if (cache.has(key)) return cache.get(key);
    let target: string | undefined;
    const tally = votes.get(key);
    if (tally) target = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (target == null) {
      const path = sourcesByKey.get(key)?.attributes.path;
      const matches = new Set(pathFileNames(path ?? "").map((n) => fileByName.get(n)).filter((u): u is string => u != null));
      if (matches.size === 1) target = [...matches][0];
    }
    if (target == null) target = fileByName.get(normalizeFileName(dataSourceName));
    cache.set(key, target);
    return target;
  };

  return {
    fileFor,
    fileForOccurrence: (occurrence) => {
      const source = occurrence.attributes.externalDataSource;
      return byUuid(occurrence) ?? (source != null ? fileFor(occurrence.fileUid, source) : undefined);
    },
  };
}

function sourceKey(fileUid: string, dataSourceName: string): string {
  return `${fileUid}|${dataSourceName.trim()}`;
}
