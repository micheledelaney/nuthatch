import { create } from "zustand";
import type { ObjectType, ParseResult, SolutionModel } from "@/types/ddr";
import { buildModel } from "@/core/model/buildModel";
import { diffAnalyses, DEFAULT_DIFF_OPTIONS, type AnalysisDiff, type DiffOptions } from "@/core/analysis/diff";
import type { ParseRequest, ParseResponse } from "@/worker/parse.worker";
import {
  createProject,
  deleteProject,
  deleteSaved,
  listProjects,
  listSaved,
  loadSaved,
  renameProject,
  saveAnalysis,
  setProjectNote,
  setProjectShowHealthGraphs,
  updateAnalysis,
  UNGROUPED,
  type ProjectRecord,
  type SavedMeta,
} from "@/state/savedAnalyses";

/** What the shared edit dialog is currently editing. */
export type EditTarget =
  | { kind: "project-rename"; name: string }
  | { kind: "project-note"; name: string }
  | { kind: "analysis-rename"; id: string }
  | { kind: "analysis-note"; id: string };

export interface EditDialog {
  target: EditTarget;
  initialValue: string;
}

/** Two analyses being compared, older (a) → newer (b), with the computed diff. */
export interface Comparison {
  a: SavedMeta;
  b: SavedMeta;
  /** Raw parse results kept so the view can recompute the diff with different options. */
  resultA: ParseResult;
  resultB: ParseResult;
  diff: AnalysisDiff;
  /** Set when the two sides were exported from different FileMaker versions —
   * some diffs may then be cosmetic (e.g. script keyword casing) rather than
   * real changes. Each value is the distinct version(s) for that side. */
  versionWarning?: { a: string; b: string };
}

export type Status = "empty" | "parsing" | "ready" | "error";
export type HomeView = "report" | "browse" | "erd";

/** Field sub-filter applied in the navigator (only meaningful when the type
 * filter is "field"): field category and storage attributes. */
export type FieldFilter = "all" | "normal" | "calculation" | "summary" | "unstored" | "global" | "deepCalc";

/** Relationship sub-filter (only meaningful when the type filter is
 * "relationship"): the cascade/sort setting, matching the graph's colors. */
export type RelFilter = "all" | "create" | "delete" | "sorted";

/** Account active/inactive sub-filter (only meaningful when navType is "account"). */
export type AccountFilter = "all" | "active" | "inactive";

/** Account password sub-filter (only meaningful when navType is "account"). */
export type AccountPwFilter = "all" | "none" | "set";

/** Privilege-set capability sub-filter (only meaningful when navType is
 * "privilegeSet"): a capability granted in any object category, or read-only. */
export type PrivCapFilter = "all" | "create" | "edit" | "delete" | "readonly";

/** Cross-cutting reference-health filter, applied to whatever type is selected:
 * objects nothing references (unreferenced), or that have a broken outbound
 * reference (broken). */
export type RefFilter = "all" | "unreferenced" | "broken";

/** Layout sub-filter (only meaningful when navType is "layout"). */
export type LayoutFilter = "all" | "hasTriggers";

/** Layout-object trigger sub-filter (only meaningful when navType is "layoutObject"). */
export type LayoutObjectFilter = "all" | "hasTriggers";

/** Which of the two Browse workbench panes an action targets. */
export type PaneSide = "primary" | "secondary";

/** How many recently opened objects the workbench welcome screen remembers. */
const RECENT_LIMIT = 12;

export interface SourceDoc {
  name: string;
  /** Raw file bytes — decoded inside the parse worker so the main thread never
   * holds a separate decoded copy. Transferred (zero-copy) on postMessage. */
  buffer: ArrayBuffer;
}

interface AppState {
  status: Status;
  model: SolutionModel | null;
  /** Display name of the analysis currently open (shown in the main header). */
  analysisName: string | null;
  error: string | null;

