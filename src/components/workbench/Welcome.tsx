import { useStore } from "@/state/store";
import { ShortcutList } from "./Shortcuts";
import { MOD_LABEL } from "./objectInfo";

/** Empty state for Browse: the ⌘K hint and the shortcut list. */
export function Welcome({ onOpenPalette }: { onOpenPalette: () => void }) {
  const model = useStore((s) => s.model);
  if (!model) return null;

  return (
    <div className="wb-welcome">
      <button type="button" className="wb-hero" onClick={onOpenPalette}>
        <span className="wb-hero-keys">
          <kbd>{MOD_LABEL}</kbd>
          <kbd>K</kbd>
        </span>
        <span className="wb-hero-text">Jump to any object</span>
        <span className="wb-hero-sub">
          Fuzzy names plus filters like <code>type:script</code> <code>is:unreferenced</code> <code>refs&gt;20</code>
        </span>
      </button>
      <div className="wb-welcome-cols">
        <section>
          <h4>Shortcuts</h4>
          <ShortcutList />
        </section>
      </div>
    </div>
  );
}
