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

describe("name boundaries", () => {
  it("treats letters of any script as part of a name, as the parser does", () => {
    expect([...occurrencesBeforeMissingField("ÄLager::<Field Missing>", ["Lager"])]).toEqual([]);
    expect([...occurrencesBeforeMissingField("x + Lager::<Field Missing>", ["Lager"])]).toEqual(["Lager"]);
  });
});
