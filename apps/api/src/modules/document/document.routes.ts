import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { MAX_UPLOAD_BYTES } from "@/shared/lib/upload-limits";
import { authRequired } from "@/shared/middleware/auth";
import {
  canAddAttachment,
  deleteAttachment,
  getAttachmentById,
  listAttachments,
  saveAttachment,
  validateAttachmentMimetype,
  validateAttachmentSize,
} from "./attachment.service";
import {
  createComment,
  deleteComment,
  getCommentById,
  listComments,
} from "./comment.service";
import {
  addDocumentShare,
  createDocument,
  createFolder,
  deleteDocument,
  deleteFolder,
  getDocumentById,
  getDocumentPermission,
  getDocumentShareById,
  getFolderById,
  getFolderByName,
  listActiveUsers,
  listAllGroups,
  listAllTags,
  listDocuments,
  listDocumentShares,
  listFolders,
  listMyDocuments,
  removeDocumentShare,
  updateDocument,
  updateFolder,
} from "./document.service";

const tagSchema = z.string().min(1).max(50).regex(/^[\w-]+$/);

// Folder names render in headings, breadcrumbs, and audit logs. Reject
// control chars, RTL overrides, zero-width and other format codepoints
// that can be used for spoofing without contributing legible content.
// Letters / numbers / spaces / `._-` / common CJK punctuation are allowed.
const RE_FOLDER_NAME = /^[\p{L}\p{N}\p{Mn}\p{Mc} ._\-()[\]&,'!?+。，、！？（）【】「」]+$/u;

const createSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  folderId: z.string().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  folderId: z.string().nullable().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: "At least one field must be provided",
});

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

async function assertAccess(
  db: Parameters<typeof getDocumentPermission>[0],
  user: { id: string; role: string },
  doc: { id: string; creatorId: string },
  requiredPermission: "viewer" | "editor" = "viewer",
) {
  if (user.role === "admin")
    return;
  if (doc.creatorId === user.id)
    return;
  const permission = await getDocumentPermission(db, doc.id, user.id);
  if (!permission)
    throw new ForbiddenError();
  if (requiredPermission === "editor" && permission !== "editor")
    throw new ForbiddenError();
}

function assertOwnerOrAdmin(user: { id: string; role: string }, doc: { creatorId: string }) {
  if (user.role === "admin")
    return;
  if (doc.creatorId !== user.id)
    throw new ForbiddenError();
}