  /** Saved analyses for the landing dashboard, newest first. */
  savedItems: SavedMeta[];
  /** Explicitly-created projects (may have zero analyses). */
  projects: ProjectRecord[];
  /** The ParseResult behind the current model, kept so it can be saved. */
  lastResult: ParseResult | null;
  /** When set, the name/note dialog is open with these prefilled fields, BEFORE
   * parsing. The chosen `docs` are held here and only parsed once the user
   * confirms (Save) or skips (Don't save); Cancel discards them unparsed.
   * `lockedProject` fixes the project (set when loading into a specific project
   * from the dashboard). */
  pendingLoad: {
    docs: SourceDoc[];
    defaultName: string;
    defaultProject: string;
    lockedProject: string | null;
  } | null;
  /** When true, the new-project dialog is open. */
  pendingProject: boolean;
  /** When set, the shared rename/note edit dialog is open. */
  editDialog: EditDialog | null;
  /** When set, the comparison view is shown for these two analyses. */
  comparison: Comparison | null;
  /** The comparison the user was viewing before drilling into an analysis via
   * openIn — lets them navigate back without losing the diff. */
  previousComparison: Comparison | null;
  /** Diff options for the comparison view, kept here (not local component state)
   * so they survive drilling into a detail view and back. */
  diffOptions: DiffOptions;

  /** Stay on the dashboard even when a model is loaded (set after confirmSave). */
  showDashboard: boolean;
  /** Id of the analysis just saved — used to flash/scroll to its row. */
  recentlyAddedId: string | null;
  clearRecentlyAdded: () => void;
  /** Which home panel shows when the column trail is empty. */
  view: HomeView;
  /** Object uids forming the Miller-column navigation trail (left → right). */
  trail: string[];
  /**
   * Per-column key of the exact list row clicked to reach the next column,
   * parallel to `trail` (trailKeys[i] is the row clicked in column i-1 that
   * produced trail[i]; trailKeys[0] is the root, with no originating row). A
   * column can list several rows pointing at the same object (e.g. a setField
   * and a field-read of one field), so the row key — not the target uid — is
   * what distinguishes the one that was actually clicked.
   */
  trailKeys: string[];
  /** Navigator search box + type filter (lifted here so other panels can drive it). */
  navType: ObjectType | "all";
  /** Field category/storage sub-filter, applied when navType is "field". */
  navFieldFilter: FieldFilter;
  /** Field data-type sub-filter (e.g. "Text"), applied when navType is "field". */
  navDataType: string | "all";
  /** Relationship cascade sub-filter, applied when navType is "relationship". */
  navRelFilter: RelFilter;
  /** Account active/inactive sub-filter, applied when navType is "account". */
  navAccountFilter: AccountFilter;
  /** Account privilege-set sub-filter (a set name), applied when navType is
   * "account". */
  navAccountPriv: string | "all";
  /** Account password sub-filter, applied when navType is "account". */
  navAccountPw: AccountPwFilter;
  /** Privilege-set capability sub-filter, applied when navType is "privilegeSet". */
  navPrivCap: PrivCapFilter;
  /** Cross-cutting reference-health filter (unreferenced / broken), any type. */
  navRefFilter: RefFilter;
  /** Layout script-trigger sub-filter, applied when navType is "layout". */
  navLayoutFilter: LayoutFilter;
  /** Layout-object type sub-filter (the loType string), applied when navType is "layoutObject". */
  navLayoutObjectType: string | "all";
  /** Layout-object trigger sub-filter, applied when navType is "layoutObject". */
  navLayoutObjectFilter: LayoutObjectFilter;
  /** When set, scroll the active script to this step (broken refs are always
   * highlighted regardless). */
  highlight: { uid: string; step: number | null } | null;
  /** When set, the relationship graph opens with this table occurrence selected
   * (as if clicked) and scrolled into view. Cleared once the graph consumes it. */
  graphFocus: string | null;

  /** Open the name/note dialog for `docs` (no parsing yet); if `projectName` is
   * given, the dialog locks to it. Parsing starts when the dialog is resolved. */
  loadDocuments: (docs: SourceDoc[], projectName?: string) => Promise<void>;
  reset: () => void;

