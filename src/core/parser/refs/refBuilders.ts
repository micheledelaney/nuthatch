import type { ObjectType, RawReference, RefKind } from "@/types/ddr";
import { MISSING_REF_ID } from "../sentinels";

/** The object a scan attributes the references it finds to. */
export interface RefOwner {
  uid: string;
  type: ObjectType;
}

/** Where inside its owner a reference was found. */
export interface ScanContext {
  stepName?: string;
  /** 1-based index of the enclosing <Step>, matching scriptSteps() numbering. */
  stepIndex?: number;
  /** The enclosing <Step> is disabled (enable="False"). */
  disabled?: boolean;
  /** Inside a <ScriptTrigger>: its script reference is a "trigger" edge. */
  inTrigger?: boolean;
  /** Inside a calculation's chunk list (followed from its DDRREF pointer). */
  inChunkList?: boolean;
}

/** Push a reference, stamped with the originating step (and whether that step is
 * disabled) from the scan context. Every reference that comes from a step goes
 * through here. */
export function pushRef(out: RawReference[], ref: RawReference, ctx: ScanContext): void {
  out.push({
    ...ref,
    ...(ctx.stepIndex != null ? { fromStep: ctx.stepIndex } : {}),
    ...(ctx.disabled ? { disabled: true } : {}),
  });
}

/** A reference whose target the export itself shows was deleted: it resolves as
 * broken whatever the target lookup would find. */
export function brokenRef(fromUid: string, toType: ObjectType, toName: string, kind: RefKind = toType): RawReference {
  return { fromUid, toType, toId: MISSING_REF_ID, toName, kind, forceBroken: true };
}

/** A use of a `$$global` variable (they have no catalog: each name becomes an
 * object of its own, see globalVariableObjects). */
export function globalVariableRef(fromUid: string, name: string): RawReference {
  return { fromUid, toType: "globalVariable", toId: name, toName: name, kind: "globalVariable" };
}
