import { useEffect, useRef, useState } from "react";

/** Looping bird animation for the first-run hero.
 *
 * WKWebView blocks unprompted <video> playback (it shows a play-button overlay),
 * so we don't call play(). Instead we keep the video PAUSED and advance its
 * currentTime ourselves each frame — WebKit renders the current frame of a
 * paused video with no overlay and no user gesture. We only scrub FORWARD and
 * loop; the clips are baked as boomerangs, so the loop is seamless and there's
 * no expensive reverse-seek (that reverse pass was the old "buggy" stutter). */
const videoModules = import.meta.glob<{ default: string }>("@/brand/animations/*.mp4", { eager: true });
const videoUrls = Object.values(videoModules).map((m) => m.default);

export function PlaybackVideo() {
  // Pick one clip once per mount (lazy initializer), so a re-render can't swap
  // the src mid-playback or re-roll the random choice.
  const [src] = useState(() => videoUrls[Math.floor(Math.random() * videoUrls.length)]);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      // `duration` is NaN until metadata loads — the guard skips those frames.
      if (last !== null && video.duration) {
        let next = video.currentTime + (now - last) / 1000;
        if (next >= video.duration) next = 0; // wrap; boomerang makes it seamless
        video.currentTime = next;
      }
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!src) return null;

  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      style={{
        width: 400,
        height: "auto",
        marginBottom: 8,
        objectFit: "cover",
        clipPath: "inset(2px 2px 2px 2px)", // trims a stray edge line baked into the source video
      }}
    />
  );
}
