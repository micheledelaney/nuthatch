<p align="center">
  <img src="docs/bird.svg" alt="nuthatch bird logo" width="160" />
</p>

<p align="center">
  <strong>See inside your FileMaker solution: structure, dependencies, and risks, all analyzed locally.</strong>
</p>

<p align="center">
  <a href="https://micheledelaney.github.io/nuthatch/">Website</a>
  &nbsp;·&nbsp;
  <a href="https://micheledelaney.github.io/nuthatch/app/">Try the live app</a>
</p>

---

# nuthatch

A static-analysis tool for FileMaker solutions. Load one or more **"Save a Copy
as XML"** exports and explore the solution's structure, dependencies, call
chains, and maintenance risks.

**All parsing happens locally** — in the browser or in the desktop app's
webview. Nothing is uploaded, and there is no backend or telemetry.

---

## Demo

A walkthrough covering the report card, browsing and filtering, the ⌘K
command palette, the relationship graph, and comparing two analyses of the
same solution:

<video src="https://github.com/user-attachments/assets/82a9694a-2605-4b14-b257-e1216f494036" controls width="100%"></video>

---

## Install

nuthatch runs two ways from the same codebase. Pick one:

| | 🌐 **Browser app** | 🖥️ **Desktop app** |
| --- | --- | --- |
| What you get | A static web page, no backend | A native, offline window ([Tauri](https://tauri.app/)) |
| Needs | Node.js 18+ | Node.js 18+ **and** the [Rust toolchain](https://www.rust-lang.org/tools/install) |
| Build it | `npm run build` → `dist/` | `npm run tauri:build` → installer |

Both start the same way:

```bash
git clone git@github.com:micheledelaney/nuthatch.git
cd nuthatch
npm install
```

### 🌐 Option A — Browser app

```bash
npm run build
npm run preview   # open it locally at the URL it prints
```

To host it, serve the static files in `dist/` from any web server; there's no
backend to set up.

### 🖥️ Option B — Desktop app

Install the Rust toolchain first (on macOS you also need the Xcode command-line
tools: `xcode-select --install`). Then:

```bash
npm run tauri:build
```

This writes the app and installer to `src-tauri/target/release/bundle/`. On
macOS that's `macos/nuthatch.app` (drag it to Applications) and a `.dmg` in
`dmg/`. The first build compiles the Rust side and takes a few minutes.

### Then

Use **+ New project** to load your own FileMaker "Save a Copy as XML" file(s).

---

## Supported input

| Format | Root element | How to generate in FileMaker Pro | Encoding |
| ------ | ------------ | -------------------------------- | -------- |
| **Save a Copy as XML** | `<FMSaveAsXML>` | **File → Save a Copy As… → XML** | UTF-16 or UTF-8 (varies by FileMaker version) |

Encoding is detected from the byte-order mark, so UTF-16LE, UTF-16BE, and UTF-8
files all load correctly without configuration. Load several files at once to
analyze a multi-file solution as a single connected model — cross-file
references resolve into any other file that's also loaded.

> **Important — enable "Include details for analysis tools" when exporting.**
> In the *Save a Copy as XML* dialog, tick the **"Include details for analysis
> tools"** checkbox. Without it, FileMaker omits `DDR_INFO` — the tokenized
> calculations and the rendered script-step text — so calculation references
> fall back to a best-effort text scan and scripts show no step text.

> **Note:** nuthatch reads the regular *Save a Copy as XML* export, **not** a
> Database Design Report (DDR). The two formats differ; the export stores raw
> structure plus the analysis details above.

---

## What nuthatch understands

It parses these object types into one flat, navigable model: **tables, fields,
table occurrences, relationships, layouts and the objects on them, scripts,
value lists, custom functions, accounts, privilege sets, extended privileges,
file access, external data sources, custom menu sets, menus and menu items,
themes**, plus inferred **global variables**.

Beyond listing objects, it reconstructs the detail FileMaker leaves implicit:

- **Readable script steps.** The steps themselves are raw parameter trees (ids,
  internal codes, option bitmasks); nuthatch shows each one with the text
  FileMaker pre-renders into `DDR_INFO` — as the Script Workspace shows it,
  e.g. `Set Field [ TABLE::FIELD ; <calc> ]` — with object names linked,
  disabled steps marked, and the Insert Text value FileMaker leaves out added.
- **Calculations** for calculated and summary fields, **auto-enter
  calculations**, custom-function bodies, and value-list definitions.
- **Auto-enter options** — calculated, serial number, creation/modification
  metadata, looked-up value, or constant data — surfaced in a field's detail.

### How references are discovered

A dependency edge can be explicit in the XML, tokenized in a calculation's
chunk list, or left only in FileMaker's rendered text. nuthatch reads all three:

1. **Element scanning** — explicit `<FieldReference>`, `<ScriptReference>`,
   `<LayoutReference>`, `<TableOccurrenceReference>`, `<DataSourceReference>`,
   `<CustomMenuSetReference>`, etc., driven by an explicit tag→type map
   (`refTags.ts`) — no guessing.
2. **Calculation chunk lists** — every calculation points into `DDR_INFO`, where
   FileMaker stores it tokenized: field references with id + occurrence, custom
   function calls, and `$$global` variables, exactly. A chunk list is used only
   when it's really that calculation's own: FileMaker writes an *empty* list for
   any calc that mentions a `<Field Missing>` / `<Table Missing>`, and objects
   without a UUID all share one pointer (`__0`, `__Condition_1`, …) whose list
   belongs to just one of them.
3. **Calculation text, as a fallback** — for a calc whose chunk list is empty or
   someone else's (or when the export has no `DDR_INFO`), the formula text is
   scanned against the file's own names: `TO::Field` through the occurrence
   named before the `::`, bare field names in a field's own calcs, custom
   functions, and `$$globals`. Names are matched whole (multi-word names
   included) with string literals and comments blanked out.
4. **Rendered step text** — targets FileMaker records only as text once the
   element is gone: a Perform Script / Go to Layout / Go to Related Record whose
   script or layout was deleted (`<unknown>`), or a Perform Script into a file
   that wasn't open at export (`<unknown> from file: …`).

Field-based **value lists**, **auto-enter** and **validation** calculations, and
privilege sets' **record-level access** formulas contribute their dependencies
too — only the options that are switched on, since FileMaker keeps a disabled
calc or lookup in the XML — so a field's "referenced by" list reflects where
it's actually used.

**Broken references** come from targets that no longer exist: an id missing from
its catalog, a `<Field Missing>` / `<Table Missing>` placeholder, a deleted
script behind a trigger or a Perform Script, a deleted layout or data source.
An external table occurrence whose file simply wasn't available when the file
was exported (or whose data-source path is a variable) has no base table in the
export; references through it can't be verified and are **not** counted as
broken — the report card says how many such occurrences there are.

---

## Features

The app has three views — **Report Card**, **Browse**, and **ERD** — plus a
dashboard of saved analyses.

- **Report card** — object inventory, references, objects with broken
  references, unreferenced objects, active accounts without a password,
  unstored calculations, deep calculations (relationship depth ≥ 2), global
  fields and variables, and derived risk flags. A banner explains when the
  export couldn't resolve external files, and parse warnings are shown there.
  Clicking a tile opens the matching filtered list.
- **Browse** — a search-first navigator (full-text search over names,
  calculations, and script code, a type rail, and filter chips such as
  Broken / Unreferenced) beside an object workbench: object pages with a full
  property sheet, readable script steps, calculation bodies, layout contents,
  and inbound (*referenced by*) and outbound (*references*) lists. Pages keep a
  back/forward history, open side by side in a second pane, and can be pinned.
  **⌘K** jumps to any object, with filters like `type:script`, `is:unreferenced`,
  and `refs>20`.
- **Call chains** — a script's recursive Perform Script tree, with cycle
  detection and external / missing targets marked.
- **ERD** — the relationship graph, laid out as in FileMaker's own graph, with
  lines colored by cascade rule (delete / create / sorted).
- **Saved analyses & comparison** — save a parsed analysis locally (IndexedDB)
  under a project and **diff two analyses of the same solution over time**:
  adds, removes, renames, and a unified diff of changed calculations and
  scripts.

---

## Stack

- **Vite + React 18 + TypeScript** (strict mode).
- **`fast-xml-parser`**, run inside a **Web Worker** (`src/worker/parse.worker.ts`)
  so the UI stays responsive while parsing large enterprise exports.
- **Zustand** for application state.
- **IndexedDB** for saved analyses (no server).
- **Tauri** (Rust shell) for the optional desktop build.

---

## Scripts

See [Install](#install) to get it running.

| Script               | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Browser dev server with HMR                          |
| `npm run build`      | Type-check, then build a production bundle to `dist/`|
| `npm run preview`    | Serve the production build                           |
| `npm run typecheck`  | `tsc --noEmit`                                       |
| `npm run tauri:dev`  | Run the desktop app in development                   |
| `npm run tauri:build`| Build a native desktop binary                        |

---

## Architecture

```
FMSaveAsXML ─▶ parse.worker ─▶ parseDocuments ─▶ buildModel ─▶ SolutionModel ─▶ React UI
              (off main thread)  (XML → objects     (resolve refs,
                                   + raw edges)       index, analyze)
```

The parse runs off the main thread; everything downstream (`buildModel` and the
analyses) is pure and synchronous, which keeps it testable and makes saved
analyses just data.

| Path | Responsibility |
| ---- | -------------- |
| `src/core/parser/` | Turn `<FMSaveAsXML>` into flat, serializable `FmObject`s and *unresolved* reference edges. Includes script-step and layout detail (`extractDetail.ts`), the tag→type map (`refTags.ts`), and the calculation-text fallback (`calcText.ts`). |
| `src/core/model/buildModel.ts` | Resolve edges to target `uid`s (field refs flow through their table occurrence → base table → field), flag broken ones, build inbound/outbound indexes, run analyses. |
| `src/core/analysis/` | Report card, call chains, dependency views, and the analysis-to-analysis diff. |
| `src/core/search/` | Full-text search over names, calculations, and script code. |
| `src/state/` | File loading + BOM-aware decoding (`loadFiles.ts`), Zustand store, and IndexedDB persistence (`savedAnalyses.ts`). |
| `src/components/` | Navigator, report card, ERD, the saved-analyses dashboard + comparison view; `browseA/` (object page, filters) and `workbench/` (panes, ⌘K palette, pins) make up Browse. |

Every object has a globally-unique `uid` of the form `fileUid:type:id`. Because
FileMaker's internal ids are stable across exports, the same uid identifies the
same object over time — which is what makes the comparison/diff reliable (a
renamed object keeps its uid; an absent uid is a genuine add or remove).

---

## Known limitations

The tool performs **static** analysis of the export, so it has the inherent
constraints of any static analysis:

- **Dynamic / indirect references** — `ExecuteSQL`, script-by-name,
  `GetField` / evaluated expressions — cannot be resolved statically, so an
  object used only indirectly may appear "unreferenced". (A `$$global` passed by
  name as a whole string literal, `"$$_MAP"`, is recognized.) Always verify
  before deleting.
- **The calculation-text fallback** (used only when a calc's chunk list is
  unusable) is best-effort: a `Let` variable that happens to share a field's
  name could read as a reference, and nothing it finds is ever reported broken.
- **Field references** resolve through the table occurrence they read from →
  base table → field, and are flagged broken **only** when that base table is
  known — fields behind an external occurrence that was unresolved at export,
  or whose file isn't loaded, stay best-effort rather than producing false
  "broken" results. Field refs with no occurrence context aren't broken-checked.
- **Unreferenced objects** ignore uses that don't count: an object referencing
  itself (a recursive script or custom function), a layout's own buttons going
  to it, and disabled script steps. Scripts, layouts, custom functions, value
  lists, tables, table occurrences, fields, themes, and privilege sets are
  checked. Fields are best-effort — one read only through an external
  occurrence whose file isn't loaded may show as a false orphan.
- **Cross-file references** resolve only into files that are *also loaded*,
  matched by base-table UUID first, then the data source's path, then its name
  (data-source names often differ from file names). A reference into a file that
  isn't loaded stays external (best-effort, not broken).
- **Accounts / privilege sets** are listed but not deeply audited; full
  security-audit reporting is out of scope.
- **Large files.** A real export can be very large (e.g. a ~234 MB UTF-16 file ≈
  6,000 objects / 30,000 references). Parsing runs in a Web Worker so the UI
  stays responsive, but expect roughly 15–40 s and a transient 1–2 GB memory
  spike during the parse.
