import type {
  AccountFilter,
  AccountPwFilter,
  FieldFilter,
  LayoutFilter,
  LayoutObjectFilter,
  PrivCapFilter,
  RefFilter,
  RelFilter,
} from "@/state/store";
import { ORPHAN_CANDIDATE_TYPES, type FmObject, type ObjectType, type SolutionModel } from "@/types/ddr";
import { brokenSourcesFor } from "./refStats";

/** Types for which "unreferenced" is meaningful — the same set the report card
 * counts, so its Unreferenced number matches this filter. */
export const UNREF_ELIGIBLE: ReadonlySet<string> = ORPHAN_CANDIDATE_TYPES;

/** Types that can be the source of a (breakable) reference, so "Has broken
 * references" is meaningful for them. Types that reference nothing (tables,
 * themes, …) or whose references aren't tracked are excluded. */
export const BROKEN_ELIGIBLE: ReadonlySet<string> = new Set([
  "script",
  "layout",
  "valueList",
  "customFunction",
  "tableOccurrence",
  "relationship",
  "account",
  "customMenuSet",
  "field",
]);

/** FileMaker's full data-type set. `value` is the raw FMSaveAsXML `datatype`;
 * Container exports as "Binary", so it carries the user-facing label. */
export const DATA_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "Text", label: "Text" },
  { value: "Number", label: "Number" },
  { value: "Date", label: "Date" },
  { value: "Time", label: "Time" },
  { value: "Timestamp", label: "Timestamp" },
  { value: "Binary", label: "Container" },
];

/** Whether a field matches the active category/storage sub-filter.
 * FMSaveAsXML spells the field-kind attribute lowercase (`fieldtype`). */
export function matchesFieldFilter(o: FmObject, filter: FieldFilter): boolean {
  switch (filter) {
    case "normal":
      return o.attributes.fieldtype === "Normal";
    case "calculation":
      return o.attributes.fieldtype === "Calculated";
    case "summary":
      return o.attributes.fieldtype === "Summary";
    case "unstored":
      return o.attributes.unstored === "true";
    case "deepCalc":
      return o.attributes.unstored === "true" && (o.relationshipDepth ?? 0) >= 2;
    case "global":
      return o.attributes.global === "true";
    default:
      return true;
  }
}

/** Whether a relationship matches the active cascade sub-filter (the setting on
 * either side), mirroring the relationship-graph colors. */
export function matchesRelFilter(o: FmObject, filter: RelFilter): boolean {
  if (filter === "all") return true;
  const d = o.detail;
  if (!d || d.kind !== "relationship") return false;
  if (filter === "create") return !!(d.left?.cascadeCreate || d.right?.cascadeCreate);
  if (filter === "delete") return !!(d.left?.cascadeDelete || d.right?.cascadeDelete);
  return !!(d.left?.sorted || d.right?.sorted);
}

/** Whether an account matches the active/inactive sub-filter. */
export function matchesAccountFilter(o: FmObject, filter: AccountFilter): boolean {
  if (filter === "all") return true;
  const active = o.attributes.status !== "Inactive";
  return filter === "active" ? active : !active;
}

/** Whether an account matches the password sub-filter. */
export function matchesAccountPw(o: FmObject, filter: AccountPwFilter): boolean {
  if (filter === "all") return true;
  return filter === "none" ? o.attributes.password === "No" : o.attributes.password === "Yes";
}

/** Whether a privilege set grants a capability in ANY object category (records,
 * layouts, value lists, scripts). "Read-only" means none of create/edit/delete
 * are granted anywhere. The access summaries already spell the verbs out. */
export function matchesPrivCap(o: FmObject, filter: PrivCapFilter): boolean {
  if (filter === "all") return true;
  const a = o.attributes;
  const parts = [a.recordsAccess, a.layoutsAccess, a.valueListsAccess, a.scriptsAccess];
  // Custom record access has no summary verb of its own ("Custom" names the
  // mode, not what's granted) — fold in what each table actually grants so a
  // set that e.g. allows editing on any table doesn't read as read-only.
  if (a.recordsAccess === "Custom" && o.detail?.kind === "privilegeSet") {
    for (const t of o.detail.tables) {
      if (t.create !== "No") parts.push("Create");
      if (t.edit !== "No") parts.push("Edit");
      if (t.delete !== "No") parts.push("Delete");
    }
  }
  const access = parts.filter(Boolean).join(" | ");
  if (filter === "create") return /\bCreate\b/.test(access);
  if (filter === "edit") return /\bEdit\b/.test(access);
  if (filter === "delete") return /\bDelete\b/.test(access);
  return !/\b(Create|Edit|Delete)\b/.test(access); // read-only
}

