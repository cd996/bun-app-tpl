import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status", { enum: ["open", "in_progress", "done", "cancelled"] }).notNull().default("open"),
  priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).notNull().default("medium"),
  creatorId: text("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: text("due_date"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_todos_creator").on(t.creatorId),
  index("idx_todos_assignee").on(t.assigneeId),
  index("idx_todos_status").on(t.status),
]);

export const todoAttachments = sqliteTable("todo_attachments", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull().references(() => todos.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  filepath: text("filepath").notNull(),
  mimetype: text("mimetype").notNull(),
  size: integer("size").notNull(),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  index("idx_todo_attachments_todo").on(t.todoId),
  index("idx_todo_attachments_uploader").on(t.uploadedBy),
]);

export const todoComments = sqliteTable("todo_comments", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull().references(() => todos.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_todo_comments_todo").on(t.todoId),
  index("idx_todo_comments_author").on(t.authorId),
]);
