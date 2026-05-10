import type { AppDatabase } from "@/db";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import {
  createTodo,
  deleteTodo,
  getTodoById,
  listMyTodos,
  listTodos,
  updateTodo,
} from "./todo.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string, role: "admin" | "user" = "user") {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@test.com`,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-todo-${Date.now()}-${nanoid()}`);
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

describe("createTodo", () => {
  test("creates with required fields", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test task", creatorId: userId });
    expect(todo.id).toHaveLength(8);
    expect(todo.title).toBe("Test task");
    expect(todo.status).toBe("open");
    expect(todo.priority).toBe("medium");
    expect(todo.creatorId).toBe(userId);
    expect(todo.assigneeId).toBeNull();
  });

  test("creates with all optional fields", async () => {
    const creator = await seedUser("Alice");
    const assignee = await seedUser("Bob");
    const todo = await createTodo(db, {
      title: "Full task",
      description: "A detailed task",
      status: "in_progress",
      priority: "high",
      creatorId: creator,
      assigneeId: assignee,
      dueDate: "2026-12-31",
    });
    expect(todo.description).toBe("A detailed task");
    expect(todo.status).toBe("in_progress");
    expect(todo.priority).toBe("high");
    expect(todo.assigneeId).toBe(assignee);
    expect(todo.dueDate).toBe("2026-12-31");
  });
});

describe("listTodos", () => {
  test("returns paginated results", async () => {
    const userId = await seedUser("Alice");
    for (let i = 0; i < 5; i++) {
      await createTodo(db, { title: `Task ${i}`, creatorId: userId });
    }

    const page1 = await listTodos(db, { page: 1, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page3 = await listTodos(db, { page: 3, limit: 2 });
    expect(page3.data).toHaveLength(1);
  });

  test("filters by search query", async () => {
    const userId = await seedUser("Alice");
    await createTodo(db, { title: "Fix the bug", creatorId: userId });
    await createTodo(db, { title: "Add feature", creatorId: userId });

    const result = await listTodos(db, { q: "bug" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Fix the bug");
  });

  test("filters by status", async () => {
    const userId = await seedUser("Alice");
    await createTodo(db, { title: "Open task", creatorId: userId, status: "open" });
    await createTodo(db, { title: "Done task", creatorId: userId, status: "done" });

    const result = await listTodos(db, { status: "open" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Open task");
  });

  test("filters by priority", async () => {
    const userId = await seedUser("Alice");
    await createTodo(db, { title: "Low task", creatorId: userId, priority: "low" });
    await createTodo(db, { title: "Urgent task", creatorId: userId, priority: "urgent" });

    const result = await listTodos(db, { priority: "urgent" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Urgent task");
  });

  test("filters by assigneeId", async () => {
    const creator = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await createTodo(db, { title: "Bob's task", creatorId: creator, assigneeId: bob });
    await createTodo(db, { title: "Unassigned", creatorId: creator });

    const result = await listTodos(db, { assigneeId: bob });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Bob's task");
  });

  test("filters by creatorId", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await createTodo(db, { title: "Alice task", creatorId: alice });
    await createTodo(db, { title: "Bob task", creatorId: bob });

    const result = await listTodos(db, { creatorId: alice });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Alice task");
  });
});

describe("listMyTodos", () => {
  test("returns todos where user is creator or assignee", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const charlie = await seedUser("Charlie");

    await createTodo(db, { title: "Created by Alice", creatorId: alice });
    await createTodo(db, { title: "Assigned to Alice", creatorId: bob, assigneeId: alice });
    await createTodo(db, { title: "Charlie's task", creatorId: charlie });

    const result = await listMyTodos(db, { userId: alice });
    expect(result.total).toBe(2);
    const titles = result.data.map(t => t.title).sort();
    expect(titles).toEqual(["Assigned to Alice", "Created by Alice"]);
  });

  test("applies filters on top of ownership", async () => {
    const alice = await seedUser("Alice");
    await createTodo(db, { title: "Open task", creatorId: alice, status: "open" });
    await createTodo(db, { title: "Done task", creatorId: alice, status: "done" });

    const result = await listMyTodos(db, { userId: alice, status: "done" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("Done task");
  });
});

describe("getTodoById", () => {
  test("finds by id", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Test", creatorId: userId });
    expect((await getTodoById(db, todo.id))?.title).toBe("Test");
    expect(await getTodoById(db, "nope")).toBeUndefined();
  });
});

describe("updateTodo", () => {
  test("updates specific fields", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Old", creatorId: userId });
    const updated = await updateTodo(db, todo.id, { title: "New", status: "done" });
    expect(updated?.title).toBe("New");
    expect(updated?.status).toBe("done");
    expect(updated?.priority).toBe("medium");
  });

  test("updates assignee", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const todo = await createTodo(db, { title: "Task", creatorId: alice });

    const updated = await updateTodo(db, todo.id, { assigneeId: bob });
    expect(updated?.assigneeId).toBe(bob);

    const cleared = await updateTodo(db, todo.id, { assigneeId: null });
    expect(cleared?.assigneeId).toBeNull();
  });

  test("updates due date", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Task", creatorId: userId });

    const updated = await updateTodo(db, todo.id, { dueDate: "2026-06-15" });
    expect(updated?.dueDate).toBe("2026-06-15");

    const cleared = await updateTodo(db, todo.id, { dueDate: null });
    expect(cleared?.dueDate).toBeNull();
  });

  test("clears description", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Task", creatorId: userId, description: "Has content" });

    const cleared = await updateTodo(db, todo.id, { description: null });
    expect(cleared?.description).toBeNull();
  });
});

describe("deleteTodo", () => {
  test("deletes todo", async () => {
    const userId = await seedUser("Alice");
    const todo = await createTodo(db, { title: "Del", creatorId: userId });
    await deleteTodo(db, todo.id);
    expect(await getTodoById(db, todo.id)).toBeUndefined();
  });
});