  /** Refresh projects + analyses from IndexedDB. */
  refreshSaved: () => Promise<void>;
  /** Open / close / submit the new-project dialog. */
  startNewProject: () => void;
  cancelNewProject: () => void;
  confirmNewProject: (name: string, note?: string) => Promise<void>;
  /** Delete a project and all analyses filed under it. */
  removeProject: (name: string) => Promise<void>;
  /** Show or hide a project's health comparison graphs. */
  setShowHealthGraphs: (name: string, show: boolean) => Promise<void>;
  /** Open / cancel / submit the shared rename/note edit dialog. */
  openEdit: (dialog: EditDialog) => void;
  cancelEdit: () => void;
  confirmEdit: (value: string) => Promise<void>;
  /** Parse the pending docs, persist under `name` in `projectName`, then open. */
  confirmSave: (name: string, projectName: string, note?: string) => Promise<void>;
  /** Parse the pending docs and open the analysis without persisting it. */
  skipSave: () => Promise<void>;
  /** Discard the pending docs without parsing (Cancel) — back to the dashboard. */
  cancelLoad: () => void;
  /** Open a saved analysis by id (rebuilds the model from stored data). */
  openSaved: (id: string) => Promise<void>;
  /** Delete a saved analysis by id. */
  removeSaved: (id: string) => Promise<void>;
  /** Compare two saved analyses (ordered oldest → newest) and show the diff. */
  compareAnalyses: (idA: string, idB: string) => Promise<void>;
  /** Close the comparison view. */
  closeComparison: () => void;
  /** Return to the comparison the user drilled in from. */
  returnToComparison: () => void;
  /** Update the comparison view's diff options. */
  setDiffOptions: (opts: DiffOptions) => void;

  /** Switch view without clearing trail or navigator state (used by tab buttons). */
  setView: (view: HomeView) => void;
  showReport: () => void;
  /** Show the browse view (Navigator sidebar + column trail). */
  showBrowse: () => void;
  /** Show the solution-wide base-table ERD. */
  showErd: () => void;
  /** Open the relationship graph with `uid` (a table occurrence) selected and
   * scrolled into view, as if it had been clicked there. */
  showGraphFor: (uid: string) => void;
  /** Clear a pending graph focus once the graph has acted on it. */
  clearGraphFocus: () => void;
  /** Start a fresh trail at `uid` (clicked from the navigator or a home panel). */
  openObject: (uid: string) => void;
  /**
   * Navigate to `uid` from the column at `index`, truncating columns after it.
   * `rowKey` identifies the exact list row clicked, so the trail can shade only
   * that row even when several rows point at the same object.
   */
  navigateFrom: (index: number, uid: string, rowKey?: string) => void;
  /** Backtrack: make the history column at `index` the active detail again,
   * dropping every column to its right. */
  truncateTo: (index: number) => void;

  setNavType: (type: ObjectType | "all") => void;
  setNavFieldFilter: (filter: FieldFilter) => void;
  setNavDataType: (dataType: string | "all") => void;
  setNavRelFilter: (filter: RelFilter) => void;
  setNavAccountFilter: (filter: AccountFilter) => void;
  setNavAccountPriv: (priv: string | "all") => void;
  setNavAccountPw: (filter: AccountPwFilter) => void;
  setNavPrivCap: (filter: PrivCapFilter) => void;
  setNavRefFilter: (filter: RefFilter) => void;
  setNavLayoutFilter: (filter: LayoutFilter) => void;
  setNavLayoutObjectType: (loType: string | "all") => void;
  setNavLayoutObjectFilter: (filter: LayoutObjectFilter) => void;
  /** Filter the navigator to fields matching `filter` (drives the report-card
   * deep links for unstored calculations and global fields). */
  focusFields: (filter: FieldFilter) => void;

