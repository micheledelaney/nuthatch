/**
 * Parser behaviors that none of the sample exports exercise, each checked on a
 * minimal hand-written FMSaveAsXML document.
 */
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { buildModel } from "@/core/model/buildModel";
import { buildDependencyView } from "@/core/analysis/dependencies";
import { diffAnalyses } from "@/core/analysis/diff";
import { brokenSourcesFor, refStatsFor } from "@/components/browseA/refStats";
import { ownFieldRef, refLabel, refStatus } from "@/core/model/refStatus";
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
    expect(object(result, "F0:globalVariable:$$x").attributes.occurrences).toBe("2");
  });

  it("flags a deleted field in a portal's filter on the portal, not only on its layout", () => {
    // As in a sample export: the filter names a field of a deleted
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

  it("closes a folder at a self-closing marker, whether its catalog is streamed or not", () => {
    const entries = (tag: string): string =>
      `<${tag} id="90" name="Dev" isFolder="True"></${tag}><${tag} id="1" name="A"></${tag}>` +
      `<${tag} id="91" name="" isFolder="Marker"/><${tag} id="2" name="B"></${tag}>`;
    const folders = (result: ParseResult, type: string): string[] =>
      result.objects.filter((o) => o.type === type).map((o) => `${o.name} ${o.folder ?? ""}`);
    const streamed = parse(doc("MAIN", `<AddAction><LayoutCatalog>${entries("Layout")}</LayoutCatalog><ScriptCatalog>${entries("Script")}</ScriptCatalog></AddAction>`));
    // An empty first catalog is the one streamed, so the second is read from the tree.
    const inTree = parse(doc("MAIN", `<AddAction><LayoutCatalog></LayoutCatalog><LayoutCatalog>${entries("Layout")}</LayoutCatalog></AddAction>`));
    expect(folders(streamed, "script")).toEqual(["A Dev", "B "]);
    expect(folders(streamed, "layout")).toEqual(["A Dev", "B "]);
    expect(folders(inTree, "layout")).toEqual(["A Dev", "B "]);
  });

  it("reads the layouts of a second LayoutCatalog after the streamed ones", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>
          <LayoutCatalog><Layout id="1" name="L1"></Layout></LayoutCatalog>
          <LayoutCatalog><Layout id="8" name="Dev" isFolder="True"></Layout><Layout id="2" name="L2"></Layout><Layout id="9" name="" isFolder="Marker"></Layout></LayoutCatalog>
        </AddAction>`,
      ),
    );
    expect(result.errors).toEqual([]);
    const layouts = result.objects.filter((o) => o.type === "layout").map((o) => `${o.name} ${o.order} ${o.folder ?? ""}`);
    expect(layouts).toEqual(["L1 0 ", "L2 1 Dev"]);
  });

  it("warns about an export saved with split catalogs", () => {
    const content = doc("MAIN", `<AddAction><ScriptCatalog></ScriptCatalog></AddAction>`).content.replace(`<FMSaveAsXML `, `<FMSaveAsXML split_catalogs="True" `);
    const result = parse({ name: "MAIN.xml", content });
    expect(result.errors).toEqual([`MAIN.xml: saved with split catalogs (split_catalogs="True"), which this app doesn't support — some objects may be missing.`]);
    expect(result.files.map((f) => f.name)).toEqual(["MAIN"]);
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
    // As in a sample export: the target's file wasn't available at
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

  it("shows an auto-enter calc that's on beside an auto-entered Data value", () => {
    // As in a sample export: FileMaker 26 marks each option enable="…".
    const autoEnter = (enable: string): string =>
      `<AutoEnter type="ConstantData" overwriteExisting="True" alwaysEvaluate="True"><ConstantData>0</ConstantData>` +
      `<Calculated enable="${enable}"><Calculation><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference><Text><![CDATA[T::a]]></Text></Calculation></Calculated></AutoEnter>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE.replace('<Field id="2" name="b"></Field>', `<Field id="2" name="b">${autoEnter("True")}</Field><Field id="3" name="c">${autoEnter("False")}</Field>`)}</AddAction>`,
      ),
    );
    const on = object(result, "F0:field:1.2");
    expect(on.detail).toEqual({ kind: "calculation", signature: "Auto-enter calculation", body: "T::a" });
    expect(on.attributes).toMatchObject({ autoEnter: "Data: 0", calcContextToId: "1" });
    expect(object(result, "F0:field:1.3").detail).toBeUndefined();
  });

  it("counts a global passed by name in a formula's text, but not one in its comment", () => {
    // No chunk list to read (no DDR_INFO block), so the text is scanned.
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><CustomFunctionsCatalog><CustomFunction id="1" name="F"><Calculation>
          <DDRREF kind="ChunkList" hash="H1">_P1</DDRREF><Text><![CDATA[$$a & Evaluate ( "$$b" ) // "$$c"]]></Text>
        </Calculation></CustomFunction></CustomFunctionsCatalog></AddAction>`,
      ),
    );
    expect(refsFrom(result, "F0:customFunction:1")).toEqual(["globalVariable:$$a globalVariable", "globalVariable:$$b globalVariable"]);
  });

  it("gives a layout without an id no place in the order, like a script", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>
          <ScriptCatalog><Script id="1" name="A"></Script><Script name="No id"></Script><Script id="2" name="B"></Script></ScriptCatalog>
          <LayoutCatalog><Layout id="1" name="A"></Layout><Layout name="No id"></Layout><Layout id="2" name="B"></Layout></LayoutCatalog>
        </AddAction>`,
      ),
    );
    expect(object(result, "F0:script:2").order).toBe(1);
    expect(object(result, "F0:layout:2").order).toBe(1);
    expect(result.errors).toEqual(["MAIN.xml: 1 script without an id was left out.", "MAIN.xml: 1 layout without an id was left out."]);
  });

  it("reports fields and steps left out because their table or script isn't in its catalog", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>
          <BaseTableCatalog><BaseTable id="1" name="T"></BaseTable></BaseTableCatalog>
          <FieldsForTables>
            <FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference><ObjectList><Field id="1" name="a"></Field></ObjectList></FieldCatalog>
            <FieldCatalog><BaseTableReference id="9" name="Gone"></BaseTableReference>
              <ObjectList><Field id="1" name="a"></Field><Field id="2" name="b"></Field></ObjectList>
            </FieldCatalog>
          </FieldsForTables>
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="7" name="Gone"></ScriptReference><ObjectList><Step id="1" name="Beep"></Step></ObjectList></Script></StepsForScripts>
        </AddAction>`,
      ),
    );
    expect(result.errors).toEqual([
      "MAIN.xml: 2 fields of tables that aren't in its table catalog were left out.",
      "MAIN.xml: the steps of 1 script that isn't in its script catalog were left out.",
    ]);
  });

  it("decodes an object's search text, without reading a placeholder name as a broken use", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE.replace(
          '<Field id="2" name="b"></Field>',
          `<Field id="2" name="b"><AutoEnter type="Looked_up"><Looked_up>
            <FieldReference id="9" name="Q &amp; A"><TableOccurrenceReference id="-1" name="&lt;Table Missing&gt;"></TableOccurrenceReference></FieldReference>
          </Looked_up></AutoEnter></Field>`,
        )}</AddAction>`,
      ),
    );
    expect(object(result, "F0:field:1.2").text).toContain("<Table Missing>");
    expect(object(result, "F0:field:1.2").text).toContain("Q & A");
    expect(forcedFrom(result, "F0:field:1.2")).toEqual([]);
    expect(buildModel(result).brokenReferences.filter((r) => r.fromUid === "F0:field:1.2")).toHaveLength(1);
  });

  it("flags a deleted field in a custom function's separately stored formula (FM 22)", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <CustomFunctionsCatalog><CustomFunction id="1" name="F"></CustomFunction></CustomFunctionsCatalog>
          <CalcsForCustomFunctions><CustomFunctionCalc><CustomFunctionReference id="1" name="F"></CustomFunctionReference>
            <Calculation><Text><![CDATA[T::<Field Missing>]]></Text></Calculation>
          </CustomFunctionCalc></CalcsForCustomFunctions>
        </AddAction>`,
      ),
    );
    expect(forcedFrom(result, "F0:customFunction:1")).toEqual(["field <Field Missing> via 1"]);
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

/** TABLE plus an external occurrence X (id 2) whose file wasn't available at
 * export: its data source exists, but it has no base table. */
const TABLE_AND_UNAVAILABLE = TABLE.replace(
  "</TableOccurrenceCatalog>",
  `<TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference><DataSourceReference id="1" name="Other"></DataSourceReference></BaseTableSourceReference></TableOccurrence>
  </TableOccurrenceCatalog>
  <ExternalDataSourceCatalog><ExternalDataSource id="1" name="Other"></ExternalDataSource></ExternalDataSourceCatalog>`,
);

/** A <FieldReference> FileMaker left with a blank name, through occurrence `to`. */
function blankField(id: string, to: string, toName: string): string {
  return `<FieldReference id="${id}" name="" UUID=""><TableOccurrenceReference id="${to}" name="${toName}"></TableOccurrenceReference></FieldReference>`;
}

function editBox(id: string, fieldRef: string, extra = ""): string {
  return `<LayoutObject id="${id}" type="Edit Box" name=""><Field>${fieldRef}</Field>${extra}</LayoutObject>`;
}

/** The broken edges the parser itself records (forceBroken) from `uid`. */
function forcedFrom(result: ParseResult, uid: string): string[] {
  return result.references
    .filter((r) => r.fromUid === uid && r.forceBroken)
    .map((r) => `${r.toType} ${r.toName}${r.viaToId ? ` via ${r.viaToId}` : ""}`)
    .sort();
}

describe("field labels", () => {
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE_AND_UNAVAILABLE}
        <RelationshipCatalog><Relationship id="1">
          <LeftTable><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></LeftTable>
          <RightTable><TableOccurrenceReference id="2" name="X"></TableOccurrenceReference></RightTable>
          <JoinPredicateList><JoinPredicate type="Equal">
            <LeftField>${blankField("9", "1", "T")}</LeftField><RightField>${blankField("7", "2", "X")}</RightField>
          </JoinPredicate></JoinPredicateList>
        </Relationship></RelationshipCatalog>
        ${layout(editBox("1", blankField("7", "2", "X")) + editBox("2", blankField("9", "1", "T")))}
      </AddAction>`,
    ),
  );

  it("reads a field behind an unavailable file by its id, not as missing", () => {
    expect(object(result, "F0:layoutObject:10.1").name).toBe("X::(field 7)");
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual([]);
  });

  it("still reads a deleted field as missing", () => {
    expect(object(result, "F0:layoutObject:10.2").name).toBe("T::<Field Missing>");
  });

  it("labels a relationship's blank predicate fields the same way", () => {
    expect(object(result, "F0:relationship:1").detail).toMatchObject({
      predicates: [{ leftField: "<Field Missing>", rightField: "(field 7)" }],
    });
  });
});

