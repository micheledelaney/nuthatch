import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { matchOffsets } from "@/components/ScriptFind";
import { ScriptWorkspace } from "@/components/ScriptWorkspace";
import type { ScriptStep } from "@/types/ddr";

describe("find in a script", () => {
  it("matches plain text, not case-sensitive", () => {
    expect(matchOffsets("Set Field [ T::x ] ; set field", "SET field")).toEqual([
      [0, 9],
      [21, 30],
    ]);
  });

  it("treats regex characters as text and a blank query as no search", () => {
    expect(matchOffsets("a.b (c) a*b", "a*b")).toEqual([[8, 11]]);
    expect(matchOffsets("a.b", ".")).toEqual([[1, 2]]);
    expect(matchOffsets("a b", " ")).toEqual([]);
    expect(matchOffsets("a b", "")).toEqual([]);
  });

  it("opens a long step while the search matches inside its hidden part", () => {
    const long = "x".repeat(200) + " needle";
    const steps = [{ index: 1, name: "Insert Text", params: long, enabled: true }] as ScriptStep[];
    const find = (query: string) => ({ query, current: 0, onCount: () => {} });
    expect(renderToStaticMarkup(<ScriptWorkspace steps={steps} find={find("needle")} />)).toContain("needle");
    expect(renderToStaticMarkup(<ScriptWorkspace steps={steps} find={find("nothing")} />)).not.toContain("needle");
  });
});
