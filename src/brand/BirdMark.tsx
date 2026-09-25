import birdUrl from "@/brand/bird.svg";

/** The nuthatch wordmark bird. The artwork lives in bird.svg — the single
 * source for the header, the favicon, and the Tauri app icon (the latter two
 * generated from it by scripts/gen-icons.mjs). */
export function BirdMark() {
  return <img className="brand-bird" src={birdUrl} alt="" aria-hidden="true" />;
}
