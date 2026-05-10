/**
 * Tiny magic-byte sniffer for the small whitelist of MIME categories we
 * accept on uploads (images, PDF, text, zip, 7z).
 *
 * The client-supplied `file.type` cannot be trusted — a `.svg` (which is XML
 * with possible script payloads) can claim `image/png`. We sniff the first
 * 16 bytes and return the inferred top-level category. Callers compare that
 * to the claimed type and reject mismatches before persisting the file.
 *
 * The sniffer is deliberately conservative: when no signature matches we
 * return `null` so the caller's policy decides (today: also reject).
 */

export type SniffedKind = "image" | "pdf" | "text" | "zip" | "7z";

interface Signature {
  readonly kind: SniffedKind;
  readonly bytes: readonly number[];
  readonly offset?: number;
}

const SIGNATURES: readonly Signature[] = [
  // Images
  { kind: "image", bytes: [0xFF, 0xD8, 0xFF] }, // jpeg
  { kind: "image", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }, // png
  { kind: "image", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // gif87a
  { kind: "image", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // gif89a
  { kind: "image", bytes: [0x42, 0x4D] }, // bmp
  { kind: "image", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // webp prefix (RIFF)
  { kind: "image", bytes: [0x49, 0x49, 0x2A, 0x00] }, // tiff little-endian
  { kind: "image", bytes: [0x4D, 0x4D, 0x00, 0x2A] }, // tiff big-endian

  // PDF
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF

  // Archives
  { kind: "zip", bytes: [0x50, 0x4B, 0x03, 0x04] }, // zip local file header
  { kind: "zip", bytes: [0x50, 0x4B, 0x05, 0x06] }, // empty zip
  { kind: "zip", bytes: [0x50, 0x4B, 0x07, 0x08] }, // spanned zip
  { kind: "7z", bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
];

function matches(buf: Uint8Array, sig: Signature): boolean {
  const offset = sig.offset ?? 0;
  if (buf.length < offset + sig.bytes.length)
    return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[offset + i] !== sig.bytes[i])
      return false;
  }
  return true;
}

function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0)
    return true;
  // Reject obvious binary: ANY null byte in the first 1KiB collapses the
  // text classification. Then require ≥95% printable ASCII / common UTF-8
  // continuation bytes, which is plenty for plain text, source code, csv.
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === 0)
      return false;
    // tab, lf, cr, printable ascii, or any > 0x7F (utf-8 continuation /
    // multibyte lead). The byte-level test is intentionally lenient.
    if (b === 0x09 || b === 0x0A || b === 0x0D || (b >= 0x20 && b <= 0x7E) || b > 0x7F)
      printable++;
  }
  return printable / buf.length >= 0.95;
}

/**
 * Sniff the leading bytes of a file and return the inferred kind, or null
 * when no signature matches. Empty buffers count as text (zero-byte text
 * files are legitimate uploads).
 */
export function sniffKind(buf: Uint8Array): SniffedKind | null {
  for (const sig of SIGNATURES) {
    if (matches(buf, sig))
      return sig.kind;
  }
  if (looksLikeText(buf))
    return "text";
  return null;
}

/**
 * Verify the claimed MIME type matches what the magic bytes say. Returns
 * `true` when they agree (or when the claim is unverifiable but the bytes
 * match a known category — text is the trickiest case, anything ASCII-like
 * is allowed as text/*).
 */
export function mimeMatchesContent(claimed: string, buf: Uint8Array): boolean {
  const kind = sniffKind(buf);
  if (kind === null)
    return false;
  const lc = claimed.toLowerCase();
  switch (kind) {
    case "image":
      return lc.startsWith("image/");
    case "pdf":
      return lc === "application/pdf";
    case "zip":
      return lc === "application/zip" || lc === "application/x-zip-compressed";
    case "7z":
      return lc === "application/x-7z-compressed";
    case "text":
      return lc.startsWith("text/");
  }
}