/** Whether a layout has at least one layout-level script trigger. */
export function matchesLayoutFilter(o: FmObject, filter: LayoutFilter): boolean {
  if (filter === "all") return true;
  const d = o.detail;
  if (!d || d.kind !== "layout") return false;
  return d.triggers.length > 0;
}

/** Whether a layout object matches the selected loType. */
export function matchesLayoutObjectType(o: FmObject, loType: string): boolean {
  if (loType === "all") return true;
  const d = o.detail;
  return d?.kind === "layoutObject" ? d.loType === loType : false;
}

/** Whether a layout object has at least one object-level script trigger. */
export function matchesLayoutObjectFilter(o: FmObject, filter: LayoutObjectFilter): boolean {
  if (filter === "all") return true;
  const d = o.detail;
  if (!d || d.kind !== "layoutObject") return false;
  return (d.triggers?.length ?? 0) > 0;
}

const unreferencedCache = new WeakMap<SolutionModel, Set<string>>();

/** Whether an object counts as "unreferenced" (dimmed in lists, matched by the
 * Unreferenced chip) — exactly the model's own unreferenced list, so the chip and
 * the report card count always agree (and share its rules: a self-reference, a
 * layout's own buttons, or a disabled step doesn't count as a use). */
export function isUnreferenced(model: SolutionModel, o: FmObject): boolean {
  let set = unreferencedCache.get(model);
  if (!set) {
    set = new Set(model.unreferenced.map((x) => x.uid));
    unreferencedCache.set(model, set);
  }
  return set.has(o.uid);
}

/** Every navigator sub-filter, mirroring the `nav*` fields in the store. */
export interface NavFilters {
  field: FieldFilter;
  dataType: string;
  rel: RelFilter;
  account: AccountFilter;
  accountPw: AccountPwFilter;
  accountPriv: string;
  privCap: PrivCapFilter;
  ref: RefFilter;
  layout: LayoutFilter;
  loType: string;
  loFilter: LayoutObjectFilter;
}

export type NavFilterKey = keyof NavFilters;

export const NO_FILTERS: NavFilters = {
  field: "all",
  dataType: "all",
  rel: "all",
  account: "all",
  accountPw: "all",
  accountPriv: "all",
  privCap: "all",
  ref: "all",
  layout: "all",
  loType: "all",
  loFilter: "all",
};

/** The reference-status filter that actually applies for `type` — a stored
 * mode that doesn't apply to this type is treated as "all", so it re-applies
 * when switching back to a compatible type. */
export function effectiveRefFilter(type: ObjectType | "all", ref: RefFilter): RefFilter {
  const canUnref = type === "all" || UNREF_ELIGIBLE.has(type);
  const canBroken = type === "all" || BROKEN_ELIGIBLE.has(type);
  if (ref === "unreferenced" && !canUnref) return "all";
  if (ref === "broken" && !canBroken) return "all";
  return ref;
}

/** Narrow `objects` by every sub-filter that applies to `type`. */
export function applyNavFilters(
  model: SolutionModel,
  objects: FmObject[],
  type: ObjectType | "all",
  f: NavFilters,
): FmObject[] {
  const tests: ((o: FmObject) => boolean)[] = [];
  if (type === "field") {
    if (f.field !== "all") tests.push((o) => matchesFieldFilter(o, f.field));
    if (f.dataType !== "all") tests.push((o) => o.attributes.datatype === f.dataType);
  }
  if (type === "relationship" && f.rel !== "all") tests.push((o) => matchesRelFilter(o, f.rel));
  if (type === "account") {
    if (f.account !== "all") tests.push((o) => matchesAccountFilter(o, f.account));
    if (f.accountPw !== "all") tests.push((o) => matchesAccountPw(o, f.accountPw));
    if (f.accountPriv !== "all") tests.push((o) => o.attributes.privilegeSet === f.accountPriv);
  }
  if (type === "privilegeSet" && f.privCap !== "all") tests.push((o) => matchesPrivCap(o, f.privCap));
  if (type === "layout" && f.layout !== "all") tests.push((o) => matchesLayoutFilter(o, f.layout));
  if (type === "layoutObject") {
    if (f.loType !== "all") tests.push((o) => matchesLayoutObjectType(o, f.loType));
    if (f.loFilter !== "all") tests.push((o) => matchesLayoutObjectFilter(o, f.loFilter));
  }
  const ref = effectiveRefFilter(type, f.ref);
  if (ref === "broken") {
    const broken = brokenSourcesFor(model);
    tests.push((o) => broken.has(o.uid));
  } else if (ref === "unreferenced") {
    tests.push((o) => isUnreferenced(model, o));
  }
  if (tests.length === 0) return objects;
  return objects.filter((o) => tests.every((t) => t(o)));
}

