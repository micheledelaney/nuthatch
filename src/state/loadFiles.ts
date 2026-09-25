import type { SourceDoc } from "@/state/store";

/**
 * Decode a raw file buffer, honoring its byte-order mark. FileMaker's
 * "Save a Copy as XML" export is UTF-16; reading via file.text() always assumes
 * UTF-8, which corrupts UTF-16 input — so we sniff the BOM and pick the right
 * decoder.
 *
 * Called inside the parse worker so the main thread never holds a decoded copy
 * alongside the raw buffer.
 */
export function decodeFile(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  return new TextDecoder("utf-8").decode(buffer);
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
