/**
 * The prototype script checks (core/scriptAnalysis): the formula tokens, the
 * block walk, and each check on small hand-built scripts — one detail apart
 * between a case that's found and one that isn't — plus the typed steps read
 * from the test-solution exports.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModel } from "@/core/model/buildModel";
import { parseDocuments } from "@/core/parser/parseDdr";
import { decodeFile } from "@/state/loadFiles";
import { analyzeScripts } from "@/core/scriptAnalysis/analyze";
import { buildBlocks } from "@/core/scriptAnalysis/blocks";
import { tokenize, variableUses } from "@/core/scriptAnalysis/calcTokens";
import { plainText, type RuleId, type ScriptFinding } from "@/core/scriptAnalysis/findings";
import { passedKeys } from "@/core/scriptAnalysis/jsonKeys";
import { keyReads } from "@/core/scriptAnalysis/paramKeys";
import type { FmObject, LayoutChoice, ObjectDetail, ObjectType, RawReference, StepIr } from "@/types/ddr";

const FILE = "F0";

function obj(type: ObjectType, id: string, name: string, extra: Partial<FmObject> = {}): FmObject {
  return { uid: `${FILE}:${type}:${id}`, type, id, name, fileUid: FILE, fileName: "TEST", attributes: {}, text: "", ...extra };
}

type StepSpec = Omit<StepIr, "index" | "enabled" | "calcs"> & Partial<Pick<StepIr, "enabled" | "calcs">>;

/** Steps numbered from 1, enabled and without formulas unless given. */
function steps(...specs: StepSpec[]): StepIr[] {
  return specs.map((spec, i) => ({ index: i + 1, enabled: true, calcs: [], ...spec }));
}
const step = (name: string, ...calcs: string[]): StepSpec => ({ name, calcs });
const setVariable = (name: string, value: string): StepSpec => ({ name: "Set Variable", calcs: [value], setsVariable: name });

const SCRIPT = obj("script", "1", "S");

/** One script S alone in a file, with `functions` as custom functions. */
function analyzeAlone(list: StepIr[], functions: Record<string, string> = {}): ScriptFinding[] {
  const objects = [SCRIPT, ...Object.entries(functions).map(([name, body], i) => obj("customFunction", String(i + 1), name, { detail: { kind: "calculation", signature: name, body } }))];
  const model = buildModel({ files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }], objects, references: [], errors: [] });
  return analyzeScripts({ model, irs: new Map([[SCRIPT.uid, list]]) }).findings;
}

/** A finding's title and detail as plain text. */
const text = (f: ScriptFinding): [string, string] => [plainText(f.title), plainText(f.detail)];
const rules = (findings: readonly ScriptFinding[]): string[] => findings.map((f) => `${f.rule}@${f.step ?? "-"}`).sort();
const only = (findings: readonly ScriptFinding[], rule: RuleId) => findings.filter((f) => f.rule === rule);

describe("formula tokens", () => {
  it("tells a Let's definitions from reads, and skips strings, comments and quoted field names", () => {
    const uses = variableUses(tokenize('Let ( [ $a = 1 ; $b = $a + $c ] ; $b & "$fake" ) /* $comment */ & ${Field $x}'));
    expect(uses).toEqual({ sets: ["$a", "$b"], reads: ["$a", "$c", "$b"] });
  });

  it("reads a variable compared with =, outside a Let", () => {
    expect(variableUses(tokenize("$x = 1 and $$g ≠ 2"))).toEqual({ sets: [], reads: ["$x", "$$g"] });
  });

  it("sets a repetition in a single Let definition", () => {
    expect(variableUses(tokenize("Let ( $r[2] = 5 ; $r[2] )"))).toEqual({ sets: ["$r"], reads: ["$r"] });
  });
});