describe("what a layout reports", () => {
  /** An empty chunk list: FileMaker's output for a calc that names a deleted field. */
  const emptyList = (pointer: string, hash: string): string => `<${pointer} hash="${hash}"><ChunkList></ChunkList></${pointer}>`;
  const conditionalFormat = (formula: string): string =>
    `<Conditions><Formatting><Condition><Calculation><DDRREF kind="ChunkList" hash="H5">_P5</DDRREF><Text><![CDATA[${formula}]]></Text></Calculation></Condition></Formatting></Conditions>`;

  it("flags a deleted field in one object's calc although another object reads a deleted occurrence", () => {
    // As on a layout in a sample export.
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(
          editBox("1", blankField("2", "-1", "&lt;Table Missing&gt;")) +
            editBox("2", `<FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference>`, conditionalFormat("T::<Field Missing> = 1")),
        )}</AddAction>`,
        `<Calcs>${emptyList("_P5", "H5")}</Calcs>`,
      ),
    );
    expect(forcedFrom(result, "F0:layoutObject:10.2")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:layout:10")).toEqual(["field <Field Missing> via 1"]);
  });

  it("flags a field object whose field and occurrence were deleted on its layout too", () => {
    // As on another layout in a sample export.
    const result = parse(doc("MAIN", `<AddAction>${TABLE}${layout(editBox("1", `<FieldReference id="0" name="" UUID=""></FieldReference>`))}</AddAction>`));
    expect(object(result, "F0:layoutObject:10.1").name).toBe("<Field Missing>");
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual(["field <Field Missing>"]);
    expect(forcedFrom(result, "F0:layout:10")).toEqual(["field <Field Missing>"]);
  });

  it("flags a field object that has no field reference at all", () => {
    // No sample has one: FileMaker writes <FieldReference id="0" name=""> instead.
    const field = `<Options>52</Options><Display Style="0" show="1"></Display><Usage inputMode="0" type="0"></Usage>`;
    const result = parse(doc("MAIN", `<AddAction>${TABLE}${layout(editBox("1", field))}</AddAction>`));
    expect(object(result, "F0:layoutObject:10.1").name).toBe("<Field Missing>");
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual(["field <Field Missing>"]);
    expect(forcedFrom(result, "F0:layout:10")).toEqual(["field <Field Missing>"]);
  });

  it("flags a button's broken Set Field once, as a script's", () => {
    const setField =
      `<Step id="1" name="Set Field" enable="True"><ParameterValues>` +
      `<Parameter type="FieldReference">${blankField("5", "1", "T")}</Parameter>` +
      `<Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation><DDRREF kind="ChunkList" hash="H6">_P6</DDRREF><Text><![CDATA[T::<Field Missing>]]></Text></Calculation></Calculation></Parameter>` +
      `</ParameterValues></Step>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>${setField}</ObjectList></Script></StepsForScripts>
          ${layout(`<LayoutObject id="1" type="Button" name=""><Button><action>${setField}</action></Button></LayoutObject>`)}
        </AddAction>`,
        `<Calcs>${emptyList("_P6", "H6")}</Calcs>`,
      ),
    );
    const broken = buildModel(result).brokenReferences;
    const from = (uid: string): number => broken.filter((r) => r.fromUid === uid).length;
    expect(from("F0:script:1")).toBe(1);
    expect(from("F0:layoutObject:10.1")).toBe(1);
    expect(from("F0:layout:10")).toBe(1);
  });

  it("keeps a layout's use of a script enabled when only one of its buttons' steps is disabled", () => {
    const button = (id: string, enable: string): string =>
      `<LayoutObject id="${id}" type="Button" name="b${id}"><Button><action><Step id="1" name="Perform Script" enable="${enable}"><ParameterValues>` +
      `<Parameter type="List"><List><ScriptReference id="1" name="S"></ScriptReference></List></Parameter></ParameterValues></Step></action></Button></LayoutObject>`;
    const result = parse(doc("MAIN", `<AddAction>${TABLE}<ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>${layout(button("1", "False") + button("2", "True"))}</AddAction>`));
    const toScript = (uid: string): string[] =>
      result.references.filter((r) => r.fromUid === uid && r.toType === "script").map((r) => (r.disabled ? "disabled" : "enabled"));
    expect(toScript("F0:layoutObject:10.1")).toEqual(["disabled"]);
    expect(toScript("F0:layoutObject:10.2")).toEqual(["enabled"]);
    expect(toScript("F0:layout:10")).toEqual(["enabled"]);
  });

  it("lists a button step's use on its layout once, without the step, beside another object's same use", () => {
    const setField =
      `<Step id="1" name="Set Field" enable="True"><ParameterValues><Parameter type="FieldReference">` +
      `<FieldReference id="2" name="b"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter></ParameterValues></Step>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(
          `<LayoutObject id="1" type="Button" name=""><Button><action>${setField}</action></Button></LayoutObject>` +
            `<LayoutObject id="2" type="Edit Box" name=""><Field><FieldReference id="2" name="b"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Field></LayoutObject>`,
        )}</AddAction>`,
      ),
    );
    // The button keeps its step; on the layout, which button's step it was isn't known.
    expect(refsFrom(result, "F0:layoutObject:10.1")).toEqual(["field:2 via 1 step 1 setField", "tableOccurrence:1 step 1 tableOccurrence"]);
    expect(refsFrom(result, "F0:layout:10")).toEqual(["field:2 via 1 field", "field:2 via 1 setField", "tableOccurrence:1 tableOccurrence"]);
  });

  it("labels a button whose calculated label is a literal, but not one whose label is computed", () => {
    const button = (id: string, formula: string): string =>
      `<LayoutObject id="${id}" type="Button" name=""><Button><Label><Calculation><Text><![CDATA[${formula}]]></Text></Calculation></Label></Button></LayoutObject>`;
    const result = parse(doc("MAIN", `<AddAction>${TABLE}${layout(button("1", `"Save"`) + button("2", `"Row " & Get ( RecordNumber )`))}</AddAction>`));
    expect(object(result, "F0:layoutObject:10.1").name).toBe("Button (Save)");
    expect(object(result, "F0:layoutObject:10.1").attributes.label).toBe("Save");
    expect(object(result, "F0:layoutObject:10.2").name).toBe("Button");
    expect(object(result, "F0:layoutObject:10.2").attributes.label).toBeUndefined();
  });

  it("flags a deleted field in an unlabeled button's step, which has no search text", () => {
    // An icon button: no name, no label — only its step's calc shows the deleted field.
    const setVariable =
      `<Step id="1" name="Set Variable" enable="True"><ParameterValues>` +
      `<Parameter type="Variable"><Name value="$x"></Name></Parameter>` +
      `<Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation><DDRREF kind="ChunkList" hash="H6">_P6</DDRREF><Text><![CDATA[T::<Field Missing>]]></Text></Calculation></Calculation></Parameter>` +
      `</ParameterValues></Step>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`<LayoutObject id="1" type="Button" name=""><Button><action>${setVariable}</action></Button></LayoutObject>`)}</AddAction>`,
        `<Calcs>${emptyList("_P6", "H6")}</Calcs>`,
      ),
    );
    expect(object(result, "F0:layoutObject:10.1").text).toBe("");
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:layout:10")).toEqual(["field <Field Missing> via 1"]);
  });
});

describe("name boundaries", () => {
  it("treats letters of any script as part of a name, as the parser does", () => {
    expect([...occurrencesBeforeMissingField("ÄLager::<Field Missing>", ["Lager"])]).toEqual([]);
    expect([...occurrencesBeforeMissingField("x + Lager::<Field Missing>", ["Lager"])]).toEqual(["Lager"]);
  });
});

describe("what a custom menu reports", () => {
  const install = (calc: string): string => `<Conditions><Install><Calculation><Text><![CDATA[${calc}]]></Text></Calculation></Install></Conditions>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}<CustomMenuCatalog>
        <CustomMenu id="30" name="M_Item">${install("1")}<MenuItemList>
          <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False">${install(`T::<Field Missing> ≠ ""`)}<Command name="Undo" id="49320"></Command></CustomMenuItem>
        </MenuItemList></CustomMenu>
        <CustomMenu id="31" name="M_Own">${install(`T::<Field Missing> ≠ ""`)}<MenuItemList></MenuItemList></CustomMenu>
        <CustomMenu id="32" name="M_Positions"><MenuItemList>
          <CustomMenuItem isSubMenuItem="False" isSeparatorItem="False"><Command name="Copy" id="57634"></Command></CustomMenuItem>
          <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><Command name="Paste" id="57637"></Command></CustomMenuItem>
        </MenuItemList></CustomMenu>
      </CustomMenuCatalog></AddAction>`,
    ),
  );

  it("flags a deleted field in an item's calc on the item, not on its menu", () => {
    expect(forcedFrom(result, "F0:customMenuItem:30.0")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:customMenu:30")).toEqual([]);
  });

  it("flags a deleted field in the menu's own install condition on the menu", () => {
    expect(forcedFrom(result, "F0:customMenu:31")).toEqual(["field <Field Missing> via 1"]);
  });

  it("keeps an item without an index apart from the item whose index is its position", () => {
    const uids = result.objects.filter((o) => o.parentUid === "F0:customMenu:32").map((o) => `${o.uid} ${o.name}`);
    expect(uids).toEqual(["F0:customMenuItem:32.pos0 Copy", "F0:customMenuItem:32.0 Paste"]);
  });
});

describe("deleted objects in what a field or privilege set lists", () => {
  const fieldRef = (id: string, name: string): string =>
    `<FieldReference id="${id}" name="${name}" UUID=""><BaseTableReference id="1" name="T"></BaseTableReference></FieldReference>`;
  const grants = `<View access="ReadWrite"></View><Edit access="ReadWrite"></Edit><Create access="ReadWrite"></Create><Delete access="ReadWrite"></Delete>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>
        <BaseTableCatalog><BaseTable id="1" name="T"></BaseTable></BaseTableCatalog>
        <FieldsForTables><FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference><ObjectList>
          <Field id="1" name="a"></Field>
          <Field id="2" name="s" fieldType="Summary"><SummaryInfo operation="Total">
            <SummaryField>${fieldRef("1", "a")}</SummaryField><SummaryField>${fieldRef("9", "")}</SummaryField>
          </SummaryInfo></Field>
        </ObjectList></FieldCatalog></FieldsForTables>
        <PrivilegeSetsCatalog><PrivilegeSet id="5" name="PS"><access>
          <Records Custom="True"><Custom><ObjectList>
            <Table type="existing"><BaseTableReference id="1" name="T"></BaseTableReference>${grants}<Fields access="Custom">
              <Field type="existing" access="ReadOnly">${fieldRef("1", "a")}</Field>
              <Field type="existing" access="ReadOnly">${fieldRef("9", "")}</Field>
              <Field type="New" access="ReadWrite"></Field>
            </Fields></Table>
            <Table type="existing"><BaseTableReference id="7" name="" UUID=""></BaseTableReference>${grants}<Fields access="ReadWrite"></Fields></Table>
            <Table type="New">${grants}<Fields access="ReadWrite"></Fields></Table>
          </ObjectList></Custom></Records>
          <Layouts Custom="True"><Custom><ObjectList>
            <Layout type="existing" access="ReadWrite" records="ReadWrite"><LayoutReference id="3" name="" UUID=""></LayoutReference></Layout>
            <Layout type="New" access="ReadOnly" records="ReadOnly"></Layout>
          </ObjectList></Custom></Layouts>
        </access></PrivilegeSet></PrivilegeSetsCatalog>
      </AddAction>`,
    ),
  );

  it("reads a privilege set's grant on a deleted object as deleted, not as the new-objects default", () => {
    const detail = object(result, "F0:privilegeSet:5").detail;
    if (detail?.kind !== "privilegeSet") throw new Error("no privilege-set detail");
    expect(detail.tables.map((t) => t.table)).toEqual(["T", "<unknown>", "(new tables)"]);
    expect(detail.tables[0]!.fields?.map((f) => f.field)).toEqual(["a", "<Field Missing>", "(new fields)"]);
    expect(detail.layouts?.map((l) => l.name)).toEqual(["<unknown>", "(new layouts)"]);
  });

  it("lists a summary field's deleted field as missing instead of dropping it", () => {
    expect(object(result, "F0:field:1.2").detail).toEqual({ kind: "summary", operation: "Total of", fields: ["a", "<Field Missing>"] });
  });
});

describe("XML names that are also members of every object", () => {
  // FileMaker never writes these; a crafted export can.
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>
        <BaseTableCatalog><BaseTable id="1" name="T &constructor;"></BaseTable></BaseTableCatalog>
        <TableOccurrenceCatalog>
          <TableOccurrence id="1" name="T"><BaseTableSourceReference><BaseTableReference id="1" name="T"></BaseTableReference></BaseTableSourceReference></TableOccurrence>
          <TableOccurrence id="2" name="U"><BaseTableSourceReference><BaseTableReference id="1" name="T"></BaseTableReference></BaseTableSourceReference></TableOccurrence>
        </TableOccurrenceCatalog>
        <RelationshipCatalog><Relationship id="1">
          <LeftTable><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></LeftTable>
          <RightTable><TableOccurrenceReference id="2" name="U"></TableOccurrenceReference></RightTable>
          <JoinPredicateList><JoinPredicate type="toString">
            <LeftField><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></LeftField>
            <RightField><FieldReference id="1" name="a"><TableOccurrenceReference id="2" name="U"></TableOccurrenceReference></FieldReference></RightField>
          </JoinPredicate></JoinPredicateList>
        </Relationship></RelationshipCatalog>
        <FieldsForTables><FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference><ObjectList>
          <Field id="1" name="a"><AutoEnter type="constructor"></AutoEnter><Validation><Strict>toString</Strict></Validation><toString id="1" name="x"></toString></Field>
          <Field id="2" name="s" fieldType="Summary"><SummaryInfo operation="valueOf">
            <SummaryField><FieldReference id="1" name="a"><BaseTableReference id="1" name="T"></BaseTableReference></FieldReference></SummaryField>
          </SummaryInfo></Field>
        </ObjectList></FieldCatalog></FieldsForTables>
      </AddAction>`,
    ),
  );

  it("reads them as plain names, so the result can still be sent from the parse worker", () => {
    expect(object(result, "F0:table:1").name).toBe("T &constructor;");
    expect(object(result, "F0:field:1.1").attributes.autoEnter).toBe("constructor");
    expect(object(result, "F0:field:1.1").attributes.validation).toContain("Strict data type: toString");
    expect(object(result, "F0:field:1.2").detail).toMatchObject({ kind: "summary", operation: "Summary of" });
    expect(object(result, "F0:relationship:1").detail).toMatchObject({ predicates: [{ operator: "toString" }] });
    expect(result.references.filter((r) => typeof r.toType !== "string")).toEqual([]);
    expect(() => structuredClone(result)).not.toThrow();
  });
});

