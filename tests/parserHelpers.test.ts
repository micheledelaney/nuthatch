/**
 * The parser's text helpers on their own: the pieces the reference passes are
 * built from, each with the FileMaker quirks it handles.
 */
import { describe, expect, it } from "vitest";
import { xmlParser } from "@/core/parser/xmlParser";
import {
  chunkListMatchesText,
  fieldNameCandidate,
  formulasUnder,
  globalVariablesInText,
  inertSpansWith,
  literalText,
  longestNameAt,
  mergeFormulas,
  makeNameIndex,
  quotedGlobalVariables,
  stripComments,
  stripLiteralsAndComments,
} from "@/core/parser/calcText";
import { decodeEntities } from "@/core/parser/entities";
import { splitLayoutCatalog } from "@/core/parser/objects/layoutStream";
import { stepIrs } from "@/core/parser/objects/stepIr";
import { stepParams } from "@/core/parser/objects/stepText";
import type { StepTexts } from "@/core/parser/context";

function chunkList(chunks: string): unknown {
  return (xmlParser.parse(`<ChunkList>${chunks}</ChunkList>`) as Record<string, unknown>)["ChunkList"];
}

describe("chunkListMatchesText", () => {
  const list = chunkList(
    `<Chunk type="FunctionRef">If</Chunk><Chunk type="NoRef"> ( </Chunk>` +
      `<Chunk type="FieldRef"><FieldReference id="1" name="Name"><TableOccurrenceReference id="1" name="Customers"></TableOccurrenceReference></FieldReference></Chunk>` +
      `<Chunk type="NoRef"> = &quot;x&quot; ; 1 )</Chunk>`,
  );

  it("matches the calc its chunks spell out, whatever its spacing and case", () => {
    expect(chunkListMatchesText(list, `If ( Customers::Name = "x" ; 1 )`)).toBe(true);
    expect(chunkListMatchesText(list, `if(customers::name="x";1)`)).toBe(true);
  });

  it("tolerates punctuation the chunk list leaves out, but no other text", () => {
    expect(chunkListMatchesText(list, `If ( Customers::Name = "x" ; 1 ) ;`)).toBe(true);
    expect(chunkListMatchesText(list, `If ( Customers::Name = "x" ; 1 ) & y`)).toBe(false);
  });

  it("doesn't match another calc's chunks", () => {
    expect(chunkListMatchesText(list, `If ( Customers::City = "x" ; 1 )`)).toBe(false);
  });

  it("reads a field chunk with no occurrence as the bare field name", () => {
    expect(chunkListMatchesText(chunkList(`<Chunk type="FieldRef"><FieldReference id="1" name="Name"></FieldReference></Chunk>`), "Name")).toBe(true);
  });

  it("matches an empty list only to an empty calc", () => {
    expect(chunkListMatchesText(chunkList(""), " ")).toBe(true);
    expect(chunkListMatchesText(chunkList(""), "1")).toBe(false);
  });
});

describe("stripLiteralsAndComments / stripComments", () => {
  const text = `"a \\" b" & x /* c */ & y // d\nz`;

  it("blank string literals (with escaped quotes) and comments, keeping everything else in place", () => {
    expect(stripLiteralsAndComments(text)).toBe(`${" ".repeat(8)} & x ${" ".repeat(7)} & y ${" ".repeat(4)}\nz`);
  });

  it("keep string literals when only comments go", () => {
    expect(stripComments(text)).toBe(`"a \\" b" & x ${" ".repeat(7)} & y ${" ".repeat(4)}\nz`);
  });

  it("blank an unclosed comment to the end", () => {
    expect(stripLiteralsAndComments("x /* never closed")).toBe(`x ${" ".repeat(15)}`);
  });
});

describe("global variable names in a formula's text", () => {
  it("run over spaces, up to an operator", () => {
    expect(globalVariablesInText(`$$_Leitweg ID & $$b`)).toEqual(["$$_Leitweg ID", "$$b"]);
  });

  it("stop before an operator keyword, a function call and a qualified field", () => {
    expect(globalVariablesInText(`$$a and $$b`)).toEqual(["$$a", "$$b"]);
    expect(globalVariablesInText(`$$a Left ( x ; 1 )`)).toEqual(["$$a"]);
    expect(globalVariablesInText(`$$a T::f`)).toEqual(["$$a"]);
  });

  it("count a name passed as a whole string literal, but not one inside other text", () => {
    expect(quotedGlobalVariables(`Map.Clear ( "$$_CMAP" ) & "$$x is: "`)).toEqual(["$$_CMAP"]);
  });
});

describe("names in a formula's text", () => {
  const index = makeNameIndex(["Name", "Name 2"]);

  it("match the longest name that ends at a name boundary", () => {
    const text = "Name 2 + Names";
    expect(longestNameAt(text, 0, index)).toBe("Name 2");
    expect(longestNameAt(text, text.indexOf("Names"), index)).toBeUndefined();
  });

  it("take what follows a `::` up to the next operator as a field name", () => {
    expect(fieldNameCandidate("T::Some Field & x", 3)).toBe("Some Field");
  });
});

