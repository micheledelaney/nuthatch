/**
 * Parser behaviors that none of the sample exports exercise, each checked on a
 * minimal hand-written FMSaveAsXML document.
 */
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { occurrencesBeforeMissingField } from "@/core/identifiers";
import type { FmObject, ParseResult } from "@/types/ddr";

function doc(name: string, structure: string, ddrInfo = ""): { name: string; content: string } {
  return {
    name: `${name}.xml`,
    content:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<FMSaveAsXML version="2.2.3.0" Source="22.0.1" File="${name}.fmp12">` +
      `<Structure membercount="1">${structure}</Structure><DDR_INFO>${ddrInfo}</DDR_INFO></FMSaveAsXML>`,
  };
}

const TABLE = `
  <BaseTableCatalog><BaseTable id="1" name="T"></BaseTable></BaseTableCatalog>
  <TableOccurrenceCatalog>
    <TableOccurrence id="1" name="T"><BaseTableSourceReference><BaseTableReference id="1" name="T"></BaseTableReference></BaseTableSourceReference></TableOccurrence>
  </TableOccurrenceCatalog>
  <FieldsForTables><FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference>
    <ObjectList><Field id="1" name="a"></Field><Field id="2" name="b"></Field></ObjectList>
  </FieldCatalog></FieldsForTables>`;

/** A layout (id 10) with the given layout objects on its body. */
function layout(objects: string): string {
  return `<LayoutCatalog><Layout id="10" name="L"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>
    <PartsList><Part type="Body"><Definition absolute="0" size="100"></Definition><ObjectList>${objects}</ObjectList></Part></PartsList>
  </Layout></LayoutCatalog>`;
}

function parse(...docs: { name: string; content: string }[]): ParseResult {
  return parseDocuments(docs);
}

function refsFrom(result: ParseResult, uid: string): string[] {
  return result.references
    .filter((r) => r.fromUid === uid)
    .map((r) => `${r.toType}:${r.toId}${r.viaToId ? ` via ${r.viaToId}` : ""}${r.fromStep ? ` step ${r.fromStep}` : ""} ${r.kind}`)
    .sort();
}

function object(result: ParseResult, uid: string): FmObject {
  const found = result.objects.find((o) => o.uid === uid);
  if (!found) throw new Error(`no object ${uid}`);
  return found;
}

describe("layout objects record what they use", () => {
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}${layout(`
        <LayoutObject id="1" type="Group" name=""><GroupedButton><ObjectList>
          <LayoutObject id="2" type="Edit Box" name="">
            <Field><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Field>
            <Conditions><Hide><Calculation><DDRREF kind="ChunkList" hash="H1">_P1</DDRREF><Text><![CDATA[T::b]]></Text></Calculation></Hide></Conditions>
          </LayoutObject>
        </ObjectList></GroupedButton></LayoutObject>
        <LayoutObject id="3" type="Button" name=""><Button><action>
          <Step id="1" name="Go to Layout" enable="True"><ParameterValues><Parameter type="LayoutReferenceContainer">
            <LayoutReferenceContainer value="1"><LayoutReference id="10" name="L"></LayoutReference></LayoutReferenceContainer>
          </Parameter></ParameterValues></Step>
        </action></Button></LayoutObject>
        <LayoutObject id="4" type="Text" name=""><Text><StyledText><Data><![CDATA[<<$$X>>]]></Data></StyledText></Text></LayoutObject>
        <LayoutObject id="6" type="Text" name=""><Text><StyledText><Data><![CDATA[Total: <<$$X>>]]></Data></StyledText></Text></LayoutObject>
        <LayoutObject id="5" type="Portal" name=""><Portal>
          <TableOccurrenceReference id="-1" name="&lt;Table Missing&gt;"></TableOccurrenceReference>
          <Options show="5"></Options><ObjectList></ObjectList>
        </Portal></LayoutObject>`)}</AddAction>`,
      `<Calcs><_P1 hash="H1"><ChunkList><Chunk type="FieldRef"><FieldReference id="2" name="b"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Chunk></ChunkList></_P1></Calcs>`,
    ),
  );

  it("records a field object's binding and the fields its hide condition reads", () => {
    expect(refsFrom(result, "F0:layoutObject:10.1.2")).toEqual([
      "field:1 via 1 field",
      "field:2 via 1 field",
      "tableOccurrence:1 tableOccurrence",
    ]);
  });

  it("leaves a nested object's uses to the nested object", () => {
    expect(refsFrom(result, "F0:layoutObject:10.1")).toEqual([]);
  });

  it("records a single-step button's target", () => {
    expect(refsFrom(result, "F0:layoutObject:10.3")).toEqual(["layout:10 step 1 goToLayout"]);
  });

  it("flags a portal on a deleted occurrence once", () => {
    const model = buildModel(result);
    expect(model.brokenReferences.filter((r) => r.fromUid === "F0:layoutObject:10.5")).toHaveLength(1);
  });

  it("counts each merge-variable use once, not again for its layout object", () => {
    expect(object(result, "F0:globalVariable:$$X").attributes.occurrences).toBe("2");
  });

  it("flags a deleted field in a portal's filter on the portal, not only on its layout", () => {
    // As in the Order.xml sample: the filter names a field of a deleted
    // occurrence, so its chunk list is empty.
    const filtered = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`
          <LayoutObject id="7" type="Portal" name=""><Portal>
            <TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>
            <Options show="5"></Options>
            <Calculation><DDRREF kind="ChunkList" hash="H7">_P7</DDRREF><Text><![CDATA[<Table Missing>::<Field Missing> = 1]]></Text></Calculation>
            <ObjectList></ObjectList>
          </Portal></LayoutObject>`)}</AddAction>`,
        `<Calcs><_P7 hash="H7"><ChunkList></ChunkList></_P7></Calcs>`,
      ),
    );
    const broken = buildModel(filtered).brokenReferences;
    expect(broken.filter((r) => r.fromUid === "F0:layoutObject:10.7")).toHaveLength(1);
    expect(broken.filter((r) => r.fromUid === "F0:layout:10")).toHaveLength(1);
  });
});

describe("export shapes no sample has", () => {
  it("reports a <Structure> it can't read instead of returning an empty file", () => {
    const result = parse(doc("MAIN", `<AddAction><ScriptCatalog></ScriptCatalog></AddAction><AddAction><ScriptCatalog></ScriptCatalog></AddAction>`));
    expect(result.errors.join("\n")).toContain("unrecognized <Structure>");
  });

  it("keeps the catalogs after an empty AddAction LayoutCatalog (FM 22 with a ModifyAction)", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><LayoutCatalog/><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog></AddAction>` +
          `<ModifyAction><LayoutCatalog><Layout><LayoutReference id="9" name="X"></LayoutReference></Layout></LayoutCatalog></ModifyAction>`,
      ),
    );
    expect(result.errors).toEqual([]);
    expect(object(result, "F0:script:1").name).toBe("S");
  });

  it("keeps the objects inside an object that has neither id nor UUID", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`
          <LayoutObject type="Group" name=""><GroupedButton><ObjectList>
            <LayoutObject id="7" type="Edit Box" name="">
              <Field><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Field>
            </LayoutObject>
          </ObjectList></GroupedButton></LayoutObject>`)}</AddAction>`,
      ),
    );
    expect(object(result, "F0:layoutObject:10.7").parentUid).toBe("F0:layout:10");
  });

  it("trims layout folder names the way it trims script folder names", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>
          <ScriptCatalog><Script id="1" name=" Admin " isFolder="True"></Script><Script id="2" name="S"></Script><Script id="3" name="--" isFolder="Marker"></Script></ScriptCatalog>
          <LayoutCatalog><Layout id="1" name=" Admin " isFolder="True"></Layout><Layout id="2" name="L"></Layout><Layout id="3" name="--" isFolder="Marker"></Layout></LayoutCatalog>
        </AddAction>`,
      ),
    );
    expect(object(result, "F0:script:2").folder).toBe("Admin");
    expect(object(result, "F0:layout:2").folder).toBe("Admin");
  });

  it("recovers an FM 21 install condition's references from its text, like an FM 26 one", () => {
    // FM 21 puts the pointer beside a <Calculation> holding bare CDATA; FM 26
    // puts it inside the <Calculation>, beside its <Text>. The chunk list is
    // empty because the condition names a deleted field.
    const menu = (install: string): string =>
      `<AddAction>${TABLE}<CustomMenuCatalog><CustomMenu id="5" name="M"><Conditions><Install>${install}</Install></Conditions></CustomMenu></CustomMenuCatalog></AddAction>`;
    const emptyList = `<Calcs><_P3 hash="H3"><ChunkList></ChunkList></_P3></Calcs>`;
    const formula = "T::b and T::<Field Missing>";
    const fm21 = parse(doc("MAIN", menu(`<DDRREF kind="ChunkList" hash="H3">_P3</DDRREF><Calculation><![CDATA[${formula}]]></Calculation>`), emptyList));
    const fm26 = parse(doc("MAIN", menu(`<Calculation><DDRREF kind="ChunkList" hash="H3">_P3</DDRREF><Text><![CDATA[${formula}]]></Text></Calculation>`), emptyList));
    expect(refsFrom(fm21, "F0:customMenu:5")).toContain("field:2 via 1 field");
    expect(refsFrom(fm21, "F0:customMenu:5")).toEqual(refsFrom(fm26, "F0:customMenu:5"));
  });
});

