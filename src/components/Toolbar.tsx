import { useStore } from "@/state/store";
import { BirdMark } from "@/brand/BirdMark";

/** Top bar: wordmark and back-to-dashboard navigation. */
export function Toolbar() {
  const model = useStore((s) => s.model);
  const comparison = useStore((s) => s.comparison);
  const previousComparison = useStore((s) => s.previousComparison);
  const reset = useStore((s) => s.reset);
  const closeComparison = useStore((s) => s.closeComparison);
  const returnToComparison = useStore((s) => s.returnToComparison);

  return (
    <header className="toolbar">
      <h1>
        <BirdMark />
        nuthatch
      </h1>
      <div className="spacer" />

      {previousComparison && !comparison && (
        <button onClick={returnToComparison}>← Comparison</button>
      )}
      {comparison ? (
        <button onClick={closeComparison}>Dashboard</button>
      ) : (
        model && <button onClick={reset}>Dashboard</button>
      )}
    </header>
  );
}
