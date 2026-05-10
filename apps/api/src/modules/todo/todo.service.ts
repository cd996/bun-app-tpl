import type { AppDatabase } from "@/db";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { todos } from "@/modules/todo/schema";
import { nanoid } from "@/shared/lib/id";

// eslint-disable-next-line regexp/no-obscure-range, regexp/no-invisible-character, no-irregular-whitespace
const RE_FTS_KEEP = /[^\w一-鿿　-〿]+/g;
const RE_TOKEN_SPLIT = /\s+/;

/**
 * FTS5 query builder. Splits user input into tokens, drops anything outside
 * the alphanumeric / CJK range (so FTS5 operators / quotes can't be smuggled
 * in), and appends a `*` for prefix matching. Empty input returns an empty
 * string so the caller can shortcut to "no rows".
 */
function buildFtsQuery(raw: string): string {
  const tokens = raw
    .split(RE_TOKEN_SPLIT)
    .map(t => t.replace(RE_FTS_KEEP, ""))
    .filter(t => t.length > 0);
  return tokens.map(t => `${t}*`).join(" ");
}

type TodoStatus = "open" | "in_progress" | "done" | "cancelled";
type TodoPriority = "low" | "medium" | "high" | "urgent";

interface ListParams {
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly priority?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly creatorId?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

interface ListMyParams extends ListParams {
  readonly userId: string;
}

export async function listTodos(db: AppDatabase, params: ListParams = {}) {
  const { q, status, priority, assigneeId, creatorId, page = 1, limit = 20 } = params;

  const conditions = [];
  if (q) {
    const fts = buildFtsQuery(q);
    conditions.push(
      fts.length === 0
        ? sql`1 = 0`
        : sql`${todos.id} IN (SELECT id FROM todos_fts WHERE todos_fts MATCH ${fts})`,
    );
  }
  if (status && status !== "__all__") {
    conditions.push(eq(todos.status, status as TodoStatus));
  }
  if (priority && priority !== "__all__") {
    conditions.push(eq(todos.priority, priority as TodoPriority));
  }
  if (assigneeId) {
    conditions.push(eq(todos.assigneeId, assigneeId));
  }
  if (creatorId) {
    conditions.push(eq(todos.creatorId, creatorId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = await db.select({ value: count() }).from(todos).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(todos)
    .where(where)
    .orderBy(desc(todos.createdAt), desc(todos.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

export async function listMyTodos(db: AppDatabase, params: ListMyParams) {
  const { userId, q, status, priority, page = 1, limit = 20 } = params;

  const ownerCondition = or(eq(todos.creatorId, userId), eq(todos.assigneeId, userId));

  const conditions = [ownerCondition];
  if (q) {
    const fts = buildFtsQuery(q);
    conditions.push(
      fts.length === 0
        ? sql`1 = 0`
        : sql`${todos.id} IN (SELECT id FROM todos_fts WHERE todos_fts MATCH ${fts})`,
    );
  }
  if (status && status !== "__all__") {
    conditions.push(eq(todos.status, status as TodoStatus));
  }
  if (priority && priority !== "__all__") {
    conditions.push(eq(todos.priority, priority as TodoPriority));
  }

  const where = and(...conditions);

  const totalRow = await db.select({ value: count() }).from(todos).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(todos)
    .where(where)
    .orderBy(desc(todos.createdAt), desc(todos.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

export async function getTodoById(db: AppDatabase, id: string) {
  return await db.select().from(todos).where(eq(todos.id, id)).get();
}

export async function createTodo(db: AppDatabase, data: {
  title: string;
  description?: string | undefined;
  status?: TodoStatus | undefined;
  priority?: TodoPriority | undefined;
  creatorId: string;
  assigneeId?: string | undefined;
  dueDate?: string | undefined;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(todos).values({
    id,
    title: data.title,
    description: data.description ?? null,
    status: data.status ?? "open",
    priority: data.priority ?? "medium",
    creatorId: data.creatorId,
    assigneeId: data.assigneeId ?? null,
    dueDate: data.dueDate ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(todos).where(eq(todos.id, id)).get())!;
}

export async function updateTodo(db: AppDatabase, id: string, data: {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: TodoStatus | undefined;
  priority?: TodoPriority | undefined;
  assigneeId?: string | null | undefined;
  dueDate?: string | null | undefined;
}) {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };
  if (data.title !== undefined)
    setData.title = data.title;
  if (data.description !== undefined)
    setData.description = data.description;
  if (data.status !== undefined)
    setData.status = data.status;
  if (data.priority !== undefined)
    setData.priority = data.priority;
  if (data.assigneeId !== undefined)
    setData.assigneeId = data.assigneeId;
  if (data.dueDate !== undefined)
    setData.dueDate = data.dueDate;
  await db.update(todos).set(setData).where(eq(todos.id, id)).run();
  return await db.select().from(todos).where(eq(todos.id, id)).get();
}

export async function deleteTodo(db: AppDatabase, id: string) {
  await db.delete(todos).where(eq(todos.id, id)).run();
}

export async function getUserById(db: AppDatabase, id: string) {
  return await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id)).get();
}

export async function listActiveUsers(db: AppDatabase) {
  return await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(users.name)
    .all();
}