export interface ChipOption {
  value: string;
  label: string;
  /** Visual accent for health chips. */
  tone?: "high" | "warn";
}

export interface ChipGroup {
  key: NavFilterKey;
  /** Small caption shown before the group's chips. */
  label: string;
  options: ChipOption[];
}

const FIELD_CHIPS: ChipOption[] = [
  { value: "normal", label: "Normal" },
  { value: "calculation", label: "Calc" },
  { value: "summary", label: "Summary" },
  { value: "unstored", label: "Unstored" },
  { value: "global", label: "Global" },
  { value: "deepCalc", label: "Deep ≥2" },
];

/** The chip groups offered for the selected type. `model` supplies the dynamic
 * option lists (privilege-set names, layout-object kinds). */
export function chipGroupsFor(model: SolutionModel, type: ObjectType | "all"): ChipGroup[] {
  const groups: ChipGroup[] = [];
  const canUnref = type === "all" || UNREF_ELIGIBLE.has(type);
  const canBroken = type === "all" || BROKEN_ELIGIBLE.has(type);
  const health: ChipOption[] = [];
  if (canUnref) health.push({ value: "unreferenced", label: "Unreferenced", tone: "warn" });
  if (canBroken) health.push({ value: "broken", label: "Broken", tone: "high" });
  if (health.length) groups.push({ key: "ref", label: "Health", options: health });

  switch (type) {
    case "field":
      groups.push({ key: "field", label: "Kind", options: FIELD_CHIPS });
      groups.push({ key: "dataType", label: "Data type", options: DATA_TYPE_OPTIONS });
      break;
    case "relationship":
      groups.push({
        key: "rel",
        label: "Cascade",
        options: [
          { value: "create", label: "Allows creation" },
          { value: "delete", label: "Deletes related" },
          { value: "sorted", label: "Sorted" },
        ],
      });
      break;
    case "account":
      groups.push({
        key: "account",
        label: "Status",
        options: [
          { value: "active", label: "Active" },
          { value: "inactive", label: "Inactive" },
        ],
      });
      groups.push({
        key: "accountPw",
        label: "Password",
        options: [
          { value: "none", label: "No password", tone: "high" },
          { value: "set", label: "Has password" },
        ],
      });
      groups.push({
        key: "accountPriv",
        label: "Privilege set",
        options: distinct(model, "privilegeSet", (o) => o.name),
      });
      break;
    case "privilegeSet":
      groups.push({
        key: "privCap",
        label: "Capability",
        options: [
          { value: "create", label: "Can create" },
          { value: "edit", label: "Can edit" },
          { value: "delete", label: "Can delete" },
          { value: "readonly", label: "Read-only" },
        ],
      });
      break;
    case "layout":
      groups.push({ key: "layout", label: "Triggers", options: [{ value: "hasTriggers", label: "Has triggers" }] });
      break;
    case "layoutObject":
      groups.push({
        key: "loType",
        label: "Kind",
        options: distinct(model, "layoutObject", (o) => (o.detail?.kind === "layoutObject" ? o.detail.loType : null)),
      });
      groups.push({ key: "loFilter", label: "Triggers", options: [{ value: "hasTriggers", label: "Has triggers" }] });
      break;
    default:
      break;
  }
  return groups;
}

/** Sorted distinct values of `pick` over one type, as chip options. */
function distinct(model: SolutionModel, type: ObjectType, pick: (o: FmObject) => string | null): ChipOption[] {
  const set = new Set<string>();
  for (const o of model.objects) {
    if (o.type !== type) continue;
    const v = pick(o);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
}

/** Faceted counts: for each chip, how many of `base` would match if that chip
 * were selected (keeping every OTHER group's current selection). */
export function chipCounts(
  model: SolutionModel,
  base: FmObject[],
  type: ObjectType | "all",
  f: NavFilters,
  groups: ChipGroup[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const real = base.filter((o) => !o.isSeparator && o.type !== "file");
  for (const g of groups) {
    const others = applyNavFilters(model, real, type, { ...f, [g.key]: "all" });
    for (const opt of g.options) {
      const n = applyNavFilters(model, others, type, { ...NO_FILTERS, [g.key]: opt.value }).length;
      counts.set(`${g.key}:${opt.value}`, n);
    }
  }
  return counts;
}
