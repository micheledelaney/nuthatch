import type { FmObject, SolutionModel } from "@/types/ddr";

export interface Fact {
  label: string;
  tone?: "high" | "warn" | "ok";
  title?: string;
}

const DATA_TYPE_LABEL: Record<string, string> = { Binary: "Container" };

const FIELD_KIND_LABEL: Record<string, string> = {
  Normal: "Normal",
  Calculated: "Calculation",
  Summary: "Summary",
};

/** Key facts about an object, shown as badges on its page. */
export function factsFor(
  obj: FmObject,
  model: SolutionModel,
  ctx: { brokenCount: number; callCount: number; unreferenced: boolean; selfBroken: boolean },
): Fact[] {
  const facts: Fact[] = [];
  const a = obj.attributes;
  const d = obj.detail;
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  switch (obj.type) {
    case "field": {
      if (a.fieldtype) facts.push({ label: FIELD_KIND_LABEL[a.fieldtype] ?? a.fieldtype });
      if (a.datatype) facts.push({ label: DATA_TYPE_LABEL[a.datatype] ?? a.datatype });
      if (a.unstored === "true") facts.push({ label: "Unstored", tone: "warn" });
      if (a.global === "true") facts.push({ label: "Global" });
      const depth = obj.relationshipDepth ?? 0;
      if (depth >= 2) {
        facts.push({ label: `Depth ${depth}`, tone: depth >= 3 ? "high" : "warn", title: `${depth} relationship hops` });
      }
      break;
    }
    case "script":
      if (d?.kind === "script") facts.push({ label: plural(d.steps.length, "step") });
      if (ctx.callCount > 0) facts.push({ label: `Calls ${plural(ctx.callCount, "script")}` });
      break;
    case "layout":
      if (a.tableOccurrence) facts.push({ label: `Shows ${a.tableOccurrence}`, title: "Shows records from" });
      if (d?.kind === "layout" && d.triggers.length > 0) facts.push({ label: plural(d.triggers.length, "trigger") });
      break;
    case "layoutObject":
      if (d?.kind === "layoutObject") {
        facts.push({ label: d.loType });
        if ((d.triggers?.length ?? 0) > 0) facts.push({ label: plural(d.triggers!.length, "trigger") });
      }
      break;
    case "table": {
      let fields = 0;
      for (const o of model.objects) if (o.parentUid === obj.uid && o.type === "field") fields++;
      facts.push({ label: plural(fields, "field") });
      break;
    }
    case "account":
      facts.push(a.status === "Inactive" ? { label: "Inactive" } : { label: "Active", tone: "ok" });
      if (a.password === "No") facts.push({ label: "No password", tone: "high" });
      if (a.privilegeSet) facts.push({ label: a.privilegeSet, title: "Privilege set" });
      break;
    case "relationship":
      if (d?.kind === "relationship") {
        if (d.left?.cascadeCreate || d.right?.cascadeCreate) facts.push({ label: "Allows creation" });
        if (d.left?.cascadeDelete || d.right?.cascadeDelete) facts.push({ label: "Deletes related", tone: "warn" });
        if (d.left?.sorted || d.right?.sorted) facts.push({ label: "Sorted" });
      }
      break;
    default:
      break;
  }

  if (ctx.selfBroken) {
    facts.push({ label: "Base table missing", tone: "high", title: "This table occurrence's base table could not be resolved" });
  }
  if (ctx.brokenCount > 0) facts.push({ label: plural(ctx.brokenCount, "broken ref"), tone: "high" });
  if (ctx.unreferenced) facts.push({ label: "Unreferenced", tone: "warn", title: "Nothing in the loaded files references this" });
  return facts;
}