describe("the file's own triggers", () => {
  it("flags a deleted field in a trigger's parameter on the file", () => {
    const result = parse({
      name: "MAIN.xml",
      content:
        `<?xml version="1.0" encoding="UTF-8"?><FMSaveAsXML version="2.2.3.0" Source="22.0.1" File="MAIN.fmp12">` +
        `<Structure membercount="1"><AddAction>${TABLE}<ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog></AddAction></Structure>` +
        `<Metadata><AddAction><ScriptTriggers><ScriptTrigger action="OnFirstWindowOpen" id="1"><ScriptReference id="1" name="S">` +
        `<Calculation><Text><![CDATA[T::<Field Missing>]]></Text></Calculation></ScriptReference></ScriptTrigger></ScriptTriggers></AddAction></Metadata>` +
        `<DDR_INFO></DDR_INFO></FMSaveAsXML>`,
    });
    expect(forcedFrom(result, "F0:file:F0")).toEqual(["field <Field Missing> via 1"]);
  });
});

describe("rendered step text", () => {
  // Steps whose XML is identical share a hash, though their text differs —
  // here, calls into two files that weren't open at export. In FM 22, steps
  // without a UUID also share a pointer; their hash tells them apart.
  const step = (pointer: string, hash: string): string =>
    `<Step id="1" name="Perform Script" enable="True"><DDRREF kind="StepText" hash="${hash}">${pointer}</DDRREF>` +
    `<ParameterValues membercount="1"><Parameter type="List"><List name="From list" value="1"></List></Parameter></ParameterValues></Step>`;
  const stepText = (pointer: string, hash: string, file: string): string =>
    `<${pointer} hash="${hash}" datatype="StepText">Perform Script [ &lt;unknown&gt; from file: “${file}” (file not open) ]</${pointer}>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
        <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference>
          <ObjectList>${step("_P1", "H")}${step("_P2", "H")}${step("__0", "H3")}${step("__0", "H4")}</ObjectList>
        </Script></StepsForScripts></AddAction>`,
      `<Script><ObjectList>${stepText("_P1", "H", "A")}${stepText("_P2", "H", "B")}${stepText("__0", "H3", "C")}${stepText("__0", "H4", "D")}</ObjectList></Script>`,
    ),
  );

  it("is each step's own, though steps share a hash or a pointer", () => {
    const calls = result.references.filter((r) => r.fromUid === "F0:script:1").map((r) => `step ${r.fromStep} → ${r.toFileName}`);
    expect(calls).toEqual(["step 1 → A", "step 2 → B", "step 3 → C", "step 4 → D"]);
    const detail = object(result, "F0:script:1").detail;
    const params = detail?.kind === "script" ? detail.steps.map((s) => s.params) : [];
    expect(params).toEqual(["A", "B", "C", "D"].map((file) => `[ <unknown> from file: “${file}” (file not open) ]`));
  });
});

