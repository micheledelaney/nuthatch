import { useEffect, useRef, useState } from "react";
import { useStore } from "@/state/store";

/**
 * Modal for creating a project up front (before any analysis is loaded). The new
 * project appears on the dashboard immediately, ready for analyses to be added.
 */
export function NewProjectDialog() {
  const pendingProject = useStore((s) => s.pendingProject);
  const confirmNewProject = useStore((s) => s.confirmNewProject);
  const cancelNewProject = useStore((s) => s.cancelNewProject);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pendingProject) return;
    setName("");
    setNote("");
    inputRef.current?.focus();
  }, [pendingProject]);

  if (!pendingProject) return null;

  function create() {
    void confirmNewProject(name, note);
  }

  return (
    <div className="modal-overlay" onClick={cancelNewProject}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>New project</h3>
        <p className="subtle">Name a project to collect a file history of analyses over time.</p>
        <label className="field-label" htmlFor="new-project-name">
          Project name
        </label>
        <input
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          id="new-project-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") cancelNewProject();
          }}
        />
        <label className="field-label" htmlFor="new-project-note">
          Note <span className="subtle">(optional)</span>
        </label>
        <textarea
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          id="new-project-note"
          className="note-input"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
            if (e.key === "Escape") cancelNewProject();
          }}
        />
        <div className="modal-actions">
          <button onClick={cancelNewProject}>Cancel</button>
          <button className="primary" onClick={create} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
