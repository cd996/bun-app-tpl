import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { and, count as countFn, desc, eq } from "drizzle-orm";
import { documentAttachments } from "@/modules/document/schema";
import { ROOT_DIR } from "@/root";
import { AppError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { mimeMatchesContent } from "@/shared/lib/mime-sniff";
import { assertWithinTotalQuota, isWithinFileSize, MAX_ATTACHMENTS_PER_RESOURCE } from "@/shared/lib/upload-limits";

export const UPLOAD_BASE_DOC_DIR = resolve(ROOT_DIR, "data/uploads/documents");
const UPLOAD_BASE = UPLOAD_BASE_DOC_DIR;

const ALLOWED_MIMETYPES = /^(?:image\/.*|application\/pdf|text\/.*|application\/zip|application\/x-7z-compressed)$/;
const RE_UNSAFE_FILENAME = /[^\w.\-]/g;
const RE_NULL_BYTE = /\0/g;

/** Sanitize an arbitrary filename: strip path components and replace unsafe chars. */
export function sanitizeAttachmentFilename(filename: string): string {
  return basename(filename).replace(RE_NULL_BYTE, "").replace(RE_UNSAFE_FILENAME, "_");
}

/**
 * Compute the on-disk path for a document attachment. Always derived from the
 * attachment id and document id, never accepting a caller-supplied path.
 */
export function buildDocumentAttachmentPath(id: string, documentId: string, filename: string): string {
  const safeFilename = sanitizeAttachmentFilename(filename);
  return resolve(UPLOAD_BASE_DOC_DIR, documentId, `${id}_${safeFilename}`);
}

export function validateAttachmentMimetype(mimetype: string): boolean {
  return ALLOWED_MIMETYPES.test(mimetype);
}

export function validateAttachmentSize(size: number): boolean {
  return isWithinFileSize(size);
}

export async function countAttachments(db: AppDatabase, documentId: string): Promise<number> {
  const row = await db.select({ value: countFn() }).from(documentAttachments).where(eq(documentAttachments.documentId, documentId)).get();
  return row?.value ?? 0;
}

export async function canAddAttachment(db: AppDatabase, documentId: string): Promise<boolean> {
  const cnt = await countAttachments(db, documentId);
  return cnt < MAX_ATTACHMENTS_PER_RESOURCE;
}

export async function saveAttachment(
  db: AppDatabase,
  documentId: string,
  file: File,
  uploadedBy: string,
): Promise<typeof documentAttachments.$inferSelect> {
  await assertWithinTotalQuota(db, file.size);
  const id = nanoid();
  const dir = resolve(UPLOAD_BASE, documentId);
  if (!existsSync(dir)) {
    // 0o700 — only the runtime user (and root) sees the cleartext attachment
    // tree. This matters when DB_ENCRYPTION is on but operators forget the
    // per-file uploads stay outside the SQLite file.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Sniff magic bytes against the client-supplied MIME type. A `.svg` (XML
  // with possible script) cannot pose as `image/png` past this gate.
  const buffer = await file.arrayBuffer();
  const sniffWindow = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  if (!mimeMatchesContent(file.type, sniffWindow)) {
    throw new AppError("File contents do not match declared type", 400, "MIME_MISMATCH");
  }

  // Two-phase write: persist to a sibling `.tmp` so a crash between write
  // and DB insert leaves a temp file we can sweep, never an orphan with the
  // final name. The DB insert commits the row, then rename → final path.
  const filepath = buildDocumentAttachmentPath(id, documentId, file.name);
  const tmppath = `${filepath}.tmp`;
  await Bun.write(tmppath, buffer);

  const now = new Date().toISOString();
  try {
    await db.insert(documentAttachments).values({
      id,
      documentId,
      filename: file.name,
      filepath,
      mimetype: file.type,
      size: file.size,
      uploadedBy,
      createdAt: now,
    }).run();
    renameSync(tmppath, filepath);
  }
  catch (err) {
    try {
      rmSync(tmppath, { force: true });
    }
    catch {}
    throw err;
  }

  return (await db.select().from(documentAttachments).where(eq(documentAttachments.id, id)).get())!;
}

export async function listAttachments(db: AppDatabase, documentId: string) {
  return await db
    .select({
      id: documentAttachments.id,
      documentId: documentAttachments.documentId,
      filename: documentAttachments.filename,
      mimetype: documentAttachments.mimetype,
      size: documentAttachments.size,
      uploadedBy: documentAttachments.uploadedBy,
      createdAt: documentAttachments.createdAt,
    })
    .from(documentAttachments)
    .where(eq(documentAttachments.documentId, documentId))
    .orderBy(desc(documentAttachments.createdAt))
    .all();
}

export async function getAttachmentById(db: AppDatabase, documentId: string, attachmentId: string) {
  return await db
    .select()
    .from(documentAttachments)
    .where(and(eq(documentAttachments.id, attachmentId), eq(documentAttachments.documentId, documentId)))
    .get();
}

export async function deleteAttachment(db: AppDatabase, attachment: typeof documentAttachments.$inferSelect) {
  // DB delete first so a crash between operations leaves a recoverable orphan
  // file (sweepable by a periodic janitor) rather than a dangling row that
  // points at nothing — that would surface as a 500 on every download attempt.
  await db.delete(documentAttachments).where(eq(documentAttachments.id, attachment.id)).run();
  try {
    if (existsSync(attachment.filepath))
      rmSync(attachment.filepath);
  }
  catch {
    // best-effort; orphan files are reclaimable, dangling rows are not.
  }
}
