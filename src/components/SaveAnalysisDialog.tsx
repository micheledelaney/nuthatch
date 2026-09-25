import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";

/**
 * Modal shown right after files are chosen and BEFORE parsing, collecting the
 * name, project, and note so the heavy parse only runs once the user commits.
 * When the load was started from a specific project (`lockedProject`), that
 * project is fixed and only the name is editable; otherwise the project can be
 * picked from existing ones or typed fresh. "Save" parses + persists, and
 * "Cancel" (or Escape) backs out without parsing at all.
 */
export function SaveAnalysisDialog() {
  const pendingLoad = useStore((s) => s.pendingLoad);
  const savedItems = useStore((s) => s.savedItems);
  const projects = useStore((s) => s.projects);
  const confirmSave = useStore((s) => s.confirmSave);
  const cancelLoad = useStore((s) => s.cancelLoad);

  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [note, setNote] = useState("");
  const projectRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const locked = pendingLoad?.lockedProject ?? null;

  /** Distinct project names (created + used), for the autocomplete datalist. */
  const projectOptions = useMemo(() => {
    const names = new Set<string>(projects.map((p) => p.name));
    for (const item of savedItems) names.add(item.projectName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [projects, savedItems]);

  // Reset fields when the prompt opens; focus the first editable field.
  useEffect(() => {
    if (!pendingLoad) return;
    setName(pendingLoad.defaultName);
    setProject(pendingLoad.defaultProject);
    setNote("");
    const input = pendingLoad.lockedProject ? nameRef.current : projectRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [pendingLoad]);

  if (!pendingLoad) return null;

  function save() {
    void confirmSave(name, locked ?? project, note);
  }

  return (
    <div className="modal-overlay" onClick={cancelLoad}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>Save this analysis</h3>
        <p className="subtle">
          {locked
            ? "Name this analysis to add it to the project. Parsing starts once you continue."
            : "Group it under a project, name it, then continue to parse and open it."}
        </p>

        <label className="field-label" htmlFor="save-project">
          Project
        </label>
        {locked ? (
          <div className="locked-field">{locked}</div>
        ) : (
          <>
            <input
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              id="save-project"
              ref={projectRef}
              type="text"
              list="save-project-options"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancelLoad();
              }}
            />
            <datalist id="save-project-options">
              {projectOptions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </>
        )}

        <label className="field-label" htmlFor="save-name">
          Name
        </label>
        <input
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          id="save-name"
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancelLoad();
          }}
        />

        <label className="field-label" htmlFor="save-note">
          Note <span className="subtle">(optional)</span>
        </label>
        <textarea
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          id="save-note"
          className="note-input"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            if (e.key === "Escape") cancelLoad();
          }}
        />

        <div className="modal-actions">
          <button style={{ marginRight: "auto" }} onClick={cancelLoad}>
            Cancel
          </button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