describe("a deleted target that only a step's rendered text shows", () => {
  // As FileMaker writes a step whose target field was deleted: a blank
  // <FieldReference id="0">, which the element scan skips (Import Records
  // writes the same for every unmapped column), and the placeholder only in the
  // step's rendered text — `T::<Field Missing>` while its occurrence is left,
  // a bare `<Table Missing>` once that's gone too.
  const sortStep = (pointer: string, to = `<TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>`): string =>
    `<Step id="154" name="Sort Records by Field" enable="True"><DDRREF kind="StepText" hash="H${pointer}">${pointer}</DDRREF>` +
    `<ParameterValues><Parameter type="List"><List name="Ascending" value="1"></List></Parameter>` +
    `<Parameter type="FieldReference"><FieldReference id="0" name="" UUID="">${to}</FieldReference></Parameter></ParameterValues></Step>`;
  const exportStep = (pointer: string): string =>
    `<Step id="132" name="Export Field Contents" enable="True"><DDRREF kind="StepText" hash="H${pointer}">${pointer}</DDRREF>` +
    `<ParameterValues><Parameter type="FieldReference"><FieldReference id="0" name="" UUID=""></FieldReference></Parameter></ParameterValues></Step>`;
  const stepText = (pointer: string, text: string): string => `<${pointer} hash="H${pointer}" datatype="StepText">${text}</${pointer}>`;
  const sortText = (pointer: string, to = "T"): string => stepText(pointer, `Sort Records by Field [ Ascending; ${to}::&lt;Field Missing&gt; ]`);
  const exportText = (pointer: string): string => stepText(pointer, "Export Field Contents [ &lt;Table Missing&gt;; Create folders:No ]");
  const button = (id: string, step: string): string => `<LayoutObject id="${id}" type="Button" name=""><Button><action>${step}</action></Button></LayoutObject>`;

  it("is flagged on a button and a menu item, as on a script's step", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>${sortStep("_S1")}${exportStep("_S2")}</ObjectList></Script></StepsForScripts>
          <CustomMenuCatalog><CustomMenu id="30" name="M"><MenuItemList>
            <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><action>${sortStep("_M1")}</action></CustomMenuItem>
          </MenuItemList></CustomMenu></CustomMenuCatalog>
          ${layout(button("1", sortStep("_B1")) + button("2", exportStep("_B2")))}
        </AddAction>`,
        `<Script><ObjectList>${sortText("_S1")}${exportText("_S2")}${sortText("_M1")}${sortText("_B1")}${exportText("_B2")}</ObjectList></Script>`,
      ),
    );
    expect(forcedFrom(result, "F0:script:1")).toEqual(["field <Field Missing> via 1", "field <Table Missing>"]);
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:layoutObject:10.2")).toEqual(["field <Table Missing>"]);
    expect(forcedFrom(result, "F0:layout:10")).toEqual(["field <Field Missing> via 1", "field <Table Missing>"]);
    expect(forcedFrom(result, "F0:customMenuItem:30.0")).toEqual(["field <Field Missing> via 1"]);
  });

  it("isn't flagged behind a file that was unavailable at export, on a button or in a script", () => {
    const to = `<TableOccurrenceReference id="2" name="X"></TableOccurrenceReference>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE_AND_UNAVAILABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>${sortStep("_S1", to)}</ObjectList></Script></StepsForScripts>
          ${layout(button("1", sortStep("_B1", to)))}
        </AddAction>`,
        `<Script><ObjectList>${sortText("_S1", "X")}${sortText("_B1", "X")}</ObjectList></Script>`,
      ),
    );
    expect(forcedFrom(result, "F0:script:1")).toEqual([]);
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual([]);
  });

  it("is flagged once on a button whose calc shows the same placeholder", () => {
    const setField =
      `<Step id="1" name="Set Field" enable="True"><DDRREF kind="StepText" hash="H_B1">_B1</DDRREF><ParameterValues>` +
      `<Parameter type="FieldReference"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter>` +
      `<Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation><DDRREF kind="ChunkList" hash="H6">_P6</DDRREF><Text><![CDATA[T::<Field Missing>]]></Text></Calculation></Calculation></Parameter>` +
      `</ParameterValues></Step>`;
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(button("1", setField))}</AddAction>`,
        `<Calcs><_P6 hash="H6"><ChunkList></ChunkList></_P6></Calcs><Script><ObjectList>${stepText("_B1", "Set Field [ T::a; T::&lt;Field Missing&gt; ]")}</ObjectList></Script>`,
      ),
    );
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual(["field <Field Missing> via 1"]);
  });
});

describe("calcs that share a chunk list", () => {
  // As FM 22 writes calcs of objects without a UUID: the same unhashed pointer
  // (`__0`) on each, and one block for it in DDR_INFO — the first calc's.
  const SHARED = `<DDRREF kind="ChunkList" hash="">__0</DDRREF>`;
  const hide = (formula: string): string => `<Conditions><Hide><Calculation>${SHARED}<Text><![CDATA[${formula}]]></Text></Calculation></Hide></Conditions>`;
  const calcField = `<Field id="3" name="c" fieldtype="Calculated"><Calculation><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>${SHARED}<Text><![CDATA[Right ( b ; 5 )]]></Text></Calculation></Field>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE.replace("</ObjectList>", `${calcField}</ObjectList>`)}
        <CustomFunctionsCatalog><CustomFunction id="7" name="Fn"></CustomFunction></CustomFunctionsCatalog>
        ${layout(
          `<LayoutObject id="1" type="Edit Box" name="">${hide("T::a")}</LayoutObject>` +
            `<LayoutObject id="2" type="Edit Box" name="">${hide(`T::b & "T::a" & Fn ( $$G )`)}</LayoutObject>` +
            `<LayoutObject id="3" type="Text" name=""><Text><StyledText><Data><![CDATA[<<ƒ:T::a>>]]></Data></StyledText></Text>` +
            `<DisplayCalculations membercount="1">${SHARED}</DisplayCalculations></LayoutObject>`,
        )}
      </AddAction>`,
      `<Calcs><__0 hash="X" datatype="ChunkList"><ChunkList hash="X"><Chunk type="FieldRef">` +
        `<FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Chunk></ChunkList></__0></Calcs>`,
    ),
  );

  it("use the block for the calc whose text it spells out", () => {
    expect(refsFrom(result, "F0:layoutObject:10.1")).toEqual(["field:1 via 1 field", "tableOccurrence:1 tableOccurrence"]);
  });

  it("recover another calc's references from its own text, not from a string literal", () => {
    expect(refsFrom(result, "F0:layoutObject:10.2")).toEqual([
      "customFunction:7 customFunction",
      "field:2 via 1 field",
      "globalVariable:$$g globalVariable",
      "tableOccurrence:1 tableOccurrence",
    ]);
    // A field's own calc names same-table fields bare.
    expect(refsFrom(result, "F0:field:1.3")).toEqual(["field:2 via 1 field", "tableOccurrence:1 tableOccurrence"]);
  });

  it("give a text object's merge calc, listed only by its pointer, the block that spells it out", () => {
    // Its <DisplayCalculations> has no formula beside the pointer; the merge
    // calc in its text (`<<ƒ:T::a>>`) is what the block is checked against.
    expect(refsFrom(result, "F0:layoutObject:10.3")).toEqual(["field:1 via 1 field", "tableOccurrence:1 tableOccurrence"]);
  });
});

