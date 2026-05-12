import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  tags: text("tags").notNull().default("[]"),
  parentId: text("parent_id").references((): AnySQLiteColumn => documents.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  creatorId: text("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_documents_creator").on(t.creatorId),
  index("idx_documents_parent").on(t.parentId),
]);

export const documentAttachments = sqliteTable("document_attachments", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  filepath: text("filepath").notNull(),
  mimetype: text("mimetype").notNull(),
  size: integer("size").notNull(),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  index("idx_document_attachments_doc").on(t.documentId),
  index("idx_document_attachments_uploader").on(t.uploadedBy),
]);

export const documentComments = sqliteTable("document_comments", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_document_comments_doc").on(t.documentId),
  index("idx_document_comments_author").on(t.authorId),
]);

export const documentShares = sqliteTable("document_shares", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  targetType: text("target_type", { enum: ["user", "group"] }).notNull(),
  targetId: text("target_id").notNull(),
  permission: text("permission", { enum: ["viewer", "editor"] }).notNull().default("viewer"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_doc_shares_unique").on(t.documentId, t.targetType, t.targetId),
  index("idx_doc_shares_doc").on(t.documentId),
  index("idx_doc_shares_target").on(t.targetType, t.targetId),
]);
