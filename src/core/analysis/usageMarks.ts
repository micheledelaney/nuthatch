import type { FmObject, UsageMark, UsageReason } from "@/types/ddr";

/** How each reason reads in the app and the AI export. */
export const USAGE_REASON_LABELS: Record<UsageReason, string> = {
  serverSchedule: "Server schedule",
  externalApp: "Data API / OData / other app",
  otherFile: "Another file (not loaded)",
  byName: "Called by name (ExecuteSQL, Evaluate, …)",
  keep: "Kept on purpose",
  other: "Other",
};

export const USAGE_REASONS = Object.keys(USAGE_REASON_LABELS) as UsageReason[];

/** The part of a uid that stays the same across exports: everything after the file. */
function refOf(obj: FmObject): string {
  return obj.uid.slice(obj.fileUid.length + 1);
}

/** File names can't contain a newline, so it can't join two keys into one. */
function keyOf(fileName: string, ref: string): string {
  return `${fileName}\n${ref}`;
}

export function createMark(obj: FmObject, reason: UsageReason, note: string | undefined, now: number): UsageMark {
  return { fileName: obj.fileName, ref: refOf(obj), name: obj.name, reason, ...(note ? { note } : {}), markedAt: now };
}

/** The marks that apply to these objects, by uid. Marks for objects that
 * aren't loaded (another analysis's, or since deleted) are left out. */
export function resolveMarks(objects: FmObject[], marks: readonly UsageMark[]): Map<string, UsageMark> {
  const resolved = new Map<string, UsageMark>();
  if (marks.length === 0) return resolved;
  const byKey = new Map(marks.map((m) => [keyOf(m.fileName, m.ref), m]));
  for (const obj of objects) {
    const mark = byKey.get(keyOf(obj.fileName, refOf(obj)));
    if (mark) resolved.set(obj.uid, mark);
  }
  return resolved;
}

/** `marks` with `obj`'s mark replaced by `mark`, or removed when it's null. */
export function withMark(marks: readonly UsageMark[], obj: FmObject, mark: UsageMark | null): UsageMark[] {
  const key = keyOf(obj.fileName, refOf(obj));
  const others = marks.filter((m) => keyOf(m.fileName, m.ref) !== key);
  return mark ? [...others, mark] : others;
}

/** Both lists of marks in one; where both mark the same object, `primary`'s wins. */
export function mergeMarks(primary: readonly UsageMark[], extra: readonly UsageMark[]): UsageMark[] {
  const keys = new Set(primary.map((m) => keyOf(m.fileName, m.ref)));
  return [...primary, ...extra.filter((m) => !keys.has(keyOf(m.fileName, m.ref)))];
}
