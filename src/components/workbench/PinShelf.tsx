import { useStore } from "@/state/store";
import { objectLabel } from "@/types/ddr";
import { TypePill } from "@/components/TypePill";

/** Slim bar of pinned objects. Click opens in the primary pane (⇧-click: the
 * split pane); × unpins. */
export function PinShelf() {
  const model = useStore((s) => s.model);
  const pins = useStore((s) => s.pins);
  const togglePin = useStore((s) => s.togglePin);
  const openInPane = useStore((s) => s.openInPane);
  if (!model) return null;

  if (pins.length === 0) {
    return <div className="wb-shelf wb-shelf-empty">☆ Pin objects from a pane header to keep them here</div>;
  }
  return (
    <div className="wb-shelf">
      {pins.map((uid) => {
        const obj = model.byUid.get(uid);
        if (!obj) return null;
        return (
          <span key={uid} className="wb-pin">
            <button
              type="button"
              className="wb-pin-open"
              title={`${objectLabel(obj)} (⇧-click: split pane)`}
              onClick={(e) => openInPane(e.shiftKey ? "secondary" : "primary", uid)}
            >
              <TypePill type={obj.type} short />
              <span className="ellipsis">{objectLabel(obj)}</span>
            </button>
            <button type="button" className="wb-pin-x" title="Unpin" aria-label="Unpin" onClick={() => togglePin(uid)}>
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
