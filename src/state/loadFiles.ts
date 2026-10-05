import type { SourceDoc } from "@/state/store";

/** Well under the 256 MiB TextDecoder takes at once (see decodeFile). */
const DECODE_SLICE_BYTES = 64 * 1024 * 1024;

/**
 * Decode a raw file buffer, honoring its byte-order mark. FileMaker's
 * "Save a Copy as XML" export is UTF-16; reading via file.text() always assumes
 * UTF-8, which corrupts UTF-16 input — so we sniff the BOM and pick the right
 * decoder.
 *
 * Called inside the parse worker so the main thread never holds a decoded copy
 * alongside the raw buffer.
 *
 * Decoded in slices: Node's TextDecoder rejects UTF-16 input of 256 MiB or
 * more as invalid (the largest sample export is 341 MiB), which failed the command-line
 * export. The decoder streams, so a character split between two slices still
 * decodes, and `+=` joins the pieces without copying them yet.
 */
export function decodeFile(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder(encodingOf(bytes));
  let text = "";
  for (let start = 0; start < bytes.length; start += DECODE_SLICE_BYTES) {
    const end = Math.min(start + DECODE_SLICE_BYTES, bytes.length);
    text += decoder.decode(bytes.subarray(start, end), { stream: end < bytes.length });
  }
  return text;
}

/** The encoding a file's byte-order mark names; UTF-8 without one. */
function encodingOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return "utf-8";
}

/** Read a picked FileList into raw source documents (buffers, not yet decoded).
 * Decoding happens inside the parse worker so the main thread never holds both
 * the raw buffer and the decoded string at the same time. */
export async function readSourceDocs(fileList: FileList): Promise<SourceDoc[]> {
  return Promise.all(
    Array.from(fileList).map(async (file) => ({
      name: file.name,
      buffer: await file.arrayBuffer(),
    })),
  );
}