describe("blocks", () => {
  it("nests If, Else and Loop", () => {
    const blocks = buildBlocks(steps(step("If"), step("Else"), step("Loop"), step("Exit Loop If"), step("End Loop"), step("End If")));
    expect(Array.isArray(blocks)).toBe(true);
  });

  it("gives up on unbalanced blocks and disabled If steps", () => {
    expect(buildBlocks(steps(step("If"), step("Else"), step("Else")))).toEqual({ error: "step 3 (Else) has no block to belong to" });
    expect(buildBlocks(steps(step("Loop")))).toEqual({ error: "a block opened at step 1 isn't closed" });
    expect(buildBlocks(steps({ name: "If", enabled: false }, step("End If")))).toEqual({ error: "step 1 (If) is disabled" });
  });
});

describe("unreachable steps", () => {
  const unreachable = (list: StepIr[]) => only(analyzeAlone(list), "unreachable-steps");

  it("finds the steps after an Exit Script, comments and disabled steps aside", () => {
    const found = unreachable(steps(step("Exit Script"), step("# (comment)"), step("Beep"), { name: "Beep", enabled: false }, step("Beep")));
    expect(found.map((f) => [f.step, f.lastStep, ...text(f)])).toEqual([[3, 5, "Steps 3–5 never run", "The script always stops at step 1 (Exit Script) first."]]);
  });

  it("finds them after an If whose every branch stops, not when one goes on", () => {
    const every = steps(step("If"), step("Exit Script"), step("Else"), step("Halt Script"), step("End If"), step("Beep"));
    expect(unreachable(every).map(text)).toEqual([["This step never runs", "Every branch of the If at step 1 stops the script."]]);
    const one = steps(step("If"), step("Exit Script"), step("End If"), step("Beep"));
    expect(unreachable(one)).toEqual([]);
  });

  it("finds them after a Loop with no way out, not after one with an Exit Loop If or Go to Record", () => {
    expect(rules(unreachable(steps(step("Loop"), step("Beep"), step("End Loop"), step("Beep"))))).toEqual(["unreachable-steps@4"]);
    expect(unreachable(steps(step("Loop"), step("If"), step("Exit Loop If"), step("End If"), step("End Loop"), step("Beep")))).toEqual([]);
    expect(unreachable(steps(step("Loop"), step("Go to Record/Request/Page"), step("End Loop"), step("Beep")))).toEqual([]);
  });

  it("doesn't count a disabled Exit Script", () => {
    expect(unreachable(steps({ name: "Exit Script", enabled: false }, step("Beep")))).toEqual([]);
  });
});

describe("variables", () => {
  it("finds a read with no set, whatever the case of the set", () => {
    const found = analyzeAlone(steps(setVariable("$CustomerID", "1"), step("If", "$customerid = 1 or $custmerID = 1"), step("End If")));
    expect(rules(found)).toEqual(["unset-variable@2"]);
    expect(found[0]!.title).toEqual([{ code: "$custmerID" }, " is never set"]);
    expect(text(found[0]!)[1]).toBe("Read at step 2, so it's always empty.");
  });

  it("says when only a disabled step sets it", () => {
    const found = analyzeAlone(steps({ ...setVariable("$x", "1"), enabled: false }, step("Beep", "$x")));
    expect(found.map(text)).toEqual([["$x is never set", "Read at step 2; only disabled step 1 would set it, so it's always empty."]]);
  });

  it("counts a Show Custom Dialog's input variables as sets", () => {
    const read = step("Beep", "$name & $note");
    expect(analyzeAlone(steps({ name: "Show Custom Dialog", inputVariables: ["$name", "$note"] }, read))).toEqual([]);
    expect(rules(analyzeAlone(steps({ name: "Show Custom Dialog", inputVariables: ["$name"] }, read)))).toEqual(["unset-variable@2"]);
  });

  it("counts a Let and a custom function as sets, and leaves globals alone", () => {
    expect(analyzeAlone(steps(step("Beep", "Let ( $x = 1 ; $x )"), step("Beep", "$$g")))).toEqual([]);
    expect(analyzeAlone(steps(step("Beep", "SetIt ( 1 ) & $x")), { SetIt: "Let ( $x = 1 ; 1 )" })).toEqual([]);
    expect(analyzeAlone(steps(step("Beep", "Outer & $x")), { Outer: "SetIt ( 1 )", SetIt: "Let ( $x = 1 ; 1 )" })).toEqual([]);
  });

  it("skips unset variables in a script that calls Evaluate", () => {
    const list = steps(step("Beep", 'Assign ( "$a = 1" ) & $a'));
    expect(analyzeAlone(list, { Assign: "Evaluate ( text )" })).toEqual([]);
    expect(rules(analyzeAlone(list))).toEqual(["unset-variable@1"]);
  });

  it("finds a set with no read, not one named in a string or read by a custom function", () => {
    expect(rules(analyzeAlone(steps(setVariable("$unused", "1"))))).toEqual(["unread-variable@1"]);
    expect(analyzeAlone(steps(setVariable("$x", "1"), step("Beep", 'Evaluate ( "$x" )')))).toEqual([]);
    expect(analyzeAlone(steps(setVariable("$x", "1"), step("Beep", "UsesX")), { UsesX: "$x + 1" })).toEqual([]);
  });
});

