/**
 * One source of truth for rendering `TO::Field` references inline.
 *
 * Where it's used:
 *   - Value-list "Field" and "Also displays" rows
 *   - Layout-object "Field" row (the property panel)
 *   - Lookups, sort orders, the At a glance rows
 *   - LinkedCode (when it spots a qualified ref inside calc / step text)
 *
 * The decision — which field, and whether it's found, deleted, unverifiable or
 * in another file — is the model's (core/model/refStatus); this component only
 * shows it.
 */
import type React from "react";
import type { FmObject, SolutionModel } from "@/types/ddr";
import { objectLabel } from "@/types/ddr";
import { ownFieldRef, refLabel, refStatus } from "@/core/model/refStatus";

interface OnGoProps {
  onGo: (uid: string, rowKey: string) => void;
}

/** Bare clickable object name: opens the object as the next detail column. */
export function ObjLink({
  obj,
  onGo,
  children,
}: { obj: FmObject; children?: React.ReactNode } & OnGoProps) {
  return (
    <button
      type="button"
      className="obj-link"
      title={objectLabel(obj)}
      onClick={() => onGo(obj.uid, `link:${obj.uid}`)}
    >
      {children ?? obj.name}
    </button>
  );
}

const STATUS_CHIP: Record<"external" | "broken" | "unused", { label: string; tone?: "high" | "warn" }> = {
  external: { label: "External" },
  broken: { label: "Broken", tone: "high" },
  unused: { label: "Unused", tone: "warn" },
};

/** A status tag ("External", "Broken", "Unused") right after a reference's
 * name — the same tag as an object's flags (Broken in red, Unused in the
 * warning tone, like Unreferenced). */
export function RefStatusChip({ kind }: { kind: "external" | "broken" | "unused" }) {
  const { label, tone } = STATUS_CHIP[kind];
  return <span className={`tag ref-external-tag${tone ? ` tone-${tone}` : ""}`}>{label}</span>;
}

/**
 * Render a `TO::Field` label from an object's detail as the field that object
 * references (see ownFieldRef), in FileMaker's wording (refLabel) — one click
 * target that goes to the field, or to its occurrence when the field itself
 * can't be reached:
 *   - found → links the field
 *   - in another file / can't be verified → links the occurrence
 *   - deleted → links the occurrence; the field half is `broken-value`
 *   - the object has no such reference → the label as written, not linked
 *
 * `showChip` toggles the trailing EXTERNAL chip — useful in property-sheet
 * rows; inline (inside calc text) the chip just adds noise. The prop is named
 * `qualified` (not `ref`) because React reserves `ref` for ref-forwarding.
 */
export function FieldRefLink({
  qualified,
  model,
  owner,
  onGo,
  showChip = false,
}: {
  qualified: string;
  model: SolutionModel;
  /** The object whose detail names the field: its own reference is shown. */
  owner: string;
  showChip?: boolean;
} & OnGoProps) {
  const ref = ownFieldRef(model, owner, qualified);
  if (!ref) return <>{qualified}</>;
  const status = refStatus(ref, model.byUid);
  const label = refLabel(ref, model.byUid);
  const sep = label.indexOf("::");
  const inner =
    status === "broken" ? (
      <>
        {sep >= 0 && label.slice(0, sep + 2)}
        <span className="broken-value">{sep >= 0 ? label.slice(sep + 2) : label}</span>
      </>
    ) : (
      label
    );
  const target = (ref.toUid ? model.byUid.get(ref.toUid) : undefined) ?? (ref.viaUid ? model.byUid.get(ref.viaUid) : undefined);
  if (!target) return <>{inner}</>;
  return (
    <>
      <ObjLink obj={target} onGo={onGo}>
        {inner}
      </ObjLink>
      {showChip && (status === "external" || status === "unverifiable") && <RefStatusChip kind="external" />}
    </>
  );
}
