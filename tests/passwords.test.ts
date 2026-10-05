/**
 * Passwords typed into script steps, buttons and custom menu items never reach
 * the parse result, nor anything built from it (the AI export).
 */
import { describe, expect, it } from "vitest";
import { parseDocuments } from "@/core/parser/parseDdr";
import { PASSWORD_NOT_STORED as T, withoutPasswordText } from "@/core/parser/passwords";
import { buildModel } from "@/core/model/buildModel";
import { buildAiExport } from "@/core/export/aiExport";
import type { FmObject, ParseResult } from "@/types/ddr";

function doc(structure: string, ddrInfo: string): { name: string; content: string } {
  return {
    name: "MAIN.xml",
    content:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<FMSaveAsXML version="2.2.3.0" Source="22.0.1" File="MAIN.fmp12">` +
      `<Structure membercount="1">${structure}</Structure><DDR_INFO>${ddrInfo}</DDR_INFO></FMSaveAsXML>`,
  };
}

const SECRET = "s3cret";
/** A password typed as a number. */
const NUMBER = "90817263";

/** A step's calc; with a chunk-list pointer, its chunks are `_<pointer>`'s. */
const calc = (formula: string, pointer?: string): string =>
  `<Calculation datatype="1" position="0"><Calculation>${pointer ? `<DDRREF kind="ChunkList" hash="H${pointer}">${pointer}</DDRREF>` : ""}` +
  `<Text><![CDATA[${formula}]]></Text></Calculation></Calculation>`;
const chunkList = (pointer: string, chunks: string): string =>
  `<${pointer} hash="H${pointer}" datatype="ChunkList"><ChunkList hash="H${pointer}">${chunks}</ChunkList></${pointer}>`;
const stepRef = (pointer: string): string => `<DDRREF kind="StepText" hash="H${pointer}">${pointer}</DDRREF>`;
const stepText = (pointer: string, text: string): string => `<${pointer} hash="H${pointer}" datatype="StepText">${text}</${pointer}>`;

/** A Re-Login step whose password is `formula`. */
const reLogin = (pointer: string, formula: string, enable = "True"): string =>
  `<Step id="138" name="Re-Login" enable="${enable}">${stepRef(pointer)}<ParameterValues>` +
  `<Parameter type="Name">${calc(`"bot"`)}</Parameter><Parameter type="Password">${calc(formula, `${pointer}_P`)}</Parameter></ParameterValues></Step>`;

const sendMail = (pointer: string): string =>
  `<Step id="63" name="Send Mail" enable="True">${stepRef(pointer)}<ParameterValues><Parameter type="Email"><SMTP>` +
  `<UserName>${calc(`"me"`)}</UserName><Password>${calc(`"${SECRET}-smtp; ]x"`)}</Password></SMTP></Parameter></ParameterValues></Step>`;

const addAccount = (pointer: string): string =>
  `<Step id="134" name="Add Account" enable="True">${stepRef(pointer)}<ParameterValues>` +
  `<Parameter type="Name">${calc(`"svc"`)}</Parameter><Parameter type="Password">${calc("$$botPassword", `${pointer}_P`)}</Parameter></ParameterValues></Step>`;

const result: ParseResult = parseDocuments([
  doc(
    `<AddAction>
      <BaseTableCatalog><BaseTable id="1" name="T"></BaseTable></BaseTableCatalog>
      <TableOccurrenceCatalog><TableOccurrence id="1" name="T"><BaseTableSourceReference><BaseTableReference id="1" name="T"></BaseTableReference></BaseTableSourceReference></TableOccurrence></TableOccurrenceCatalog>
      <ScriptCatalog><Script id="1" name="S"></Script></ScriptCatalog>
      <StepsForScripts><Script><ScriptReference id="1" name="S"></ScriptReference><ObjectList>
        ${reLogin("_S1", `"${SECRET}-relogin"`)}${reLogin("_S2", `"${SECRET}-disabled"`, "False")}${sendMail("_S3")}${addAccount("_S4")}
        ${reLogin("_S5", `$prefix & "${SECRET}-mixed" /* ${SECRET}-note */`)}${reLogin("_S6", NUMBER)}
      </ObjectList></Script></StepsForScripts>
      <LayoutCatalog><Layout id="10" name="L"><TableOccurrenceReference id="1" name="T"></TableOccurrenceReference>
        <PartsList><Part type="Body"><Definition absolute="0" size="100"></Definition><ObjectList>
          <LayoutObject id="1" type="Button" name="b"><Button><action>${reLogin("_B1", `"${SECRET}-button"`)}</action></Button></LayoutObject>
        </ObjectList></Part></PartsList>
      </Layout></LayoutCatalog>
      <CustomMenuCatalog><CustomMenu id="30" name="M"><MenuItemList>
        <CustomMenuItem index="0" isSubMenuItem="False" isSeparatorItem="False"><action>${reLogin("_M1", `$$menuPw & "${SECRET}-menu"`)}</action><Command id="0"></Command></CustomMenuItem>
      </MenuItemList></CustomMenu></CustomMenuCatalog>
    </AddAction>`,
    `<Script><ObjectList>
      ${chunkList("_S1_P", `<Chunk type="NoRef">&quot;${SECRET}-relogin&quot;</Chunk>`)}
      ${chunkList("_S4_P", `<Chunk type="VariableReference">$$botPassword</Chunk>`)}
      ${stepText("_S1", `Re-Login [ Account Name: &quot;bot&quot;; Password: &quot;${SECRET}-relogin&quot;; Current File ]&#13;[ No dialog ]`)}
      ${stepText("_S2", `//  Re-Login [ Account Name: &quot;bot&quot;; Password: &quot;${SECRET}-disabled&quot;]&#13;[ No dialog ]`)}
      ${stepText("_S3", `Send Mail [ Send via SMTP Server; Authentication Type: Plain Password; User Name: &quot;me&quot;; Password: &quot;${SECRET}-smtp; ]x&quot;]&#13;[ No dialog ]`)}
      ${stepText("_S4", `Add Account [ Authenticate via: FileMaker; Account Name: &quot;svc&quot;; Password: $$botPassword; Privilege Set: [Data Entry Only] ]`)}
      ${stepText("_S5", `Re-Login [ Account Name: &quot;bot&quot;; Password: $prefix &amp; &quot;${SECRET}-mixed&quot; /* ${SECRET}-note */ ]`)}
      ${stepText("_S6", `Re-Login [ Account Name: &quot;bot&quot;; Password: ${NUMBER} ]`)}
      ${stepText("_B1", `Re-Login [ Account Name: &quot;bot&quot;; Password: &quot;${SECRET}-button&quot; ]`)}
      ${stepText("_M1", `Re-Login [ Account Name: &quot;bot&quot;; Password: $$menuPw &amp; &quot;${SECRET}-menu&quot; ]`)}
    </ObjectList></Script>`,
  ),
]);

function object(uid: string): FmObject {
  const found = result.objects.find((o) => o.uid === uid);
  if (!found) throw new Error(`no object ${uid}`);
  return found;
}

describe("passwords in steps", () => {
  it("are nowhere in the parse result", () => {
    const json = JSON.stringify(result);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(NUMBER);
  });

  it("are nowhere in the AI export", () => {
    const files = buildAiExport(buildModel(result), { analysisName: "A", projectName: "P", savedAt: 0, exportedAt: 0 });
    for (const file of files) {
      expect(file.content, file.name).not.toContain(SECRET);
      expect(file.content, file.name).not.toContain(NUMBER);
    }
  });

  it("show as not stored in a script's steps, enabled or not, keeping their code", () => {
    const script = object("F0:script:1");
    expect(script.detail).toMatchObject({
      steps: [
        { params: `[ Account Name: "bot"; Password: ${T}; Current File ] [ No dialog ]` },
        { enabled: false, params: `[ Account Name: "bot"; Password: ${T}] [ No dialog ]` },
        { params: `[ Send via SMTP Server; Authentication Type: Plain Password; User Name: "me"; Password: ${T}] [ No dialog ]` },
        { params: `[ Authenticate via: FileMaker; Account Name: "svc"; Password: $$botPassword; Privilege Set: [Data Entry Only] ]` },
        { params: `[ Account Name: "bot"; Password: $prefix & ${T} ${T} ]` },
        { params: `[ Account Name: "bot"; Password: ${T} ]` },
      ],
    });
    expect(script.text).toContain(`Re-Login [ Account Name: "bot"; Password: ${T}; Current File ]`);
  });

  it("show as not stored in a button's action", () => {
    expect(JSON.stringify(object("F0:layout:10").detail)).toContain(`"params":"[ Account Name: \\"bot\\"; Password: ${T} ]"`);
  });

  it("leave a menu item's search text its code", () => {
    expect(object("F0:customMenuItem:30.0").text).toContain(`$$menuPw & ${T}`);
  });

  it("keep what a password calc uses", () => {
    expect(result.references.some((r) => r.fromUid === "F0:script:1" && r.toType === "globalVariable" && r.toName === "$$botPassword")).toBe(true);
  });
});

describe("withoutPasswordText", () => {
  const cut = (text: string, formula: string): string => withoutPasswordText(text, [formula]);

  it("cuts a formula's literals and comments, keeping its code", () => {
    expect(cut(`[ Password: $p & "x\\"; ]y" // z\n ]`, `$p & "x\\"; ]y" // z`)).toBe(`[ Password: $p & ${T} ${T}\n ]`);
  });

  it("finds them as a step's rendered text shows them", () => {
    expect(cut(`Password: "a\nb" & "c d"`, `"a\rb" & "c\td"`)).toBe(`Password: ${T} & ${T}`);
  });

  it("cuts a comment that holds a literal whole", () => {
    expect(cut(`Password: /* "x" */ "x"`, `/* "x" */ "x"`)).toBe(`Password: ${T} ${T}`);
  });

  it("cuts a bare number, not a number in code, and leaves an empty literal", () => {
    expect(cut(`Password: 12345`, `12345`)).toBe(`Password: ${T}`);
    expect(cut(`Password: Left ( $p ; 3 )`, `Left ( $p ; 3 )`)).toBe(`Password: Left ( $p ; 3 )`);
    expect(cut(`Password: ""`, `""`)).toBe(`Password: ""`);
  });
});