describe("layout objects copied without a new UUID", () => {
  // FileMaker copies a layout object without regenerating its UUID, so the
  // copies' calcs share pointers (`_<UUID>_Label`); DDR_INFO keeps one block
  // per pointer, and the copy whose pointer has the hash owns it (as on two
  // buttons of a layout in a sample export).
  const SPELLS_A = `<ChunkList hash="X"><Chunk type="FieldRef"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Chunk></ChunkList>`;
  const block = (pointer: string): string => `<${pointer} hash="X" datatype="ChunkList">${SPELLS_A}</${pointer}>`;
  const pointer = (name: string, hash: string): string => `<DDRREF kind="ChunkList" hash="${hash}">${name}</DDRREF>`;
  const label = (calc: string): string => `<Button><Label><Calculation>${calc}</Calculation></Label></Button>`;
  const textObject = (id: string, merge: string, list: string): string =>
    `<LayoutObject id="${id}" type="Text" name=""><Text><StyledText><Data><![CDATA[<<ƒ:${merge}>>]]></Data></StyledText></Text>` +
    `<DisplayCalculations membercount="1">${list}</DisplayCalculations></LayoutObject>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}${layout(
        `<LayoutObject id="1" type="Button" name="">${label(`${pointer("_U1_Label", "X")}<Text><![CDATA[T::a]]></Text>`)}</LayoutObject>` +
          `<LayoutObject id="2" type="Button" name="">${label(pointer("_U1_Label", ""))}</LayoutObject>` +
          textObject("3", "T::a", pointer("_U2_DisplayCalculations_0", "X")) +
          textObject("4", "T::b", pointer("_U2_DisplayCalculations_0", "")) +
          textObject("5", "T::a", pointer("_U2_DisplayCalculations_0", "")),
      )}</AddAction>`,
      `<Calcs>${block("_U1_Label")}${block("_U2_DisplayCalculations_0")}</Calcs>`,
    ),
  );

  it("give an empty calc none of the copy's references", () => {
    expect(refsFrom(result, "F0:layoutObject:10.1")).toEqual(["field:1 via 1 field", "tableOccurrence:1 tableOccurrence"]);
    expect(refsFrom(result, "F0:layoutObject:10.2")).toEqual([]);
  });

  it("give a text object's merge calc the copy's references only when it's the same calc", () => {
    expect(refsFrom(result, "F0:layoutObject:10.3")).toEqual(["field:1 via 1 field", "tableOccurrence:1 tableOccurrence"]);
    // Changed since: read from its own text.
    expect(refsFrom(result, "F0:layoutObject:10.4")).toEqual(["field:2 via 1 field", "tableOccurrence:1 tableOccurrence"]);
    expect(refsFrom(result, "F0:layoutObject:10.5")).toEqual(["field:1 via 1 field", "tableOccurrence:1 tableOccurrence"]);
  });
});

describe("a field read through another file's occurrence, recovered from a calc's text", () => {
  // The calc's chunk list is empty (it names a deleted field), so its text is
  // all there is; X's base table lives in EXT, which its UUID identifies.
  const main = doc(
    "MAIN",
    `<AddAction>${TABLE.replace(
      "</TableOccurrenceCatalog>",
      `<TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference>
        <DataSourceReference id="1" name="EXT"></DataSourceReference><BaseTableReference id="1" name="T" UUID="U-EXT-T"></BaseTableReference>
      </BaseTableSourceReference></TableOccurrence></TableOccurrenceCatalog>
      <ExternalDataSourceCatalog><ExternalDataSource id="1" name="EXT"></ExternalDataSource></ExternalDataSourceCatalog>`,
    )}${layout(
      `<LayoutObject id="1" type="Edit Box" name=""><Conditions><Hide><Calculation><DDRREF kind="ChunkList" hash="H1">_P1</DDRREF>` +
        `<Text><![CDATA[X::Long Name & T::<Field Missing>]]></Text></Calculation></Hide></Conditions></LayoutObject>`,
    )}</AddAction>`,
    `<Calcs><_P1 hash="H1"><ChunkList></ChunkList></_P1></Calcs>`,
  );
  const ext = doc(
    "EXT",
    `<AddAction><BaseTableCatalog><BaseTable id="1" name="T"><UUID>U-EXT-T</UUID></BaseTable></BaseTableCatalog>
      <FieldsForTables><FieldCatalog><BaseTableReference id="1" name="T"></BaseTableReference>
        <ObjectList><Field id="5" name="Long"></Field><Field id="6" name="Long Name"></Field></ObjectList>
      </FieldCatalog></FieldsForTables></AddAction>`,
  );
  const fieldUse = (result: ParseResult) =>
    buildModel(result).references.find((r) => r.fromUid === "F0:layoutObject:10.1" && r.toType === "field" && !r.broken);

  it("is recorded by the name its text gives, through that occurrence", () => {
    const byName = parse(main, ext).references.filter((r) => r.byName);
    // The layout gets its copy, like of any reference its objects record.
    expect(byName.map((r) => `${r.fromUid} ${r.toName} via ${r.viaToId}`)).toEqual([
      "F0:layoutObject:10.1 Long Name via 2",
      "F0:layout:10 Long Name via 2",
    ]);
  });

  it("resolves to that file's field with the longest name the text starts with", () => {
    expect(fieldUse(parse(main, ext))).toMatchObject({ toUid: "F1:field:1.6", toName: "Long Name" });
  });

  it("stays unresolved, not broken, while that file isn't loaded", () => {
    expect(fieldUse(parse(main))).toMatchObject({ toUid: null, broken: false });
  });
});

describe("a field read through another file's occurrence while that file isn't loaded", () => {
  // As an occurrence in a sample export: X has its base table recorded, so its file
  // was open at export.
  const TABLE_AND_EXTERNAL = TABLE.replace(
    "</TableOccurrenceCatalog>",
    `<TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference>
      <DataSourceReference id="1" name="EXT"></DataSourceReference><BaseTableReference id="1" name="T" UUID="U-EXT-T"></BaseTableReference>
    </BaseTableSourceReference></TableOccurrence></TableOccurrenceCatalog>
    <ExternalDataSourceCatalog><ExternalDataSource id="1" name="EXT"></ExternalDataSource></ExternalDataSourceCatalog>`,
  );
  const named = `<FieldReference id="5" name="b"><TableOccurrenceReference id="2" name="X"></TableOccurrenceReference></FieldReference>`;
  const fieldUse = (result: ParseResult, uid: string) => buildModel(result).references.find((r) => r.fromUid === uid && r.toType === "field");

  it("is broken when FileMaker left its name blank: it was deleted", () => {
    const result = parse(doc("MAIN", `<AddAction>${TABLE_AND_EXTERNAL}${layout(editBox("1", blankField("7", "2", "X")))}</AddAction>`));
    expect(object(result, "F0:layoutObject:10.1").name).toBe("X::<Field Missing>");
    expect(fieldUse(result, "F0:layoutObject:10.1")).toMatchObject({ toUid: null, broken: true });
  });

  it("stays unresolved, not broken, when it has a name", () => {
    const result = parse(doc("MAIN", `<AddAction>${TABLE_AND_EXTERNAL}${layout(editBox("1", named))}</AddAction>`));
    expect(fieldUse(result, "F0:layoutObject:10.1")).toMatchObject({ toUid: null, broken: false });
  });

  it("isn't broken behind a file that wasn't available at export, where FileMaker blanks every name", () => {
    const result = parse(doc("MAIN", `<AddAction>${TABLE_AND_UNAVAILABLE}${layout(editBox("1", blankField("7", "2", "X")))}</AddAction>`));
    expect(fieldUse(result, "F0:layoutObject:10.1")).toMatchObject({ toUid: null, broken: false });
  });
});

describe("a layout object's search text", () => {
  it("isn't read for placeholders: a name that reads like one is no broken use", () => {
    const result = parse(doc("MAIN", `<AddAction>${TABLE}${layout(`<LayoutObject id="1" type="Edit Box" name="&lt;Field Missing&gt;"></LayoutObject>`)}</AddAction>`));
    expect(object(result, "F0:layoutObject:10.1").text).toBe("<Field Missing>");
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual([]);
  });
});

