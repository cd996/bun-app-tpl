import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import {
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listAttachmentsByOwner,
  makeAttachmentView,
  releaseAllByOwner,
  releaseReference,
  uploadAndReference,
} from "@/modules/file";
import { mountItemCommentRoutes } from "@/modules/item/comment.routes";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { MAX_UPLOAD_BYTES } from "@/shared/lib/upload-limits";
import { authRequired } from "@/shared/middleware/auth";
import {
  addDocumentShare,
  createDocument,
  getDocumentById,
  getDocumentPermission,
  getDocumentShareById,
  getDocumentTreeForUser,
  isVersionConflict,
  listActiveUsers,
  listAllGroups,
  listAllTags,
  listDescendantIds,
  listDocuments,
  listDocumentSharesWithInheritance,
  listMyDocuments,
  removeDocumentShare,
  resolveDocumentItem,
  softDeleteDocument,
  updateDocument,
} from "./document.service";

const tagSchema = z.string().min(1).max(50).regex(/^[\w-]+$/);

const createSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  parentId: z.string().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  parentId: z.string().nullable().optional(),
  commentsLocked: z.boolean().optional(),
  version: z.number().int().nonnegative(),
}).refine(d => Object.entries(d).some(([k, v]) => k !== "version" && v !== undefined), {
  message: "At least one mutable field must be provided",
});

