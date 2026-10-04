import { useStore } from "@/state/store";
import { ShortcutList } from "./Shortcuts";

/** Empty state for Browse: the shortcut list. */
export function Welcome() {
  const model = useStore((s) => s.model);
  if (!model) return null;

  return (
    <div className="wb-welcome">
      <div className="wb-welcome-cols">
        <section>
          <h4 className="head">Shortcuts</h4>
          <ShortcutList />
        </section>
      </div>
    </div>
  );
}
