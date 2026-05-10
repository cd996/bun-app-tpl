import type { AppDatabase } from "@/db";
import { desc, eq } from "drizzle-orm";
import { documentComments } from "@/modules/document/schema";
import { nanoid } from "@/shared/lib/id";

export async function listComments(db: AppDatabase, documentId: string) {
  return await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.documentId, documentId))
    .orderBy(desc(documentComments.createdAt))
    .all();
}

export async function createComment(db: AppDatabase, data: {
  documentId: string;
  authorId: string;
  content: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documentComments).values({
    id,
    documentId: data.documentId,
    authorId: data.authorId,
    content: data.content,
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(documentComments).where(eq(documentComments.id, id)).get())!;
}

export async function getCommentById(db: AppDatabase, id: string) {
  return await db.select().from(documentComments).where(eq(documentComments.id, id)).get();
}

export async function deleteComment(db: AppDatabase, id: string) {
  await db.delete(documentComments).where(eq(documentComments.id, id)).run();
}
