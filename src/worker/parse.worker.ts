/// <reference lib="webworker" />
import { parseDocuments } from "@/core/parser/parseDdr";
import { decodeFile } from "@/state/loadFiles";
import type { ParseResult } from "@/types/ddr";

export interface ParseRequest {
  docs: { name: string; buffer: ArrayBuffer }[];
}

export type ParseResponse =
  | { ok: true; result: ParseResult }
  | { ok: false; error: string };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  // Copy the doc specs into our own array so the event (and its raw ArrayBuffers)
  // can be garbage-collected once onmessage returns.  The buffers are released
  // inside the microtask after decoding, so we never hold buffer + decoded string
  // + the parsed object-tree all at the same time.
  type MutableSpec = { name: string; buffer: ArrayBuffer | null };
  const rawDocs: MutableSpec[] = event.data.docs.map((d) => ({ name: d.name, buffer: d.buffer }));

  queueMicrotask(() => {
    try {
      let docs: { name: string; content: string }[] | null = rawDocs.map((d) => {
        const content = decodeFile(d.buffer!);
        d.buffer = null; // drop the reference — buffer is now GC-eligible
        return { name: d.name, content };
      });
      const result = parseDocuments(docs);
      // Drop the decoded source strings (hundreds of MB for large exports) before
      // postMessage structured-clones the result — otherwise both the source and
      // two copies of the result are live at once, the peak that OOMs the renderer.
      docs = null;
      const response: ParseResponse = { ok: true, result };
      self.postMessage(response);
    } catch (err) {
      const error =
        err instanceof Error
          ? err.message || "Parse worker error (no message)"
          : String(err) || "Parse worker error";
      const response: ParseResponse = { ok: false, error };
      self.postMessage(response);
    }
  });
};
