/**
 * Runs the real parser + model on a set of FMSaveAsXML exports and indexes the
 * result by the names the test-solution oracles use: "<FILE>:<type>:<name>",
 * with FILE = MAIN (TEST_MAIN) or EXT (TEST_EXT), fields as "Table::field" and
 * relationships as "LeftTO → RightTO".
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { decodeFile } from "@/state/loadFiles";
import type { FmObject, ReportCard } from "@/types/ddr";

/** One outbound edge, with its target named like an oracle edge target. */
export interface ActualEdge {
  /** A resolved ref, or "broken:<type>" / "unresolved:<type>". */
  to: string;
  kind: string;
  via?: string;
  step?: number;
  disabled: boolean;
  toName: string;
}

export interface Snapshot {
  objects: FmObject[];
  byUid: Map<string, FmObject>;
  /** uid → oracle ref. */
  refOf: Map<string, string>;
  edgesFrom: Map<string, ActualEdge[]>;
  /** Oracle refs of the unreferenced objects (ignored types left out). */
  unreferenced: Set<string>;
  /** globalVariable name → the refs of every object (and its ancestors) using it. */
  globalUsers: Map<string, Set<string>>;
  reportCard: ReportCard;
  errors: string[];
}

function fileTag(name: string): string {
  if (name.toUpperCase().startsWith("TEST_MAIN")) return "MAIN";
  if (name.toUpperCase().startsWith("TEST_EXT")) return "EXT";
  return name;
}

/** A file decoded the way the app does it (FM 22 exports are UTF-16). */
function readExport(path: string): string {
  const bytes = readFileSync(path);
  return decodeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export function loadSnapshot(paths: string[], ignoredTypes: ReadonlySet<string>): Snapshot {
  const parsed = parseDocuments(paths.map((p) => ({ name: basename(p), content: readExport(p) })));
  const model = buildModel(parsed);
  const tags = new Map(parsed.files.map((f) => [f.uid, fileTag(f.name)]));
  const byUid = new Map(parsed.objects.map((o) => [o.uid, o]));

  const refOf = new Map<string, string>();
  for (const o of parsed.objects) {
    const file = tags.get(o.fileUid) ?? "?";
    if (o.type === "field") {
      const table = byUid.get(o.parentUid ?? "")?.name ?? "?";
      refOf.set(o.uid, `${file}:field:${table}::${o.name}`);
    } else if (o.type === "relationship" && o.detail?.kind === "relationship") {
      refOf.set(o.uid, `${file}:relationship:${o.detail.leftTable} → ${o.detail.rightTable}`);
    } else {
      refOf.set(o.uid, `${file}:${o.type}:${o.name}`);
    }
  }

  const edgesFrom = new Map<string, ActualEdge[]>();
  for (const r of model.references) {
    if (ignoredTypes.has(r.toType)) continue;
    const to = r.toUid ? (refOf.get(r.toUid) ?? `?${r.toUid}`) : `${r.broken ? "broken" : "unresolved"}:${r.toType}`;
    const edge: ActualEdge = {
      to,
      kind: r.kind,
      disabled: Boolean(r.disabled),
      toName: r.toName,
      ...(r.viaUid ? { via: refOf.get(r.viaUid) } : {}),
      ...(r.fromStep != null ? { step: r.fromStep } : {}),
    };
    edgesFrom.set(r.fromUid, [...(edgesFrom.get(r.fromUid) ?? []), edge]);
  }

  const snapshot: Snapshot = {
    objects: parsed.objects,
    byUid,
    refOf,
    edgesFrom,
    unreferenced: new Set(
      model.unreferenced.filter((o) => !ignoredTypes.has(o.type)).map((o) => refOf.get(o.uid) ?? o.uid),
    ),
    globalUsers: new Map(),
    reportCard: model.reportCard,
    errors: parsed.errors,
  };

  for (const g of parsed.objects.filter((o) => o.type === "globalVariable")) {
    const users = new Set<string>();
    for (const r of model.references) {
      if (r.toUid !== g.uid) continue;
      for (const uid of ancestors(snapshot, r.fromUid)) users.add(refOf.get(uid) ?? uid);
    }
    snapshot.globalUsers.set(g.name, users);
  }
  return snapshot;
}

/** The object and every container above it (layout object → … → layout, field → table). */
export function ancestors(snapshot: Snapshot, uid: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = uid;
  while (current != null && snapshot.byUid.has(current) && chain.length < 64) {
    chain.push(current);
    current = snapshot.byUid.get(current)?.parentUid;
  }
  return chain;
}

/** Every object at or below the given ones in the containment tree. */
export function descendants(snapshot: Snapshot, uids: string[]): string[] {
  const roots = new Set(uids);
  return snapshot.objects.map((o) => o.uid).filter((uid) => ancestors(snapshot, uid).some((a) => roots.has(a)));
}

/** A relationship ref with its two occurrences in a fixed order, so "A → B" matches "B → A". */
export function canonicalRelationship(ref: string): string {
  const m = /^(\w+):relationship:(.+) → (.+)$/.exec(ref);
  return m ? `${m[1]}:relationship:${[m[2], m[3]].sort().join(" ↔ ")}` : ref;
}

/** The uids an oracle ref names (relationships match in either direction). */
export function lookup(snapshot: Snapshot, ref: string): string[] {
  const want = ref.includes(":relationship:") ? canonicalRelationship(ref) : ref;
  const uids: string[] = [];
  for (const [uid, r] of snapshot.refOf) {
    if ((ref.includes(":relationship:") ? canonicalRelationship(r) : r) === want) uids.push(uid);
  }
  return uids;
}
