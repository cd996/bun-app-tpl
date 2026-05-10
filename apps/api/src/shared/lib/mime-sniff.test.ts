import { describe, expect, test } from "bun:test";
import { mimeMatchesContent, sniffKind } from "./mime-sniff";

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

describe("sniffKind", () => {
  test("recognises PNG / JPEG / GIF / PDF / ZIP / 7z magic bytes", () => {
    expect(sniffKind(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe("image");
    expect(sniffKind(bytes(0xFF, 0xD8, 0xFF, 0xE0))).toBe("image");
    expect(sniffKind(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image");
    expect(sniffKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2D, 0x31))).toBe("pdf");
    expect(sniffKind(bytes(0x50, 0x4B, 0x03, 0x04))).toBe("zip");
    expect(sniffKind(bytes(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C))).toBe("7z");
  });

  test("classifies plain ASCII as text", () => {
    expect(sniffKind(new TextEncoder().encode("hello, world\n"))).toBe("text");
    expect(sniffKind(new Uint8Array(0))).toBe("text");
  });

  test("returns null for unknown binary blobs (e.g. SVG/XML)", () => {
    // SVG: starts with `<svg` ASCII, currently classified as text — that is
    // intentional: we accept text/svg+xml only via the higher-level mimetype
    // check, never inline-render. The signature itself is text-y.
    expect(sniffKind(bytes(0x00, 0x01, 0x02, 0x03, 0x04))).toBeNull();
  });
});

describe("mimeMatchesContent", () => {
  test("png claimed as image/png passes", () => {
    expect(mimeMatchesContent("image/png", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(true);
  });

  test("png claimed as image/jpeg passes (any image/* OK by category)", () => {
    expect(mimeMatchesContent("image/jpeg", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(true);
  });

  test("png claimed as application/pdf is rejected", () => {
    expect(mimeMatchesContent("application/pdf", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(false);
  });

  test("text claimed as text/csv passes", () => {
    expect(mimeMatchesContent("text/csv", new TextEncoder().encode("a,b,c\n1,2,3"))).toBe(true);
  });

  test("text claimed as image/svg+xml is rejected (must use text/*)", () => {
    expect(mimeMatchesContent("image/svg+xml", new TextEncoder().encode("<svg/>"))).toBe(false);
  });
});
