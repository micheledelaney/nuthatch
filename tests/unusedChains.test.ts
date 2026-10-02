/**
 * Unused chains on a small hand-built solution, for the cases the test-solution
 * fixture doesn't have: a parent script whose callees go with it, a loop, a
 * button on an unused layout, menu-visible entry points, a disabled call, and
 * a field used from outside its unused table.
 */
import { describe, expect, it } from "vitest";
import { buildModel } from "@/core/model/buildModel";
import { chainTops, findUnusedChains, isUnusedSource } from "@/core/analysis/unusedChains";
import type { FmObject, FmReference, ObjectType, RawReference } from "@/types/ddr";

const FILE = "F0";

function obj(type: ObjectType, id: string, name: string, extra: Partial<FmObject> = {}): FmObject {
  return { uid: `${FILE}:${type}:${id}`, type, id, name, fileUid: FILE, fileName: "TEST", attributes: {}, text: "", ...extra };
}
/** Hidden from the Scripts menu, so only a reference keeps it in use. */
const script = (id: string, name: string) => obj("script", id, name, { attributes: { includeInMenu: "No" } });
const menuScript = (id: string, name: string) => obj("script", id, name);
const layout = (id: string, name: string) => obj("layout", id, name, { attributes: { includeInLayoutMenus: "No" } });
const menuLayout = (id: string, name: string) => obj("layout", id, name);
const button = (on: FmObject, id: string) => obj("layoutObject", `${on.id}.${id}`, `Button ${id}`, { parentUid: on.uid });

function call(from: FmObject, to: FmObject, extra: Partial<RawReference> = {}): RawReference {
  return { fromUid: from.uid, toType: to.type, toId: to.id, toName: to.name, kind: "performScript", ...extra };
}

const P = script("1", "P"); // unreferenced, hidden: starts a chain
const A = script("2", "A"); // called by P and by V
const B = script("3", "B"); // called only by P
const C = script("4", "C"); // called only by B
const D = script("5", "D"); // called by P, and by V in a disabled step
const V = menuScript("6", "V"); // unreferenced, but in the Scripts menu
const R = script("7", "R"); // called only by V
const X = script("8", "X"); // X and Y only call each other
const Y = script("9", "Y");
const L = layout("10", "L"); // unreferenced, hidden from the Layouts menu
const onL = button(L, "1");
const E = script("11", "E"); // called only by a button on L
const M = menuLayout("12", "M"); // unreferenced, but in the Layouts menu
const onM = button(M, "1");
const G = script("13", "G"); // called only by a button on M

const model = buildModel({
  files: [{ uid: FILE, name: "TEST", source: "TEST.xml" }],
  objects: [P, A, B, C, D, V, R, X, Y, L, onL, E, M, onM, G],
  references: [
    call(P, A),
    call(P, B),
    call(P, D),
    call(B, C),
    call(V, A),
    call(V, R),
    call(V, D, { disabled: true }),
    call(X, Y),
    call(Y, X),
    call(onL, E),
    call(onM, G),
  ],
  errors: [],
});
const names = (objects: FmObject[]) => objects.map((o) => o.name).sort();

describe("unused chains", () => {
  it("leaves the unreferenced list as it was", () => {
    expect(names(model.unreferenced)).toEqual(["L", "M", "P", "V"]);
  });

  it("finds what only unused objects use, and nothing else", () => {
    expect(names(model.unusedChain)).toEqual(["B", "C", "D", "E", "X", "Y"]);
    expect(model.reportCard.unusedChainCount).toBe(6);
  });

  it("names the unreferenced object at the top of a chain, however deep", () => {
    expect(names(chainTops(model, B.uid).tops)).toEqual(["P"]);
    expect(names(chainTops(model, C.uid).tops)).toEqual(["P"]);
    expect(names(chainTops(model, E.uid).tops)).toEqual(["L"]);
  });

  it("doesn't let a disabled call keep a script in use", () => {
    expect(names(chainTops(model, D.uid).tops)).toEqual(["P"]);
  });

  it("reports a loop with the objects in it", () => {
    expect(chainTops(model, X.uid)).toEqual({ tops: [], loop: [Y] });
  });

  it("treats menu-visible scripts and layouts as in use", () => {
    expect(isUnusedSource(model, V.uid)).toBe(false);
    expect(isUnusedSource(model, onM.uid)).toBe(false);
    expect(isUnusedSource(model, P.uid)).toBe(true);
    // A button counts as its layout.
    expect(isUnusedSource(model, onL.uid)).toBe(true);
  });

  it("never flags an object something in use uses, even inside an unused container", () => {
    const table = obj("table", "1", "T");
    const field = obj("field", "1.1", "f", { parentUid: table.uid });
    const user = menuScript("1", "Uses f");
    const ref: FmReference = { fromUid: user.uid, toUid: field.uid, toType: "field", toId: "1", toName: "f", kind: "field", broken: false };
    const objects = [table, field, user];
    const found = findUnusedChains(objects, new Map([[user.uid, [ref]]]), new Map(objects.map((o) => [o.uid, o])), [table]);
    expect(found).toEqual([]);
  });
});
