/**
 * One source of truth for rendering `TO::Field` references inline.
 *
 * Where it's used:
 *   - Value-list "Field" and "Also displays" rows
 *   - Layout-object "Field" row (the property panel)
 *   - LinkedCode (when it spots a qualified ref inside calc / step text)
 *
 * Decision-making lives in `resolveQualifiedRef`; styling lives in
 * `RefStatusChip`; this component is just the glue that joins both halves
 * with `::` and lets each be independently linked.
 */
import type React from "react";
import type { FmObject, SolutionModel } from "@/types/ddr";
import { objectLabel } from "@/types/ddr";
import { resolveQualifiedRef } from "@/core/model/refResolution";

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

/** A small uppercase chip ("EXTERNAL", "BROKEN") to qualify the row in the
 * margin — matches the chip the references list already uses. */
export function RefStatusChip({ kind }: { kind: "external" | "broken" }) {
  return <span className="ref-external-tag">{kind}</span>;
}

/**
 * Render `TO::Field` as a single click target — clicking anywhere on the
 * qualified ref navigates to the field (or to the closest available target
 * when the field can't be reached):
 *   - resolved → one button wrapping the whole label, navigates to the field
 *   - external → one button wrapping the whole label, navigates to the TO
 *     (the field's file isn't loaded; the TO is the nearest navigable target)
 *   - field-missing → one button, navigates to the TO; the field half is
 *     rendered with `broken-value` so the missing field is still obvious
 *   - to-missing → plain text, both halves broken-styled, not clickable
 *
 * `showChip` toggles the trailing EXTERNAL chip — useful in property-sheet
 * rows; inline (inside calc text) the chip just adds noise. The prop is named
 * `qualified` (not `ref`) because React reserves `ref` for ref-forwarding.
 */
export function FieldRefLink({
  qualified,
  model,
  fileUid,
  onGo,
  showChip = false,
}: {
  qualified: string;
  model: SolutionModel;
  fileUid: string;
  showChip?: boolean;
} & OnGoProps) {
  const res = resolveQualifiedRef(qualified, model, fileUid);
  if (!res) return <>{qualified}</>;
  const sep = qualified.indexOf("::");
  const toName = qualified.slice(0, sep);
  const fieldName = qualified.slice(sep + 2);

  // Inner content: a `field-missing` ref still flags the deleted field's name
  // even though the click goes to the TO.
  const inner =
    res.kind === "field-missing" ? (
      <>
        {toName}
        {"::"}
        <span className="broken-value">{fieldName}</span>
      </>
    ) : (
      `${toName}::${fieldName}`
    );

  // Pick the navigation target. Field if we have one; otherwise the TO; if
  // neither exists, render plain text (broken-styled).
  if (res.kind === "to-missing") {
    return <span className="broken-value">{qualified}</span>;
  }
  const target = res.kind === "resolved" ? res.field : res.to;
  return (
    <>
      <ObjLink obj={target} onGo={onGo}>
        {inner}
      </ObjLink>
      {showChip && res.kind === "external" && <RefStatusChip kind="external" />}
    </>
  );
}
