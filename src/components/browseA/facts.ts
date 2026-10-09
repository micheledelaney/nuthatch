import type { UsageMark } from "@/types/ddr";
import { USAGE_REASON_LABELS } from "@/core/analysis/usageMarks";

export interface Fact {
  label: string;
  tone?: "high" | "warn" | "soft" | "ok";
  title?: string;
}

/** The flags shown as badges in an object's At a glance card: problems —
 * broken references, what the script checks found, nothing referencing it, or
 * only unused objects using it — and a mark saying it's used anyway.
 * Everything else (storage, step counts, triggers, …) lives in the card's rows
 * or the Metadata box. */
export function factsFor(ctx: {
  brokenCount: number;
  /** A script's findings in its Script checks section. */
  scriptCheckCount: number;
  unreferenced: boolean;
  unusedChain: boolean;
  selfBroken: boolean;
  mark: UsageMark | undefined;
}): Fact[] {
  const facts: Fact[] = [];
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  if (ctx.selfBroken) {
    facts.push({ label: "Base table missing", tone: "high", title: "This table occurrence's base table could not be resolved" });
  }
  if (ctx.brokenCount > 0) facts.push({ label: plural(ctx.brokenCount, "broken ref"), tone: "high" });
  if (ctx.scriptCheckCount > 0) {
    facts.push({ label: plural(ctx.scriptCheckCount, "script check"), tone: "warn", title: "What the script checks found — listed under Script checks" });
  }
  if (ctx.unreferenced) facts.push({ label: "Unreferenced", tone: "soft", title: "Nothing in the loaded files references this" });
  if (ctx.unusedChain) {
    facts.push({ label: "Unused chain", tone: "soft", title: "Everything that uses this is itself unused — see Used only by" });
  }
  if (ctx.mark) {
    const reason = USAGE_REASON_LABELS[ctx.mark.reason];
    facts.push({ label: "Marked as used", tone: "ok", title: ctx.mark.note ? `${reason} — ${ctx.mark.note}` : reason });
  }
  return facts;
}