describe("decoding", () => {
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>
        <RelationshipCatalog><Relationship id="1">
          <LeftTable><TableOccurrenceReference id="1" name="A &amp; B"></TableOccurrenceReference></LeftTable>
          <RightTable><TableOccurrenceReference id="2" name="C"></TableOccurrenceReference></RightTable>
          <JoinPredicateList><JoinPredicate type="Equal">
            <LeftField><FieldReference id="1" name="x&amp;y"></FieldReference></LeftField>
            <RightField><FieldReference id="2" name="z"></FieldReference></RightField>
          </JoinPredicate></JoinPredicateList>
        </Relationship></RelationshipCatalog>
        <BaseTableCatalog><BaseTable id="1" name="T"></BaseTable></BaseTableCatalog>
        <FieldsForTables><FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference>
          <ObjectList><Field id="1" name="a" comment="FileMaker&apos;s own id"></Field></ObjectList>
        </FieldCatalog></FieldsForTables>
        <CustomFunctionsCatalog><CustomFunction id="1" name="F"><Display>F ( a &amp; b )</Display></CustomFunction></CustomFunctionsCatalog>
        <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
        <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference>
          <ObjectList><Step id="1" name="Q &amp; A" enable="True"></Step>
            <Step id="2" name="Insert Text" enable="True"><DDRREF kind="StepText" hash="S2"></DDRREF>
              <ParameterValues><Parameter type="Text"><Text value="a &amp; b&#13;c"></Text></Parameter></ParameterValues>
            </Step>
          </ObjectList>
        </Script></StepsForScripts>
      </AddAction>`,
      `<Script><ObjectList><_ datatype="StepText" hash="S2">Insert Text [ Select ]</_></ObjectList></Script>`,
    ),
  );

  it("decodes relationship occurrence and field names", () => {
    expect(object(result, "F0:relationship:1").detail).toMatchObject({
      leftTable: "A & B",
      predicates: [{ leftField: "x&y", rightField: "z" }],
    });
  });

  it("decodes attribute values copied from the XML", () => {
    expect(object(result, "F0:field:1.1").attributes.comment).toBe("FileMaker's own id");
  });

  it("decodes an Insert Text value, keeping its line breaks", () => {
    expect(object(result, "F0:script:1").detail).toMatchObject({
      steps: [{}, { name: "Insert Text", params: '[ Select ] [ Text: "a & b\nc" ]' }],
    });
  });

  it("decodes a custom function's signature and a script step's name", () => {
    expect(object(result, "F0:customFunction:1").detail).toMatchObject({ signature: "F ( a & b )" });
    expect(object(result, "F0:script:1").detail).toMatchObject({ steps: [{ name: "Q & A" }, {}] });
  });
});

describe("CDATA stays verbatim", () => {
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}
        <CustomFunctionsCatalog><CustomFunction id="1" name="F"><Display><![CDATA[F ( "&amp;" )]]></Display></CustomFunction></CustomFunctionsCatalog>
        ${layout(`<LayoutObject id="1" type="Text" name=""><Text><StyledText><Data><![CDATA[Tom &amp; Jerry]]></Data></StyledText></Text></LayoutObject>`)}
      </AddAction>`,
    ),
  );

  it("keeps a literal entity typed into a text object or a signature", () => {
    expect(object(result, "F0:layoutObject:10.1").detail).toMatchObject({ info: "Tom &amp; Jerry" });
    expect(object(result, "F0:customFunction:1").detail).toMatchObject({ signature: 'F ( "&amp;" )' });
  });
});

