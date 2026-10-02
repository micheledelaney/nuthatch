/**
 * Formula text reaches the UI verbatim (every export writes calculations as
 * CDATA), so the code views must show it as-is — never entity-decode it again.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Highlight, LinkedCode } from "@/components/Highlight";
import type { FmObject } from "@/types/ddr";

/** The text a reader sees: the markup without tags, HTML-unescaped once. */
function visibleText(node: ReactElement): string {
  const html: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
  return renderToStaticMarkup(node)
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => html[e]!);
}

const FORMULA = 'Substitute ( Notes ; "¶" ; "&lt;br&gt;" ) & "&amp;"';

const field: FmObject = {
  uid: "F0:field:1.1",
  type: "field",
  id: "1",
  name: "Notes",
  fileUid: "F0",
  fileName: "MAIN",
  attributes: {},
  text: "Notes",
};

describe("code views", () => {
  it("show a formula's literal entity text as written", () => {
    expect(visibleText(<Highlight text={FORMULA} />)).toBe(FORMULA);
  });

  it("keep it as written while linking the names in it", () => {
    const linked = <LinkedCode text={FORMULA} objects={[field]} onGo={() => {}} />;
    expect(visibleText(linked)).toBe(FORMULA);
    expect(renderToStaticMarkup(linked)).toContain('class="obj-link"');
  });
});
