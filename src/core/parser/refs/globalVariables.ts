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
import type { FileParse, TextScan } from "../context";
import { objectUid } from "../uid";
import { newObject } from "../objects/catalogItems";
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

/** The `$$globals` the data sources in a batch of objects name in their path lists. */
export function addDataSourcePathGlobalRefs(fp: FileParse, batch: readonly TextScan[]): void {
  for (const { obj } of batch) {
    if (obj.type !== "externalDataSource") continue;
    for (const name of pathListGlobals(obj.attributes.path ?? "")) fp.references.push(globalVariableRef(obj.uid, name));
  }
}

/** The `$$globals` merged into a layout's or layout object's own element text
 * (`<<$$name>>`): one reference per merge, so every use counts (dedupeRefs
 * collapses them). */
export function addMergeVariableRefs(fp: FileParse, fromUid: string, text: string): void {
  if (!text.includes("<<$$")) return;
  for (const m of text.matchAll(MERGE_VARIABLE_RE)) fp.references.push(globalVariableRef(fromUid, m[1]!.trim()));
}

/** One navigable object per distinct `$$name` the file uses (the same $$x in two
 * files is two objects; `$$x` and `$$X` in one file are one, see
 * globalVariableRef), so a variable lists its users and each script/calc the
 * globals it touches. It's named by its most used spelling (the first, of
 * equally used ones); its text holds every spelling, for search.
 * `occurrences` counts uses before references are de-duplicated, so a calc
 * that reads $$x twice counts two. A use on a layout object is copied onto its
 * layout (addObjectRefsToLayout); it counts once. */
export function globalVariableObjects(fp: FileParse): FmObject[] {
  const layoutObjectUids = new Set(fp.objects.filter((o) => o.type === "layoutObject").map((o) => o.uid));
  const spellingsById = new Map<string, Map<string, number>>();
  for (const ref of fp.references) {
    if (ref.toType !== "globalVariable" || layoutObjectUids.has(ref.fromUid)) continue;
    const spellings = spellingsById.get(ref.toId) ?? new Map<string, number>();
    spellings.set(ref.toName, (spellings.get(ref.toName) ?? 0) + 1);
    spellingsById.set(ref.toId, spellings);
  }
  return [...spellingsById].map(([id, spellings]) => {
    const uses = [...spellings];
    const [name] = uses.reduce((most, use) => (use[1] > most[1] ? use : most));
    return newObject(fp.file, {
      uid: objectUid(fp.file.uid, "globalVariable", id),
      type: "globalVariable",
      id,
      name,
      attributes: { occurrences: String(uses.reduce((sum, [, count]) => sum + count, 0)) },
      text: [...spellings.keys()].join(" "),
    });
  });
}