  /** Workbench split view: the secondary pane's own back-history (last = active),
   * or null when the split is closed. The primary pane uses `trail`. */
  split: string[] | null;
  /** The pane that ← and ⌘[ / ⌘] act on: the last one clicked, focused, or
   * opened into. Only meaningful while the split is open. */
  activePane: PaneSide;
  setActivePane: (side: PaneSide) => void;
  /** Pinned objects shown in the workbench shelf (in memory only). */
  pins: string[];
  /** Recently opened objects, most recent first (in memory only). */
  recent: string[];
  /** Open `uid` in a pane, appending to that pane's history (opens the split
   * if the secondary pane isn't showing yet). */
  openInPane: (side: PaneSide, uid: string) => void;
  /** Backtrack a pane to history entry `index`. */
  truncatePane: (side: PaneSide, index: number) => void;
  /** Close a pane. Closing the primary promotes the secondary into it. */
  closePane: (side: PaneSide) => void;
  swapPanes: () => void;
  togglePin: (uid: string) => void;
  noteRecent: (uid: string) => void;
}

type SetState = (partial: Partial<AppState>) => void;

/** Parse `docs` (showing the loading view), returning the result + resolved
 * model, or null if parsing failed (status/error are set in that case). */
async function parseDocs(
  set: SetState,
  docs: SourceDoc[],
): Promise<{ result: ParseResult; model: SolutionModel } | null> {
  set({ status: "parsing", error: null, ...INITIAL_NAV });
  try {
    const response = await parseInWorker(docs);
    if (!response.ok) {
      set({ status: "error", error: response.error || "Failed to parse the file." });
      return null;
    }
    const { result } = response;
    if (result.errors.length > 0 && result.files.length === 0) {
      set({ status: "error", error: result.errors.join("\n") });
      return null;
    }
    return { result, model: buildModel(result) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({ status: "error", error: msg || "An unexpected error occurred while parsing." });
    return null;
  }
}

/** Parse off the main thread to keep the UI responsive on large exports. */
function parseInWorker(docs: SourceDoc[]): Promise<ParseResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("@/worker/parse.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = (event) => {
      reject(new Error(event.message || "Parse worker crashed — the file may be too large to process in the browser."));
      worker.terminate();
    };
    const request: ParseRequest = { docs };
    // Transfer the ArrayBuffers (zero-copy) so the worker owns the raw bytes
    // and the main thread doesn't hold a decoded duplicate in memory.
    worker.postMessage(request, docs.map((d) => d.buffer));
  });
}

/** A sensible default project name from the loaded file names. */
function defaultProjectFor(docs: SourceDoc[]): string {
  const first = docs[0]?.name ?? "Analysis";
  return docs.length > 1 ? `${first} +${docs.length - 1}` : first;
}

/** Default analysis label: the loaded file's name (extension dropped), so an
 * analysis reads as the file it came from. Multi-file loads append `+N`. */
function defaultNameFor(docs: SourceDoc[]): string {
  const first = (docs[0]?.name ?? "Analysis").replace(/\.xml$/i, "");
  return docs.length > 1 ? `${first} +${docs.length - 1}` : first;
}

const INITIAL_NAV = {
  view: "report" as HomeView,
  trail: [] as string[],
  trailKeys: [] as string[],
  navType: "all" as const,
  navFieldFilter: "all" as FieldFilter,
  navDataType: "all" as string | "all",
  navRelFilter: "all" as RelFilter,
  navAccountFilter: "all" as AccountFilter,
  navAccountPriv: "all" as string | "all",
  navAccountPw: "all" as AccountPwFilter,
  navPrivCap: "all" as PrivCapFilter,
  navRefFilter: "all" as RefFilter,
  navLayoutFilter: "all" as LayoutFilter,
  navLayoutObjectType: "all" as string | "all",
  navLayoutObjectFilter: "all" as LayoutObjectFilter,
  highlight: null,
  graphFocus: null as string | null,
  split: null as string[] | null,
  activePane: "primary" as PaneSide,
  pins: [] as string[],
  recent: [] as string[],
};

