import type { AppDatabase } from "@/db";
import { and, desc, eq } from "drizzle-orm";
import { todoComments } from "@/modules/todo/schema";
import { nanoid } from "@/shared/lib/id";

export async function listComments(db: AppDatabase, todoId: string) {
  return await db
    .select()
    .from(todoComments)
    .where(eq(todoComments.todoId, todoId))
    .orderBy(desc(todoComments.createdAt))
    .all();
}

export async function createComment(db: AppDatabase, data: {
  todoId: string;
  authorId: string;
  content: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(todoComments).values({
    id,
    todoId: data.todoId,
    authorId: data.authorId,
    content: data.content,
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(todoComments).where(eq(todoComments.id, id)).get())!;
}

export async function getCommentById(db: AppDatabase, todoId: string, id: string) {
  return await db
    .select()
    .from(todoComments)
    .where(and(eq(todoComments.todoId, todoId), eq(todoComments.id, id)))
    .get();
}

export async function deleteComment(db: AppDatabase, id: string) {
  await db.delete(todoComments).where(eq(todoComments.id, id)).run();
}
