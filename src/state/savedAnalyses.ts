import type { ParseResult, ReportCard } from "@/types/ddr";

/**
 * Local persistence for analyses, backed by IndexedDB so it works identically
 * in the browser and the Tauri webview — and, like the rest of nuthatch, keeps
 * everything on the user's machine (no backend).
 *
 * We persist the worker's serializable {@link ParseResult}, not the resolved
 * SolutionModel (which holds Maps) and not the raw source XML (which can be
 * hundreds of MB). Reopening rebuilds the full model with `buildModel`, which is
 * pure and fast — no re-parse needed.
 *
 * Two object stores keep the dashboard list cheap: `meta` holds the small
 * summary rows the landing screen renders, `data` holds the heavy ParseResult
 * loaded only when an analysis is actually opened.
 */

const DB_NAME = "nuthatch";
const DB_VERSION = 2;
const META_STORE = "meta";
const DATA_STORE = "data";
const PROJECT_STORE = "projects";

/** Default project name for an analysis saved without one. */
export const UNGROUPED = "Ungrouped";

/** A project, persisted independently so it can exist with zero analyses. */
export interface ProjectRecord {
  /** Project name — also the key; names are unique. */
  name: string;
  createdAt: number;
  /** Free-text note for the project. */
  note?: string;
  /** Whether the project's health comparison graphs are shown. */
  showHealthGraphs: boolean;
}

/** Lightweight summary shown in the dashboard list. */
export interface SavedMeta {
  id: string;
  /** Snapshot label within its project (e.g. a version or date). */
  name: string;
  /** Project this analysis is grouped under (its file-history bucket). */
  projectName: string;
  /** Epoch millis when saved. */
  savedAt: number;
  fileNames: string[];
  fileCount: number;
  objectCount: number;
  referenceCount: number;
  brokenCount: number;
  /** Free-text note for this analysis. */
  note?: string;
  // Health metrics for the project trend chart, captured at save time.
  unreferencedCount: number;
  unstoredCalculationCount: number;
  globalFieldCount: number;
  globalVariableCount: number;
  /** High/medium-severity risk-flag counts at save time. */
  riskHighCount: number;
  riskWarnCount: number;
}

/** The health subset of a SavedMeta, derived from a resolved report card when an
 * analysis is saved. */
export type HealthSnapshot = Pick<
  SavedMeta,
  | "brokenCount"
  | "unreferencedCount"
  | "unstoredCalculationCount"
  | "globalFieldCount"
  | "globalVariableCount"
  | "riskHighCount"
  | "riskWarnCount"
>;

export function healthFromReportCard(card: ReportCard): HealthSnapshot {
  return {
    brokenCount: card.brokenReferenceCount,
    unreferencedCount: card.unreferencedCount,
    unstoredCalculationCount: card.unstoredCalculationCount,
    globalFieldCount: card.globalFieldCount,
    globalVariableCount: card.globalVariableCount,
    riskHighCount: card.riskFlags.filter((f) => f.severity === "high").length,
    riskWarnCount: card.riskFlags.filter((f) => f.severity === "warn").length,
  };
}

interface SavedData {
  id: string;
  parseResult: ParseResult;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(DATA_STORE)) {
        db.createObjectStore(DATA_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "name" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a later version upgrade (or another tab) proceed instead of blocking.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    // A still-open connection from a previous session can block the upgrade;
    // surface it instead of hanging forever.
    request.onblocked = () =>
      reject(new Error("Database upgrade is blocked — close other nuthatch tabs and reload."));
  });
  return dbPromise;
}

/** Promise wrapper around a single IndexedDB request. */
function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolve once a transaction commits, so callers know writes are durable. */
function awaitTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/**
 * Summary of a ParseResult for the dashboard, without storing the heavy data
 * twice. The report card is supplied by the caller because its metrics (broken
 * references, unreferenced objects, …) are only known after `buildModel`
 * resolves the solution, not from the raw ParseResult.
 */
function summarize(
  parseResult: ParseResult,
  reportCard: ReportCard,
): Omit<SavedMeta, "id" | "name" | "projectName" | "savedAt"> {
  return {
    fileNames: parseResult.files.map((f) => f.name),
    fileCount: parseResult.files.length,
    objectCount: parseResult.objects.length,
    referenceCount: parseResult.references.length,
    ...healthFromReportCard(reportCard),
  };
}

/** All saved analyses, newest first. */
export async function listSaved(): Promise<SavedMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  const metas = await awaitRequest(tx.objectStore(META_STORE).getAll() as IDBRequest<SavedMeta[]>);
  return metas.sort((a, b) => b.savedAt - a.savedAt);
}

