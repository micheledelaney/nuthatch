# nuthatch theme: Power

This guide describes the nuthatch UI theme as it is built on `main`: which file holds what, the rules every screen follows, and the CSS that carries them. It is written for anyone changing the UI, whether you or Claude.

**Read sections 1 to 4 before you change any UI.** They matter more than any single value. Most past mistakes came from breaking them: an area file that restyled a button, a second hover style, a grey fill on hover, an underlined link, an orange link, or a heading in a new size.

> This guide replaces the Slate Teal `THEME.md` (the "one moulded surface" theme with raised and sunk shapes). That theme is gone. Don't follow it.

---

## Contents

1. [Files and load order](#1-files-and-load-order)
2. [Ground rules](#2-ground-rules)
3. [Tokens](#3-tokens)
4. [Kinds and states](#4-kinds-and-states)
5. [Type](#5-type)
6. [Layout, sizes and alignment](#6-layout-sizes-and-alignment)
7. [Status: broken, unused, external, unreferenced](#7-status-broken-unused-external-unreferenced)
8. [Screens and areas](#8-screens-and-areas)
9. [Code and syntax](#9-code-and-syntax)
10. [Graphs](#10-graphs)
11. [Motion](#11-motion)
12. [Accessibility](#12-accessibility)
13. [Recipes](#13-recipes)
14. [Don'ts](#14-donts)
15. [Checklist](#15-checklist)

---

## 1. Files and load order

All styling is plain CSS, imported once in `src/main.tsx` in this order. Later files win at equal specificity, so the order is part of the design.

```ts
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-sans-condensed/700.css";
import "@/styles/nuthatch-power.css";   // 1. Power: palette, reset, nh-* components
import "@/styles/app/tokens.css";       // 2. the app's tokens (override Power's values)
import "@/styles/app/base.css";         // 3. element defaults, fields, checkbox
import "@/styles/app/kinds.css";        // 4. every element kind + the one set of states
import "@/styles/app/shell.css";        // 5+. area files: place and size only
import "@/styles/app/navigator.css";
import "@/styles/app/object-page.css";
import "@/styles/app/workbench.css";
import "@/styles/app/code.css";
import "@/styles/app/layout-detail.css";
import "@/styles/app/graphs.css";
import "@/styles/app/report-card.css";
import "@/styles/app/dashboard.css";
import "@/styles/app/comparison.css";
import "@/styles/app/motion.css";       // last: keyframes + reduced motion
```

| File | Holds | May it set colours, borders or states? |
|---|---|---|
| `nuthatch-power.css` | The Power theme as delivered: tokens, reset, `nh-*` component classes. **Keep it verbatim.** | It's the source. Override it in `tokens.css` or the area files, never edit it. |
| `app/tokens.css` | Every value the app uses: colours, sizes, fonts, graph line colours. | Yes. This is the only place a raw colour belongs. |
| `app/base.css` | `body`, text selection, text/search fields, `select`, the checkbox, `.fchevron`, `.ellipsis`. | Yes, for elements. |
| `app/kinds.css` | The element kinds (`.btn`, `.row`, `.chip`…) and the **only** state rules (hover, active, tones, focus). | Yes. This is the only place states are defined. |
| `app/shell.css` | Toolbar, workspace grid, sidebar resizer, view tabs, menus, dialogs, banner, loading screen. | Place and size only. |
| `app/navigator.css` | Type rail, navigator list, its search, filter popover and chips. | Place and size only. |
| `app/object-page.css` | History bar, crumbs, object header, name row, flags, tabs, sections, At a glance, reference lists, call chain. | Place and size only. |
| `app/workbench.css` | Pin shelf, ⌘K search button, split panes, command palette, shortcuts, welcome. | Place and size only. |
| `app/code.css` | Script steps, calculations, syntax colours, code boxes. | Syntax colours, from tokens. |
| `app/layout-detail.css` | Layout map, parts, layout objects, script triggers. | Place and size only. |
| `app/graphs.css` | The ERD tab and the relationship graph. | Graph strokes, from tokens. |
| `app/report-card.css` | The Report Card (it un-boxes Power's `nh-card`, `nh-issue`, `nh-tile`). | Place and size only. |
| `app/dashboard.css` | Projects screen: projects, analysis rows, health tiles, compare bar. | Place and size only. |
| `app/comparison.css` | Comparison view: file cards, By type table, change lists, diffs. | Change tones, from tokens. |
| `app/motion.css` | `@keyframes spring-in` and the reduced-motion switch. | n/a |

The one exception to "one place": `nuthatch-power.css` has its own `prefers-reduced-motion` rule and `:focus-visible` ring, and the app relies on both.

---

## 2. Ground rules

1. **Use the tokens.** Never hard-code a hex, `rgba()`, radius or font size in a component or an area file when a token exists. If you need a value that doesn't exist, add a token to `tokens.css`. (A few one-off values live in area files today, such as the modal scrim; don't add more.)
2. **Every clickable thing is a kind.** A button is `.btn`, `.btn-primary`, `.icon-btn`, `.glyph-btn` or `.link-btn`; a list item is `.row`; a toggle is `.chip`; and so on (section 4). Don't invent a new button style for one screen.
3. **Area files place and size; they never restyle a kind or its states.** An area file may set margin, padding, width, gap, grid and position. It may not give `.btn` a new border, give `.row` a new hover, or give `.tab.active` a new colour.
4. **One set of states, everywhere.** Hover is one brightness lift. Selected is `.active`: grey fill, orange text, weight 600 (rows: orange text only). There is no press effect. There is no second hover style anywhere, including graphs and the Report Card.
5. **The state class is always `.active`.** Not `selected`, `on`, `current`, `clicked` or `is-active`. (The one deliberate exception: the current crumb is `.current`, because it isn't selectable.)
6. **Consistency beats the mockup.** One look per element kind across the whole app, even where Power's reference page draws it differently. If a screen needs something the kinds don't cover, raise it before building a one-off.
7. **Links take the colour of the text around them.** No orange links, no underline, ever, including on hover. The hover lift marks them.
8. **FileMaker names are data.** Show object, file and project names in their real case. Never `text-transform: uppercase` a name.
9. **Dark only.** Power has no light mode. Don't add a theme toggle or light tokens without a decision to do so.
10. **One radius.** `--radius` (6px) for everything that isn't a round icon button or a dot.
11. **No shadows, no gradients, no glows** (except the relationship graph's clicked-box accent glow, section 10). Edges are 1px lines from the line tokens.
12. **Fit split panes.** The object page must work in one of two side-by-side panes at a 1240px window (about 327px per pane). Power's reference sizes assume one wide pane; check both.

---

## 3. Tokens

`nuthatch-power.css` defines the `--nh-*` palette. `tokens.css` then **overrides** many of those values and maps the app's own names (`--bg`, `--text`, `--accent`, `--type-*`…) onto them. Components use the app names; `--nh-*` names appear only where no app name exists.

> The header of `nuthatch-power.css` still says "Indigo night ground". That's Power as delivered. The app replaced the indigo with neutral greys in `tokens.css`. The values below are the ones in effect.

### 3.1 Surfaces and lines

| Token | Value | Use |
|---|---|---|
| `--nh-bg` → `--bg`, `--bg-panel` | `#1b1c1e` | The ground: page, panes, headers, wells. |
| `--nh-deep` | = `--nh-bg` | Power's darker layer is the ground too: inputs, type-tag fill, cards on the Report Card. |
| `--header-bg` | = `--nh-bg` | Toolbar and view-tab header: the same as the ground. |
| `--code-bg` | `#131415` | Script steps and calculations: one step darker than the ground. |
| `--nh-pane` | `#232830` | Popovers, menus, dialogs, palette (so the hover fill shows inside them). |
| `--nh-pane-2` → `--bg-elevated`, `--selected-soft` | `#2d333f` | The "active" fill on buttons, chips and tabs. |
| `--nh-line` → `--border` | `#272b33` | Dividers, hairlines, card outlines, the tab-strip baseline. |
| `--nh-line-2` | `#575e6a` | Control outlines: `.btn`, `.chip`, `.tag`, fields, checkboxes, popover edges. |

```css
:root {
  --nh-bg: #1b1c1e;
  --code-bg: #131415;
  --nh-deep: var(--nh-bg);
  --header-bg: var(--nh-bg);
  --nh-pane: #232830;
  --nh-pane-2: #2d333f;
  --nh-line: #272b33;
  --nh-line-2: #575e6a;
}
```

### 3.2 Text

| Token | Value | Use |
|---|---|---|
| `--nh-ink` | `#d2d4d8` | Brightest text. Barely used: Power's headings colour, kept for completeness. |
| `--nh-ink-soft` → `--text` | `#b4b7bc` | **Main text.** Rows, body, names, values. (Your choice: dimmer than Power's off-white.) |
| `--nh-ink-muted` → `--text-muted` | `#a9b0bd` | Secondary text, select chevron, operators in code. |
| `--nh-ink-dim` → `--text-dim` | `#8b94a3` | Labels (`.head`), counts, hints, `dt` cells, comments, unreferenced rows. |
| `--nh-on-accent` | = `--nh-bg` | Text on solid orange (primary button, checked checkbox). |

### 3.3 The accent and status colours

Orange is the only accent. Red, yellow, green and blue mean status, never decoration.

| Token | Value | Means |
|---|---|---|
| `--nh-accent` → `--accent` | `#f28a45` | Primary button, active tab underline, selected text, focus ring, checked checkbox, text selection tint. |
| `--nh-accent-2` | `#f6b58b` | Light orange (Power's hover for primary). Rarely needed: hover is the lift. |
| `--nh-accent-deep` → `--accent-dim` | `#3a2418` | Orange-on-dark tile (notice icon). |
| `--nh-danger` → `--high` | `#ff6b6b` | Broken. Red text, red outline, red dot. |
| `--nh-danger-soft` | `#3b2326` | Red tint behind broken steps, `tone-high` chips, the error banner. |
| `--nh-warning` → `--warn` | `#f6c453` | Needs a look: unreferenced, unused, unstored calculations. |
| `--nh-ok` → `--ok` | `#79dca4` | Good or added: marked as used, added in a comparison, record-creation cascade. |
| `--nh-info` → `--info` | `#7fb4ff` | Neutral information: changed in a comparison, sort cascade. |

### 3.4 Object-type colours

Every object type has a colour and a short code. The colour appears **only** in type tags (`.type-pill`), rail glyphs, ERD table-occurrence outlines and the `TO` half of a `TO::Field` in code. Nowhere else.

The colour reaches the element as `--tc`, set inline by `TypePill` from `typeColor()` in `src/components/typeStyle.ts`. Short codes are `SHORT_LABEL` in `src/components/TypePill.tsx`.

| Type | Code | App token | Value |
|---|---|---|---|
| File | F | `--type-file` | `#cfd5df` (plain light grey: a file reads as text) |
| Table | T | `--type-table` | `#7fb4ff` |
| Field | Fld | `--type-field` | `#6fd0f0` |
| Table occurrence | TO | `--type-table-occurrence` | `#9aaeff` |
| Relationship | Rel | `--type-relationship` | `#e6ad73` |
| Layout | L | `--type-layout` | `#f2cc5c` |
| Layout object | Obj | `--type-layout-object` | `#f59a62` |
| Script | S | `--type-script` | `#79dca4` |
| Value list | VL | `--type-value-list` | `#ef93cf` |
| Custom function | CF | `--type-custom-function` | `#6fdccb` |
| Account | Acct | `--type-account` | `#f6ae63` |
| Privilege set | PS | `--type-privilege-set` | `#f59384` |
| Extended privilege | XP | `--type-extended-privilege` | `#e8928a` |
| File access | FA | `--type-file-access` | `#d6a8a8` |
| External data source | EDS | `--type-data-source` | `#8fa8ff` |
| Custom menu set | CMS | `--type-menu-set` | `#a7b0c6` |
| Custom menu | CM | `--type-menu` | `#b8bfd0` |
| Custom menu item | CMI | `--type-menu-item` | `#cdd2de` |
| Theme | Thm | `--type-theme` | `#dcbd6a` |
| Global variable | $$ | `--type-global-variable` | `#c7e88f` |
| Script separator | Sep | `--type-separator` | 45% script green + 55% dim ink |

Type colours are never used at full strength. Tags tone them toward the ground, and rail tiles even out their lightness with `oklch`, so no type shouts louder than another:

```css
:root {
  --tag-text: 78%;    /* tag lettering: the type colour, 78% of the way from the ground */
  --tag-border: 40%;  /* tag outline: 40% */
}
.rail-glyph {
  --tc-even: oklch(from var(--tc) 0.74 c h);  /* one shared lightness */
}
.type-pill.filled,
.rail-entry.active .rail-glyph {
  --tc-fill: oklch(from var(--tc) 0.66 c h);  /* fill a little below the text lightness */
}
```

### 3.5 Syntax colours

| Token | Value | Colours |
|---|---|---|
| `--syn-string` | `#a5c0b6` | `"strings"`, names quoted in step text (`“Layout”`) |
| `--syn-var` | `#d9bf72` | `$variables`, `$$globals` |
| `--syn-func` | `#6fdccb` | `Functions ()` |
| `--syn-kw` | `#7fb4ff` | Keywords; control-flow step names (If, Loop…) |
| `--syn-num` | `#e6ad73` | Numbers |
| `--syn-op` | = `--nh-ink-muted` | Operators |
| `--syn-const` | `#c3a6ff` | `True` / `False`, `¶`, the constant in `Get ( … )`, a step option's `On` / `Off` |
| `--syn-label` | = `--nh-ink-muted` | A step option's label (`Parameter:`, `With dialog:`) |
| `--syn-change` | `#ff9e57` | Step names that change records (bold) |
| `--sw-group-mix` | `60%` | How much hue the other step groups keep, mixed with the text colour (8.4:1 or more, above comments' 6:1) |
| `--nh-syn-exit` | `#f08fb0` | Halt / Exit step names |

Keywords are the logical operators (`and`, `or`, `xor`, `not`) and the functions that steer a calculation (`If`, `Case`, `Let`, `While`, `Choose`). Names with spaces (`Due Date`, `TO::Field Name`) never take in a logical operator next to them: FileMaker writes a name that contains one as `${…}`.

### 3.6 Sizes

These are the shared sizes of the kinds. Change them here, never per screen.

```css
:root {
  --radius: 6px;

  /* Rows: 24px tall (16px line + 4px padding), no gap between rows. */
  --row-pad-y: 4px;
  --row-pad-x: 12px;
  --row-font: 13px;
  --row-line: 16px;
  --row-radius: var(--radius);

  /* Chips, tags and type tags: 16px tall, so they sit in a row without stretching it. */
  --chip-pad: 0 8px;
  --chip-font: 10.5px;
  --chip-line: 14px;

  /* Small-caps labels (.head). */
  --label-font: 11.5px;
  --label-tracking: 0.16em;

  /* Buttons: every text button is as tall as an icon button. */
  --btn-pad: 0 16px;
  --btn-font: 13px;
  --icon-btn: 26px;
  --icon-glyph: 16px;

  /* Key/value tables (At a glance, Metadata, Definition) share one label column. */
  --kv-label-w: 152px;

  /* Hover: every clickable thing gets this much lighter. */
  --hover-lift: 1.25;

  /* Shell. */
  --rail-w: 76px;
  --sidebar-w: 320px;
  --bar-h: 46px;     /* navigator header = pin bar */
  --subbar-h: 40px;  /* navigator file row = breadcrumb bar */
}
```

### 3.7 Fonts

Power is monospace everywhere. The condensed face exists, but the app uses it only for the loading title.

```css
:root {
  --nh-font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --nh-font-display: "IBM Plex Sans Condensed", "Arial Narrow", sans-serif;

  --font-ui: var(--nh-font-mono);
  --font-mono: var(--nh-font-mono);
  --font-sans: var(--nh-font-mono);
}
```

Fonts are bundled with `@fontsource` (the app runs offline in Tauri), so there's no Google Fonts link. The landing page (`docs/`) self-hosts the same faces in `docs/fonts/`.

---

## 4. Kinds and states

`app/kinds.css` defines every element kind and the one set of states they share. Everything clickable in the app is one of these.

| Kind | What it is | Typical markup |
|---|---|---|
| `.btn` | Text button: outlined pill | `<button className="btn">Remove mark</button>` |
| `.btn.btn-primary` | The solid orange button. At most one per screen. | `<button className="btn btn-primary">Save</button>` |
| `.icon-btn` | Round icon button, no fill or outline | `<button className="icon-btn" aria-label="Show in graph"><GraphIcon/></button>` |
| `.glyph-btn` | A bare glyph inside another control (×, chevron) | `<button className="glyph-btn" aria-label="Unpin">×</button>` |
| `.link-btn` / `.obj-link` | Text-only link | `<button className="link-btn">Show 12 more</button>` |
| `.tabs > .tab` | Underline tab strip | `<div className="tabs" role="tablist"><button className="tab active">Details</button>…</div>` |
| `.tab` (alone) | A crumb or a rail entry: tab behaviour, no underline | |
| `.chip` | Small toggle pill (filters) | `<button className="chip active">Broken <span className="chip-count">3</span></button>` |
| `.tag` | The same pill, static (flags, status) | `<span className="tag tone-high">Broken</span>` |
| `.type-pill` | An object type's code, in its colour | `<TypePill type="script" short />` |
| `.row` | List item | `<div className="row active" {...pressable(open)}>…</div>` |
| `.card` | A clickable block | |
| `.popover` | Menu, filter popover, palette or dialog surface | |
| `.head` | Small-caps label; `.head.clickable` toggles a section | `<div className="head clickable" {...pressable(toggle, { expanded })}>Calculation</div>` |

### 4.1 The kinds' CSS

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: var(--icon-btn);            /* as tall as an icon button */
  padding: var(--btn-pad);
  border: 1px solid var(--nh-line-2);
  border-radius: var(--nh-radius-pill);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--btn-font);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
.btn-primary {
  background: var(--nh-accent);
  border-color: var(--nh-accent);
  color: var(--nh-on-accent);
  font-weight: 600;
}

.icon-btn {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: var(--icon-btn);
  height: var(--icon-btn);
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--text);
  font-size: var(--icon-glyph);
  line-height: 1;
  cursor: pointer;
  will-change: filter;                /* keeps the icon from shifting half a pixel on hover */
}
.icon-btn svg { width: 16px; height: 16px; }

.glyph-btn {
  flex: none;
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 3px;
  border: 0;
  border-radius: var(--nh-radius-pill);
  background: none;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

/* Links take the colour of the text around them: navigation, not syntax. */
.link-btn,
.obj-link {
  display: inline;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  max-width: 100%;
  overflow-x: auto;                   /* a narrow pane scrolls the strip, it never wraps */
  scrollbar-width: none;
}
.tab {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 6px;
  padding: 4px 12px;
  border: 0;
  border-radius: var(--nh-radius-pill);
  background: none;
  color: var(--nh-ink-soft);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.chip,
.tag {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 6px;
  padding: var(--chip-pad);
  border: 1px solid var(--nh-line-2);
  border-radius: var(--nh-radius-pill);
  background: none;
  color: var(--text);
  font-size: var(--chip-font);
  line-height: var(--chip-line);
  white-space: nowrap;
}
.chip { cursor: pointer; }
.chip-count { color: var(--text-dim); font-variant-numeric: tabular-nums; }

.type-pill {
  flex: none;
  display: inline-grid;
  place-items: center;
  height: 16px;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--tc, var(--text-muted)) var(--tag-border), var(--nh-bg));
  border-radius: var(--radius);
  background: var(--nh-deep);
  color: color-mix(in srgb, var(--tc, var(--text-muted)) var(--tag-text), var(--nh-bg));
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.type-pill.short { min-width: 36px; }   /* short codes share a width, so names after them line up */
.type-pill.filled {                     /* pins and the current crumb */
  --tc-fill: oklch(from var(--tc, var(--text-muted)) 0.66 c h);
  background: var(--tc-fill);
  border-color: var(--tc-fill);
  color: var(--nh-deep);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: var(--row-pad-y) var(--row-pad-x);
  border: 0;
  border-radius: var(--row-radius);
  background: none;
  color: var(--text);
  font-size: var(--row-font);
  line-height: var(--row-line);
  text-align: left;
  cursor: pointer;
}

.card {
  border: 1px solid var(--border);
  border-radius: var(--nh-radius-soft);
  background: var(--nh-deep);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

/* The card colour, so a hovered row's lift shows against it. */
.popover {
  background: var(--nh-pane);
  border: 1px solid var(--nh-line-2);
  border-radius: var(--nh-radius-window);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--row-radius);
  color: var(--text-dim);
  font-size: var(--label-font);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: var(--label-tracking);
  user-select: none;
}
.head.clickable { cursor: pointer; }
```

### 4.2 The states (the only state rules in the app)

```css
/* :where() keeps these at single-class weight, so a tone or a status rule
   (a broken row's red) still wins. */

/* Hover: one step lighter. The lift lightens whatever the item is drawn in
   (text, orange, outlines, type tags) by the same step. No fill, no line. */
:where(.btn, .icon-btn, .glyph-btn, .link-btn, .obj-link, .tab, .chip, .row, .card,
       .head.clickable, .type-pill, select, input[type="checkbox"]) {
  transition: filter var(--nh-dur) var(--nh-ease);
}
:where(.btn, .icon-btn, .glyph-btn, .link-btn, .obj-link, .tab, .chip, .row, .card,
       .head.clickable, select, input[type="checkbox"]):where(:not(.inert)):hover,
:where(.icon-btn, .chip).open {
  filter: brightness(var(--hover-lift));
}

/* A type tag just before a link belongs to it, and lightens with it. */
.type-pill:has(+ :where(.obj-link, .link-btn):hover) {
  filter: brightness(var(--hover-lift));
}

/* A clickable inside a clickable: only the inner one lightens. */
:where(.btn, .chip, .row, .card):has(:where(.btn, .icon-btn, .glyph-btn, .link-btn,
       .obj-link, .chip, .row, .card):hover) {
  filter: none;
}

/* Selected / on: grey fill, orange text, 600. */
:where(.btn, .icon-btn, .glyph-btn, .tab, .chip, .row, .card).active {
  background: var(--nh-pane-2);
  color: var(--accent);
  font-weight: 600;
}
.row.active { background: none; }           /* a selected row is marked by its orange name only */
.icon-btn.active { background: none; }      /* an "on" icon button draws its icon filled instead */

/* Tab strip: the active tab gets an orange underline on the strip's baseline. */
.tabs > .tab {
  padding: 8px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
}
.tabs > .tab.active {
  background: none;
  border-bottom-color: var(--accent);
}
.tabs > .tab.active:hover { filter: none; } /* already selected: doesn't react */

/* Focus: Power's orange ring (2px, offset 3px); drawn inside for clipped items. */
:where(.row, .head.clickable, .card, .tab):focus-visible { outline-offset: -2px; }

/* A row that can't be opened (broken, external, the chain's own root). */
.inert { cursor: default; }

/* Tones: an active chip and a static tag of the same tone look the same. */
:where(.chip.active, .tag).tone-high {
  background: var(--nh-danger-soft);
  border-color: var(--high);
  color: var(--high);
}
:where(.chip.active, .tag).tone-warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  border-color: var(--warn);
  color: var(--warn);
}
:where(.tag).tone-ok {
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  border-color: var(--ok);
  color: var(--ok);
}

/* A filter with no matches: dimmed like a disabled control, still clickable. */
:where(.chip).empty { opacity: 0.35; }
```

**Disabled** comes from Power: `[disabled], .is-disabled { opacity: .35; pointer-events: none; }`.

**What the states deliberately leave out:**

- No grey fill on hover. You tried it and rejected it; the lift replaced it.
- No underline on hover, and no sliding arrow.
- No press effect (Power's `scale(.97)` is not used).
- No red on destructive menu items.
- Selected rows have no fill, only the orange name.

### 4.3 Where the lift reaches beyond the kinds

These aren't kinds, but they use the same `--hover-lift` and nothing else: ERD table boxes and fields, relationship-graph nodes, the Report Card's main issue and its figure buttons, and checkboxes and selects. The only other hover in the app is the sidebar resizer's accent line, because it's a drag handle.

---

## 5. Type

Everything is IBM Plex Mono. Weight and size carry the hierarchy, not a second face.

| Role | Size / line | Weight | Colour | Where |
|---|---|---|---|---|
| Body | 14px / 1.57 | 400 | `--text` | `body` default |
| Object name, page title | 18px / 24px | 600 | `--text` | `.op-glance-name`, `.dashboard-header h2` |
| Report Card main number | 56px / 1 | 400 | severity colour | `.nh-issue__num` |
| Figures | 22px / 28px (Report Card 26px / 32px) | 600 | `--text` or severity | `.metric-value`, `.file-summary-num`, `.nh-tile__value` |
| Report Card main sentence | 16px / 24px | 600 | `--text` | `.nh-issue__what` |
| Rows, tabs, buttons | 13px | 400 / 500 | `--text` | `.row`, `.tab`, `.btn` |
| Code and script steps | 13px / 26px | 400 | syntax | `.sw`, `pre.code` |
| Section titles | 12.5px | 400, caps, 0.16em | `--text-dim` | `.detail-widget-header`, `.report-card .head` |
| Hints, details | 12.5px / 20px or 12px / 18px | 400 | `--text-dim` | `.nh-issue__detail`, `.nh-tile__hint` |
| Small-caps labels | 11.5px | 400, caps, 0.16em | `--text-dim` | `.head` |
| Tab counts | 11.5px | 400, 65% opacity | inherit | `.op-tab-count` |
| Chips, tags | 10.5px / 14px | 400 | `--text` or tone | `.chip`, `.tag` |
| Type tags | 10px | 600 | type colour, toned | `.type-pill` |
| Loading title | 20px | 700, condensed | `--text` | `.loading-title`, the only use of `--nh-font-display` |

Rules:

- **Uppercase is for labels only** (`.head`, eyebrows). Never for names, titles of FileMaker objects, or sentences.
- **Sentence case** for every heading and button label ("Mark as used…", "Show all types").
- Numbers that line up use `font-variant-numeric: tabular-nums`.
- Display headings are unified. Don't introduce a 20px, 24px or 30px title; use 18px / 600.

---

## 6. Layout, sizes and alignment

### 6.1 The shell

```
┌ toolbar ─ wordmark ─────────────────────────────── actions ┐  fixed height, 8px 32px padding
├ main-header ─ Report Card · Browse · ERD ──── analysis name ┤  .tabs; baseline = border
├ rail ┬ navigator ──────┬ pin bar (--bar-h) ─────────── ⌘K ──┤
│ 76px │ head (--bar-h)  │ crumbs / history (--subbar-h)       │
│      │ file row        │ object page                         │
│      │ (--subbar-h)    │                                     │
│      │ rows…           │                                     │
└──────┴─────────────────┴─────────────────────────────────────┘
```

- The navigator header and the pin bar are both `--bar-h` tall, and the navigator's file row and the pane's breadcrumb bar are both `--subbar-h`, so their bottom lines run straight across.
- The sidebar is resizable (`--sidebar-w` is the default); the resizer is a 4px accent line that fades in after a short hover delay.
- Projects and Comparison have no navigable model, so they drop the sidebar and span the full width. **Don't cap their width.**

### 6.2 Left edges that line up

- **Page-level screens** (Report Card, relationship graph) hang from the first view tab's label: `padding-left: calc(32px + 14px)` (header padding + tab padding).
- **The object name** starts level with the first object tab's label: `.op-glance-head { padding-left: 14px; }`.
- **Inside a section**, content starts where the section title's text starts, past its chevron: `--section-title-indent: 15px`. Lists pull back by `--row-pad-x` because rows carry their own padding. Code boxes and script steps start at the section's edge, with their text at the title text.

```css
.detail-widget { margin: 24px 0; --section-title-indent: 15px; }
.detail-widget-header { padding: 3px 0; font-size: 12.5px; }
.detail-widget-body { margin-top: 10px; }
.detail-widget-body:not(.flush) { padding-left: var(--section-title-indent); }
.detail-widget-body .ref-list { margin-left: calc(-1 * var(--row-pad-x)); }
.detail-widget-body:not(.flush) > .code-box { margin-left: calc(-1 * var(--section-title-indent)); }
```

### 6.3 Heights

| Element | Height |
|---|---|
| Row | 24px (4 + 16 + 4), no gap between rows |
| Chip, tag, type tag | 16px |
| Text button, icon button | 26px |
| Glyph button, pin | 24px |
| Checkbox | 20px |
| Rail tile | 34 × 26px |

Keep rows 24px everywhere: navigator, reference lists, call chain, palette results, menus, comparison rows, layout objects, pins.

---

## 7. Status: broken, unused, external, unreferenced

Status has one look per meaning, and every indicator of a status (dot, tag, list filter, Report Card count) must come from the same source and agree for every object, including when a file is loaded alone.

| Status | Row in a list | Flag / tag | Elsewhere |
|---|---|---|---|
| **Broken** | Red dot (`--high`), rail tile gets a red dot | `.tag.tone-high` "Broken" | Broken script step: red tint + 3px red bar. Broken value: `.broken-value` red. Placeholder in code (`<Field Missing>`): `.syn-missing` red 600. |
| **Unreferenced** | Dim ink (`.unref`); orange once selected | `.tag.tone-warn` | Report Card figure in `--warn`. |
| **Unused** (used only by unreferenced objects) | Dim ink | `.tag.tone-warn` "Unused" | Call chain: dimmed. |
| **External** (target in a file that isn't loaded) | Dimmed, `.inert` | `.tag` "External" (no tone) | Not an error: never red. |
| **Unmatched** (a field name from calculation text that its loaded file doesn't have) | Dimmed, `.inert` | `.tag` "Unmatched" (no tone) | Not counted as broken: the name is read from text. |
| **Disabled** (a Used by row whose every reference is in a disabled step) | Normal | `.tag` "Disabled" (no tone) | Call chain: a call in a disabled step gets "Disabled". |
| **Marked as used** | Normal | `.tag.tone-ok` | Report Card "Marked as used" figure. |

An object's own name stays in plain ink where it heads things (page title, navigator, breadcrumbs, pins), even when it reads `<Field Missing>`. Anywhere else the name is listed (a portal's Contents, a layout's object tree, At a glance), its `<… Missing>` parts are `.broken-value` red. In the relationship graph a broken occurrence's box has a red outline and a red name.

```tsx
// RefStatusChip: the status tag right after a reference's name.
<span className="tag ref-external-tag tone-high">Broken</span>
<span className="tag ref-external-tag tone-warn">Unused</span>
<span className="tag ref-external-tag">External</span>
<span className="tag ref-external-tag">Unmatched</span>
<span className="tag ref-external-tag">Disabled</span>
```

```css
/* The red dot on a rail tile, same red as a row's dot. */
.rail-broken-dot {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--high);
  box-shadow: 0 0 0 2px var(--bg-panel);
}

/* A broken script step: --nh-danger-soft's shade, see-through for find tints. */
.sw-line.hit {
  background: color-mix(in srgb, var(--nh-danger) 17%, transparent);
  box-shadow: inset 3px 0 0 var(--high);
  border-radius: var(--radius);
}
```

Disabled FileMaker options (a lookup, auto-enter or validation that's switched off) count for nothing, even when they point at something deleted. Don't flag them.

---

## 8. Screens and areas

### 8.1 Toolbar and view tabs (`shell.css`)

- The toolbar has a fixed height so it doesn't jump between screens, and `--header-bg` (the ground).
- The wordmark is the bird in its own colours, then "nuthatch" in lowercase, normal spacing.
- View tabs (Report Card, Browse, ERD) are a `.tabs` strip in `.main-header`; the header draws the baseline, and the open analysis's name sits on the right.

### 8.2 Menus, popovers, dialogs

All four are `.popover` surfaces: `--nh-pane` fill, `--nh-line-2` outline, `--radius` corners, no shadow. Menu items are `.row`. Dialogs sit on a 70% dark scrim, spring open (`spring-in`, section 11), trap focus with `useModalFocus`, and are labelled with `aria-labelledby`.

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 17, 21, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  padding: 22px 24px;
  width: min(440px, 90vw);
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: spring-in 0.22s var(--ease-spring);
}
```

Dialog fields use `.head.field-label` labels and the base text field; one primary button.

### 8.3 Fields, selects, checkbox (`base.css`)

```css
input[type="search"],
input[type="text"],
select {
  font: inherit;
  color: var(--text);
  background: var(--nh-deep);
  border: 1px solid var(--nh-line-2);
  border-radius: var(--nh-radius-pill);
  padding: 8px 18px;
  width: 100%;
}
/* A focused field turns its border orange: no second ring on top. */
input[type="search"]:focus, input[type="text"]:focus, select:focus, textarea:focus {
  border-color: var(--accent);
}
input[type="search"]:focus-visible, input[type="text"]:focus-visible,
select:focus-visible, textarea:focus-visible { outline: none; }

/* The one checkbox: sunk square, solid orange with a dark tick when checked. */
input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 20px;
  height: 20px;
  margin: 0;
  border-radius: var(--radius);
  background: var(--nh-deep) center / 12px 12px no-repeat;
  border: 1px solid var(--nh-line-2);
  cursor: pointer;
}
input[type="checkbox"]:checked {
  background-color: var(--accent);
  border-color: var(--accent);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.5 6.2 5 8.6l4.6-5' fill='none' stroke='%231b1c1e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/></svg>");
}
```

Text selection is tinted orange, and the text keeps its own colour so syntax stays readable:

```css
::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
```

### 8.4 Type rail (`navigator.css`)

Icons only; the type name is the tooltip and `aria-label`. Each entry is a `.tab`; its glyph is a tile outlined in the type colour, filled with it when selected. The selected entry has no background.

```css
.type-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 6px;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}
.rail-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  border: 1px solid transparent;
  border-radius: var(--radius);
}
.rail-glyph {
  --tc-even: oklch(from var(--tc) 0.74 c h);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 26px;
  padding: 0 4px;
  border: 1px solid;
  border-radius: var(--nh-radius-tile);
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: var(--tc-even);
  font-size: 10.5px;
  font-weight: 600;
}
.rail-entry:not(.active) .rail-glyph { opacity: 0.78; }
.rail-entry.active { background: none; }
.rail-entry.active .rail-glyph {
  --tc-fill: oklch(from var(--tc) 0.66 c h);
  background: var(--tc-fill);
  border-color: var(--tc-fill);
  -webkit-text-fill-color: var(--nh-deep);
  font-weight: 700;
}
```

### 8.5 Navigator (`navigator.css`)

- **Pane head** (`--bar-h`): the type's title and count, the round search button (it grows into a field when clicked or holding a query), and the round filter button. The title truncates before the count does.
- **File row** (`--subbar-h`): a full-width `.row`, level with the breadcrumb bar.
- **Group and folder headers** are `.head.clickable`, on one line: name with `…`, then ` · N` that never truncates.
- **One floating header** pinned to the top of the list shows the file and group you're scrolled in (instead of per-section sticky headers).
- **Object rows** are `.row`; indent is set inline per depth. The selected one is `.active` (orange name) and the list scrolls to `.node.active`.
- **Filter popover** is a `.popover` anchored to the navigator's controls, with `.chip` filters grouped under `.head` labels. A filter with no matches is `.chip.empty`.

### 8.6 Pins and crumbs (`workbench.css`, `object-page.css`)

- **A pin** is a `.row` with no outline: its type tag **filled** (`<TypePill filled />`), the name, a dim `.glyph-btn` ×.
- **Crumbs** are `.tab`. The current crumb is `.current`: no background, no orange; only its type tag is filled. It goes nowhere.
- **History bar:** round back/forward `.icon-btn`s, the crumbs, then the pane's round actions at the right.
- **With two panes**, the pane that ⌘[ / ⌘] act on is marked.

### 8.7 Object page (`object-page.css`)

```
┌ op-header ───────────────────────────────────────────────┐
│  Name (18px/600, real case)  [Broken] [Unused]   (◎) [Mark as used…]
│  ───────────────────────────────────────────────────────── │
│  Details   Used by 12   Uses 4   Calls                    │  .tabs, orange underline
└───────────────────────────────────────────────────────────┘
   ▸ AT A GLANCE                                               .head.clickable
     Type          [S] Script                                  .op-glance-kv
     Folder        Utilities
   ▸ SCRIPT STEPS
     ┌ 1  Set Variable [ $x ; Value: 1 ] ──────────────────┐  .sw
```

```css
.op-header {
  flex: none;
  padding: 24px 28px 0;
  background: var(--bg-panel);
}
.op-glance-head {                    /* name row: name, flags, actions at the far right */
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding-left: 14px;                /* level with the first tab's label */
}
.op-glance-name {
  margin: 0;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text);
  word-break: break-word;            /* no uppercase: names are FileMaker data */
}
.op-facts { display: flex; flex-wrap: wrap; gap: 8px; }   /* flags: .tag.op-fact + tone */
.op-glance-actions {                 /* round graph icon + "Mark as used…" / "Remove mark" */
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex: none;
}
.op-tabs {
  max-width: none;
  margin: 16px -28px 0;
  padding: 8px 28px 0;
  box-shadow: inset 0 -1px 0 var(--border);   /* the strip's baseline; also stops content seeming to slide under */
}
.op-tab-count { font-size: 11.5px; opacity: 0.65; font-variant-numeric: tabular-nums; }
.op-body { padding: 0 28px 36px; }
.op-tab-panel { margin: 22px 0; max-width: 900px; }

/* At a glance and Metadata share one label column. */
.op-glance-kv {
  display: grid;
  grid-template-columns: var(--kv-label-w) minmax(0, 1fr);
  gap: 2px 16px;
  margin: 8px 0;
}
.op-glance-row { display: contents; }
.op-glance-kv dt { color: var(--text-dim); }
.op-glance-kv dd { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; }
```

Content decisions on this page:

- Tabs are **Details · Used by · Uses · Calls**, short so both fit in a split pane.
- "At a glance" is a collapsible section inside Details, not a pinned card in the header.
- Sections (`.detail-widget`) have **no box**: a spaced-caps title with a chevron, then spacing.
- "Show in graph" is a round `.icon-btn` with a tooltip, not a text button.
- Reference lists group by type (`.ref-group` with a `.head` label), items are `.row`, and long lists end in a `.link-btn` "Show N more".
- In Used by, a layout object's row starts with its layout: the layout's type tag and its name as an `.obj-link` (it opens the layout), a dim `›` (`.ref-sep`), then the object's own type tag and name (the rest of the row opens the object).

### 8.8 Report Card (`report-card.css`)

Laid out like the Browse details: **no boxes, no rules**, mono figures. It reuses Power's `nh-issue` / `nh-tile` markup and strips their cards.

```css
.report-card {
  overflow: auto;
  flex: 1;
  padding: 32px 32px 40px calc(32px + 14px);
  display: flex;
  flex-direction: column;
  gap: 40px;
}
.report-card .nh-card { background: none; border: 0; border-radius: 0; }
.report-card .nh-notice { padding: 0; border: 0; border-radius: 0; background: none; }

/* Main issue: the most severe flag. Count in the severity colour, sentence in plain text. */
.report-card .nh-issue { --issue-tone: var(--accent); padding: 0; gap: 18px; }
.report-card .nh-issue.tone-danger  { --issue-tone: var(--nh-danger); }
.report-card .nh-issue.tone-warning { --issue-tone: var(--nh-warning); }
.report-card .nh-issue__title { font-size: 12.5px; color: var(--issue-tone); }
.report-card .nh-issue__main {        /* label + count + sentence: one button */
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: fit-content;
  cursor: pointer;
  transition: filter var(--nh-dur) var(--nh-ease);
}
.report-card .nh-issue__main:hover { filter: brightness(var(--hover-lift)); }
.report-card .nh-issue__big { align-items: baseline; gap: 18px; }
.report-card .nh-issue__num { font-family: var(--font-mono); font-size: 56px; line-height: 1; color: var(--issue-tone); }
.report-card .nh-issue__what { font-family: var(--font-mono); font-size: 16px; line-height: 24px; font-weight: 600; text-transform: none; color: var(--text); }
.report-card .nh-issue__detail { max-width: 78ch; font-size: 12.5px; line-height: 20px; color: var(--text-dim); }

/* Health figures: a responsive grid. */
.report-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 36px 40px;
}
.report-card .nh-tile__value { font-family: var(--font-mono); font-size: 26px; line-height: 32px; }
.report-card .nh-tile__label { font-size: 13px; line-height: 20px; color: var(--text); }
.report-card .nh-tile__hint  { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--text-dim); }
.report-card .nh-tile:hover { background: none; }
.report-card button.nh-tile:hover { filter: brightness(var(--hover-lift)); }
```

Order on the page: notices, the main issue (with "Found in" type chips for broken references), then the Health figures. A figure that needs attention takes its severity colour; the risk flags themselves come from `deriveRiskFlags` as `{ kind, severity, count }` and the UI owns the wording (`RiskFlags.tsx`).

### 8.9 Projects (`dashboard.css`)

- Full width, no cap.
- Page title: 18px / 600 mono, like an object name, with a one-line intro.
- Each project is a panel outlined in the faint `--nh-line` on the page's own background (no grey header strip). Head row: chevron, name · note on one line (note truncates), "+ Add analysis" `.btn`, ☰ menu.
- Each analysis is one grid row (min 42px): checkbox, name and note, files (blank when equal to the name), date, ☰. 46px left padding puts the checkboxes under the project name. The row's ☰ appears on hover, focus-within and while open.
- Health tiles fit one row and align at the bottom so values and sparklines line up.

### 8.10 Comparison (`comparison.css`)

- Notices are inline rows with an orange mark, no box.
- File cards show counts in the change tones: added `--ok`, removed `--high`, changed `--info`.
- **By type** is a `.type-counts` table: full type tags (no name beside them), `.head` column labels, 24px rows, right-aligned counts in the change tones, fixed column widths (170px + 4 × 104px) so "Show all types" never moves them.
- Change lists have no box: a thin rule in the change's colour marks the list. Renamed shows two equal columns (old → new). Changed objects expand into line diffs.

---

## 9. Code and syntax

Code sits in a well one step darker than the ground (`--code-bg`), with `--nh-radius-soft` corners and a copy button in the top right that is discreet until hover or focus.

```css
.sw {                                 /* script steps */
  margin: 4px 0 0;
  padding: 8px 34px 8px 0;            /* right side: room for the copy button */
  background: var(--code-bg);
  border-radius: var(--nh-radius-soft);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 26px;
  color: var(--nh-ink-soft);
}
.sw-line {
  display: flex;
  gap: 4px;
  padding: 0 8px 0 calc(var(--section-title-indent, 15px) + 21px);
  border-radius: var(--radius);
  position: relative;
}
.sw-line.disabled { opacity: 0.4; }
.sw-ln {                              /* step numbers: a quiet, right-aligned margin */
  position: absolute;
  left: calc(var(--section-title-indent, 15px) - 19px);
  width: 44px;
  text-align: right;
  color: color-mix(in srgb, var(--text-dim) 50%, var(--code-bg));
  user-select: none;
  pointer-events: none;
}

/* Step names by category. Steps that change records stand out (bold, full
   colour); the other groups sit back, their hue mixed toward the text colour —
   muted but as bright as text, so nothing but a comment reads as commented out. */
.sw-name.sw-change { color: var(--syn-change); font-weight: 600; } /* Set Field, Insert …, Replace, New / Commit / Revert Record, Import */
.sw-name.sw-delete { color: var(--high); font-weight: 600; }       /* Delete …, Truncate Table */
.sw-name.sw-flow   { color: color-mix(in srgb, var(--syn-kw) var(--sw-group-mix), var(--nh-ink-soft)); }      /* If, Loop, transactions */
.sw-name.sw-nav    { color: color-mix(in srgb, var(--ok) var(--sw-group-mix), var(--nh-ink-soft)); }          /* Go to …, windows, popovers */
.sw-name.sw-call   { color: color-mix(in srgb, var(--syn-func) var(--sw-group-mix), var(--nh-ink-soft)); }    /* Perform Script / JavaScript / AppleScript, Data API, OnTimer */
.sw-name.sw-exit   { color: color-mix(in srgb, var(--nh-syn-exit) var(--sw-group-mix), var(--nh-ink-soft)); } /* Halt, Exit Script / App */
.sw-name.sw-set    { color: color-mix(in srgb, var(--syn-var) var(--sw-group-mix), var(--nh-ink-soft)); }     /* Set Variable, Copy, Set Selection */
.sw-name.sw-find   { color: color-mix(in srgb, var(--syn-const) var(--sw-group-mix), var(--nh-ink-soft)); }   /* Enter … Mode, Find, Omit, Sort, Open Record, Export */
.sw-name.sw-quiet  { color: var(--text-muted); }                   /* Set Error Capture, Allow User Abort, Beep… */

/* Syntax. */
.syn-comment { color: var(--text-dim); font-style: italic; }
.syn-string  { color: var(--syn-string); }
.syn-var     { color: var(--syn-var); }
.syn-to      { color: var(--type-table-occurrence); } /* TO half of an unlinked TO::Field */
.syn-field   { color: var(--text-dim); }          /* field half: grey, not clickable */
.syn-func    { color: var(--syn-func); }
.syn-kw      { color: var(--syn-kw); }
.syn-num     { color: var(--syn-num); }
.syn-op      { color: var(--syn-op); }
.syn-const   { color: var(--syn-const); }
.syn-label   { color: var(--syn-label); }
.syn-missing { color: var(--high); font-weight: 600; }  /* <Field Missing> etc. */

pre.code {                            /* calculations */
  background: var(--code-bg);
  border: 0;
  border-radius: var(--nh-radius-soft);
}
```

Every code block goes in a `CodeBox` (`src/components/CodeBox.tsx`), which adds the copy button:

```tsx
<CodeBox text={calc}>
  <pre className="code">
    <LinkedCode text={calc} objects={targets} onGo={onGo} model={model} owner={owner.uid} />
  </pre>
</CodeBox>
```

**Find in a script.** The Script steps header holds a find field (`.sw-find`: the navigator's `.nav-search`, always open at a fixed 200px and flush with the steps' right edge, with "3 of 12" and ↑ ↓ glyph buttons before it, which keep their room while hidden so nothing moves; typing tints every match and shows "12 matches"; the first Enter (or ↓) goes to the first match, ↑ to the last, then Enter / Shift+Enter move and the view scrolls to the current one; Esc clears). Matches are found in the text as shown and tinted with plain boxes on `.sw-find-layer`, under the steps, so links and syntax colours stay: a warning-yellow tint behind every match, stronger behind the current one. Not the CSS Custom Highlight API: Safari leaves parts of a changed highlight painted. A broken step's red is see-through (the same shade as `--nh-danger-soft` on the well) so a tint behind it shows. Long collapsed steps open while they match.

```css
.sw-find-layer             { position: absolute; inset: 0; pointer-events: none; }  /* first in .sw */
.sw-find-mark              { position: absolute; border-radius: 2px; background: color-mix(in srgb, var(--warn) 18%, transparent); }
.sw-find-mark.is-current   { background: color-mix(in srgb, var(--warn) 40%, transparent); }
```

Linked names inside code are `.obj-link`: they take the syntax colour of the token they sit in (a linked `$$global` stays a variable, a script name in quotes stays a string) and lift on hover. The text is coloured whole before the links are laid over it, so a link never splits a string or a comment. Nothing is linked inside a comment, a step option's label or a `<… Missing>` placeholder. Script triggers are shown the same way: the trigger's name and mode tags on a line, then a code box with the Perform Script step it runs, drawn like a script step: the step name in its step colour, then `[ “script” ; Parameter: … ]` through the same highlighter, so a deleted script reads `“<unknown>”` with the placeholder red. A button's step box (its Perform Script, or its single step) is drawn the same way.

---

## 10. Graphs

### 10.1 ERD tab (`graphs.css`, `RelationshipGraphView.tsx`)

- Table-occurrence boxes are flat boxes on a dotted well, no shadows. Each keeps its **FileMaker table-occurrence colour**, toned like a type tag (`boxColors()`):

  ```ts
  fill:   `color-mix(in srgb, ${c} 14%, var(--nh-deep))`,              // title bar: a faint tint
  border: `color-mix(in srgb, ${c} var(--tag-border), var(--nh-deep))`, // outline: like a tag's
  text:   `color-mix(in srgb, ${c} 92%, var(--nh-deep))`,              // the name
  ```

  An occurrence without a valid colour falls back to `--accent`.
- A hairline separates an expanded box's title bar from its field rows.
- Hover is the lift; keyboard focus is the accent outline.
- The TO detail diagram on an object page (`RelationshipERD.tsx`) uses the same lines and hover.

### 10.2 Relationship lines

Lines are solid colours, never opacity, so overlapping lines don't add up to a brighter line.

```css
:root {
  --fmg-edge:        color-mix(in srgb, var(--text) 50%, var(--nh-deep));        /* plain */
  --fmg-edge-del:    color-mix(in srgb, var(--nh-danger) 75%, var(--nh-deep));   /* cascade delete */
  --fmg-edge-create: color-mix(in srgb, var(--nh-ok) 75%, var(--nh-deep));       /* record creation */
  --fmg-edge-sort:   color-mix(in srgb, var(--nh-info) 75%, var(--nh-deep));     /* sorted */
  --fmg-edge-dim:        #4b5260;
  --fmg-edge-del-dim:    color-mix(in srgb, var(--nh-danger) 30%, var(--nh-deep));
  --fmg-edge-create-dim: color-mix(in srgb, var(--nh-ok) 30%, var(--nh-deep));
  --fmg-edge-sort-dim:   color-mix(in srgb, var(--nh-info) 30%, var(--nh-deep));
}
```

- Cascade colouring is a toggle per rule: delete red (and bold), create green, sort blue, with an ⓘ popover explaining them.
- A hovered line gets thicker and brighter but **keeps its colour**, so it never clashes with the cascade colours.
- A wide invisible hit target makes ⌘/Ctrl-click on a line forgiving.
- The clicked node gets a tinted fill and accent glow so it stands out from its highlighted siblings. Hovering doesn't dim the rest (no strobing when sweeping across boxes).

---

## 11. Motion

| Token | Value | Use |
|---|---|---|
| `--nh-dur` | 150ms | Every state transition (the hover lift, borders) |
| `--nh-ease` | `cubic-bezier(.2, .7, .3, 1)` | Every state transition |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | **Arrivals only**: a menu or dialog opening |

```css
@keyframes spring-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .menu-popup, .modal { animation: none; }
}
```

Power's base also turns every transition off under reduced motion. There's no slide-in for the object page and no pulse animation; both were removed on purpose. Chevrons rotate 90° in 0.2s (`.fchevron.open`).

---

## 12. Accessibility

### 12.1 Contrast (measured)

| Pair | Ratio | Target |
|---|---|---|
| Main text `--text` on ground | 8.5:1 | ✓ 4.5:1 |
| Dim text `--text-dim` on ground / popover | 5.6:1 / 4.8:1 | ✓ 4.5:1 |
| Dim text on the active grey `--nh-pane-2` | 4.1:1 | ✗ just under 4.5:1 |
| Orange `--accent` on ground | 6.9:1 | ✓ |
| Dark text on orange (primary button) | 6.9:1 | ✓ |
| Red / yellow / green on ground | 6.2 / 10.5 / 10.2:1 | ✓ |
| Control outline `--nh-line-2` on ground | 2.6:1 | ✗ under the 3:1 its comment claims |

The two misses are known; don't make them worse. If you lift `--nh-line-2`, check that outlines don't start to dominate the screen.

### 12.2 Keyboard and semantics

`src/components/a11y.ts` provides the helpers. Use them instead of a bare `onClick` on a non-button.

| Helper | Gives |
|---|---|
| `pressable(fn, { expanded?, current? })` | `role="button"`, `tabIndex=0`, Enter/Space, `aria-expanded` / `aria-current` |
| `keyPressable(fn, …)` | The keyboard half only, for an element whose parent keeps the click |
| `onTabListKeyDown` | Arrow keys across a tab strip (roving tabindex) |
| `useModalFocus(active)` | Tab trap inside a dialog, focus returned on close |

- View tabs and object tabs are real tablists with tabpanels. Rail entries and chips use `aria-pressed`. Crumbs use `aria-current`.
- List rows are `li > div.row` (an `li` can't carry `role="button"`).
- The palette is a combobox with a listbox; menus take arrow keys.
- Loading, notices and "No matches" use `status` / `alert` roles.
- Icon-only buttons need an `aria-label` (and usually a `title`).
- Graph edges are mouse-only (⌘-click); every relationship is also reachable from the object page.

### 12.3 Focus

Power's ring: `:focus-visible { outline: 2px solid var(--nh-accent); outline-offset: 3px; }`. Rows, tabs, cards and clickable heads draw it inside (`outline-offset: -2px`) because they sit in clipped containers. Fields don't get a ring; their border turns orange.

### 12.4 Forced colours

```css
@media (forced-colors: active) {
  .icon-btn { border: 1px solid ButtonText; }
  :where(.btn, .icon-btn, .tab, .chip, .row, .card).active {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
}
```

---

## 13. Recipes

### A new button

Use a kind. Don't add CSS.

```tsx
<button className="btn" onClick={exportReport}>Export</button>
<button className="icon-btn" aria-label="Copy" title="Copy" onClick={copy}><CopyIcon /></button>
```

If it has to sit somewhere specific, the area file may place it:

```css
/* object-page.css: placement only */
.op-glance-actions .btn { margin-left: 4px; }
```

### A new list

Items are `.row`; the selected one is `.active`; non-clickable ones are `.inert`. Use a `TypePill short` before the name.

```tsx
<ul className="ref-list">
  {items.map((o) => (
    <li key={o.uid}>
      <div className={`row${o.uid === activeUid ? " active" : ""}`} {...pressable(() => onGo(o.uid))}>
        <TypePill type={o.type} short />
        <span className="ellipsis">{o.name}</span>
      </div>
    </li>
  ))}
</ul>
```

### A new section on the object page

```tsx
<Section title="Filter">
  <CodeBox text={detail.portalFilter}>
    <pre className="code">
      <LinkedCode text={detail.portalFilter} objects={targets} onGo={onGo} model={model} owner={owner.uid} />
    </pre>
  </CodeBox>
</Section>
```

The section's title, chevron, spacing and indent come for free.

### A new flag or status tag

```tsx
<span className={`tag op-fact tone-${tone}`} title={explanation}>{label}</span>
```

Use `tone-high` for broken, `tone-warn` for needs-a-look, `tone-ok` for good, no tone for neutral. Make sure the dot, the filter and the Report Card count read the same source.

### A new object type

1. Add its colour as `--nh-t-<name>` and `--type-<name>` in `tokens.css`.
2. Add the case to `typeColor()` in `typeStyle.ts` and a short code to `SHORT_LABEL` in `TypePill.tsx` (keep it ≤ 4 characters so `.type-pill.short` stays 36px).
3. Check the rail tile and a tag at both sizes; the `oklch` evening keeps it level with the others.

### A new token

Add it to `tokens.css` with a comment saying what it's for, next to its siblings. If it's a colour that has a meaning (status, a type), name it after the meaning, not the hue.

### A new screen

Give it its own area file, import it in `main.tsx` before `motion.css`, and build it only from kinds. Hang its left edge from the same line as its neighbours (section 6.2). Check it at 1240 × 900, 1440 × 900 and 1720 × 1000.

---

## 14. Don'ts

- Don't edit `nuthatch-power.css`. Override in `tokens.css` or an area file.
- Don't hard-code colours in components (`style={{ color: "#…" }}`). Inline styles may set `--tc` or a token, nothing else.
- Don't give anything a grey hover fill, an underline, a sliding arrow, a scale on press or a coloured hover.
- Don't colour links orange. Don't colour destructive menu items red.
- Don't add a second primary button to a screen.
- Don't uppercase FileMaker names, or anything but small labels.
- Don't add new title sizes; use 18px / 600.
- Don't box things the theme left unboxed: sections, the Report Card, notices, change lists.
- Don't add shadows, gradients or glows.
- Don't use type colours for anything but type tags, rail glyphs, TO outlines and `syn-to`.
- Don't use red for "external": it isn't an error.
- Don't count disabled FileMaker options as broken.
- Don't cap the width of the Projects or Comparison screens.
- Don't name a state anything but `.active`.
- Don't make chips or flags bigger than 16px.

---

## 15. Checklist

Before you call a UI change done:

- [ ] Every clickable element is a kind; no new button, row or chip styles.
- [ ] No area file sets colour, border or state on a kind.
- [ ] Hover is the lift and nothing else; selected is `.active`.
- [ ] No raw colours outside `tokens.css`.
- [ ] Names in real case; labels in small caps; headings in sentence case.
- [ ] Rows 24px, chips 16px, buttons 26px.
- [ ] Left edges line up with the tabs and section titles.
- [ ] Status indicators agree (dot, tag, filter, Report Card), including with one file loaded alone.
- [ ] Keyboard: reachable, operable with Enter/Space, visible focus.
- [ ] Icon buttons have an `aria-label`.
- [ ] Checked in one pane and in two split panes at 1240px wide.
- [ ] `npx tsc -b --noEmit` and `npx vitest run --exclude ".claude/**"` pass.