const moveSchema = z.object({
  parentId: z.string().nullable(),
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

async function assertMoveTargetAllowed(
  db: Parameters<typeof getDocumentPermission>[0],
  user: { id: string; role: string },
  movingId: string,
  targetParentId: string | null,
) {
  if (targetParentId === null)
    return;
  if (targetParentId === movingId)
    throw new AppError("A document cannot be its own parent", 400, "INVALID_MOVE");

  const target = await getDocumentById(db, targetParentId);
  if (!target)
    throw new NotFoundError("Document", targetParentId);
  await assertAccess(db, user, target, "editor");

  const descendants = await listDescendantIds(db, movingId);
  if (descendants.includes(targetParentId)) {
    throw new AppError("Cannot move a document under its own descendant", 400, "INVALID_MOVE");
  }
}

export function documentRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", authRequired);

  router.get("/documents", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const q = c.req.query("q");
    const tag = c.req.query("tag");
    const creatorId = c.req.query("creator_id");
    const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

    const isAdmin = user.role === "admin";
    const result = isAdmin
      ? await listDocuments(db, { q, tag, creatorId, page, limit })
      : await listMyDocuments(db, { userId: user.id, q, tag, page, limit });

    return c.json({
      success: true,
      data: result.data,
      meta: { total: result.total, page, limit },
    });
  });

  router.get("/documents/tree", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const data = await getDocumentTreeForUser(db, user);
    return c.json({ success: true, data });
  });

  router.get("/documents/tags", async (c) => {
    const db = c.get("db");
    const tags = await listAllTags(db);
    return c.json({ success: true, data: tags });
  });

  router.get("/documents/users", async (c) => {
    const db = c.get("db");
    const data = await listActiveUsers(db);
    return c.json({ success: true, data });
  });

  router.get("/documents/groups", async (c) => {
    const db = c.get("db");
    const data = await listAllGroups(db);
    return c.json({ success: true, data });
  });

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

  router.get("/documents/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");
    return c.json({ success: true, data: doc });
  });

  router.patch("/documents/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getDocumentById(db, id);
    if (!existing)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, existing, "editor");

    const body = updateSchema.parse(await c.req.json());

    if (body.parentId !== undefined && body.parentId !== existing.parentId) {
      await assertMoveTargetAllowed(db, user, id, body.parentId);
    }

    if (body.commentsLocked !== undefined && body.commentsLocked !== existing.commentsLocked) {
      const isOwner = existing.creatorId === user.id;
      const isAdmin = user.role === "admin";
      if (!isOwner && !isAdmin)
        throw new ForbiddenError("Only the document creator or an admin can change the comment lock state");
    }

    const { version: expectedVersion, ...rest } = body;
    const updated = await updateDocument(db, id, { ...rest, expectedVersion });
    if (!updated)
      throw new NotFoundError("Document", id);
    if (isVersionConflict(updated)) {
      return c.json(
        { success: false, error: { code: "VERSION_CONFLICT", message: "Document was modified by another writer" }, data: updated.current },
        409,
      );
    }

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

  router.patch("/documents/:id/move", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getDocumentById(db, id);
    if (!existing)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, existing, "editor");

    const body = moveSchema.parse(await c.req.json());
    await assertMoveTargetAllowed(db, user, id, body.parentId);

    const moved = await updateDocument(db, id, { parentId: body.parentId });
    if (!moved || isVersionConflict(moved))
      throw new NotFoundError("Document", id);

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.updated",
      resourceType: "document",
      resourceId: id,
      resourceName: existing.title,
      detail: { moved: { from: existing.parentId, to: body.parentId } },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: moved });
  });

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

    const descendantIds = await listDescendantIds(db, id);
    const descendantRows = await Promise.all(descendantIds.map(d => getDocumentById(db, d)));

    // Release every attachment in the subtree before stamping deleted_at —
    // refcounts drain so the async GC reclaims any blobs that were only
    // referenced by the deleted documents.
    const item = await resolveDocumentItem(db, id);
    if (item)
      await releaseAllByOwner(db, "item_attachment", item.id);
    for (const dId of descendantIds) {
      const dItem = await resolveDocumentItem(db, dId);
      if (dItem)
        await releaseAllByOwner(db, "item_attachment", dItem.id);
    }

    await softDeleteDocument(db, id);

    const meta = auditMeta(c);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.deleted",
      resourceType: "document",
      resourceId: id,
      resourceName: existing.title,
      ...meta,
      result: "success",
    });
    for (const d of descendantRows) {
      if (!d)
        continue;
      await audit(db, {
        actorId: user.id,
        actorName: user.name,
        action: "document.deleted",
        resourceType: "document",
        resourceId: d.id,
        resourceName: d.title,
        detail: { cascadedFrom: id },
        ...meta,
        result: "success",
      });
    }
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
    const item = await resolveDocumentItem(db, id);
    if (!item)
      throw new NotFoundError("Document", id);

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_UPLOAD_BYTES) {
      throw new AppError("Upload too large", 413, "UPLOAD_TOO_LARGE");
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new AppError("No file provided", 400, "VALIDATION_ERROR");
    }
    const { reference, file: uploaded } = await uploadAndReference(db, {
      file,
      ownerType: "item_attachment",
      ownerId: item.id,
      uploadedBy: user.id,
    });
    const view = makeAttachmentView(reference, uploaded);

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.attachment_uploaded",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { attachmentId: reference.id, filename: file.name, size: file.size },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: view }, 201);
  });

  router.get("/documents/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const doc = await getDocumentById(db, id);
    if (!doc)
      throw new NotFoundError("Document", id);
    await assertAccess(db, user, doc, "viewer");
    const item = await resolveDocumentItem(db, id);
    if (!item)
      throw new NotFoundError("Document", id);
    const data = await listAttachmentsByOwner(db, "item_attachment", item.id);
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
    const item = await resolveDocumentItem(db, id);
    if (!item)
      throw new NotFoundError("Document", id);
    const ref = await getReferenceById(db, aid);
    if (!ref || ref.ownerType !== "item_attachment" || ref.ownerId !== item.id)
      throw new NotFoundError("Attachment", aid);
    const file = await getFileById(db, ref.fileId);
    if (!file)
      throw new NotFoundError("File", aid);
    const wantInline = c.req.query("inline") === "true";
    return await buildDownloadResponse(file, ref, { inline: wantInline });
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
    const item = await resolveDocumentItem(db, id);
    if (!item)
      throw new NotFoundError("Document", id);
    const ref = await getReferenceById(db, aid);
    if (!ref || ref.ownerType !== "item_attachment" || ref.ownerId !== item.id)
      throw new NotFoundError("Attachment", aid);
    await releaseReference(db, { referenceId: aid });
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "document.attachment_deleted",
      resourceType: "document",
      resourceId: id,
      resourceName: doc.title,
      detail: { attachmentId: aid, filename: ref.filename },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Comments + attachments (delegated to mod-item) ──
  mountItemCommentRoutes(router, {
    routePrefix: "/documents",
    resourceType: "document",
    maxCommentLength: 10000,
    async resolve(db, idParam) {
      const doc = await getDocumentById(db, idParam);
      if (!doc)
        return null;
      const item = await resolveDocumentItem(db, idParam);
      if (!item)
        return null;
      return { item, resource: doc, externalId: idParam, resourceName: doc.title };
    },
    async permissions(db, user, subject) {
      const isAdmin = user.role === "admin";
      const canView = isAdmin
        || subject.resource.creatorId === user.id
        || (await getDocumentPermission(db, subject.resource.id, user.id)) !== null;
      return {
        canRead: canView,
        canPost: canView && !subject.resource.commentsLocked,
        // Documents do not currently distinguish internal vs public
        // comments. `item_comments.is_internal` defaults to `false`
        // (set by ItemService.createComment), so passing `true` is safe
        // and forward-compatible — the day the sub-type wants to flip
        // some comments to internal, viewer-only callers will still be
        // shielded if this flag is recomputed.
        includeInternal: true,
        canDelete: authorId => isAdmin || authorId === user.id,
      };
    },
  });

  // ── Share endpoints (policy tuples) ──

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
    const data = await listDocumentSharesWithInheritance(db, id);
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
    const share = await addDocumentShare(db, {
      documentId: id,
      ...body,
      createdBy: user.id,
    });

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

    return c.json(
      {
        success: true,
        data: share,
        note: "Share applies recursively to all descendant documents.",
      },
      201,
    );
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
