/**
 * Decoding an export the way the app and the command-line tool do.
 */
import { describe, expect, it } from "vitest";
import { decodeFile } from "@/state/loadFiles";

const MiB = 1024 * 1024;

/** Where decodeFile ends its first slice. */
const FIRST_SLICE_END = 64 * MiB;

describe("decodeFile", () => {
  it("decodes a UTF-16 file of 256 MiB or more, which Node's TextDecoder rejects whole", () => {
    // A byte-order mark, then "a"s, with an emoji (a surrogate pair) split
    // across the first slice's end.
    const bytes = Buffer.from(new ArrayBuffer(257 * MiB));
    bytes.fill("a", 2, undefined, "utf16le");
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    bytes.write("😀", FIRST_SLICE_END - 2, "utf16le");
    const text = decodeFile(bytes.buffer);
    const emojiAt = (FIRST_SLICE_END - 4) / 2;
    expect(text.slice(emojiAt - 1, emojiAt + 3)).toBe("a😀a");
    // Compared as a boolean: a failed comparison of two 128M-character strings would print both.
    expect(text === bytes.toString("utf16le", 2)).toBe(true);
  });

  it("decodes a UTF-8 character split between two slices", () => {
    const bytes = Buffer.from(new ArrayBuffer(FIRST_SLICE_END + 4));
    bytes.fill("a");
    bytes.write("€", FIRST_SLICE_END - 1, "utf8");
    const text = decodeFile(bytes.buffer);
    expect(text.slice(FIRST_SLICE_END - 2, FIRST_SLICE_END + 1)).toBe("a€a");
    expect(text === bytes.toString("utf8")).toBe(true);
  });
});
