import { useCallback, useEffect, useState } from "react";
import { useStore, type PaneSide } from "@/state/store";
import { CommandPalette } from "./CommandPalette";
import { Pane } from "./Pane";
import { PinShelf } from "./PinShelf";
import { ShortcutsOverlay } from "./Shortcuts";
import { Welcome } from "./Welcome";
import { MOD_LABEL } from "./objectInfo";
import "./workbench.css";

/** True when a key event comes from somewhere the user is typing text. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
}

/**
 * Browse main area: pinned shelf + ⌘K search bar on top, then one or two
 * object panes (or the keyboard welcome screen when nothing is open). Owns the
 * global ⌘K / ? shortcuts; the active pane (for ← and ⌘[ / ⌘]) lives in the store.
 */
export function Workbench() {
  const trail = useStore((s) => s.trail);
  const split = useStore((s) => s.split);
  const noteRecent = useStore((s) => s.noteRecent);
  const closePane = useStore((s) => s.closePane);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const activePane = useStore((s) => s.activePane);
  const setActivePane = useStore((s) => s.setActivePane);
  const activeSide: PaneSide = split ? activePane : "primary";

  const primaryUid = trail[trail.length - 1];
  const secondaryUid = split ? split[split.length - 1] : undefined;
  useEffect(() => {
    if (primaryUid) noteRecent(primaryUid);
  }, [primaryUid, noteRecent]);
  useEffect(() => {
    if (secondaryUid) noteRecent(secondaryUid);
  }, [secondaryUid, noteRecent]);

  // The trail can be cleared from outside (e.g. switching tabs via showBrowse);
  // promote a lone secondary pane rather than showing an empty primary.
  useEffect(() => {
    if (trail.length === 0 && split) closePane("primary");
  }, [trail.length, split, closePane]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHelpOpen(false);
        setPaletteOpen((v) => !v);
      } else if (e.key === "?" && !isTyping(e.target)) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  return (
    <div className="wb">
      <div className="wb-bar">
        <PinShelf />
        <button type="button" className="wb-search-btn" onClick={openPalette}>
          Search <kbd>{MOD_LABEL}</kbd>
          <kbd>K</kbd>
        </button>
        <button type="button" className="wb-icon-btn" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
          ?
        </button>
      </div>
      {trail.length > 0 ? (
        <div className={`wb-panes${split ? " split" : ""}`}>
          <Pane side="primary" isSplit={!!split} isActive={activeSide === "primary"} onActivate={setActivePane} />
          {split && <Pane side="secondary" isSplit isActive={activeSide === "secondary"} onActivate={setActivePane} />}
        </div>
      ) : (
        <Welcome onOpenPalette={openPalette} />
      )}
      {paletteOpen && <CommandPalette onClose={closePalette} />}
      {helpOpen && <ShortcutsOverlay onClose={closeHelp} />}
    </div>
  );
}
