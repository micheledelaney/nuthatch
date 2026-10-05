/**
 * "Show in relationship graph" switches to the graph without losing Browse's
 * place: going back finds the same object and breadcrumb trail.
 */
import { describe, expect, it } from "vitest";
import { useStore } from "@/state/store";

describe("showing an occurrence in the graph", () => {
  it("keeps the Browse trail for when the user comes back", () => {
    const { openObject, navigateFrom, showGraphFor, setView } = useStore.getState();
    openObject("F0:tableOccurrence:1");
    navigateFrom(0, "F0:tableOccurrence:2", "row-2");
    showGraphFor("F0:tableOccurrence:2");
    expect(useStore.getState()).toMatchObject({ view: "erd", graphFocus: "F0:tableOccurrence:2" });
    setView("browse");
    expect(useStore.getState()).toMatchObject({
      trail: ["F0:tableOccurrence:1", "F0:tableOccurrence:2"],
      trailKeys: ["", "row-2"],
    });
  });
});