describe("Set Field context", () => {
  const table = obj("table", "1", "T");
  const field = obj("field", "1.1", "f", { parentUid: table.uid });
  const globalField = obj("field", "1.2", "g", { parentUid: table.uid, attributes: { global: "Yes" } });
  const occurrence = (id: string, name: string) => obj("tableOccurrence", id, name, { attributes: { baseTableId: "1", baseTable: "T" } });
  const [A, B, C] = [occurrence("1", "A"), occurrence("2", "B"), occurrence("3", "C")];
  const AB = obj("relationship", "1", "A-B", { detail: { kind: "relationship", leftTable: "A", rightTable: "B", leftToId: "1", rightToId: "2", predicates: [] } });
  const onA = obj("layout", "1", "LA", { attributes: { tableOccurrence: "A" } });
  const onC = obj("layout", "2", "LC", { attributes: { tableOccurrence: "C" } });
  const button = obj("layoutObject", "1.1", "Button", { parentUid: onA.uid });
  const SUB = obj("script", "2", "Sub");

  const setField = (from: FmObject, at: number, occurrenceId: string, f = field): RawReference => ({
    fromUid: from.uid,
    toType: "field",
    toId: f.id.split(".")[1]!,
    toName: f.name,
    kind: "setField",
    viaToId: occurrenceId,
    fromStep: at,
  });
  const call = (from: FmObject, to: FmObject, at?: number): RawReference => ({
    fromUid: from.uid,
    toType: "script",
    toId: to.id,
    toName: to.name,
    kind: "performScript",
    ...(at != null ? { fromStep: at } : {}),
  });
  const goTo = (at: number, layout: FmObject): RawReference => ({ fromUid: SCRIPT.uid, toType: "layout", toId: layout.id, toName: layout.name, kind: "goToLayout", fromStep: at });

  /** S with `list`, and Sub with `sub` (no typed steps when null), with `functions` as custom functions. */
  function check(list: StepIr[], references: RawReference[], sub: StepIr[] | null = steps(step("Beep")), functions: FmObject[] = []): ScriptFinding[] {
    const objects = [table, field, globalField, A, B, C, AB, onA, onC, button, SCRIPT, SUB, ...functions];
    const model = buildModel({ files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }], objects, references, errors: [] });
    const irs = new Map([[SCRIPT.uid, list], ...(sub ? [[SUB.uid, sub] as const] : [])]);
    return analyzeScripts({ model, irs }).findings.filter((f) => f.rule.startsWith("unrelated-"));
  }

  it("finds a Set Field into an occurrence unrelated to the button's layout", () => {
    const found = check(steps(step("Set Field")), [call(button, SCRIPT), setField(SCRIPT, 1, "3")]);
    expect(found.map((f) => [f.step, ...text(f)])).toEqual([
      [1, "Set Field into C::f has no record to set", "C isn't related to the occurrence of the layout the script is on here: LA (A)."],
    ]);
  });

  it("accepts a related occurrence, a global field, and a script nothing on a layout runs", () => {
    expect(check(steps(step("Set Field")), [call(button, SCRIPT), setField(SCRIPT, 1, "2")])).toEqual([]);
    expect(check(steps(step("Set Field")), [call(button, SCRIPT), setField(SCRIPT, 1, "3", globalField)])).toEqual([]);
    expect(check(steps(step("Set Field")), [setField(SCRIPT, 1, "3")])).toEqual([]);
  });

  it("follows Go to Layout, and its original layout", () => {
    const list = steps({ name: "Go to Layout", layoutChoice: "specified" }, step("Set Field"), { name: "Go to Layout", layoutChoice: "original" }, step("Set Field"));
    const found = check(list, [call(button, SCRIPT), goTo(1, onC), setField(SCRIPT, 2, "3"), setField(SCRIPT, 4, "3")]);
    expect(rules(found)).toEqual(["unrelated-set-field@4"]);
    expect(rules(check(list, [goTo(1, onA), setField(SCRIPT, 2, "3")]))).toEqual(["unrelated-set-field@2"]);
  });

  it("joins the layouts of an If's branches", () => {
    const list = steps(step("If"), { name: "Go to Layout", layoutChoice: "specified" }, step("End If"), step("Set Field"));
    expect(check(list, [call(button, SCRIPT), goTo(2, onC), setField(SCRIPT, 4, "3")])).toEqual([]);
    expect(rules(check(list, [call(button, SCRIPT), goTo(2, onA), setField(SCRIPT, 4, "3")]))).toEqual(["unrelated-set-field@4"]);
  });

  const layoutRef = (at: number, layout: FmObject): RawReference => ({ fromUid: SCRIPT.uid, toType: "layout", toId: layout.id, toName: layout.name, kind: "layout", fromStep: at });

  it("follows New Window and Go to Related Record where they name a layout", () => {
    const newWindow = (layoutChoice: LayoutChoice) => steps({ name: "New Window", layoutChoice }, step("Set Field"));
    // A named layout is known even when nothing shows where the script starts.
    expect(rules(check(newWindow("specified"), [layoutRef(1, onA), setField(SCRIPT, 2, "3")]))).toEqual(["unrelated-set-field@2"]);
    // "<Current Layout>": still the button's.
    expect(rules(check(newWindow("original"), [call(button, SCRIPT), setField(SCRIPT, 2, "3")]))).toEqual(["unrelated-set-field@2"]);
    const related = steps({ name: "Go to Related Record", layoutChoice: "specified" }, step("Set Field"));
    expect(rules(check(related, [call(button, SCRIPT), layoutRef(1, onA), setField(SCRIPT, 2, "3")]))).toEqual(["unrelated-set-field@2"]);
    // With no related record it stays on LA, whose A it can set; nor is it
    // known where it stays when nothing shows where the script starts.
    expect(check(related, [call(button, SCRIPT), layoutRef(1, onC), setField(SCRIPT, 2, "1")])).toEqual([]);
    expect(check(related, [layoutRef(1, onA), setField(SCRIPT, 2, "3")])).toEqual([]);
  });

  it("starts a performed script on the layout its caller is on at the call", () => {
    const sub = steps(step("Set Field"));
    const found = check(steps(step("Perform Script")), [call(button, SCRIPT), call(SCRIPT, SUB, 1), setField(SUB, 1, "3")], sub);
    expect(found.map((f) => [f.uid, f.step])).toEqual([[SUB.uid, 1]]);
    // Not once the caller has gone to LC, nor when Sub also runs itself.
    const afterGoTo = steps({ name: "Go to Layout", layoutChoice: "specified" }, step("Perform Script"));
    expect(check(afterGoTo, [call(button, SCRIPT), goTo(1, onC), call(SCRIPT, SUB, 2), setField(SUB, 1, "3")], sub)).toEqual([]);
    const recursive = steps(step("Set Field"), step("Perform Script"));
    expect(check(steps(step("Perform Script")), [call(button, SCRIPT), call(SCRIPT, SUB, 1), call(SUB, SUB, 2), setField(SUB, 1, "3")], recursive)).toEqual([]);
  });

  const fieldRef = (at: number, occurrenceId: string): RawReference => ({ ...setField(SCRIPT, at, occurrenceId), kind: "field" });

  it("checks the field other steps write into or go to, apart from the fields their formulas read", () => {
    const target = (name: string, occurrence: string): StepSpec => ({ name, fieldTargets: [{ field: "1", occurrence }] });
    const found = check(steps(target("Insert Text", "3"), target("Go to Field", "2")), [call(button, SCRIPT), fieldRef(1, "3"), fieldRef(2, "2")]);
    expect(found.map((f) => [f.rule, f.step, ...text(f)])).toEqual([
      ["unrelated-field-target", 1, "Insert Text can't reach C::f", "C isn't related to the occurrence of the layout the script is on here: LA (A)."],
    ]);
    expect(rules(check(steps(step("Insert Calculated Result", "C::f")), [call(button, SCRIPT), fieldRef(1, "3")]))).toEqual(["unrelated-field-read@1"]);
  });

  it("finds a formula reading a field the layout can't reach, not one taking only its name", () => {
    const reading = (formula: string, functions: FmObject[] = []) => rules(check(steps(step("Set Variable", formula)), [call(button, SCRIPT), fieldRef(1, "3")], undefined, functions));
    expect(reading("C::f + 1")).toEqual(["unrelated-field-read@1"]);
    expect(reading("GetFieldName ( C::f )")).toEqual([]);
    expect(reading("If ( IsValid ( C::f ) ; 1 )")).toEqual([]);
    expect(reading('"C::f" /* C::f */')).toEqual([]);
    const cf = (name: string, body: string) => obj("customFunction", name, name, { detail: { kind: "calculation", signature: `${name} ( field )`, body } });
    expect(reading("SqlName ( C::f )", [cf("SqlName", "Quote ( GetFieldName ( field ) )")])).toEqual([]);
    expect(reading("Twice ( C::f )", [cf("Twice", "field * 2")])).toEqual(["unrelated-field-read@1"]);
    // B is related to LA's A; Set Field's own target has its own finding.
    expect(rules(check(steps(step("Set Variable", "B::f")), [call(button, SCRIPT), fieldRef(1, "2")]))).toEqual([]);
    expect(rules(check(steps(step("Set Field", "C::f + 1")), [call(button, SCRIPT), setField(SCRIPT, 1, "3"), fieldRef(1, "3")]))).toEqual(["unrelated-set-field@1"]);
  });

  it("forgets the layout after a pause, when the user can go to another", () => {
    const refs = [call(button, SCRIPT), setField(SCRIPT, 2, "3")];
    expect(rules(check(steps(step("Beep"), step("Set Field")), refs))).toEqual(["unrelated-set-field@2"]);
    expect(check(steps(step("Pause/Resume Script"), step("Set Field")), refs)).toEqual([]);
    expect(check(steps({ name: "Enter Find Mode", flags: { Pause: true } }, step("Set Field")), refs)).toEqual([]);
  });

  it("forgets the layout after a calculated Go to Layout, a window step, or a call that might change it", () => {
    const after = (first: StepSpec, sub?: StepIr[] | null) => check(steps(first, step("Set Field")), [call(button, SCRIPT), call(SCRIPT, SUB, 1), setField(SCRIPT, 2, "3")], sub);
    expect(after({ name: "Go to Layout", layoutChoice: "calculated" })).toEqual([]);
    expect(after(step("New Window"))).toEqual([]);
    expect(after(step("Perform Script"), steps(step("Go to Related Record")))).toEqual([]);
    expect(after(step("Perform Script"), null)).toEqual([]);
    expect(rules(after(step("Perform Script")))).toEqual(["unrelated-set-field@2"]);
  });
});

