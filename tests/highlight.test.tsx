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

/** The markup with each coloured span written as ⟦class:text⟧ and each link
 * as ⟦link:text⟧ (a coloured link: ⟦class:⟦link:text⟧⟧), so a test can read
 * what colour every piece gets. */
function colours(node: ReactElement): string {
  const html: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
  return renderToStaticMarkup(node)
    .replace(/<button[^>]*>([^<]*)<\/button>/g, "⟦link:$1⟧")
    .replace(/<span class="syn-([a-z]+)">([^<]*)<\/span>/g, "⟦$1:$2⟧")
    .replace(/&(amp|lt|gt|quot);/g, (_, e: string) => html[e]!);
}

const obj = (type: FmObject["type"], name: string): FmObject => ({ ...field, uid: `F0:${type}:${name}`, type, name });

describe("syntax colours", () => {
  it("keep a logical operator after a variable or a field out of the name", () => {
    expect(colours(<Highlight text="$x and $y" />)).toBe("⟦var:$x⟧ ⟦kw:and⟧ ⟦var:$y⟧");
    expect(colours(<Highlight text="A::x or B C::y" />)).toBe(
      "⟦to:A⟧::⟦field:x⟧ ⟦kw:or⟧ ⟦to:B C⟧::⟦field:y⟧",
    );
  });

  it("keep spaces inside field names and words that only start like an operator", () => {
    expect(colours(<Highlight text="Line Items::Order Date" />)).toBe("⟦to:Line Items⟧::⟦field:Order Date⟧");
  });

  it("colour not ( as a keyword and control functions as keywords", () => {
    expect(colours(<Highlight text="not ( IsEmpty ( x ) )" />)).toContain("⟦kw:not⟧ ⟦op:(⟧ ⟦func:IsEmpty⟧");
    expect(colours(<Highlight text="Let ( a = 1 ; Case ( a ; 2 ) )" />)).toMatch(/^⟦kw:Let⟧.*⟦kw:Case⟧/);
  });

  it("colour constants, ^ and decimals without a leading digit", () => {
    expect(colours(<Highlight text="True & ¶ & Get ( AccountName )" />)).toBe(
      "⟦const:True⟧ ⟦op:&⟧ ⟦const:¶⟧ ⟦op:&⟧ ⟦func:Get⟧ ⟦op:(⟧ ⟦const:AccountName⟧ ⟦op:)⟧",
    );
    expect(colours(<Highlight text="2^.5" />)).toBe("⟦num:2⟧⟦op:^⟧⟦num:.5⟧");
  });

  it("colour step option labels and On / Off only where an option starts", () => {
    expect(colours(<Highlight text="[ “Name”; Parameter: $x ; With dialog: Off ]" />)).toBe(
      "⟦op:[⟧ ⟦string:“Name”⟧⟦op:;⟧ ⟦label:Parameter:⟧ ⟦var:$x⟧ ⟦op:;⟧ ⟦label:With dialog:⟧ ⟦const:Off⟧ ⟦op:]⟧",
    );
    expect(colours(<Highlight text="[ $x; Value:Get ( FoundCount ) ]" />)).toBe(
      "⟦op:[⟧ ⟦var:$x⟧⟦op:;⟧ ⟦label:Value:⟧⟦func:Get⟧ ⟦op:(⟧ ⟦const:FoundCount⟧ ⟦op:)⟧ ⟦op:]⟧",
    );
    expect(colours(<Highlight text="[ On ]" />)).toBe("⟦op:[⟧ ⟦const:On⟧ ⟦op:]⟧");
    expect(colours(<Highlight text="[ T::x ]" />)).toBe("⟦op:[⟧ ⟦to:T⟧::⟦field:x⟧ ⟦op:]⟧");
    expect(colours(<Highlight text="x & Note: y" />)).not.toContain("label");
  });

  it("colour a quoted name in step text as a string, even before ( TO )", () => {
    const linked = <LinkedCode text="Using layout: “A | B” (T)" objects={[obj("layout", "A | B")]} onGo={() => {}} />;
    expect(colours(linked)).toBe("⟦label:Using layout:⟧ ⟦string:“⟧⟦string:⟦link:A | B⟧⟧⟦string:”⟧ ⟦op:(⟧T⟦op:)⟧");
  });

  it("flag every placeholder the model counts as broken", () => {
    expect(colours(<Highlight text="<unknown> & <Field Missing>" />)).toBe(
      "⟦missing:<unknown>⟧ ⟦op:&⟧ ⟦missing:<Field Missing>⟧",
    );
    expect(colours(<Highlight text="[ “<unknown>” ]" />)).toContain("⟦missing:<unknown>⟧");
  });

  it("don't let a link inside a string pair its closing quote with the next string", () => {
    const linked = <LinkedCode text={'[ "Run Me" ; Parameter: "abc" ]'} objects={[obj("script", "Run Me")]} onGo={() => {}} />;
    expect(colours(linked)).toBe(
      '⟦op:[⟧ ⟦string:"⟧⟦string:⟦link:Run Me⟧⟧⟦string:"⟧ ⟦op:;⟧ ⟦label:Parameter:⟧ ⟦string:"abc"⟧ ⟦op:]⟧',
    );
  });

  it("give a link the colour of the token it sits in", () => {
    const objects = [obj("globalVariable", "$$G"), obj("customFunction", "MyFunc")];
    expect(colours(<LinkedCode text="$$G & MyFunc ( 1 )" objects={objects} onGo={() => {}} />)).toBe(
      '⟦var:⟦link:$$G⟧⟧ ⟦op:&⟧ ⟦func:⟦link:MyFunc⟧⟧ ⟦op:(⟧ ⟦num:1⟧ ⟦op:)⟧',
    );
  });

  it("link nothing inside comments, labels or placeholders", () => {
    const objects = [obj("field", "Field"), obj("field", "Parameter")];
    const html = colours(<LinkedCode text="<Field Missing> ; Parameter: 1 // Field" objects={objects} onGo={() => {}} />);
    expect(html).not.toContain("link:");
  });
});