/** Persist the current analysis and return its summary row. */
export async function saveAnalysis(
  name: string,
  projectName: string,
  parseResult: ParseResult,
  reportCard: ReportCard,
  savedAt: number,
  note?: string,
): Promise<SavedMeta> {
  const id = crypto.randomUUID();
  const meta: SavedMeta = { id, name, projectName, savedAt, note, ...summarize(parseResult, reportCard) };
  const data: SavedData = { id, parseResult };
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE], "readwrite");
  tx.objectStore(META_STORE).put(meta);
  tx.objectStore(DATA_STORE).put(data);
  await awaitTx(tx);
  return meta;
}

/** Load the stored ParseResult for an analysis, or null if it's gone. */
export async function loadSaved(id: string): Promise<ParseResult | null> {
  const db = await openDb();
  const tx = db.transaction(DATA_STORE, "readonly");
  const data = await awaitRequest(tx.objectStore(DATA_STORE).get(id) as IDBRequest<SavedData | undefined>);
  return data?.parseResult ?? null;
}

/** Remove an analysis (both its summary and its data). */
export async function deleteSaved(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE], "readwrite");
  tx.objectStore(META_STORE).delete(id);
  tx.objectStore(DATA_STORE).delete(id);
  await awaitTx(tx);
}

/** All explicitly-created projects, newest first. */
export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await openDb();
  const tx = db.transaction(PROJECT_STORE, "readonly");
  const projects = await awaitRequest(
    tx.objectStore(PROJECT_STORE).getAll() as IDBRequest<ProjectRecord[]>,
  );
  return projects.sort((a, b) => b.createdAt - a.createdAt);
}

/** Create (or touch) a project so it appears on the dashboard with no analyses. */
export async function createProject(
  name: string,
  createdAt: number,
  note?: string,
  showHealthGraphs = false,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PROJECT_STORE, "readwrite");
  tx.objectStore(PROJECT_STORE).put({ name, createdAt, note, showHealthGraphs });
  await awaitTx(tx);
}

/** Set (or clear) a project's note, materializing an implicit project if needed. */
export async function setProjectNote(name: string, note: string, now: number): Promise<void> {
  const projects = await listProjects();
  const existing = projects.find((p) => p.name === name);
  await createProject(name, existing?.createdAt ?? now, note.trim() || undefined, existing?.showHealthGraphs);
}

/** Toggle a project's health-graph visibility, materializing it if implicit. */
export async function setProjectShowHealthGraphs(
  name: string,
  show: boolean,
  now: number,
): Promise<void> {
  const projects = await listProjects();
  const existing = projects.find((p) => p.name === name);
  await createProject(name, existing?.createdAt ?? now, existing?.note, show);
}

/**
 * Rename a project, reassigning every analysis filed under it. Merges into the
 * target if a project with `newName` already exists (keeping the target's note).
 */
export async function renameProject(oldName: string, newName: string, now: number): Promise<void> {
  if (!newName || oldName === newName) return;
  const db = await openDb();
  const projects = await listProjects();
  const oldRec = projects.find((p) => p.name === oldName);
  const targetExists = projects.some((p) => p.name === newName);
  const metas = await getAllMetas();

  const tx = db.transaction([META_STORE, PROJECT_STORE], "readwrite");
  const metaStore = tx.objectStore(META_STORE);
  for (const meta of metas) {
    if (meta.projectName === oldName) {
      metaStore.put({ ...meta, projectName: newName });
    }
  }
  const projStore = tx.objectStore(PROJECT_STORE);
  if (!targetExists) {
    projStore.put({
      name: newName,
      createdAt: oldRec?.createdAt ?? now,
      note: oldRec?.note,
      showHealthGraphs: oldRec?.showHealthGraphs ?? true,
    });
  }
  if (oldRec) projStore.delete(oldName);
  await awaitTx(tx);
}

/** Patch an analysis's editable fields (name, note). */
export async function updateAnalysis(
  id: string,
  patch: Partial<Pick<SavedMeta, "name" | "note">>,
): Promise<void> {
  const db = await openDb();
  const readTx = db.transaction(META_STORE, "readonly");
  const meta = await awaitRequest(
    readTx.objectStore(META_STORE).get(id) as IDBRequest<SavedMeta | undefined>,
  );
  if (!meta) return;
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({ ...meta, ...patch });
  await awaitTx(tx);
}

/** Raw analysis summaries (no projectName fallback) — for internal rewrites. */
async function getAllMetas(): Promise<SavedMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  return awaitRequest(tx.objectStore(META_STORE).getAll() as IDBRequest<SavedMeta[]>);
}

/** Delete a project and every analysis filed under it. */
export async function deleteProject(name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE, PROJECT_STORE], "readwrite");
  const metaStore = tx.objectStore(META_STORE);
  const dataStore = tx.objectStore(DATA_STORE);
  const metas = await awaitRequest(metaStore.getAll() as IDBRequest<SavedMeta[]>);
  for (const meta of metas) {
    if (meta.projectName === name) {
      metaStore.delete(meta.id);
      dataStore.delete(meta.id);
    }
  }
  tx.objectStore(PROJECT_STORE).delete(name);
  await awaitTx(tx);
}