describe("parameter keys", () => {
  it("reads the keys a parameter formula builds", () => {
    expect(passedKeys('JSONSetElement ( "{}" ; [ "id" ; 1 ; JSONNumber ] ; [ "customer.name" ; "x" ; JSONString ] )')).toEqual(["id", "customer"]);
    expect(passedKeys('JSONSetElement ( JSONSetElement ( "" ; "a" ; 1 ; JSONNumber ) ; "b" ; 2 ; JSONNumber )')).toEqual(["a", "b"]);
    expect(passedKeys("")).toEqual([]);
    expect(passedKeys("$id")).toBeUndefined();
    expect(passedKeys('JSONSetElement ( "{}" ; $key ; 1 ; JSONNumber )')).toBeUndefined();
    expect(passedKeys('JSONSetElement ( "{}" ; "a" ; 1 ; JSONNumber ) & ""')).toBeUndefined();
  });

  it("reads the keys a script gets from its parameter, directly or through a variable", () => {
    const reads = keyReads(steps(setVariable("$p", "Get ( ScriptParameter )"), step("Beep", 'JSONGetElement ( $p ; "id" )'), step("Beep", 'JSONGetElement ( Get ( ScriptParameter ) ; "mode" )')));
    expect(reads && { keys: [...reads.keys], complete: reads.complete }).toEqual({ keys: [["id", [2]], ["mode", [3]]], complete: true });
    const passedOn = keyReads(steps(step("Beep", 'JSONGetElement ( Get ( ScriptParameter ) ; "id" )'), step("Exit Script", "Get ( ScriptParameter )")));
    expect(passedOn?.complete).toBe(false);
  });

  const CALLER = obj("script", "2", "Caller");
  const BUTTON = obj("layoutObject", "1.1", "Button", { parentUid: `${FILE}:layout:1`, detail: { kind: "layoutObject", loType: "Button", scriptParameter: '"plain"' } as ObjectDetail });
  const LAYOUT = obj("layout", "1", "L");
  const callerRef = (from: FmObject, at?: number): RawReference => ({
    fromUid: from.uid,
    toType: "script",
    toId: SCRIPT.id,
    toName: SCRIPT.name,
    kind: "performScript",
    ...(at != null ? { fromStep: at } : {}),
  });
  const CALLEE = steps(step("Beep", 'JSONGetElement ( Get ( ScriptParameter ) ; "id" )'), step("Beep", 'JSONGetElement ( Get ( ScriptParameter ) ; "mode" )'));

  function check(callee: StepIr[], parameter: string, extra: RawReference[] = []): ScriptFinding[] {
    const model = buildModel({
      files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }],
      objects: [SCRIPT, CALLER, LAYOUT, BUTTON],
      references: [callerRef(CALLER, 1), ...extra],
      errors: [],
    });
    const irs = new Map([
      [SCRIPT.uid, callee],
      [CALLER.uid, steps({ name: "Perform Script", calcs: [parameter], parameter })],
    ]);
    return analyzeScripts({ model, irs }).findings.filter((f) => f.rule.endsWith("parameter-key"));
  }
  const passing = 'JSONSetElement ( "{}" ; [ "id" ; 1 ; JSONNumber ] ; [ "mdoe" ; "x" ; JSONString ] )';

  it("finds a key no caller passes and a key the script never reads", () => {
    const found = check(CALLEE, passing);
    expect(found.map((f) => [f.rule, f.uid, f.step, ...text(f)])).toEqual([
      ["unpassed-parameter-key", SCRIPT.uid, 2, 'Parameter key "mode" isn\'t passed', "Its caller doesn't pass it. It passes: id, mdoe."],
      ["unread-parameter-key", CALLER.uid, 1, 'Parameter key "mdoe" is never read', "Passed to S, which reads only: id, mode."],
    ]);
  });

  it("says nothing it can't back: an unknown caller, or a script that uses its parameter otherwise", () => {
    expect(rules(check(CALLEE, passing, [callerRef(BUTTON)]))).toEqual(["unread-parameter-key@1"]);
    expect(rules(check([...CALLEE, ...steps(step("Exit Script", "Get ( ScriptParameter )"))], passing))).toEqual(["unpassed-parameter-key@2"]);
  });
});