describe("what gets parsed", () => {
  it("keeps an account's stored password out of its text", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><AccountsCatalog><Account id="2" type="FileMaker" enable="True">
          <Authentication><AccountName>admin</AccountName><PasswordEncrypted><Context>SALT==</Context><Data>HASH=</Data></PasswordEncrypted></Authentication>
          <PrivilegeSetReference id="1" name="[Full Access]"></PrivilegeSetReference>
        </Account></AccountsCatalog></AddAction>`,
      ),
    );
    const account = object(result, "F0:account:2");
    expect(account.text).toBe("admin [Full Access]");
    expect(account.attributes.password).toBe("Yes");
  });

  it("marks only a Set Field's target as set, not the fields its value reads", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>
            <Step id="1" name="Set Field" enable="True"><ParameterValues>
              <Parameter type="FieldReference"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter>
              <Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation>
                <DDRREF kind="ChunkList" hash="H2">_P2</DDRREF><Text><![CDATA[T::b]]></Text>
              </Calculation></Calculation></Parameter>
            </ParameterValues></Step>
          </ObjectList></Script></StepsForScripts>
        </AddAction>`,
        `<Calcs><_P2 hash="H2"><ChunkList><Chunk type="FieldRef"><FieldReference id="2" name="b"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Chunk></ChunkList></_P2></Calcs>`,
      ),
    );
    expect(refsFrom(result, "F0:script:1")).toEqual([
      "field:1 via 1 step 1 setField",
      "field:2 via 1 step 1 field",
      "tableOccurrence:1 step 1 tableOccurrence",
    ]);
  });

  it("keeps a Set Field's target and its value's read of the same field", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>
            <Step id="1" name="Set Field" enable="True"><ParameterValues>
              <Parameter type="FieldReference"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter>
              <Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation>
                <DDRREF kind="ChunkList" hash="H2">_P2</DDRREF><Text><![CDATA[T::a + 1]]></Text>
              </Calculation></Calculation></Parameter>
            </ParameterValues></Step>
          </ObjectList></Script></StepsForScripts>
        </AddAction>`,
        `<Calcs><_P2 hash="H2"><ChunkList><Chunk type="FieldRef"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Chunk><Chunk type="NoRef">+ 1</Chunk></ChunkList></_P2></Calcs>`,
      ),
    );
    expect(refsFrom(result, "F0:script:1")).toEqual([
      "field:1 via 1 step 1 field",
      "field:1 via 1 step 1 setField",
      "tableOccurrence:1 step 1 tableOccurrence",
    ]);
  });

  it("flags a deleted field in a step whose other field sits behind an unavailable file", () => {
    // As in the SampleB.xml sample: the target's file wasn't available at
    // export, so FileMaker blanks its name; the value reads a deleted occurrence.
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>
          <ExternalDataSourceCatalog><ExternalDataSource id="1" name="Other"></ExternalDataSource></ExternalDataSourceCatalog>
          <TableOccurrenceCatalog>
            <TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference><DataSourceReference id="1" name="Other"></DataSourceReference></BaseTableSourceReference></TableOccurrence>
          </TableOccurrenceCatalog>
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>
            <Step id="76" name="Set Field" enable="True"><DDRREF kind="StepText" hash="S1"></DDRREF><ParameterValues>
              <Parameter type="FieldReference"><FieldReference id="137" name="" UUID=""><TableOccurrenceReference id="2" name="X"></TableOccurrenceReference></FieldReference></Parameter>
              <Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation>
                <DDRREF kind="ChunkList" hash="H1">_P1</DDRREF><Text><![CDATA[<Table Missing>::<Field Missing>]]></Text>
              </Calculation></Calculation></Parameter>
            </ParameterValues></Step>
          </ObjectList></Script></StepsForScripts>
        </AddAction>`,
        `<Calcs><_P1 hash="H1"><ChunkList></ChunkList></_P1></Calcs>` +
          `<Script><ObjectList><_ datatype="StepText" hash="S1">Set Field [ X::&lt;File Missing&gt;; &lt;Table Missing&gt;::&lt;Field Missing&gt; ]</_></ObjectList></Script>`,
      ),
    );
    const broken = buildModel(result).brokenReferences.filter((r) => r.fromUid === "F0:script:1");
    expect(broken.map((r) => `${r.toName} step ${r.fromStep}`)).toEqual(["<Field Missing> step 1"]);
  });

  it("names a custom menu item by its title and types it by what it does", () => {
    // The shapes of the test solution's M_Custom items: FM 22 / 26, and FM 21
    // (no <action> wrapper, bare-CDATA title).
    const title = (text: string): string =>
      `<Name><Calculation><DDRREF kind="ChunkList" hash=""></DDRREF><Text><![CDATA["${text}"]]></Text></Calculation></Name>`;
    const step = (script: string): string =>
      `<Step index="0" id="1" name="Perform Script" enable="True"><ParameterValues><Parameter type="List"><List name="From list" value="1">${script}</List></Parameter></ParameterValues></Step>`;
    const performScript = (script: string): string => `<action>${step(script)}</action>`;
    const S_MAIN = `<ScriptReference id="8" name="S_Main"></ScriptReference>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><CustomMenuCatalog><CustomMenu id="30" name="M_Custom"><MenuItemList>
          <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><Command name="Copy" id="57634"></Command></CustomMenuItem>
          <CustomMenuItem index="1" isSubMenuItem="False" isSeparatorItem="False">${performScript(S_MAIN)}${title("Run S_Main")}<Command id="0"></Command></CustomMenuItem>
          <CustomMenuItem index="4" isSubMenuItem="False" isSeparatorItem="False">${title("Shortcut item")}<Command id="0"></Command></CustomMenuItem>
          <CustomMenuItem index="5" isSubMenuItem="False" isSeparatorItem="False">${title("Conditional item")}<Command name="Undo" id="49320"></Command></CustomMenuItem>
          <CustomMenuItem index="6" isSubMenuItem="False" isSeparatorItem="False">${performScript("")}${title("Deleted script item")}<Command id="0"></Command></CustomMenuItem>
          <CustomMenuItem index="7" isSubMenuItem="False" isSeparatorItem="False">${step(S_MAIN)}<Name><Calculation><![CDATA["Run S_Main (FM 21)"]]></Calculation></Name><Command id="0"></Command></CustomMenuItem>
        </MenuItemList></CustomMenu></CustomMenuCatalog></AddAction>`,
      ),
    );
    const item = (index: number): string => {
      const o = object(result, `F0:customMenuItem:30.${index}`);
      return `${o.name} (${o.attributes.itemType})`;
    };
    expect([0, 1, 4, 5, 6, 7].map(item)).toEqual([
      "Copy (Command)",
      "Run S_Main (Performs script)",
      "Shortcut item (Custom)",
      "Conditional item (Command)",
      "Deleted script item (Performs script)",
      "Run S_Main (FM 21) (Performs script)",
    ]);
  });

  it("shows a join type it has no symbol for as written, not as =", () => {
    const predicate = (type: string): string =>
      `<JoinPredicate type="${type}"><LeftField><FieldReference id="1" name="x"></FieldReference></LeftField><RightField><FieldReference id="2" name="y"></FieldReference></RightField></JoinPredicate>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><RelationshipCatalog><Relationship id="1">
          <LeftTable><TableOccurrenceReference id="1" name="A"></TableOccurrenceReference></LeftTable>
          <RightTable><TableOccurrenceReference id="2" name="B"></TableOccurrenceReference></RightTable>
          <JoinPredicateList>${predicate("Less")}${predicate("Unforeseen")}</JoinPredicateList>
        </Relationship></RelationshipCatalog></AddAction>`,
      ),
    );
    expect(object(result, "F0:relationship:1").detail).toMatchObject({ predicates: [{ operator: "<" }, { operator: "Unforeseen" }] });
  });

  it("gives an empty formula no body, not its context occurrence's name", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE.replace(
          '<Field id="2" name="b"></Field>',
          `<Field id="2" name="b" fieldtype="Calculated"><Calculation>
            <TableOccurrenceReference id="1" name="T"></TableOccurrenceReference><DDRREF kind="ChunkList" hash="H3">_P3</DDRREF>
          </Calculation></Field>`,
        )}</AddAction>`,
      ),
    );
    expect(object(result, "F0:field:1.2").detail).toBeUndefined();
  });

  it("streams layouts whose text holds layout markup", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><LayoutCatalog>
          <Layout id="1" name="A"><PartsList><Part type="Body"><Definition absolute="0" size="100"></Definition><ObjectList>
            <LayoutObject id="1" type="Text" name=""><Text><StyledText><Data><![CDATA[</Layout><Layout id="9" name="X">]]></Data></StyledText></Text></LayoutObject>
          </ObjectList></Part></PartsList></Layout>
          <Layout id="2" name="B"></Layout>
        </LayoutCatalog></AddAction>`,
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.objects.filter((o) => o.type === "layout").map((o) => o.name)).toEqual(["A", "B"]);
    expect(object(result, "F0:layoutObject:1.1").detail).toMatchObject({ info: '</Layout><Layout id="9" name="X">' });
  });
});

describe("name boundaries", () => {
  it("treats letters of any script as part of a name, as the parser does", () => {
    expect([...occurrencesBeforeMissingField("ÄLager::<Field Missing>", ["Lager"])]).toEqual([]);
    expect([...occurrencesBeforeMissingField("x + Lager::<Field Missing>", ["Lager"])]).toEqual(["Lager"]);
  });
});
