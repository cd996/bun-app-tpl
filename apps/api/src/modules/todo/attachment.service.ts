import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { and, count as countFn, desc, eq } from "drizzle-orm";
import { todoAttachments } from "@/modules/todo/schema";
import { ROOT_DIR } from "@/root";
import { AppError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { mimeMatchesContent } from "@/shared/lib/mime-sniff";
import { assertWithinTotalQuota, isWithinFileSize, MAX_ATTACHMENTS_PER_RESOURCE } from "@/shared/lib/upload-limits";

export const UPLOAD_BASE_TODO_DIR = resolve(ROOT_DIR, "data/uploads/todos");
const UPLOAD_BASE = UPLOAD_BASE_TODO_DIR;

const ALLOWED_MIMETYPES = /^(?:image\/.*|application\/pdf|text\/.*|application\/zip|application\/x-7z-compressed)$/;
const RE_UNSAFE_FILENAME = /[^\w.\-]/g;
const RE_NULL_BYTE = /\0/g;

/** Sanitize an arbitrary filename: strip path components and replace unsafe chars. */
export function sanitizeAttachmentFilename(filename: string): string {
  return basename(filename).replace(RE_NULL_BYTE, "").replace(RE_UNSAFE_FILENAME, "_");
}

/**
 * Compute the on-disk path for a todo attachment. Always derived from the
 * attachment id and todo id, never accepting a caller-supplied path.
 */
export function buildTodoAttachmentPath(id: string, todoId: string, filename: string): string {
  const safeFilename = sanitizeAttachmentFilename(filename);
  return resolve(UPLOAD_BASE_TODO_DIR, todoId, `${id}_${safeFilename}`);
}

export function validateAttachmentMimetype(mimetype: string): boolean {
  return ALLOWED_MIMETYPES.test(mimetype);
}

export function validateAttachmentSize(size: number): boolean {
  return isWithinFileSize(size);
}

export async function countAttachments(db: AppDatabase, todoId: string): Promise<number> {
  const row = await db.select({ value: countFn() }).from(todoAttachments).where(eq(todoAttachments.todoId, todoId)).get();
  return row?.value ?? 0;
}

export async function canAddAttachment(db: AppDatabase, todoId: string): Promise<boolean> {
  const count = await countAttachments(db, todoId);
  return count < MAX_ATTACHMENTS_PER_RESOURCE;
}

export async function saveAttachment(
  db: AppDatabase,
  todoId: string,
  file: File,
  uploadedBy: string,
): Promise<typeof todoAttachments.$inferSelect> {
  await assertWithinTotalQuota(db, file.size);
  const id = nanoid();
  const dir = resolve(UPLOAD_BASE, todoId);
  if (!existsSync(dir)) {
    // 0o700 — see document/attachment.service.ts for rationale.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const filepath = buildTodoAttachmentPath(id, todoId, file.name);
  const tmppath = `${filepath}.tmp`;
  const now = new Date().toISOString();
  const buffer = await file.arrayBuffer();

  // Magic-byte sniff against the client-supplied MIME — see mime-sniff.ts.
  const sniffWindow = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  if (!mimeMatchesContent(file.type, sniffWindow)) {
    throw new AppError("File contents do not match declared type", 400, "MIME_MISMATCH");
  }

  return await db.transaction(async (tx) => {
    const existingCount = await tx
      .select({ value: countFn() })
      .from(todoAttachments)
      .where(eq(todoAttachments.todoId, todoId))
      .get();

    if ((existingCount?.value ?? 0) >= MAX_ATTACHMENTS_PER_RESOURCE) {
      throw new AppError(`Maximum attachments per task reached (${MAX_ATTACHMENTS_PER_RESOURCE})`, 400, "LIMIT_EXCEEDED");
    }

    // Two-phase write: temp path first, DB insert second, rename last. A crash
    // between steps leaves a `.tmp` file (sweepable) instead of an orphan with
    // the final name that any code might mistake for a real attachment.
    await Bun.write(tmppath, buffer);

    try {
      await tx.insert(todoAttachments).values({
        id,
        todoId,
        filename: file.name,
        filepath,
        mimetype: file.type,
        size: file.size,
        uploadedBy,
        createdAt: now,
      }).run();
      renameSync(tmppath, filepath);
    }
    catch (error) {
      try {
        rmSync(tmppath, { force: true });
      }
      catch {}
      throw error;
    }

    return (await tx.select().from(todoAttachments).where(eq(todoAttachments.id, id)).get())!;
  });
}

export async function listAttachments(db: AppDatabase, todoId: string) {
  return await db
    .select({
      id: todoAttachments.id,
      todoId: todoAttachments.todoId,
      filename: todoAttachments.filename,
      mimetype: todoAttachments.mimetype,
      size: todoAttachments.size,
      uploadedBy: todoAttachments.uploadedBy,
      createdAt: todoAttachments.createdAt,
    })
    .from(todoAttachments)
    .where(eq(todoAttachments.todoId, todoId))
    .orderBy(desc(todoAttachments.createdAt))
    .all();
}

export async function getAttachmentById(db: AppDatabase, todoId: string, attachmentId: string) {
  return await db
    .select()
    .from(todoAttachments)
    .where(and(eq(todoAttachments.id, attachmentId), eq(todoAttachments.todoId, todoId)))
    .get();
}

export async function deleteAttachment(db: AppDatabase, attachment: typeof todoAttachments.$inferSelect) {
  // DB delete first so a crash leaves a recoverable orphan file rather than
  // a dangling row.
  await db.delete(todoAttachments).where(eq(todoAttachments.id, attachment.id)).run();
  try {
    if (existsSync(attachment.filepath))
      rmSync(attachment.filepath);
  }
  catch {
    // best-effort
  }
}

export async function deleteTodoAttachments(db: AppDatabase, todoId: string) {
  const attachments = await db.select().from(todoAttachments).where(eq(todoAttachments.todoId, todoId)).all();

  for (const attachment of attachments) {
    if (existsSync(attachment.filepath)) {
      rmSync(attachment.filepath);
    }
  }

  const dir = resolve(UPLOAD_BASE, todoId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
