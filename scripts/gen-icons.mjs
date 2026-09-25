// Generates the favicon and the Tauri app-icon source from the single bird
// artwork in src/brand/bird.svg, so all three renderings of the bird (header,
// favicon, app icon) stay in sync.
//
//   node scripts/gen-icons.mjs
//
// After this, regenerate the raster app icons from the new SVG:
//   npx tauri icon src-tauri/app-icon.svg
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const svg = readFileSync(new URL("src/brand/bird.svg", root), "utf8");

// Reuse the artwork's own viewBox and inner markup verbatim. Embedding it in a
// nested <svg> with preserveAspectRatio lets the browser center and scale the
// bird into a square area without recomputing any path coordinates.
const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();

const BG = "#252a33";

// Favicon: flat rounded square so the mark reads on a browser tab.
const favicon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
  `<rect width="24" height="24" rx="5" fill="${BG}"/>` +
  `<svg x="3" y="3" width="18" height="18" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${inner}</svg>` +
  `</svg>\n`;

// App icon: 1024px with a rounded gradient backdrop; the bird fills the safe area.
const appIcon =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n` +
  `  <defs>\n` +
  `    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">\n` +
  `      <stop offset="0" stop-color="#2d333f"/>\n` +
  `      <stop offset="1" stop-color="${BG}"/>\n` +
  `    </linearGradient>\n` +
  `  </defs>\n` +
  `  <rect width="1024" height="1024" rx="180" fill="url(#bg)"/>\n` +
  `  <svg x="140" y="140" width="744" height="744" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${inner}</svg>\n` +
  `</svg>\n`;

writeFileSync(new URL("public/favicon.svg", root), favicon);
writeFileSync(new URL("src-tauri/app-icon.svg", root), appIcon);
console.log("Wrote public/favicon.svg and src-tauri/app-icon.svg from bird.svg");
