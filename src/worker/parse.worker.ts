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

type MutableSpec = { name: string; buffer: ArrayBuffer | null };

/** Each doc's text, decoded only when the parser reaches it, its buffer dropped
 * once decoded — so the files' buffers, decoded texts and object trees aren't
 * all live at once. */
function* decodeEach(specs: MutableSpec[]): Generator<{ name: string; content: string }> {
  for (const spec of specs) {
    const content = decodeFile(spec.buffer!);
    spec.buffer = null; // drop the reference — buffer is now GC-eligible
    yield { name: spec.name, content };
  }
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  // Copy the doc specs into our own array so the event (and its raw ArrayBuffers)
  // can be garbage-collected once onmessage returns.  Each buffer is released
  // as soon as it's decoded, and each decoded text once it's parsed, so by the
  // time postMessage structured-clones the result no source text (hundreds of
  // MB for large exports) is left beside it.
  const rawDocs: MutableSpec[] = event.data.docs.map((d) => ({ name: d.name, buffer: d.buffer }));

  queueMicrotask(() => {
    try {
      const result = parseDocuments(decodeEach(rawDocs));
      const response: ParseResponse = { ok: true, result };
      self.postMessage(response);
    } catch (err) {
      // The message alone doesn't say where it failed.
      console.error("Parse worker error", err);
      const error =
        err instanceof Error
          ? err.message || "Parse worker error (no message)"
          : String(err) || "Parse worker error";
      const response: ParseResponse = { ok: false, error };
      self.postMessage(response);
    }
  });
};