describe("a placeholder a developer typed", () => {
  // FileMaker writes `<Field Missing>` (…) where a reference's target was
  // deleted, but never inside a formula's string literals or comments: there
  // it's typed text. Each object here has typed ones; some have a real one too.
  const calcField = (id: string, formula: string): string =>
    `<Field id="${id}" name="c${id}" fieldtype="Calculated"><Calculation><Text><![CDATA[${formula}]]></Text></Calculation></Field>`;
  const calc = (formula: string): string =>
    `<Parameter type="Calculation"><Calculation datatype="1" position="0"><Calculation><Text><![CDATA[${formula}]]></Text></Calculation></Calculation></Parameter>`;
  const stepRef = (pointer: string): string => `<DDRREF kind="StepText" hash="H${pointer}">${pointer}</DDRREF>`;
  const setVariable = (pointer: string, name: string, formula: string): string =>
    `<Step id="1" name="Set Variable" enable="True">${stepRef(pointer)}<ParameterValues><Parameter type="Variable"><Name value="${name}"></Name></Parameter>${calc(formula)}</ParameterValues></Step>`;
  const comment = (pointer: string): string =>
    `<Step id="89" name="# (comment)" enable="True">${stepRef(pointer)}<ParameterValues><Parameter type="Comment"><Comment value="see &lt;Field Missing&gt;"></Comment></Parameter></ParameterValues></Step>`;
  // Its target field was deleted: only the rendered text shows it.
  const setField = (pointer: string, formula: string): string =>
    `<Step id="76" name="Set Field" enable="True">${stepRef(pointer)}<ParameterValues><Parameter type="FieldReference">` +
    `<FieldReference id="0" name="" UUID=""><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter>${calc(formula)}</ParameterValues></Step>`;
  const stepText = (pointer: string, text: string): string => `<${pointer} hash="H${pointer}" datatype="StepText">${text}</${pointer}>`;
  const cfCalc = (id: string, formula: string): string =>
    `<CustomFunctionCalc><CustomFunctionReference id="${id}" name="Fn${id}"></CustomFunctionReference><Calculation><Text><![CDATA[${formula}]]></Text></Calculation></CustomFunctionCalc>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE.replace(
        "</ObjectList>",
        calcField("3", `If ( T::a = "<Field Missing>" ; 1 ; 0 ) /* <Table Missing> */ // <Function Missing>`) +
          calcField("4", `"<Field Missing>" & T::<Field Missing>`) +
          calcField("5", `/* T::<Field Missing> */ T::<Field Missing>`) +
          "</ObjectList>",
      )}
        <CustomFunctionsCatalog><CustomFunction id="7" name="Fn7"></CustomFunction><CustomFunction id="8" name="Fn8"></CustomFunction></CustomFunctionsCatalog>
        <CalcsForCustomFunctions>${cfCalc("7", "1 // <Function Missing> ( 1 )")}${cfCalc("8", "<Function Missing> ( 1 )")}</CalcsForCustomFunctions>
        <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
        <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>
          ${setVariable("_S1", "$x", `"<Field Missing>"`)}${comment("_S2")}${setField("_S3", `"<Field Missing>"`)}${setVariable("_S4", "$y", `"a\t<Table Missing>"`)}
        </ObjectList></Script></StepsForScripts>
        ${layout(
          `<LayoutObject id="1" type="Button" name="b"><Button><action>${setVariable("_B1", "$x", `"<Field Missing>"`)}</action></Button></LayoutObject>` +
            `<LayoutObject id="2" type="Text" name=""><Text><StyledText><Data><![CDATA["<<T::<Field Missing>>>"]]></Data></StyledText></Text></LayoutObject>`,
        )}
      </AddAction>`,
      `<Script><ObjectList>` +
        stepText("_S1", `Set Variable [ $x ; Value: "&lt;Field Missing&gt;" ]`) +
        stepText("_S2", `# see &lt;Field Missing&gt;`) +
        stepText("_S3", `Set Field [ T::&lt;Field Missing&gt; ; "&lt;Field Missing&gt;" ]`) +
        // FileMaker renders the literal's tab as a character reference.
        stepText("_S4", `Set Variable [ $y ; Value: "a&#9;&lt;Table Missing&gt;" ]`) +
        stepText("_B1", `Set Variable [ $x ; Value: "&lt;Field Missing&gt;" ]`) +
        `</ObjectList></Script>`,
    ),
  );

  it("isn't flagged in a formula's string literal or comment", () => {
    expect(forcedFrom(result, "F0:field:1.3")).toEqual([]);
    expect(forcedFrom(result, "F0:customFunction:7")).toEqual([]);
  });

  it("leaves a real placeholder in the same formula flagged", () => {
    expect(forcedFrom(result, "F0:field:1.4")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:field:1.5")).toEqual(["field <Field Missing> via 1"]);
    expect(forcedFrom(result, "F0:customFunction:8")).toEqual(["customFunction <Function Missing>"]);
  });

  it("isn't flagged in a script step's literal or a comment step, but a deleted target is", () => {
    const steps = result.references.filter((r) => r.fromUid === "F0:script:1" && r.forceBroken).map((r) => `${r.toName} step ${r.fromStep}`);
    expect(steps).toEqual(["<Field Missing> step 3"]);
  });

  it("isn't flagged in a button step's literal", () => {
    expect(forcedFrom(result, "F0:layoutObject:10.1")).toEqual([]);
  });

  it("is still flagged in layout text, which isn't a formula, quotes or not", () => {
    expect(forcedFrom(result, "F0:layoutObject:10.2")).toEqual(["field <Field Missing> via 1"]);
  });

  it("isn't flagged in an Insert Text step's text, though the step shows it", () => {
    // FileMaker's rendered text leaves the typed text out; the app adds it.
    const insertText = (pointer: string): string =>
      `<Step id="61" name="Insert Text" enable="True">${stepRef(pointer)}<ParameterValues>` +
      `<Parameter type="Text"><Text value="see &lt;Field Missing&gt;"></Text></Parameter>` +
      `<Parameter type="Target"><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></Parameter>` +
      `</ParameterValues></Step>`;
    const typed = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}
          <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
          <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>${insertText("_I1")}</ObjectList></Script></StepsForScripts>
          ${layout(`<LayoutObject id="1" type="Button" name="b"><Button><action>${insertText("_I2")}</action></Button></LayoutObject>`)}
        </AddAction>`,
        `<Script><ObjectList>${stepText("_I1", "Insert Text [ T::a ]")}${stepText("_I2", "Insert Text [ T::a ]")}</ObjectList></Script>`,
      ),
    );
    expect(object(typed, "F0:script:1").detail).toMatchObject({ steps: [{ params: `[ T::a ] [ Text: "see <Field Missing>" ]` }] });
    expect(forcedFrom(typed, "F0:script:1")).toEqual([]);
    expect(forcedFrom(typed, "F0:layoutObject:10.1")).toEqual([]);
  });
});

describe("custom menu items with the same index", () => {
  it("are objects of their own", () => {
    const item = (name: string): string =>
      `<CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><Command name="${name}" id="1"></Command></CustomMenuItem>`;
    const result = parse(doc("MAIN", `<AddAction><CustomMenuCatalog><CustomMenu id="30" name="M"><MenuItemList>${item("Copy")}${item("Paste")}</MenuItemList></CustomMenu></CustomMenuCatalog></AddAction>`));
    const items = result.objects.filter((o) => o.type === "customMenuItem").map((o) => `${o.uid} ${o.name}`);
    expect(items).toEqual(["F0:customMenuItem:30.0 Copy", "F0:customMenuItem:30.0#1 Paste"]);
    // The menu's containment edges reach both.
    const model = buildModel(result);
    expect(model.references.filter((r) => r.kind === "menuItem").map((r) => r.toUid)).toEqual(["F0:customMenuItem:30.0", "F0:customMenuItem:30.0#1"]);
  });
});

describe("a label, tooltip or title written as a formula", () => {
  const calc = (formula: string): string => `<Calculation><Text><![CDATA[${formula}]]></Text></Calculation>`;
  // As in a Dev export: computed, though it starts and ends with a quote.
  const COMPUTED = `"Feedbackinhalt ansehen" & ¶ & "gelb, wenn Feedback hinterlegt"`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}
        <CustomMenuCatalog><CustomMenu id="30" name="M"><MenuItemList>
          <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><Name>${calc(`"Save " & "all"`)}</Name><Command id="0"></Command></CustomMenuItem>
          <CustomMenuItem index="1" isSubMenuItem="False" isSeparatorItem="False"><Name>${calc(`"Say \\"hi\\""`)}</Name><Command id="0"></Command></CustomMenuItem>
        </MenuItemList></CustomMenu></CustomMenuCatalog>
        ${layout(
          `<LayoutObject id="1" type="Edit Box" name=""><Tooltip>${calc(COMPUTED)}</Tooltip></LayoutObject>` +
            `<LayoutObject id="2" type="Edit Box" name=""><Tooltip>${calc(`"Click \\"Save\\""`)}</Tooltip></LayoutObject>` +
            `<LayoutObject id="3" type="Tab Panel" name=""><TabPanel>${calc(`"Tab " & "1"`)}</TabPanel></LayoutObject>` +
            `<LayoutObject id="4" type="Button" name=""><Button><Label>${calc(`"Say \\"hi\\""`)}</Label></Button></LayoutObject>` +
            `<LayoutObject id="5" type="Button" name="b5"><Button><Label>${calc(`""`)}</Label></Button></LayoutObject>`,
        )}
      </AddAction>`,
    ),
  );

  it("shows a computed one as its formula, not with its outer quotes cut off", () => {
    expect(object(result, "F0:layoutObject:10.1").attributes.tooltip).toBe(COMPUTED);
    expect(object(result, "F0:layoutObject:10.3").name).toBe(`"Tab " & "1"`);
    expect(object(result, "F0:customMenuItem:30.0").name).toBe(`"Save " & "all"`);
  });

  it("shows a literal one as its text, with its escaped quotes undone", () => {
    expect(object(result, "F0:layoutObject:10.2").attributes.tooltip).toBe(`Click "Save"`);
    expect(object(result, "F0:layoutObject:10.4").attributes.label).toBe(`Say "hi"`);
    expect(object(result, "F0:layoutObject:10.4").name).toBe(`Button (Say "hi")`);
    expect(object(result, "F0:customMenuItem:30.1").name).toBe(`Say "hi"`);
  });

  it("gives an empty literal label no label", () => {
    expect(object(result, "F0:layoutObject:10.5").attributes.label).toBeUndefined();
    expect(object(result, "F0:layoutObject:10.5").name).toBe("b5");
  });
});

