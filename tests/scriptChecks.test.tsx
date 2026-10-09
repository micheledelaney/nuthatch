/**
 * The script checks in the app: the "Script checks" list above a script's
 * steps (facts and likely defects only), the amber mark on their steps, the
 * script's flag and the Script checks filter — all from one source.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Detail } from "@/components/ObjectColumn";
import { factsFor } from "@/components/browseA/facts";
import { applyNavFilters, chipGroupsFor, NO_FILTERS } from "@/components/browseA/filters";
import { ScriptChecks } from "@/components/ScriptChecks";
import { ScriptWorkspace } from "@/components/ScriptWorkspace";
import { buildAiExport } from "@/core/export/aiExport";
import { buildModel } from "@/core/model/buildModel";
import { shownScriptChecks } from "@/core/scriptAnalysis/analyze";
import type { FmObject, ScriptStep, SolutionModel, StepIr } from "@/types/ddr";

const FILE = "F0";

/** A script whose steps are `names`, with no formulas but `calcs` (by step index). */
function solution(names: string[], typed: Partial<Record<number, Partial<StepIr>>> = {}) {
  const steps: ScriptStep[] = names.map((name, i) => ({ index: i + 1, name, enabled: true, params: "" }));
  const script: FmObject = {
    uid: `${FILE}:script:1`,
    type: "script",
    id: "1",
    name: "S",
    fileUid: FILE,
    fileName: "TEST",
    attributes: {},
    text: "",
    detail: { kind: "script", steps },
  };
  const scriptSteps = { [script.uid]: steps.map((s) => ({ index: s.index, name: s.name, enabled: true, calcs: [], ...typed[s.index] })) };
  const model = buildModel({ files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }], objects: [script], references: [], errors: [], scriptSteps });
  return { script, model };
}

function page(names: string[], typed?: Partial<Record<number, Partial<StepIr>>>): string {
  const { script, model } = solution(names, typed);
  return renderToStaticMarkup(<Detail detail={script.detail!} owner={script} model={model} onGo={() => {}} brokenSteps={new Set()} scrollToStep={null} />);
}

const markedSteps = (html: string) => [...html.matchAll(/class="sw-line[^"]*\bcheck\b[^"]*"[^>]*>.*?<span class="sw-ln">(\d+)/g)].map((m) => Number(m[1]));