describe("typed text in a formula", () => {
  const TOKENS = ["<Field Missing>", "<Table Missing>"];

  it("is the string literals and comments that hold a placeholder, as written", () => {
    const formula = `"<Field Missing>" & T::<Field Missing> & "x" /* <Table Missing> */ & "say \\"<Field Missing>\\"" // <Field Missing>\nT::a`;
    expect(inertSpansWith(formula, TOKENS)).toEqual([`"<Field Missing>"`, `/* <Table Missing> */`, `"say \\"<Field Missing>\\""`, `// <Field Missing>`]);
  });

  it("runs to the end of an unclosed literal or comment", () => {
    expect(inertSpansWith(`1 /* <Field Missing>`, TOKENS)).toEqual([`/* <Field Missing>`]);
    expect(inertSpansWith(`"<Table Missing>`, TOKENS)).toEqual([`"<Table Missing>`]);
  });

  it("is read from every <Calculation> under a node — not from layout text", () => {
    const node = xmlParser.parse(
      `<Step><Calculation><Calculation><Text><![CDATA[1 + 2]]></Text></Calculation></Calculation>` +
        `<Conditions><Install><Calculation><![CDATA[Get ( AccountName )]]></Calculation></Install></Conditions>` +
        `<Text><StyledText><Data><![CDATA["<<T::a>>"]]></Data></StyledText></Text></Step>`,
    );
    expect([...new Set(formulasUnder(node))]).toEqual(["1 + 2", "Get ( AccountName )"]);
  });
});

describe("mergeFormulas", () => {
  it("reads each <<ƒ:…>> merge calc's formula", () => {
    expect(mergeFormulas(`Total: <<ƒ:Sum ( T::a )>> of <<ƒ:Count ( T::a )>>`)).toEqual(["Sum ( T::a )", "Count ( T::a )"]);
  });

  it("ends one at the last `>>` of a run, outside its literals and comments", () => {
    expect(mergeFormulas(`<<ƒ:T::<Field Missing>>>`)).toEqual(["T::<Field Missing>"]);
    expect(mergeFormulas(`<<ƒ:">>" & /* >> */ T::a>> after`)).toEqual([`">>" & /* >> */ T::a`]);
  });

  it("reads none from text without one, or an unclosed one", () => {
    expect(mergeFormulas(`<<T::a>> and <<$$x>>`)).toEqual([]);
    expect(mergeFormulas(`<<ƒ:T::a`)).toEqual([]);
  });
});

describe("literalText", () => {
  it("reads a formula that is one string literal, undoing its escapes", () => {
    expect(literalText(`"Save"`)).toBe("Save");
    expect(literalText(` "Say \\"hi\\" \\\\ \\¶" `)).toBe(`Say "hi" \\ ¶`);
    expect(literalText(`""`)).toBe("");
  });

  it("reads nothing from a formula that computes its text", () => {
    expect(literalText(`"Feedback" & ¶ & "gelb"`)).toBeUndefined();
    expect(literalText(`Get ( AccountName )`)).toBeUndefined();
    expect(literalText(`"unclosed`)).toBeUndefined();
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;b&gt; &#128512; &#x1F600;")).toBe("Tom & Jerry <b> 😀 😀");
  });

  it("turns control characters into spaces, or CR/LF into newlines with keepLineBreaks", () => {
    expect(decodeEntities("a&#13;b&#9;c")).toBe("a b c");
    expect(decodeEntities("a&#13;b&#10;c", true)).toBe("a\nb\nc");
  });

  it("leaves a reference that names no character as written", () => {
    expect(decodeEntities("&constructor; &bogus; &#xFFFFFFFF;")).toBe("&constructor; &bogus; &#xFFFFFFFF;");
  });
});

describe("splitLayoutCatalog", () => {
  const xml = (structure: string): string => `<FMSaveAsXML><Structure>${structure}</Structure></FMSaveAsXML>`;

  it("cuts out the catalog, not stopping at a closing tag inside CDATA", () => {
    const catalog = `<LayoutCatalog><Layout id="1"><![CDATA[</LayoutCatalog>]]></Layout></LayoutCatalog>`;
    expect(splitLayoutCatalog(xml(`<AddAction>${catalog}</AddAction>`))).toEqual({
      rest: xml(`<AddAction><LayoutCatalog/></AddAction>`),
      layoutCatalog: catalog,
    });
  });

  it("leaves an empty catalog, and one after a <ModifyAction>, to the main parse", () => {
    expect(splitLayoutCatalog(xml(`<AddAction><LayoutCatalog/></AddAction>`)).layoutCatalog).toBeUndefined();
    expect(splitLayoutCatalog(xml(`<ModifyAction><LayoutCatalog><Layout id="1"></Layout></LayoutCatalog></ModifyAction>`)).layoutCatalog).toBeUndefined();
  });
});