export const useStore = create<AppState>((set, get) => ({
  status: "empty",
  model: null,
  analysisName: null,
  error: null,
  savedItems: [],
  projects: [],
  lastResult: null,
  pendingLoad: null,
  pendingProject: false,
  editDialog: null,
  comparison: null,
  previousComparison: null,
  diffOptions: DEFAULT_DIFF_OPTIONS,
  showDashboard: false,
  recentlyAddedId: null,
  ...INITIAL_NAV,

  // Collect name/project/note first; parsing is deferred until the dialog is
  // resolved (confirmSave / skipSave), so the heavy parse never runs for a load
  // the user cancels.
  loadDocuments: async (docs, projectName) => {
    set({
      pendingLoad: {
        docs,
        defaultName: defaultNameFor(docs),
        defaultProject: projectName ?? defaultProjectFor(docs),
        lockedProject: projectName ?? null,
      },
    });
  },

  reset: () =>
    set({
      status: "empty",
      model: null,
      analysisName: null,
      error: null,
      lastResult: null,
      pendingLoad: null,
      comparison: null,
      previousComparison: null,
      ...INITIAL_NAV,
    }),

  refreshSaved: async () => {
    const [savedItems, projects] = await Promise.all([listSaved(), listProjects()]);
    set({ savedItems, projects });
  },

  startNewProject: () => set({ pendingProject: true }),
  cancelNewProject: () => set({ pendingProject: false }),
  confirmNewProject: async (name, note) => {
    const trimmed = name.trim();
    if (!trimmed) return set({ pendingProject: false });
    try {
      await createProject(trimmed, Date.now(), note?.trim() || undefined);
      set({ pendingProject: false, projects: await listProjects() });
    } catch (err) {
      set({ pendingProject: false, error: (err as Error).message });
    }
  },

  removeProject: async (name) => {
    await deleteProject(name);
    const [savedItems, projects] = await Promise.all([listSaved(), listProjects()]);
    set({ savedItems, projects });
  },

  setShowHealthGraphs: async (name, show) => {
    await setProjectShowHealthGraphs(name, show, Date.now());
    set({ projects: await listProjects() });
  },

  openEdit: (dialog) => set({ editDialog: dialog }),
  cancelEdit: () => set({ editDialog: null }),
  confirmEdit: async (value) => {
    const { editDialog } = get();
    if (!editDialog) return;
    const { target } = editDialog;
    try {
      switch (target.kind) {
        case "project-rename":
          await renameProject(target.name, value.trim(), Date.now());
          break;
        case "project-note":
          await setProjectNote(target.name, value, Date.now());
          break;
        case "analysis-rename":
          await updateAnalysis(target.id, { name: value.trim() || "Untitled analysis" });
          break;
        case "analysis-note":
          await updateAnalysis(target.id, { note: value.trim() || undefined });
          break;
      }
      const [savedItems, projects] = await Promise.all([listSaved(), listProjects()]);
      set({ editDialog: null, savedItems, projects });
    } catch (err) {
      set({ editDialog: null, error: (err as Error).message });
    }
  },

  confirmSave: async (name, projectName, note) => {
    const { pendingLoad } = get();
    if (!pendingLoad) return;
    // Close the dialog before parsing so the loading view shows.
    set({ pendingLoad: null });
    const parsed = await parseDocs(set, pendingLoad.docs);
    if (!parsed) return;
    const { result, model } = parsed;
    const savedMeta = await saveAnalysis(
      name.trim() || "Untitled analysis",
      projectName.trim() || UNGROUPED,
      result,
      model.reportCard,
      Date.now(),
      note?.trim() || undefined,
    );
    const [savedItems, projects] = await Promise.all([listSaved(), listProjects()]);
    set({ status: "ready", model, analysisName: name.trim() || "Untitled analysis", lastResult: result, savedItems, projects, showDashboard: true, recentlyAddedId: savedMeta.id });
  },

  // "Don't save" still opens the analysis — it just isn't filed under a project.
  skipSave: async () => {
    const { pendingLoad } = get();
    if (!pendingLoad) return;
    const name = pendingLoad.defaultName;
    set({ pendingLoad: null });
    const parsed = await parseDocs(set, pendingLoad.docs);
    if (!parsed) return;
    set({ status: "ready", model: parsed.model, analysisName: name, lastResult: parsed.result, showDashboard: false, recentlyAddedId: null });
  },

  // Cancel before parsing: drop the chosen docs and return to the dashboard.
  cancelLoad: () => set({ pendingLoad: null, status: "empty", model: null, lastResult: null }),

  openSaved: async (id) => {
    const { comparison, previousComparison } = get();
    set({ status: "parsing", error: null, pendingLoad: null });
    try {
      const result = await loadSaved(id);
      if (!result) {
        set({ status: "empty", error: "That saved analysis could not be found.", savedItems: await listSaved() });
        return;
      }
      const model = buildModel(result);
      const name = get().savedItems.find((i) => i.id === id)?.name ?? null;
      set({
        status: "ready", model, analysisName: name, lastResult: result,
        showDashboard: false, recentlyAddedId: null,
        comparison: null,
        previousComparison: comparison ?? previousComparison,
        ...INITIAL_NAV,
      });
    } catch (err) {
      set({ status: "error", error: (err as Error).message });
    }
  },

  removeSaved: async (id) => {
    await deleteSaved(id);
    set({ savedItems: await listSaved() });
  },

  compareAnalyses: async (idA, idB) => {
    const { savedItems } = get();
    const older = savedItems.find((i) => i.id === idA);
    const newer = savedItems.find((i) => i.id === idB);
    if (!older || !newer) return;
    // The first-selected analysis is the baseline ("old", a); the second is the
    // comparison ("new", b). Selection order — not import time — sets direction.
    const [resultOlder, resultNewer] = await Promise.all([loadSaved(older.id), loadSaved(newer.id)]);
    if (!resultOlder || !resultNewer) {
      set({ error: "One of the analyses could not be loaded.", savedItems: await listSaved() });
      return;
    }
    const diff = diffAnalyses(resultOlder, resultNewer, older.brokenCount, newer.brokenCount);
    const versionWarning = versionMismatch(resultOlder, resultNewer);
    set({ comparison: { a: older, b: newer, resultA: resultOlder, resultB: resultNewer, diff, versionWarning }, error: null });
  },

  closeComparison: () => { get().reset(); set({ comparison: null, previousComparison: null }); },
  returnToComparison: () => {
    const { previousComparison } = get();
    if (!previousComparison) return;
    set({ comparison: previousComparison, previousComparison: null });
  },

  clearRecentlyAdded: () => set({ recentlyAddedId: null }),
  setDiffOptions: (diffOptions) => set({ diffOptions }),
  setView: (view) => set({ view, showDashboard: false }),
  showReport: () => set({ view: "report", showDashboard: false, trail: [], trailKeys: [], highlight: null }),
  showBrowse: () => set({ view: "browse", showDashboard: false, trail: [], trailKeys: [], highlight: null }),
  showErd: () => set({ view: "erd", showDashboard: false, trail: [], trailKeys: [], highlight: null, graphFocus: null }),
  showGraphFor: (uid) => set({ view: "erd", trail: [], trailKeys: [], highlight: null, graphFocus: uid }),
  clearGraphFocus: () => set({ graphFocus: null }),
  openObject: (uid) =>
    set({ view: "browse" as HomeView, trail: [uid], trailKeys: [""], highlight: null, activePane: "primary" }),

  navigateFrom: (index, uid, rowKey = "") =>
    set((state) => {
      const head = state.trail.slice(0, index + 1);
      if (head[index] === uid) return state; // clicking the column's own object
      const headKeys = state.trailKeys.slice(0, index + 1);
      return { trail: [...head, uid], trailKeys: [...headKeys, rowKey], highlight: null, activePane: "primary" };
    }),


  truncateTo: (index) =>
    set((state) => {
      if (index >= state.trail.length - 1) return state; // already the active column
      return {
        trail: state.trail.slice(0, index + 1),
        trailKeys: state.trailKeys.slice(0, index + 1),
        highlight: null,
      };
    }),

  // Leaving the field type clears the field-only sub-filters so they don't
  // silently constrain a later return to fields.
  setNavType: (navType) =>
    set({
      navType,
      // Leaving a type clears its sub-filters so they don't silently constrain a
      // later return to that type.
      ...(navType === "field" ? {} : { navFieldFilter: "all", navDataType: "all" }),
      ...(navType === "relationship" ? {} : { navRelFilter: "all" }),
      ...(navType === "account" ? {} : { navAccountFilter: "all", navAccountPriv: "all", navAccountPw: "all" }),
      ...(navType === "privilegeSet" ? {} : { navPrivCap: "all" }),
      ...(navType === "layout" ? {} : { navLayoutFilter: "all" }),
      ...(navType === "layoutObject" ? {} : { navLayoutObjectType: "all", navLayoutObjectFilter: "all" }),
    }),
  setNavFieldFilter: (navFieldFilter) => set({ navFieldFilter }),
  setNavDataType: (navDataType) => set({ navDataType }),
  setNavRelFilter: (navRelFilter) => set({ navRelFilter }),
  setNavAccountFilter: (navAccountFilter) => set({ navAccountFilter }),
  setNavAccountPriv: (navAccountPriv) => set({ navAccountPriv }),
  setNavAccountPw: (navAccountPw) => set({ navAccountPw }),
  setNavPrivCap: (navPrivCap) => set({ navPrivCap }),
  setNavRefFilter: (navRefFilter) => set({ navRefFilter }),
  setNavLayoutFilter: (navLayoutFilter) => set({ navLayoutFilter }),
  setNavLayoutObjectType: (navLayoutObjectType) => set({ navLayoutObjectType }),
  setNavLayoutObjectFilter: (navLayoutObjectFilter) => set({ navLayoutObjectFilter }),
  focusFields: (filter) =>
    set({ view: "browse" as HomeView, navType: "field", navFieldFilter: filter, navDataType: "all" }),

  openInPane: (side, uid) =>
    set((state) => {
      if (side === "primary" || state.trail.length === 0) {
        if (state.trail[state.trail.length - 1] === uid) return { activePane: "primary" };
        return {
          view: "browse" as HomeView,
          trail: [...state.trail, uid],
          trailKeys: [...state.trailKeys, ""],
          highlight: null,
          activePane: "primary",
        };
      }
      const split = state.split ?? [];
      if (split[split.length - 1] === uid) return { activePane: "secondary" };
      return { split: [...split, uid], activePane: "secondary" };
    }),
  truncatePane: (side, index) => {
    if (side === "primary") return get().truncateTo(index);
    set((state) => (state.split ? { split: state.split.slice(0, index + 1) } : state));
  },
  closePane: (side) =>
    set((state) => {
      if (side === "secondary") return { split: null, activePane: "primary" };
      if (!state.split) return { trail: [], trailKeys: [], highlight: null, activePane: "primary" };
      return { trail: state.split, trailKeys: state.split.map(() => ""), split: null, highlight: null, activePane: "primary" };
    }),
  swapPanes: () =>
    set((state) => {
      if (!state.split || state.trail.length === 0) return state;
      // The active pane follows its content to the other side.
      const activePane: PaneSide = state.activePane === "primary" ? "secondary" : "primary";
      return { trail: state.split, trailKeys: state.split.map(() => ""), split: state.trail, highlight: null, activePane };
    }),
  setActivePane: (activePane) => set({ activePane }),
  togglePin: (uid) =>
    set((state) => ({ pins: state.pins.includes(uid) ? state.pins.filter((p) => p !== uid) : [...state.pins, uid] })),
  noteRecent: (uid) =>
    set((state) =>
      state.recent[0] === uid ? state : { recent: [uid, ...state.recent.filter((r) => r !== uid)].slice(0, RECENT_LIMIT) },
    ),
}));

/**
 * Warn when two analyses were exported from different FileMaker versions: some
 * diffs are then cosmetic (e.g. script keyword casing changes between versions)
 * rather than real edits. Returns the distinct version(s) per side, or undefined
 * when the versions match or either side predates version capture.
 */
function versionMismatch(a: ParseResult, b: ParseResult): Comparison["versionWarning"] {
  const versionsOf = (r: ParseResult) =>
    [...new Set(r.files.map((f) => f.version).filter((v): v is string => !!v))].sort();
  const va = versionsOf(a);
  const vb = versionsOf(b);
  if (va.length === 0 || vb.length === 0 || va.join(", ") === vb.join(", ")) return undefined;
  return { a: va.join(", "), b: vb.join(", ") };
}