describe("script checks on a script's page", () => {
  it("lists a finding above the steps and marks every step of an unreachable run", () => {
    const html = page(["Exit Script", "Beep", "Beep"]);
    expect(html).toContain("Script checks · 1");
    expect(html).toContain(
      '<span class="script-check-step" style="width:1ch">2</span><span class="script-check-text"><span>Steps 2–3 never run</span><span class="script-check-detail">The script always stops at step 1 (Exit Script) first.</span></span>',
    );
    expect(html.indexOf("Script checks")).toBeLessThan(html.indexOf("Script steps"));
    expect(markedSteps(html)).toEqual([2, 3]);
  });

  it("keys two findings on the same step apart", () => {
    const { script, model } = solution(["Beep"], { 1: { calcs: ["$title & $message"] } });
    const checks = shownScriptChecks(model, script.uid);
    // Static rendering doesn't report duplicate keys; ScriptChecks has no
    // hooks, so call it for its rows.
    const rows = ScriptChecks({ checks, onShow: () => {} }).props.children as { key: string }[];
    expect(checks.map((check) => check.step)).toEqual([1, 1]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("shows the names a finding mentions in their code colours", () => {
    const html = page(["If", "End If"], { 1: { calcs: ["$x = 1"] } });
    expect(html).toContain('<span><span class="syn-var">$x</span> is never set</span>');
  });

  it("leaves out the possible findings, and the section when nothing's left", () => {
    const html = page(["Set Variable"], { 1: { calcs: ["1"], setsVariable: "$unused" } });
    expect(html).not.toContain("Script checks");
    expect(markedSteps(html)).toEqual([]);
  });

  it("shows nothing for an analysis saved without typed steps", () => {
    const { script } = solution(["Exit Script", "Beep"]);
    const model = buildModel({ files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }], objects: [script], references: [], errors: [] });
    const html = renderToStaticMarkup(<Detail detail={script.detail!} owner={script} model={model} onGo={() => {}} brokenSteps={new Set()} scrollToStep={null} />);
    expect(html).not.toContain("Script checks");
  });
});

describe("the check mark on a step", () => {
  const steps = [1, 2].map((index) => ({ index, name: "Beep", enabled: true, params: "" })) as ScriptStep[];

  it("is amber unless the step is broken, whose red wins", () => {
    const html = renderToStaticMarkup(<ScriptWorkspace steps={steps} checkSteps={new Set([1, 2])} brokenSteps={new Set([2])} />);
    expect(html).toMatch(/class="sw-line check"/);
    expect(html).toMatch(/class="sw-line hit"/);
    expect(html).not.toMatch(/hit check|check hit/);
  });
});

describe("the flag and the filter", () => {
  it("flags a script with the count its Script checks section shows", () => {
    const { script, model } = solution(["Exit Script", "Beep", "If", "End If"], { 3: { calcs: ["$x"] } });
    const count = shownScriptChecks(model, script.uid).length;
    expect(count).toBe(2);
    const facts = factsFor({ brokenCount: 0, scriptCheckCount: count, unreferenced: false, unusedChain: false, selfBroken: false, mark: undefined });
    expect(facts).toEqual([{ label: "2 script checks", tone: "warn", title: "What the script checks found — listed under Script checks" }]);
  });

  it("filters Scripts and All objects to the flagged scripts, and offers the chip only there", () => {
    const flagged = solution(["Exit Script", "Beep"]);
    const clean = solution(["Beep"]);
    expect(applyNavFilters(flagged.model, [flagged.script], "script", { ...NO_FILTERS, ref: "scriptChecks" })).toEqual([flagged.script]);
    expect(applyNavFilters(clean.model, [clean.script], "all", { ...NO_FILTERS, ref: "scriptChecks" })).toEqual([]);
    const chips = (type: "script" | "all" | "layout") =>
      chipGroupsFor(flagged.model, type).flatMap((g) => g.options.filter((o) => o.value === "scriptChecks").map((o) => [o.label, o.tone]));
    expect(chips("script")).toEqual([["Script checks", "warn"]]);
    expect(chips("all")).toEqual([["Script checks", "warn"]]);
    expect(chips("layout")).toEqual([]);
  });
});

describe("the AI export", () => {
  const exported = (model: SolutionModel) => {
    const files = buildAiExport(model, { analysisName: "A", projectName: "P", savedAt: 0, exportedAt: 0 });
    return (name: string) => files.find((f) => f.name === name)!.content;
  };

  it("lists the findings the app shows, and counts them on the script's line", () => {
    // Step 1's $unused is a possible finding: left out, as in the app.
    const { script, model } = solution(["Set Variable", "Exit Script", "Beep"], { 1: { setsVariable: "$unused", calcs: ["1"] }, 3: { calcs: ["$x"] } });
    const file = exported(model);
    const lines = file("script-checks.jsonl").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual(
      shownScriptChecks(model, script.uid).map((f) => ({ uid: script.uid, script: "S", rule: f.rule, certainty: f.certainty, step: 3, title: expect.any(String), detail: expect.any(String) })),
    );
    expect(lines.map((l) => [l.rule, l.certainty, l.title])).toEqual([
      ["unset-variable", "likely", "$x is never set"],
      ["unreachable-steps", "fact", "This step never runs"],
    ]);
    expect(JSON.parse(file("objects.jsonl").split("\n")[0]!)).toMatchObject({ uid: script.uid, scriptChecks: 2 });
    expect(file("README.md")).toContain("**Scripts flagged by script checks:** 1 (2 findings)");
  });

  it("says the checks weren't run for an analysis saved without typed steps", () => {
    const { model } = solution(["Exit Script", "Beep"]);
    const file = exported({ ...model, scriptSteps: new Map() });
    expect(file("script-checks.jsonl")).toBe("");
    expect(file("README.md")).toContain("**Script checks:** not run");
    expect(file("README.md")).toContain("Empty: the script checks weren't run");
  });
});
