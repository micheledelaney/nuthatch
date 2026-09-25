/** A loading state themed to nuthatch: a dependency graph that draws and pulses
 * in the UI's object-type colors while an XML export is parsed. */

import { useState, useEffect } from "react";
import { PlaybackVideo } from "./PlaybackVideo";

function AnimatedEllipsis() {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => (d + 1) % 4);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return <span style={{ display: "inline-block", width: "1.5ch" }}>{".".repeat(dots)}</span>;
}

export function LoadingView({ note }: { note?: string }) {
  return (
    <div className="loading">
      <PlaybackVideo />
      <div className="loading-title">Parsing<AnimatedEllipsis /></div>
      <div className="subtle" style={{ maxWidth: 360, textAlign: "center" }}>
        {note ?? "Reading objects, resolving references, and building the dependency graph."}
      </div>
    </div>
  );
}