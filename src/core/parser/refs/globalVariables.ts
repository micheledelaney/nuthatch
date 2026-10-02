/**
 * Global variables ($$name) have no catalog — they exist only where FileMaker
 * reads or sets them. The element scan records each use as a `globalVariable`
 * edge from exact export data: the `VariableReference` chunks of calculation
 * chunk lists, and the variable a Set Variable (or "Target: $$x") step writes —
 * with a scan of the formula itself only for a calc whose chunk list is
 * unusable. Best-effort: a variable handled by name is only caught when the
 * whole name is one string literal (`Map.Clear ( "$$_MAP" )`); names built
 * dynamically (e.g. via Evaluate) can't be detected.
 *
 * Two kinds of use show only in text, and are picked up here: a layout can merge
 * a variable (`<<$$name>>`), which no chunk records, and a data source's path
 * list can name one (`$$path`), which FileMaker resolves when it opens the file.
 */
import type { FmObject } from "@/types/ddr";
import type { FileParse } from "../context";
import { objectUid } from "../uid";
import { globalVariableRef } from "./refBuilders";

const MERGE_VARIABLE_RE = /<<(\$\$[^<>]+)>>/g;

/** The `$$globals` a data source's path list names. A variable is a whole path
 * entry; entries are space-separated but may contain spaces themselves, so split
 * where the next entry's scheme prefix (or `$`) begins. */
function pathListGlobals(pathList: string): string[] {
  return pathList
    .split(/\s+(?=(?:file|filemac|filewin|filelinux|fmnet|fmp)\s*:|\$)/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("$$"));
}

/** The text-only global-variable uses (data-source paths, layout merge
 * variables) of a batch of objects. Layout text is scanned in full, so this
 * runs before the layout is compacted. */
export function addTextGlobalRefs(fp: FileParse, batch: readonly FmObject[]): void {
  for (const obj of batch) {
    if (obj.type !== "externalDataSource") continue;
    for (const name of pathListGlobals(obj.attributes.path ?? "")) fp.references.push(globalVariableRef(obj.uid, name));
  }
  for (const obj of batch) {
    if ((obj.type !== "layout" && obj.type !== "layoutObject") || !obj.text.includes("<<$$")) continue;
    // One reference per merge, so every use counts (dedupeRefs collapses them).
    for (const m of obj.text.matchAll(MERGE_VARIABLE_RE)) fp.references.push(globalVariableRef(obj.uid, m[1]!.trim()));
  }
}

/** One navigable object per distinct `$$name` the file uses (the same $$x in two
 * files is two objects), so a variable lists its users and each script/calc the
 * globals it touches. `occurrences` counts uses before references are
 * de-duplicated, so a calc that reads $$x twice counts two. A use on a layout
 * is recorded by the layout object and by its layout; it counts once. */
export function globalVariableObjects(fp: FileParse): FmObject[] {
  const layoutObjectUids = new Set(fp.objects.filter((o) => o.type === "layoutObject").map((o) => o.uid));
  const counts = new Map<string, number>();
  for (const ref of fp.references) {
    if (ref.toType !== "globalVariable" || layoutObjectUids.has(ref.fromUid)) continue;
    counts.set(ref.toId, (counts.get(ref.toId) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({
    uid: objectUid(fp.file.uid, "globalVariable", name),
    type: "globalVariable",
    id: name,
    name,
    fileUid: fp.file.uid,
    fileName: fp.file.name,
    attributes: { occurrences: String(count) },
    text: name,
  }));
}
