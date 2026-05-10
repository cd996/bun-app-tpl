import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import {
  canAddAttachment,
  countAttachments,
  deleteAttachment,
  deleteTodoAttachments,
  getAttachmentById,
  listAttachments,
  saveAttachment,
  validateAttachmentMimetype,
  validateAttachmentSize,
} from "./attachment.service";
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

function makeFile(name: string, content: string, type: string): File {
  return new File([content], name, { type });
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-attach-${Date.now()}-${nanoid()}`);
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

describe("validateAttachmentMimetype", () => {
  test("allows images", () => {
    expect(validateAttachmentMimetype("image/png")).toBe(true);
    expect(validateAttachmentMimetype("image/jpeg")).toBe(true);
  });

  test("allows pdf", () => {
    expect(validateAttachmentMimetype("application/pdf")).toBe(true);
  });

  test("allows text", () => {
    expect(validateAttachmentMimetype("text/plain")).toBe(true);
    expect(validateAttachmentMimetype("text/csv")).toBe(true);
  });

  test("allows zip and 7z", () => {
    expect(validateAttachmentMimetype("application/zip")).toBe(true);
    expect(validateAttachmentMimetype("application/x-7z-compressed")).toBe(true);
  });

  test("rejects disallowed types", () => {
    expect(validateAttachmentMimetype("application/javascript")).toBe(false);
    expect(validateAttachmentMimetype("application/octet-stream")).toBe(false);
  });
});

describe("validateAttachmentSize", () => {
  test("allows valid sizes", () => {
    expect(validateAttachmentSize(1)).toBe(true);
    expect(validateAttachmentSize(10 * 1024 * 1024)).toBe(true);
  });

  test("rejects oversized files", () => {
    expect(validateAttachmentSize(10 * 1024 * 1024 + 1)).toBe(false);
  });

  test("rejects zero size", () => {
    expect(validateAttachmentSize(0)).toBe(false);
  });
});

describe("saveAttachment", () => {
  test("saves file and creates record", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    const file = makeFile("test.txt", "hello world", "text/plain");
    const att = await saveAttachment(db, todo.id, file, userId);

    expect(att.id).toHaveLength(8);
    expect(att.todoId).toBe(todo.id);
    expect(att.filename).toBe("test.txt");
    expect(att.mimetype).toStartWith("text/plain");
    expect(att.uploadedBy).toBe(userId);
    expect(existsSync(att.filepath)).toBe(true);
  });
});

describe("listAttachments", () => {
  test("returns attachments for a todo", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    await saveAttachment(db, todo.id, makeFile("a.txt", "a", "text/plain"), userId);
    await saveAttachment(db, todo.id, makeFile("b.txt", "b", "text/plain"), userId);

    const list = await listAttachments(db, todo.id);
    expect(list).toHaveLength(2);
    // Should not include filepath in response
    expect(list[0]).not.toHaveProperty("filepath");
  });
});

describe("getAttachmentById", () => {
  test("finds by id", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    const att = await saveAttachment(db, todo.id, makeFile("test.txt", "x", "text/plain"), userId);

    const found = await getAttachmentById(db, todo.id, att.id);
    expect(found).toBeDefined();
    expect(found!.filename).toBe("test.txt");

    const notFound = await getAttachmentById(db, todo.id, "nope");
    expect(notFound).toBeUndefined();
  });
});

describe("deleteAttachment", () => {
  test("removes file and record", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    const att = await saveAttachment(db, todo.id, makeFile("test.txt", "x", "text/plain"), userId);

    expect(existsSync(att.filepath)).toBe(true);
    await deleteAttachment(db, att);
    expect(existsSync(att.filepath)).toBe(false);
    expect(await getAttachmentById(db, todo.id, att.id)).toBeUndefined();
  });
});

describe("deleteTodoAttachments", () => {
  test("removes all files stored for a todo", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    const first = await saveAttachment(db, todo.id, makeFile("a.txt", "a", "text/plain"), userId);
    const second = await saveAttachment(db, todo.id, makeFile("b.txt", "b", "text/plain"), userId);

    expect(existsSync(first.filepath)).toBe(true);
    expect(existsSync(second.filepath)).toBe(true);

    await deleteTodoAttachments(db, todo.id);

    expect(existsSync(first.filepath)).toBe(false);
    expect(existsSync(second.filepath)).toBe(false);
  });
});

describe("countAttachments / canAddAttachment", () => {
  test("counts correctly", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });

    expect(await countAttachments(db, todo.id)).toBe(0);
    expect(await canAddAttachment(db, todo.id)).toBe(true);

    await saveAttachment(db, todo.id, makeFile("a.txt", "a", "text/plain"), userId);
    expect(await countAttachments(db, todo.id)).toBe(1);
  });

  test("rejects uploads after the quota is reached", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });

    for (let i = 0; i < 20; i++) {
      await saveAttachment(db, todo.id, makeFile(`${i}.txt`, `${i}`, "text/plain"), userId);
    }

    await expect(saveAttachment(db, todo.id, makeFile("overflow.txt", "x", "text/plain"), userId)).rejects.toThrow(
      "Maximum attachments per task reached (20)",
    );
    expect(await countAttachments(db, todo.id)).toBe(20);
  });
});
