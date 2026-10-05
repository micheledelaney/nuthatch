// Particle background: still dots, nearby dots link with fading lines, and
// dots near the pointer light up and tether to it.
(() => {
  const canvas = document.getElementById("particles");
  const ctx = canvas && canvas.getContext("2d");
  if (!ctx) return;

  const css = getComputedStyle(document.documentElement);
  const BASE_RGB = hexToRgb(css.getPropertyValue("--particle").trim() || "#8b94a3");
  const ACCENT_RGB = hexToRgb(css.getPropertyValue("--accent").trim() || "#5aa9e6");

  const AREA_PER_DOT = 11000; // px² of viewport per particle
  const MAX_DOTS = 170;
  const LINK_DIST = 140;
  const HOVER_DIST = 200;
  const DOT_RADIUS = 1.6;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: -9999, y: -9999, active: false };
  let dots = [];
  let width = 0;
  let height = 0;
  let last = performance.now();
  let frame = 0;

  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgba([r, g, b], a) {
    return `rgba(${r},${g},${b},${a})`;
  }

  function makeDot() {
    return { x: Math.random() * width, y: Math.random() * height, glow: 0 };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.min(MAX_DOTS, Math.round((width * height) / AREA_PER_DOT));
    dots = dots.slice(0, target);
    while (dots.length < target) dots.push(makeDot());
  }

  function step(dt) {
    for (const d of dots) {
      const dist = Math.hypot(d.x - pointer.x, d.y - pointer.y);
      const target = pointer.active && dist < HOVER_DIST ? 1 - dist / HOVER_DIST : 0;
      d.glow += (target - d.glow) * Math.min(1, dt * 8);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;

    for (let i = 0; i < dots.length; i++) {
      const a = dots[i];
      for (let j = i + 1; j < dots.length; j++) {
        const b = dots[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK_DIST * LINK_DIST) continue;
        const fade = 1 - Math.sqrt(d2) / LINK_DIST;
        const glow = Math.max(a.glow, b.glow);
        ctx.strokeStyle = glow > 0.05 ? rgba(ACCENT_RGB, fade * (0.12 + glow * 0.5)) : rgba(BASE_RGB, fade * 0.2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    for (const d of dots) {
      if (d.glow > 0.05) {
        ctx.strokeStyle = rgba(ACCENT_RGB, d.glow * 0.45);
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
      ctx.fillStyle = d.glow > 0.05 ? rgba(ACCENT_RGB, 0.4 + d.glow * 0.6) : rgba(BASE_RGB, 0.55);
      ctx.beginPath();
      ctx.arc(d.x, d.y, DOT_RADIUS + d.glow * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick(now) {
    // Per-second step (capped) so the glow fades at the same rate on any refresh rate.
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    step(dt);
    draw();
    frame = requestAnimationFrame(tick);
  }

  function start() {
    cancelAnimationFrame(frame);
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  window.addEventListener("resize", () => {
    resize();
    if (reduceMotion) draw();
  });
  window.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = e.pointerType === "mouse";
  });
  // document "pointerleave" is unreliable; a mouseout with no destination
  // means the pointer left the window, so the lit dots don't stay stuck.
  const clearPointer = () => {
    pointer.active = false;
  };
  window.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) clearPointer();
  });
  window.addEventListener("blur", clearPointer);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(frame);
    else if (!reduceMotion) start();
  });

  resize();
  if (reduceMotion) draw();
  else start();
})();