export function documentRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  router.use("*", authRequired);

  // GET /documents — list (admin: all, user: own + published)
  router.get("/documents", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const q = c.req.query("q");
    const tag = c.req.query("tag");
    const folderId = c.req.query("folder_id");
    const creatorId = c.req.query("creator_id");
    const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

    const isAdmin = user.role === "admin";
    const result = isAdmin
      ? await listDocuments(db, { q, tag, folderId, creatorId, page, limit })
      : await listMyDocuments(db, { userId: user.id, q, tag, folderId, page, limit });

    return c.json({
      success: true,
      data: result.data,
      meta: { total: result.total, page, limit },
    });
  });

  // GET /documents/tags — list all unique tags
  router.get("/documents/tags", async (c) => {
    const db = c.get("db");
    const tags = await listAllTags(db);
    return c.json({ success: true, data: tags });
  });

  // GET /documents/users — list active users (for sharing UI)
  router.get("/documents/users", async (c) => {
    const db = c.get("db");
    const data = await listActiveUsers(db);
    return c.json({ success: true, data });
  });

  // GET /documents/groups — list all groups (for sharing UI)
  router.get("/documents/groups", async (c) => {
    const db = c.get("db");
    const data = await listAllGroups(db);
    return c.json({ success: true, data });
  });

  // POST /documents — create
  router.post("/documents", async (c) => {
    const db = c.get("db");
    const body = createSchema.parse(await c.req.json());
    const actor = c.get("user")!;

    const doc = await createDocument(db, { ...body, creatorId: actor.id });

    await audit(db, {
      actorId: actor.id,
      actorName: actor.name,
      action: "document.created",
      resourceType: "document",
      resourceId: doc.id,
      resourceName: doc.title,
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: doc }, 201);
  });

  // ── Folder endpoints ──

  const folderSchema = z.object({
    name: z.string().min(1).max(200).refine(v => RE_FOLDER_NAME.test(v), {
      message: "Folder name contains disallowed characters",
    }),
  });

  router.get("/documents/folders", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const isAdmin = user.role === "admin";
    const data = isAdmin ? await listFolders(db) : await listFolders(db, user.id);
    return c.json({ success: true, data });
  });

  router.post("/documents/folders", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const body = folderSchema.parse(await c.req.json());
    const duplicate = await getFolderByName(db, body.name);
    if (duplicate)
      throw new AppError(`Folder name "${body.name}" already exists`, 409, "CONFLICT");
    const folder = await createFolder(db, { name: body.name, creatorId: user.id });
    return c.json({ success: true, data: folder }, 201);
  });

  router.patch("/documents/folders/:fid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const fid = c.req.param("fid");
    const existing = await getFolderById(db, fid);
    if (!existing)
      throw new NotFoundError("Folder", fid);
    if (user.role !== "admin" && existing.creatorId !== user.id)
      throw new ForbiddenError();
    const body = folderSchema.parse(await c.req.json());
    if (body.name !== existing.name) {
      const duplicate = await getFolderByName(db, body.name);
      if (duplicate)
        throw new AppError(`Folder name "${body.name}" already exists`, 409, "CONFLICT");
    }
    const updated = await updateFolder(db, fid, body);
    return c.json({ success: true, data: updated });
  });

  router.delete("/documents/folders/:fid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const fid = c.req.param("fid");
    const existing = await getFolderById(db, fid);
    if (!existing)
      throw new NotFoundError("Folder", fid);
    if (user.role !== "admin" && existing.creatorId !== user.id)
      throw new ForbiddenError();
    await deleteFolder(db, fid);
    return c.json({ success: true, data: null });
  });

  // GET /documents/:id — detail
  router.get("/documents/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const doc = await getDocumentById(db, c.req.param("id"));
    if (!doc)
      throw new NotFoundError("Document", c.req.param("id"));
    await assertAccess(db, user, doc, "viewer");
    return c.json({ success: true, data: doc });
  });

  // PATCH /documents/:id — update (creator or admin)
  router.patch("/documents/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getDocumentById(db, id);
    if (!existing)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, existing, "editor");

    const body = updateSchema.parse(await c.req.json());
    const updated = await updateDocument(db, id, body);

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.updated",
      resourceType: "document",
      resourceId: id,
      resourceName: existing.title,
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: updated });
  });

  // DELETE /documents/:id — delete (creator or admin)
  router.delete("/documents/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getDocumentById(db, id);
    if (!existing)
      throw new NotFoundError("Document", id);

    if (user.role !== "admin" && existing.creatorId !== user.id) {
      throw new ForbiddenError();
    }

    await deleteDocument(db, id);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.deleted",
      resourceType: "document",
      resourceId: id,
      resourceName: existing.title,
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Attachment endpoints ──

  router.post("/documents/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "editor");

    if (!(await canAddAttachment(db, id))) {
      throw new AppError("Maximum attachments per document reached (20)", 400, "LIMIT_EXCEEDED");
    }

    // Reject oversize uploads before buffering the body.
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new AppError("Upload too large", 413, "UPLOAD_TOO_LARGE");
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new AppError("No file provided", 400, "VALIDATION_ERROR");
    }
    if (!validateAttachmentSize(file.size)) {
      throw new AppError("File size exceeds 10MB limit", 400, "FILE_TOO_LARGE");
    }
    if (!validateAttachmentMimetype(file.type)) {
      throw new AppError("File type not allowed", 400, "INVALID_MIMETYPE");
    }
    const attachment = await saveAttachment(db, id, file, user.id);

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.attachment_uploaded",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { attachmentId: attachment.id, filename: file.name, size: file.size },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: attachment }, 201);
  });

  router.get("/documents/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");
    const data = await listAttachments(db, id);
    return c.json({ success: true, data });
  });

  router.get("/documents/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");
    const attachment = await getAttachmentById(db, id, aid);
    if (!attachment)
      throw new NotFoundError("Attachment", aid);

    const file = Bun.file(attachment.filepath);
    if (!(await file.exists())) {
      throw new NotFoundError("File", aid);
    }

    return new Response(file.stream(), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
        "Content-Length": String(attachment.size),
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  router.delete("/documents/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "editor");
    const attachment = await getAttachmentById(db, id, aid);
    if (!attachment)
      throw new NotFoundError("Attachment", aid);

    await deleteAttachment(db, attachment);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.attachment_deleted",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { attachmentId: aid, filename: attachment.filename },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Comment endpoints ──

  const commentSchema = z.object({
    content: z.string().min(1).max(10000),
  });

  router.get("/documents/:id/comments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");
    const data = await listComments(db, id);
    return c.json({ success: true, data });
  });

  router.post("/documents/:id/comments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");

    const body = commentSchema.parse(await c.req.json());
    const comment = await createComment(db, { documentId: id, authorId: user.id, content: body.content });

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.comment_added",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { commentId: comment.id },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: comment }, 201);
  });

  router.delete("/documents/:id/comments/:cid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const cid = c.req.param("cid");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);

    const comment = await getCommentById(db, cid);
    if (!comment)
      throw new NotFoundError("Comment", cid);

    if (user.role !== "admin" && comment.authorId !== user.id) {
      throw new ForbiddenError();
    }

    await deleteComment(db, cid);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.comment_deleted",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { commentId: cid },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Share endpoints ──

  const shareSchema = z.object({
    targetType: z.enum(["user", "group"]),
    targetId: z.string().min(1),
    permission: z.enum(["viewer", "editor"]).default("viewer"),
  });

  router.get("/documents/:id/shares", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    assertOwnerOrAdmin(user, doc);
    const data = await listDocumentShares(db, id);
    return c.json({ success: true, data });
  });

  router.post("/documents/:id/shares", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    assertOwnerOrAdmin(user, doc);

    const body = shareSchema.parse(await c.req.json());
    const share = await addDocumentShare(db, { documentId: id, ...body });

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.share_added",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { targetType: body.targetType, targetId: body.targetId, permission: body.permission },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: share }, 201);
  });

  router.delete("/documents/:id/shares/:shareId", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const shareId = c.req.param("shareId");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    assertOwnerOrAdmin(user, doc);

    const share = await getDocumentShareById(db, shareId);
    if (!share || share.documentId !== id)
      throw new NotFoundError("Share", shareId);

    await removeDocumentShare(db, shareId);

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.share_removed",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { shareId, targetType: share.targetType, targetId: share.targetId },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: null });
  });

  return router;
}
