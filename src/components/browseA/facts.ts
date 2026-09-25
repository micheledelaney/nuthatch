export interface Fact {
  label: string;
  tone?: "high" | "warn" | "ok";
  title?: string;
}

/** The flags shown as badges in an object's At a glance card: only problems —
 * broken references and nothing referencing it. Everything else (storage,
 * step counts, triggers, …) lives in the card's rows or the Metadata box. */
export function factsFor(ctx: { brokenCount: number; unreferenced: boolean; selfBroken: boolean }): Fact[] {
  const facts: Fact[] = [];
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  if (ctx.selfBroken) {
    facts.push({ label: "Base table missing", tone: "high", title: "This table occurrence's base table could not be resolved" });
  }
  if (ctx.brokenCount > 0) facts.push({ label: plural(ctx.brokenCount, "broken ref"), tone: "high" });
  if (ctx.unreferenced) facts.push({ label: "Unreferenced", tone: "warn", title: "Nothing in the loaded files references this" });
  return facts;
}