describe("script results", () => {
  const SUB = obj("script", "2", "Sub");
  const SUB2 = obj("script", "3", "Sub2");
  const perform = (from: FmObject, at: number, to: FmObject): RawReference => ({
    fromUid: from.uid,
    toType: "script",
    toId: to.id,
    toName: to.name,
    kind: "performScript",
    fromStep: at,
  });
  const returning = (formula: string) => steps({ name: "Exit Script", calcs: [formula] });
  const RETURNS_ID = returning('JSONSetElement ( "{}" ; [ "id" ; 1 ; JSONNumber ] )');

  /** S with `caller`, performing Sub at the steps in `at`; Sub with `sub`, Sub2 with `sub2`. */
  function check(caller: StepIr[], at: number[], sub: StepIr[], extra: { sub2?: StepIr[]; refs?: RawReference[]; functions?: Record<string, string> } = {}) {
    const functions = Object.entries(extra.functions ?? {}).map(([name, body], i) => obj("customFunction", String(i + 1), name, { detail: { kind: "calculation", signature: name, body } }));
    const model = buildModel({
      files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }],
      objects: [SCRIPT, SUB, SUB2, ...functions],
      references: [...at.map((n) => perform(SCRIPT, n, SUB)), ...(extra.refs ?? [])],
      errors: [],
    });
    const irs = new Map([
      [SCRIPT.uid, caller],
      [SUB.uid, sub],
      [SUB2.uid, extra.sub2 ?? steps(step("Beep"))],
    ]);
    return analyzeScripts({ model, irs }).findings.filter((f) => f.rule === "unreturned-result-key" || f.rule === "result-before-call");
  }
  const reads = (key: string) => step("Beep", `JSONGetElement ( Get ( ScriptResult ) ; "${key}" )`);

  it("finds a key the performed script doesn't return, not one it does", () => {
    const found = check(steps(step("Perform Script"), reads("id"), reads("idd")), [1], RETURNS_ID);
    expect(found.map((f) => [f.step, ...text(f)])).toEqual([[3, 'Result key "idd" isn\'t returned', "Sub never returns it. It returns: id."]]);
  });

  it("follows a variable set to Get ( ScriptResult )", () => {
    const caller = steps(step("Perform Script"), setVariable("$r", "Get ( ScriptResult )"), step("Beep", 'JSONGetElement ( $r ; "x" )'));
    expect(rules(check(caller, [1], RETURNS_ID))).toEqual(["unreturned-result-key@3"]);
  });

  it("reads results built in a variable, by a custom function, or passed on from a subscript", () => {
    // Reads a and b, which they return, and c, which none does: only c is found.
    const caller = steps(step("Perform Script"), reads("a"), reads("b"), reads("c"));
    const built = steps(setVariable("$res", 'JSONSetElement ( "{}" ; "a" ; 1 ; JSONNumber )'), setVariable("$res", 'JSONSetElement ( $res ; "b" ; 2 ; JSONNumber )'), { name: "Exit Script", calcs: ["$res"] });
    expect(rules(check(caller, [1], built))).toEqual(["unreturned-result-key@4"]);
    const byFunction = check(caller, [1], returning("Result"), { functions: { Result: 'JSONSetElement ( "{}" ; [ "a" ; 1 ; JSONNumber ] ; [ "b" ; 2 ; JSONNumber ] )' } });
    expect(rules(byFunction)).toEqual(["unreturned-result-key@4"]);
    const passesOn = steps(step("Perform Script"), { name: "Exit Script", calcs: ["Get ( ScriptResult )"] });
    const sub2 = returning('JSONSetElement ( "{}" ; [ "a" ; 1 ; JSONNumber ] ; [ "b" ; 2 ; JSONNumber ] )');
    expect(rules(check(caller, [1], passesOn, { sub2, refs: [perform(SUB, 1, SUB2)] }))).toEqual(["unreturned-result-key@4"]);
  });

  it("says when the script returns nothing, or isn't waited for on the server", () => {
    expect(check(steps(step("Perform Script"), reads("id")), [1], steps(step("Beep"))).map(text)).toEqual([['Result key "id" isn\'t returned', "Sub doesn't return a result."]]);
    const noWait = steps({ name: "Perform Script on Server", flags: { "Wait for completion": false } }, reads("id"));
    expect(check(noWait, [1], RETURNS_ID).map(text)).toEqual([['Result key "id" isn\'t returned', "The Perform Script on Server at step 1 doesn't wait for its script, so there's no result."]]);
  });

  it("says nothing it can't back: a text result, or a call on only some paths", () => {
    expect(check(steps(step("Perform Script"), reads("id")), [1], returning('"done"'))).toEqual([]);
    expect(check(steps(step("If"), step("Perform Script"), step("End If"), reads("x")), [2], RETURNS_ID)).toEqual([]);
  });

  it("finds Get ( ScriptResult ) read before any script runs, except after JavaScript, a pause, or as a callback", () => {
    expect(rules(check(steps(setVariable("$r", "Get ( ScriptResult )")), [], RETURNS_ID))).toEqual(["result-before-call@1"]);
    expect(check(steps(step("Perform JavaScript in Web Viewer"), setVariable("$r", "Get ( ScriptResult )")), [], RETURNS_ID)).toEqual([]);
    expect(check(steps(step("Pause/Resume Script"), setVariable("$r", "Get ( ScriptResult )")), [], RETURNS_ID)).toEqual([]);
    const callback = check(steps(setVariable("$r", "Get ( ScriptResult )")), [], steps(step("Perform Script on Server with Callback")), { refs: [perform(SUB, 1, SCRIPT)] });
    expect(callback).toEqual([]);
  });
});