describe("stepParams", () => {
  const params = (name: string, rendered: string, extra: Record<string, unknown> = {}): string => {
    const stepTexts: StepTexts = { byPointer: new Map([["_P", [{ hash: "H", text: rendered }]]]), byHash: new Map() };
    const step = { "@_name": name, DDRREF: { "@_kind": "StepText", "@_hash": "H", "#text": "_P" }, ...extra };
    return stepParams(step, name, stepTexts);
  };

  it("drops the step's name and a disabled step's `//`", () => {
    expect(params("Go to Layout", "// Go to Layout [ “L” (T) ]")).toBe("[ “L” (T) ]");
    expect(params("# (comment)", "# note")).toBe("note");
  });

  it("joins bracket groups on one line, keeping the line breaks inside brackets", () => {
    expect(params("Go to Related Record", "Go to Related Record [ From table: “T” ]&#13;[ Show only related records ]")).toBe(
      "[ From table: “T” ] [ Show only related records ]",
    );
    expect(params("Import Records", "Import Records [ a&#13;b ]")).toBe("[ a\nb ]");
  });

  it("adds an Insert Text step's text, which its rendered text leaves out", () => {
    const text = { ParameterValues: { Parameter: { "@_type": "Text", Text: { "@_value": "Hi{{char13}}there" } } } };
    expect(params("Insert Text", "Insert Text [ Select ; Target: T::f ]", text)).toBe(`[ Select ; Target: T::f ] [ Text: "Hi\nthere" ]`);
  });

  it("adds a Perform Script on Server's off Wait for completion, which its rendered text leaves out", () => {
    const wait = (value: string): Record<string, unknown> => ({
      ParameterValues: { Parameter: [{ "@_type": "Parameter" }, { "@_type": "Boolean", Boolean: { "@_type": "Wait for completion", "@_id": "256", "@_value": value } }] },
    });
    expect(params("Perform Script on Server", "Perform Script on Server [ By name; $s ]", wait("False"))).toBe("[ By name; $s ] [ Wait for completion: Off ]");
    expect(params("Perform Script on Server", "Perform Script on Server [ By name; $s ]&#13;[ Wait for completion ]", wait("True"))).toBe(
      "[ By name; $s ] [ Wait for completion ]",
    );
    expect(params("Perform Script on Server", "Perform Script on Server [ By name; $s ]")).toBe("[ By name; $s ]");
  });
});

describe("stepIrs", () => {
  it("reads the variables a Show Custom Dialog's inputs write, not the fields", () => {
    const target = (n: number, inner: string) => `<Parameter type="Field${n}"><Parameter type="Target">${inner}</Parameter></Parameter>`;
    const repetition = `<repetition><Calculation><Calculation><![CDATA[1]]></Calculation></Calculation></repetition>`;
    const list = xmlParser.parse(
      `<ObjectList><Step index="0" id="87" name="Show Custom Dialog" enable="True"><ParameterValues>` +
        target(1, `<Variable value="$name">${repetition}</Variable>`) +
        target(2, `<FieldReference id="1" name="f">${repetition}<TableOccurrenceReference id="1" name="T"/></FieldReference>`) +
        target(3, `<Variable value="$note">${repetition}</Variable>`) +
        `</ParameterValues></Step></ObjectList>`,
    ) as Record<string, unknown>;
    expect(stepIrs(list["ObjectList"])[0]?.inputVariables).toEqual(["$name", "$note"]);
  });
});

describe("stepIrs: how a step picks its layout", () => {
  it("reads New Window's in its window, and Go to Related Record's", () => {
    const step = (name: string, parameter: string) => `<Step index="0" id="1" name="${name}" enable="True"><ParameterValues>${parameter}</ParameterValues></Step>`;
    const window = (container: string) => `<Parameter type="WindowReference"><WindowReference><Name></Name>${container}</WindowReference></Parameter>`;
    const list = xmlParser.parse(
      `<ObjectList>` +
        step("New Window", window(`<LayoutReferenceContainer value="5"><LayoutReference id="2" name="L"></LayoutReference></LayoutReferenceContainer>`)) +
        step("New Window", window(`<LayoutReferenceContainer value="0"></LayoutReferenceContainer>`)) +
        step("Go to Related Record", `<Parameter type="Related"><TableOccurrenceReference id="3" name="T"></TableOccurrenceReference><LayoutReferenceContainer value="1"><Label>original layout</Label></LayoutReferenceContainer></Parameter>`) +
        `</ObjectList>`,
    ) as Record<string, unknown>;
    expect(stepIrs(list["ObjectList"]).map((s) => s.layoutChoice)).toEqual(["specified", "none", "original"]);
  });
});
