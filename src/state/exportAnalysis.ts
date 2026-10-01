import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AI_EXPORT_FOLDER, type ExportFile } from "@/core/export/aiExport";
import { buildZip } from "@/core/export/zip";

/**
 * Where "Export for AI" files go, by the best means the platform offers:
 *   • desktop app → native folder picker, files written by the Rust side;
 *   • Chromium browsers → File System Access folder picker;
 *   • other browsers → a zip download holding the same folder.
 * Every route produces `<chosen folder>/nuthatch/…`.
 *
 * Choosing is split from writing because the browser folder picker must open
 * while the click's user activation is still live, i.e. before the (possibly
 * multi-second) export is built.
 */

export type ExportOutcome =
  /** Written into a folder; `location` is a full path (desktop) or the folder name (browser). */
  | { kind: "folder"; location: string }
  | { kind: "download"; fileName: string };

export interface ExportDestination {
  write: (files: ExportFile[]) => Promise<ExportOutcome>;
}

type DirectoryPicker = (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;

/** Ask where to export. Resolves to null when the user dismisses the picker. */
export async function chooseExportDestination(zipName: string): Promise<ExportDestination | null> {
  if (isTauri()) return chooseTauriFolder();
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (picker) return chooseBrowserFolder(picker);
  return { write: async (files) => downloadZip(files, zipName) };
}

async function chooseTauriFolder(): Promise<ExportDestination | null> {
  const dir = await open({ directory: true, title: "Choose the project folder to export into" });
  if (typeof dir !== "string") return null;
  return {
    write: async (files) => ({
      kind: "folder",
      location: await invoke<string>("write_ai_export", { dir, folder: AI_EXPORT_FOLDER, files }),
    }),
  };
}

async function chooseBrowserFolder(picker: DirectoryPicker): Promise<ExportDestination | null> {
  let root: FileSystemDirectoryHandle;
  try {
    root = await picker({ mode: "readwrite", id: "nuthatch-ai-export" });
  } catch (err) {
    if ((err as DOMException).name === "AbortError") return null;
    throw err;
  }
  return {
    write: async (files) => {
      const folder = await root.getDirectoryHandle(AI_EXPORT_FOLDER, { create: true });
      for (const file of files) {
        const handle = await folder.getFileHandle(file.name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(file.content);
        await writable.close();
      }
      return { kind: "folder", location: `${root.name}/${AI_EXPORT_FOLDER}` };
    },
  };
}

function downloadZip(files: ExportFile[], zipName: string): ExportOutcome {
  const blob = buildZip(files.map((f) => ({ path: `${AI_EXPORT_FOLDER}/${f.name}`, content: f.content })));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = zipName;
  link.click();
  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { kind: "download", fileName: zipName };
}
