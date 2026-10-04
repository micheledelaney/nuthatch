import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { objectLabel, type UsageReason } from "@/types/ddr";
import { USAGE_REASONS, USAGE_REASON_LABELS } from "@/core/analysis/usageMarks";
import { useModalFocus } from "./a11y";

const DEFAULT_REASON: UsageReason = "serverSchedule";

/** Modal for marking an object as used by something the export can't see. */
export function MarkUsedDialog() {
  const uid = useStore((s) => s.markDialog);
  const model = useStore((s) => s.model);
  const markUsed = useStore((s) => s.markUsed);
  const cancel = useStore((s) => s.cancelMarkDialog);

  const [reason, setReason] = useState<UsageReason>(DEFAULT_REASON);
  const [note, setNote] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(!!uid);
  const titleId = useId();

  useEffect(() => {
    if (!uid) return;
    setReason(DEFAULT_REASON);
    setNote("");
    selectRef.current?.focus();
  }, [uid]);

  const obj = uid ? model?.byUid.get(uid) : undefined;
  if (!obj) return null;

  const save = () => void markUsed(obj.uid, reason, note);

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div
        className="popover modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <h3 id={titleId}>Mark as used</h3>
        <p className="subtle">
          {objectLabel(obj)}, and anything used only through it, will stop showing as unused in every analysis in
          this project.
        </p>
        <label className="head field-label" htmlFor="mark-reason">
          Reason
        </label>
        <select id="mark-reason" ref={selectRef} value={reason} onChange={(e) => setReason(e.target.value as UsageReason)}>
          {USAGE_REASONS.map((r) => (
            <option key={r} value={r}>
              {USAGE_REASON_LABELS[r]}
            </option>
          ))}
        </select>
        <label className="head field-label" htmlFor="mark-note">
          Note <span className="subtle">(optional)</span>
        </label>
        <textarea
          autoComplete="off"
          spellCheck={false}
          id="mark-note"
          className="note-input"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>
            Mark as used
          </button>
        </div>
      </div>
    </div>
  );
}
