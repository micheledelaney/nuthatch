/**
 * What the app shows for a reference, decided once from the model's resolution
 * (buildModel): its status and the label FileMaker would show for its target.
 * The UI colours and labels references from these, never from names.
 */
import {
  OBJECT_TYPE_META,
  isUnresolvedTableOccurrence,
  objectLabel,
  type FmObject,
  type FmReference,
  type SolutionModel,
} from "@/types/ddr";
import { BROKEN_PLACEHOLDER_RE } from "@/core/identifiers";

/**
 * - ok: the target was found.
 * - broken: the target should be there and isn't (deleted).
 * - unverifiable: a field FileMaker left nameless behind an occurrence whose
 *   file wasn't available at export, so no one can tell whether it exists.
 * - external: the target lives in a file that isn't loaded.
 */
export type RefStatus = "ok" | "broken" | "unverifiable" | "external";

export function refStatus(ref: FmReference, byUid: ReadonlyMap<string, FmObject>): RefStatus {
  if (ref.broken) return "broken";
  if (ref.toUid) return "ok";
  const via = ref.viaUid ? byUid.get(ref.viaUid) : undefined;
  return ref.toType === "field" && ref.toName === "" && via != null && isUnresolvedTableOccurrence(via) ? "unverifiable" : "external";
}

/** The target as FileMaker shows it: a field as `Occurrence::Field` (FileMaker's
 * `<Field Missing>` when deleted, `<File Missing>` when its file wasn't
 * available at export, `<Table Missing>` for a deleted occurrence), anything
 * else by its name. */
export function refLabel(ref: FmReference, byUid: ReadonlyMap<string, FmObject>): string {
  const status = refStatus(ref, byUid);
  const target = ref.toUid ? byUid.get(ref.toUid) : undefined;
  if (ref.toType === "field") {
    const via = ref.viaUid ? byUid.get(ref.viaUid) : undefined;
    // An occurrence the reference names but the model doesn't have was deleted.
    const table = ref.viaUid
      ? (via?.name ?? "<Table Missing>")
      : target?.parentUid
        ? byUid.get(target.parentUid)?.name
        : undefined;
    const field =
      target?.name ||
      ref.toName ||
      (status === "unverifiable" ? "<File Missing>" : status === "broken" ? "<Field Missing>" : `(field ${ref.toId})`);
    return table ? `${table}::${field}` : field;
  }
  if (target) return objectLabel(target);
  if (ref.toName) return ref.toName;
  const type = OBJECT_TYPE_META[ref.toType].label;
  return status === "broken" ? `<${type} Missing>` : `${type} ${ref.toId}`;
}

/** A placeholder anywhere in a text (a non-global copy, safe for `.test()`). */
const HAS_PLACEHOLDER = new RegExp(BROKEN_PLACEHOLDER_RE.source);

const fieldRefCache = new WeakMap<SolutionModel, Map<string, Map<string, FmReference>>>();

/** An object's field references by the keys a `TO::Field` label can match them
 * on: the field's name, or, for a field FileMaker left nameless, its id
 * (`(field N)`) or any placeholder. The first reference wins. */
function fieldRefsOf(model: SolutionModel, ownerUid: string): Map<string, FmReference> {
  let byOwner = fieldRefCache.get(model);
  if (!byOwner) {
    byOwner = new Map();
    fieldRefCache.set(model, byOwner);
  }
  let refs = byOwner.get(ownerUid);
  if (refs) return refs;
  refs = new Map();
  const add = (key: string, ref: FmReference) => {
    if (!refs!.has(key)) refs!.set(key, ref);
  };
  for (const ref of model.outbound.get(ownerUid) ?? []) {
    if (ref.toType !== "field") continue;
    const via = ref.viaUid ? model.byUid.get(ref.viaUid) : undefined;
    const table = via ? `${via.name}::` : "";
    const name = (ref.toUid ? model.byUid.get(ref.toUid)?.name : undefined) ?? ref.toName;
    if (name && !HAS_PLACEHOLDER.test(name)) {
      add(`${table}${name}`, ref);
    } else {
      add(`${table}#${ref.toId}`, ref);
      add(`${table}<placeholder>`, ref);
    }
  }
  byOwner.set(ownerUid, refs);
  return refs;
}

/** The owner's own reference to the field a `TO::Field` label names, as the
 * parser writes it in an object's detail (a nameless field as `(field N)` or a
 * placeholder; a deleted occurrence as `<Table Missing>`). Undefined when the
 * owner has no such reference. */
export function ownFieldRef(model: SolutionModel, ownerUid: string, qualified: string): FmReference | undefined {
  const sep = qualified.indexOf("::");
  // A deleted occurrence isn't in the model: its references are keyed with none.
  const table = sep < 0 || HAS_PLACEHOLDER.test(qualified.slice(0, sep)) ? "" : qualified.slice(0, sep + 2);
  const field = sep < 0 ? qualified : qualified.slice(sep + 2);
  const refs = fieldRefsOf(model, ownerUid);
  const id = /^\(field (\d+)\)$/.exec(field)?.[1];
  if (id != null) return refs.get(`${table}#${id}`);
  if (HAS_PLACEHOLDER.test(field)) return refs.get(`${table}<placeholder>`);
  return refs.get(`${table}${field}`);
}
