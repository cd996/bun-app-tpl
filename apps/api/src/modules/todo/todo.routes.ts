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
  deleteTodoAttachments,
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
  createTodo,
  deleteTodo,
  getTodoById,
  getUserById,
  listMyTodos,
  listTodos,
  updateTodo,
} from "./todo.service";

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.string().max(30).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueDate: z.string().max(30).nullable().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: "At least one field must be provided",
});

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

/** Check if the user can access this todo (admin can access all). */
function assertAccess(user: { id: string; role: string }, todo: { creatorId: string; assigneeId: string | null }) {
  if (user.role === "admin")
    return;
  if (todo.creatorId !== user.id && todo.assigneeId !== user.id) {
    throw new ForbiddenError();
  }
}

export function todoRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  router.use("*", authRequired);

  // GET /todos — list (admin: all, user: own)
  router.get("/todos", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const q = c.req.query("q");
    const status = c.req.query("status");
    const priority = c.req.query("priority");
    const assigneeId = c.req.query("assignee_id");
    const creatorId = c.req.query("creator_id");
    const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

    const isAdmin = user.role === "admin";
    const result = isAdmin
      ? await listTodos(db, { q, status, priority, assigneeId, creatorId, page, limit })
      : await listMyTodos(db, { userId: user.id, q, status, priority, page, limit });

    return c.json({
      success: true,
      data: result.data,
      meta: { total: result.total, page, limit },
    });
  });

  // POST /todos — create
  router.post("/todos", async (c) => {
    const db = c.get("db");
    const body = createSchema.parse(await c.req.json());
    const actor = c.get("user")!;

    if (body.assigneeId) {
      const assignee = await getUserById(db, body.assigneeId);
      if (!assignee)
        throw new NotFoundError("User", body.assigneeId);
    }

    const todo = await createTodo(db, { ...body, creatorId: actor.id });

    await audit(db, {
      actorId: actor.id,
      actorName: actor.name,
      action: "todo.created",
      resourceType: "todo",
      resourceId: todo.id,
      resourceName: todo.title,
      ...(body.assigneeId ? { detail: { assigneeId: body.assigneeId } } : {}),
      ...auditMeta(c),
      result: "success",
    });

    if (body.assigneeId) {
      await audit(db, {
        actorId: actor.id,
        actorName: actor.name,
        action: "todo.assigned",
        resourceType: "todo",
        resourceId: todo.id,
        resourceName: todo.title,
        detail: { from: null, to: body.assigneeId },
        ...auditMeta(c),
        result: "success",
      });
    }

    return c.json({ success: true, data: todo }, 201);
  });

  // GET /todos/:id — detail (admin: any, user: own)
  router.get("/todos/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const todo = await getTodoById(db, c.req.param("id"));
    if (!todo)
      throw new NotFoundError("Todo", c.req.param("id"));
    assertAccess(user, todo);
    return c.json({ success: true, data: todo });
  });

  // PATCH /todos/:id — update (admin: full, user: creator full / assignee status only)
  router.patch("/todos/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getTodoById(db, id);
    if (!existing)
      throw new NotFoundError("Todo", id);
    assertAccess(user, existing);

    const body = updateSchema.parse(await c.req.json());
    const isAdmin = user.role === "admin";
    const isCreator = existing.creatorId === user.id;

    // Non-admin assignee (non-creator) can only change status
    if (!isAdmin && !isCreator) {
      const nonStatusKeys = Object.keys(body).filter(k => k !== "status");
      if (nonStatusKeys.length > 0) {
        throw new AppError("Assignees can only update status", 403, "FORBIDDEN");
      }
    }

    if (body.assigneeId) {
      const assignee = await getUserById(db, body.assigneeId);
      if (!assignee)
        throw new NotFoundError("User", body.assigneeId);
    }

    const updated = await updateTodo(db, id, body);

    const detail: Record<string, unknown> = {};
    if (body.status && body.status !== existing.status) {
      detail.previousStatus = existing.status;
      detail.newStatus = body.status;
    }

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "todo.updated",
      resourceType: "todo",
      resourceId: id,
      resourceName: existing.title,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
      ...auditMeta(c),
      result: "success",
    });

    if (body.status && body.status !== existing.status) {
      await audit(db, {
        actorId: user.id,
        actorName: user.name,
        action: "todo.status_changed",
        resourceType: "todo",
        resourceId: id,
        resourceName: existing.title,
        detail: { previous: existing.status, new: body.status },
        ...auditMeta(c),
        result: "success",
      });
    }

    if (body.assigneeId !== undefined && body.assigneeId !== existing.assigneeId) {
      await audit(db, {
        actorId: user.id,
        actorName: user.name,
        action: "todo.assigned",
        resourceType: "todo",
        resourceId: id,
        resourceName: existing.title,
        detail: { from: existing.assigneeId, to: body.assigneeId },
        ...auditMeta(c),
        result: "success",
      });
    }

    return c.json({ success: true, data: updated });
  });

  // DELETE /todos/:id — delete (admin: any, user: creator only)
  router.delete("/todos/:id", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const existing = await getTodoById(db, id);
    if (!existing)
      throw new NotFoundError("Todo", id);

    if (user.role !== "admin" && existing.creatorId !== user.id) {
      throw new ForbiddenError();
    }

    await deleteTodoAttachments(db, id);
    await deleteTodo(db, id);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "todo.deleted",
      resourceType: "todo",
      resourceId: id,
      resourceName: existing.title,
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Attachment endpoints ──

  // POST /todos/:id/attachments — upload (admin: any, user: creator or assignee)
  router.post("/todos/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);

    if (!(await canAddAttachment(db, id))) {
      throw new AppError("Maximum attachments per task reached (20)", 400, "LIMIT_EXCEEDED");
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
      action: "todo.attachment_uploaded",
      resourceType: "todo",
      resourceId: id,
      resourceName: todo.title,
      detail: { attachmentId: attachment.id, filename: file.name, size: file.size },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: attachment }, 201);
  });

  // GET /todos/:id/attachments — list
  router.get("/todos/:id/attachments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);
    const data = await listAttachments(db, id);
    return c.json({ success: true, data });
  });

  // GET /todos/:id/attachments/:aid — download
  router.get("/todos/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);
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

  // DELETE /todos/:id/attachments/:aid — delete (admin: any, creator: any, uploader: own)
  router.delete("/todos/:id/attachments/:aid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);
    const attachment = await getAttachmentById(db, id, aid);
    if (!attachment)
      throw new NotFoundError("Attachment", aid);

    // Non-admin: only creator of the todo or uploader of the attachment can delete
    if (user.role !== "admin" && todo.creatorId !== user.id && attachment.uploadedBy !== user.id) {
      throw new ForbiddenError();
    }

    await deleteAttachment(db, attachment);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "todo.attachment_deleted",
      resourceType: "todo",
      resourceId: id,
      resourceName: todo.title,
      detail: { attachmentId: aid, filename: attachment.filename },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  // ── Comment endpoints ──

  const commentSchema = z.object({
    content: z.string().min(1).max(2000),
  });

  // GET /todos/:id/comments — list comments
  router.get("/todos/:id/comments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);
    const data = await listComments(db, id);
    return c.json({ success: true, data });
  });

  // POST /todos/:id/comments — add comment
  router.post("/todos/:id/comments", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);

    const body = commentSchema.parse(await c.req.json());
    const comment = await createComment(db, { todoId: id, authorId: user.id, content: body.content });

    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "todo.comment_added",
      resourceType: "todo",
      resourceId: id,
      resourceName: todo.title,
      detail: { commentId: comment.id },
      ...auditMeta(c),
      result: "success",
    });

    return c.json({ success: true, data: comment }, 201);
  });

  // DELETE /todos/:id/comments/:cid — delete comment (author or admin)
  router.delete("/todos/:id/comments/:cid", async (c) => {
    const db = c.get("db");
    const user = c.get("user")!;
    const id = c.req.param("id");
    const cid = c.req.param("cid");
    const todo = await getTodoById(db, id);
    if (!todo)
      throw new NotFoundError("Todo", id);
    assertAccess(user, todo);

    const comment = await getCommentById(db, id, cid);
    if (!comment)
      throw new NotFoundError("Comment", cid);

    if (user.role !== "admin" && comment.authorId !== user.id) {
      throw new ForbiddenError();
    }

    await deleteComment(db, cid);
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "todo.comment_deleted",
      resourceType: "todo",
      resourceId: id,
      resourceName: todo.title,
      detail: { commentId: cid },
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: null });
  });

  return router;
}
