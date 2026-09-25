import { useEffect, useRef, useState } from "react";
import { useStore } from "@/state/store";
import type { EditTarget } from "@/state/store";

/** Presentation for each edit kind. */
function configFor(target: EditTarget): { title: string; label: string; multiline: boolean } {
  switch (target.kind) {
    case "project-rename":
      return { title: "Rename project", label: "Project name", multiline: false };
    case "project-note":
      return { title: "Project note", label: "Note", multiline: true };
    case "analysis-rename":
      return { title: "Rename analysis", label: "Name", multiline: false };
    case "analysis-note":
      return { title: "Analysis note", label: "Note", multiline: true };
  }
}

/** Shared modal for renaming projects/analyses and editing their notes. */
export function EditDialog() {
  const editDialog = useStore((s) => s.editDialog);
  const confirmEdit = useStore((s) => s.confirmEdit);
  const cancelEdit = useStore((s) => s.cancelEdit);

  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editDialog) return;
    setValue(editDialog.initialValue);
    const el = editDialog.target.kind.endsWith("note") ? textareaRef.current : inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editDialog]);

  if (!editDialog) return null;

  const { title, label, multiline } = configFor(editDialog.target);
  const isRename = editDialog.target.kind.endsWith("rename");
  const canSave = !isRename || value.trim().length > 0;

  function save() {
    if (canSave) void confirmEdit(value);
  }

  return (
    <div className="modal-overlay" onClick={cancelEdit}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <label className="field-label" htmlFor="edit-field">
          {label}
        </label>
        {multiline ? (
          <textarea
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            id="edit-field"
            ref={textareaRef}
            className="note-input"
            rows={4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              if (e.key === "Escape") cancelEdit();
            }}
          />
        ) : (
          <input
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            id="edit-field"
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancelEdit();
            }}
          />
        )}
        <div className="modal-actions">
          <button onClick={cancelEdit}>Cancel</button>
          <button className="primary" onClick={save} disabled={!canSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
