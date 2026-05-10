import type { AppDatabase } from "@/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { todos } from "@/modules/todo/schema";
import { createComment, deleteComment, getCommentById, listComments } from "./comment.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dir: string;
let userId: string;
let todoId: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "todo-comment-"));
  db = await createDb(resolve(dir, "app.db"));
  userId = nanoid();
  todoId = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: userId,
    oauthSub: `sub_${userId}`,
    username: `u_${userId}`,
    name: "u",
    email: `${userId}@example.com`,
    createdAt: now,
    updatedAt: now,
  }).run();
  await db.insert(todos).values({
    id: todoId,
    title: "t",
    creatorId: userId,
    createdAt: now,
    updatedAt: now,
  }).run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("comment service", () => {
  test("create + listComments returns newest-first", async () => {
    const c1 = await createComment(db, { todoId, authorId: userId, content: "first" });
    await Bun.sleep(5);
    const c2 = await createComment(db, { todoId, authorId: userId, content: "second" });

    const list = await listComments(db, todoId);
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(c2.id);
    expect(list[1]!.id).toBe(c1.id);
  });

  test("getCommentById finds the row when (todoId, id) match; otherwise undefined", async () => {
    const c = await createComment(db, { todoId, authorId: userId, content: "hi" });
    expect((await getCommentById(db, todoId, c.id))?.content).toBe("hi");
    expect(await getCommentById(db, todoId, "missing")).toBeUndefined();
    expect(await getCommentById(db, "wrong-todo", c.id)).toBeUndefined();
  });

  test("deleteComment removes the row", async () => {
    const c = await createComment(db, { todoId, authorId: userId, content: "x" });
    await deleteComment(db, c.id);
    expect(await getCommentById(db, todoId, c.id)).toBeUndefined();
  });
});