describe("a button's script parameter", () => {
  const calc = (formula: string): string => `<Calculation><Text><![CDATA[${formula}]]></Text></Calculation>`;
  const button = (id: string, action: string): string =>
    `<LayoutObject id="${id}" type="Button" name="b${id}"><Button><action><Options>4</Options>${action}</action></Button></LayoutObject>`;
  const withParameter = (parameter: string) =>
    parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(
          button("1", `<ScriptReference id="1" name="S"></ScriptReference>${calc(parameter)}`) +
            // As in two sample exports: the script was deleted, so FileMaker
            // dropped the <ScriptReference> and kept the parameter.
            button("2", calc(`"orphaned"`)),
        )}</AddAction>`,
      ),
    );
  const result = withParameter("T::a");

  it("is read from beside the script reference", () => {
    const obj = object(result, "F0:layoutObject:10.1");
    expect(obj.attributes.scriptParameter).toBe("T::a");
    expect(obj.detail).toMatchObject({ scriptRef: { name: "S" }, scriptParameter: "T::a" });
    expect(obj.text).toContain("T::a");
  });

  it("is kept when the script was deleted", () => {
    expect(object(result, "F0:layoutObject:10.2").attributes.scriptParameter).toBe(`"orphaned"`);
  });

  it("shows as a change when it's edited", () => {
    const diff = diffAnalyses(result, withParameter("T::b"), 0, 0);
    expect(diff.changed.map((c) => c.uid)).toEqual(["F0:layoutObject:10.1"]);
  });
});

describe("global variables", () => {
  const setVariable = (name: string): string =>
    `<Step id="1" name="Set Variable" enable="True"><ParameterValues><Parameter type="Variable"><Name value="${name}"></Name></Parameter></ParameterValues></Step>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
        <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference>
          <ObjectList>${setVariable("$$Count")}${setVariable("$$count")}${setVariable("$$count")}</ObjectList>
        </Script></StepsForScripts></AddAction>`,
    ),
  );

  it("are one variable whatever the case of their name, named by its most used spelling", () => {
    const globals = result.objects.filter((o) => o.type === "globalVariable");
    expect(globals.map((o) => `${o.uid} ${o.name} ${o.attributes.occurrences}`)).toEqual(["F0:globalVariable:$$count $$count 3"]);
    expect(globals[0]!.text).toBe("$$Count $$count");
    // Each use keeps its own spelling.
    expect(result.references.filter((r) => r.toType === "globalVariable").map((r) => `${r.toId} ${r.toName}`)).toEqual([
      "$$count $$Count",
      "$$count $$count",
      "$$count $$count",
    ]);
  });
});

describe("script step text in another language", () => {
  const exportWith = (render: (i: number) => string): { name: string; content: string } => {
    const indexes = [...Array(10).keys()];
    return doc(
      "MAIN",
      `<AddAction><ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
        <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>${indexes
          .map((i) => `<Step id="1" name="Go to Layout" enable="True"><DDRREF kind="StepText" hash="H${i}">_S${i}</DDRREF></Step>`)
          .join("")}</ObjectList></Script></StepsForScripts></AddAction>`,
      `<Script><ObjectList>${indexes.map((i) => `<_S${i} hash="H${i}" datatype="StepText">${render(i)}</_S${i}>`).join("")}</ObjectList></Script>`,
    );
  };

  it("is reported: what only that text shows can't be read", () => {
    const result = parse(exportWith((i) => `Gehe zu Layout [ “L${i}” ]`));
    expect(result.errors).toEqual([expect.stringContaining("MAIN.xml: its script steps are written in a language other than English")]);
  });

  it("isn't reported in English", () => {
    expect(parse(exportWith((i) => `Go to Layout [ “L${i}” ]`)).errors).toEqual([]);
  });
});

describe("sort orders", () => {
  const sortSpec = (sorts: string): string => `<SortSpecification value="True" blanksLast="False" maintain="True"><SortList>${sorts}</SortList></SortSpecification>`;
  const sort = (type: string, field: string, extra = ""): string => `<Sort type="${type}"><PrimaryField>${field}</PrimaryField>${extra}</Sort>`;
  const tField = (id: string, name: string): string => `<FieldReference id="${id}" name="${name}"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference>`;
  const result = parse(
    doc(
      "MAIN",
      `<AddAction>${TABLE}
        <RelationshipCatalog><Relationship id="1">
          <LeftTable><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>${sortSpec(sort("Ascending", tField("1", "a")) + sort("Descending", blankField("14", "1", "T")))}</LeftTable>
          <RightTable><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference><SortSpecification value="False"></SortSpecification></RightTable>
          <JoinPredicateList><JoinPredicate type="Equal"><LeftField>${tField("1", "a")}</LeftField><RightField>${tField("2", "b")}</RightField></JoinPredicate></JoinPredicateList>
        </Relationship></RelationshipCatalog>
        ${layout(
          `<LayoutObject id="1" type="Portal" name=""><Portal><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference><Options index="1" show="6">401</Options>` +
            sortSpec(
              sort("Custom", tField("1", "a"), `<ValueListReference id="3" name="Order"></ValueListReference>`) +
                sort("Ascending", tField("2", "b"), `<SummaryField>${tField("1", "a")}</SummaryField>`),
            ) +
            `</Portal></LayoutObject>`,
        )}
      </AddAction>`,
    ),
  );

  it("lists a relationship side's sort fields in order, a deleted one as missing", () => {
    const detail = object(result, "F0:relationship:1").detail;
    expect(detail).toMatchObject({
      left: { sorted: true, sortFields: [{ field: "T::a", order: "Ascending" }, { field: "T::<Field Missing>", order: "Descending" }] },
    });
    expect(detail).toMatchObject({ right: { cascadeCreate: false, cascadeDelete: false, sorted: false } });
    expect(detail?.kind === "relationship" && detail.right).not.toHaveProperty("sortFields");
  });

  it("lists a portal's sort fields, with a custom order's value list and a summary field", () => {
    expect(object(result, "F0:layoutObject:10.1").detail).toMatchObject({
      portalSort: [
        { field: "T::a", order: "Custom", valueList: "Order" },
        { field: "T::b", order: "Ascending", summaryField: "T::a" },
      ],
    });
  });
});

describe("a deleted field with the id of another table's field", () => {
  // As a layout of a sample export loaded without its local file: no field
  // is found, and field ids are only unique within a table, so X's field 7 is
  // no repeat of Y's, while Z's is: Z is another occurrence of Y's table.
  const EXTERNAL = TABLE.replace(
    "</TableOccurrenceCatalog>",
    `<TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference>
      <DataSourceReference id="1" name="EXT"></DataSourceReference><BaseTableReference id="1" name="T1" UUID="U1"></BaseTableReference>
    </BaseTableSourceReference></TableOccurrence>
    <TableOccurrence id="3" name="Y" type="External"><BaseTableSourceReference>
      <DataSourceReference id="1" name="EXT"></DataSourceReference><BaseTableReference id="2" name="T2" UUID="U2"></BaseTableReference>
    </BaseTableSourceReference></TableOccurrence>
    <TableOccurrence id="4" name="Z" type="External"><BaseTableSourceReference>
      <DataSourceReference id="1" name="EXT"></DataSourceReference><BaseTableReference id="2" name="T2" UUID="U2"></BaseTableReference>
    </BaseTableSourceReference></TableOccurrence></TableOccurrenceCatalog>
    <ExternalDataSourceCatalog><ExternalDataSource id="1" name="EXT"></ExternalDataSource></ExternalDataSourceCatalog>`,
  );
  const field7 = (to: string, toName: string): string =>
    `<FieldReference id="7" name="b"><TableOccurrenceReference id="${to}" name="${toName}"></TableOccurrenceReference></FieldReference>`;
  const model = buildModel(
    parse(doc("MAIN", `<AddAction>${EXTERNAL}${layout(editBox("1", field7("3", "Y")) + editBox("2", blankField("7", "2", "X")) + editBox("3", field7("4", "Z")))}</AddAction>`)),
  );
  const LAYOUT = "F0:layout:10";

  it("has a row of its own in the layout's References, unlike the same field through another occurrence", () => {
    const fields = buildDependencyView(model, LAYOUT)!.outbound.filter((e) => e.ref.toType === "field");
    expect(fields.map((e) => `${e.ref.toName || "(blank)"}: ${e.ref.broken ? "broken" : "not found"}`).sort()).toEqual(["(blank): broken", "b: not found"]);
  });

  it("is counted by the badge, the navigator's dot and the report card alike", () => {
    const listed = buildDependencyView(model, LAYOUT)!.outbound.filter((e) => e.ref.broken).length;
    expect([listed, refStatsFor(model, LAYOUT).broken]).toEqual([1, 1]);
    expect(brokenSourcesFor(model).has(LAYOUT)).toBe(true);
    expect(model.reportCard.brokenReferenceCount).toBe(brokenSourcesFor(model).size);
  });
});

describe("what a field reference shows as", () => {
  // X's file wasn't available at export (no base table); Y's was, but isn't
  // loaded; occurrence -1 is FileMaker's <Table Missing>, a deleted one.
  const OCCURRENCES = TABLE.replace(
    "</TableOccurrenceCatalog>",
    `<TableOccurrence id="2" name="X" type="External"><BaseTableSourceReference><DataSourceReference id="1" name="Other"></DataSourceReference></BaseTableSourceReference></TableOccurrence>
    <TableOccurrence id="3" name="Y" type="External"><BaseTableSourceReference>
      <DataSourceReference id="2" name="EXT"></DataSourceReference><BaseTableReference id="1" name="T" UUID="U1"></BaseTableReference>
    </BaseTableSourceReference></TableOccurrence></TableOccurrenceCatalog>
    <ExternalDataSourceCatalog><ExternalDataSource id="1" name="Other"></ExternalDataSource><ExternalDataSource id="2" name="EXT"></ExternalDataSource></ExternalDataSourceCatalog>`,
  );
  const named = (id: string, name: string, to: string, toName: string): string =>
    `<FieldReference id="${id}" name="${name}"><TableOccurrenceReference id="${to}" name="${toName}"></TableOccurrenceReference></FieldReference>`;
  const model = buildModel(
    parse(
      doc(
        "MAIN",
        `<AddAction>${OCCURRENCES}${layout(
          editBox("1", named("1", "a", "1", "T")) +
            editBox("2", blankField("9", "1", "T")) +
            editBox("3", blankField("7", "2", "X")) +
            editBox("4", named("5", "b", "3", "Y")) +
            editBox("5", blankField("4", "-1", "&lt;Table Missing&gt;")),
        )}</AddAction>`,
      ),
    ),
  );
  /** The layout object's field as its detail names it, and what that shows as. */
  const shown = (id: string): string => {
    const uid = `F0:layoutObject:10.${id}`;
    const detail = model.byUid.get(uid)?.detail;
    const fieldRef = detail?.kind === "layoutObject" ? detail.fieldRef! : "";
    const ref = ownFieldRef(model, uid, fieldRef);
    return ref ? `${fieldRef} -> ${refLabel(ref, model.byUid)}: ${refStatus(ref, model.byUid)}` : `${fieldRef} -> no reference`;
  };

  it("is found", () => {
    expect(shown("1")).toBe("T::a -> T::a: ok");
  });

  it("is deleted, by FileMaker's name for it", () => {
    expect(shown("2")).toBe("T::<Field Missing> -> T::<Field Missing>: broken");
    expect(shown("5")).toBe("<Table Missing>::<Field Missing> -> <Table Missing>::<Field Missing>: broken");
  });

  it("can't be verified behind a file that wasn't available at export", () => {
    expect(shown("3")).toBe("X::(field 7) -> X::<File Missing>: unverifiable");
  });

  it("is in another file while that file isn't loaded", () => {
    expect(shown("4")).toBe("Y::b -> Y::b: external");
  });

  it("is found only among the object's own references", () => {
    expect(ownFieldRef(model, "F0:layoutObject:10.1", "T::<Field Missing>")).toBeUndefined();
  });
});

describe("a lookup that copies from no field", () => {
  // Nothing selected under "Copy value from field" in FileMaker's Lookup dialog.
  const lookup = (enable: string): string =>
    TABLE.replace(
      '<Field id="2" name="b"></Field>',
      `<Field id="2" name="b"><AutoEnter type="Looked_up"><Looked_up${enable}>
        <FieldReference id="0" name="" UUID=""></FieldReference><Context><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></Context>
      </Looked_up></AutoEnter></Field>`,
    );

  it("says so, and isn't broken", () => {
    const result = parse(doc("MAIN", `<AddAction>${lookup("")}</AddAction>`));
    expect(object(result, "F0:field:1.2").detail).toEqual({ kind: "lookup", source: "(no field set)", startingFrom: "T" });
    expect(buildModel(result).brokenReferences.filter((r) => r.fromUid === "F0:field:1.2")).toEqual([]);
  });

  it("counts for nothing while switched off", () => {
    const result = parse(doc("MAIN", `<AddAction>${lookup(' enable="False"')}</AddAction>`));
    expect(object(result, "F0:field:1.2").detail?.kind).not.toBe("lookup");
  });
});

describe("settings the samples write in shapes the test solution doesn't", () => {
  /** TABLE with field b replaced by `field` (an element with id 2). */
  const withField = (field: string): string => TABLE.replace('<Field id="2" name="b"></Field>', field);

  it("reads a lookup's constant for no match", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${withField(`<Field id="2" name="b"><AutoEnter type="Looked_up"><Looked_up dontCopyIfEmpty="False" noMatchCopyOption="ConstantData">
          <ConstantData>none</ConstantData>
          <FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference>
          <Context><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></Context>
        </Looked_up></AutoEnter></Field>`)}</AddAction>`,
      ),
    );
    expect(object(result, "F0:field:1.2").detail).toEqual({ kind: "lookup", source: "T::a", startingFrom: "T", skipEmpty: false, ifNoMatch: "Use “none”" });
  });

  it("names a standard deviation as FileMaker spells it", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${withField(`<Field id="2" name="b" fieldtype="Summary"><SummaryInfo restartEachGroup="False" summarizeRepetition="Individually" operation="StdDeviation">
          <SummaryField><FieldReference id="1" name="a"><BaseTableReference id="1" name="T"></BaseTableReference></FieldReference></SummaryField>
        </SummaryInfo></Field>`)}</AddAction>`,
      ),
    );
    expect(object(result, "F0:field:1.2").detail).toEqual({ kind: "summary", operation: "Standard deviation of", fields: ["a"], repetitions: "Individually" });
  });

  it("reads an average's extra field as what it's weighted by", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${withField(`<Field id="2" name="b" fieldtype="Summary"><SummaryInfo summarizeRepetition="Together" operation="Average">
          <SummaryField><FieldReference id="1" name="a"><BaseTableReference id="1" name="T"></BaseTableReference></FieldReference></SummaryField>
          <AdditionalField><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference></AdditionalField>
        </SummaryInfo></Field>`)}</AddAction>`,
      ),
    );
    const detail = object(result, "F0:field:1.2").detail;
    expect(detail).toMatchObject({ kind: "summary", weightedBy: "T::a" });
    expect(detail).not.toHaveProperty("sortedBy");
  });

  it("lists every container base directory and the thumbnail setting", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction><BaseDirectoryCatalog membercount="2" generate="True" temporary="False">
          <BaseDirectory name="Mona_Lisa/" id="0" relativeTo="True"></BaseDirectory>
          <BaseDirectory name="Tasks/" id="3" relativeTo="True"></BaseDirectory>
        </BaseDirectoryCatalog>${TABLE}</AddAction>`,
      ),
    );
    expect(object(result, "F0:file:F0").attributes).toMatchObject({
      containerBaseDirectories: "Mona_Lisa/ (relative to the file), Tasks/ (relative to the file)",
      containerThumbnails: "Permanent",
    });
  });

  it("keeps a custom order position, and shows an unknown View by code as written", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE.replace(
          '<ObjectList><Field id="1" name="a"></Field>',
          '<CustomOrderList><key>2</key><key>1</key></CustomOrderList><SortOrder>3</SortOrder><ObjectList><Field id="1" name="a"></Field>',
        )}</AddAction>`,
      ),
    );
    expect(object(result, "F0:field:1.1").attributes.customOrder).toBe("2");
    expect(object(result, "F0:field:1.2").attributes.customOrder).toBe("1");
    expect(object(result, "F0:table:1").attributes.fieldsListedBy).toBe("3");
  });

  it("reads a chart's series data formula when FileMaker exports one", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`<LayoutObject id="1" type="Chart" name=""><External type="CHRT" name="Chart"><Chart>
          <SeriesSource source="Current Record (delimited data)"></SeriesSource>
          <ChartSeries><YSeriesList><Series>
            <Value><Calculation><DDRREF kind="ChunkList" hash="H1">_P1</DDRREF><Text><![CDATA[T::a]]></Text></Calculation></Value>
            <Title><Text></Text></Title>
          </Series></YSeriesList></ChartSeries>
          <Visual><Type>Line</Type></Visual>
        </Chart></External></LayoutObject>`)}</AddAction>`,
      ),
    );
    const lo = object(result, "F0:layoutObject:10.1");
    expect(lo.detail).toMatchObject({ chart: { type: "Line", dataSource: "Current Record (delimited data)", series: [{ axis: "Y", value: "T::a" }] } });
    expect(lo.text).toContain("T::a");
  });

  it("keeps each conditional format's style in step with its formula", () => {
    const result = parse(
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`<LayoutObject id="1" type="Edit Box" name="">
          <Field><FieldReference id="1" name="a"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference></FieldReference>
            <Display><Placeholder findMode="False"><Calculation><Text><![CDATA["Type here"]]></Text></Calculation></Placeholder></Display></Field>
          <Conditions><Formatting>
            <Condition type="0" id="0"><Calculation><Text><![CDATA[1]]></Text></Calculation></Condition>
            <Condition type="13" id="1"><Calculation><Text><![CDATA[IsEmpty(Self)]]></Text></Calculation><LocalCSS><![CDATA[self .self { color: red; }]]></LocalCSS></Condition>
          </Formatting></Conditions>
        </LayoutObject>`)}</AddAction>`,
      ),
    );
    const lo = object(result, "F0:layoutObject:10.1");
    expect(lo.detail).toMatchObject({ conditionalFormats: ["1", "IsEmpty(Self)"], conditionalFormatStyles: ["", "self .self {\n  color: red;\n}"], placeholder: "Type here" });
    expect(lo.detail).not.toHaveProperty("placeholderInFind");
  });

  it("shows a changed portal filter as a change", () => {
    const portal = (filter: string) =>
      doc(
        "MAIN",
        `<AddAction>${TABLE}${layout(`<LayoutObject id="1" type="Portal" name=""><Portal>
          <TableOccurrenceReference id="1" name="T"></TableOccurrenceReference><Options index="3" show="4">144</Options>
          <Calculation><Text><![CDATA[${filter}]]></Text></Calculation><ObjectList></ObjectList>
        </Portal></LayoutObject>`)}</AddAction>`,
      );
    const before = parse(portal("T::a = 1"));
    expect(object(before, "F0:layoutObject:10.1").attributes).toMatchObject({ portalFilter: "T::a = 1", portalInitialRow: "3" });
    const diff = diffAnalyses(before, parse(portal("T::a = 2")), 0, 0);
    expect(diff.changed.map((c) => c.uid)).toContain("F0:layoutObject:10.1");
  });
});
