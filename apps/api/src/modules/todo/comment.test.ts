import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { createComment, getCommentById } from "./comment.service";
import { createTodo } from "./todo.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-comment-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("getCommentById", () => {
  test("scopes comment lookup to the todo id", async () => {
    const userId = await seedUser("Alice");
    const firstTodo = await createTodo(db, { title: "First", creatorId: userId });
    const secondTodo = await createTodo(db, { title: "Second", creatorId: userId });
    const comment = await createComment(db, { todoId: firstTodo.id, authorId: userId, content: "hello" });

    expect(await getCommentById(db, firstTodo.id, comment.id)).toBeDefined();
    expect(await getCommentById(db, secondTodo.id, comment.id)).toBeUndefined();
  });
});