describe("typed steps from the exports", () => {
  const read = (version: string) => {
    const paths = ["TEST_MAIN", "TEST_EXT"].map((f) => `tests/fixtures/test-solution/XML ${version}/${f}.xml`);
    const docs = paths.map((path) => {
      const bytes = readFileSync(path);
      return { name: path.split("/").pop()!, content: decodeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) };
    });
    const model = buildModel(parseDocuments(docs));
    return { model, irs: model.scriptSteps };
  };

  it("reads variables, layout choices and parameters (FM 26)", () => {
    const { model, irs } = read("FM26");
    const main = model.objects.find((o) => o.type === "script" && o.name === "S_Main")!;
    const byIndex = new Map(irs.get(main.uid)!.map((s) => [s.index, s]));
    expect(byIndex.get(20)).toMatchObject({ name: "Set Variable", setsVariable: "$local", calcs: ["3", "1"] });
    expect(byIndex.get(21)).toMatchObject({ name: "Insert from URL", setsVariable: "$$RESULT" });
    expect(byIndex.get(9)?.layoutChoice).toBe("specified");
    expect(byIndex.get(11)?.layoutChoice).toBe("calculated");
    expect(byIndex.get(2)?.parameter).toBe("TO_Main::f_ID");
    expect(byIndex.get(31)?.calcs).toEqual(["$local = 3"]);
  });

  it("reads the same steps from the FM 22 export, and finds nothing in either", () => {
    const fm26 = read("FM26");
    const fm22 = read("FM22");
    const mainOf = ({ model, irs }: ReturnType<typeof read>) => irs.get(model.objects.find((o) => o.type === "script" && o.name === "S_Main")!.uid);
    expect(mainOf(fm22)).toEqual(mainOf(fm26));
    expect(analyzeScripts(fm26).findings).toEqual([]);
    expect(analyzeScripts(fm22).findings).toEqual([]);
  });

  it("finds the appended steps' unread variable, and skips unset variables for their Evaluate", () => {
    const analysis = analyzeScripts(read("FM26/APPENDED TESTS"));
    expect(rules(analysis.findings)).toEqual(["unread-variable@34"]);
    expect(analysis.skipped.map((s) => s.check)).toEqual(["unset-variable"]);
  });
});
