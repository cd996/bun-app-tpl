# Document Module

Document workspace with nested documents (Outline-style self-nesting), attachments, comments, and policy-based sharing with inheritance.

## File layout

```text
apps/api/src/modules/document/
  schema.ts                  # documents / *_attachments / *_comments / *_shares
  document.routes.ts
  document.service.ts
  attachment.service.ts
  comment.service.ts
  index.ts
```

## Database

| Table | Purpose |
|---|---|
| `documents` | Document records: title, content, tags, creator, `parent_id` (self-FK, null = root, `ON DELETE CASCADE`), `version` (optimistic-concurrency counter). Folders are not a separate concept — top-level documents act as containers when needed. |
| `document_attachments` | File attachments. Stored in `data/uploads/document/`. |
| `document_comments` | Comments on a document. |
| `document_shares` | Per-document share grants (target user/group, viewer/editor). Tied into the policy module via `relation_tuples`. |

## Routes

Mounted under `protectedRoutes`. All routes require `authRequired`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/documents` | Lists documents the caller can read (flat, paginated). |
| POST | `/api/documents` | Creates a document. Body accepts nullable `parentId` (self-nesting). |
| GET | `/api/documents/tree` | Returns every document the caller can read as `{ id, title, parentId, updatedAt, childCount }[]`. Siblings sorted case-insensitively by title. No `content` / `tags` — payload kept light. |
| GET | `/api/documents/tags` | All tags in use. |
| GET | `/api/documents/users` | Active users (for share UI). |
| GET | `/api/documents/groups` | Groups (for share UI). |
| GET | `/api/documents/:id` | Document detail (includes `parentId`, `version`). |
| PATCH | `/api/documents/:id` | Updates a document. Body **must** include `version` (the value last observed by the caller). Mismatch returns 409 with the current row. May also include `parentId` to move; subject to the same cycle / access checks as `PATCH /:id/move`. Bumps `version`. |
| PATCH | `/api/documents/:id/move` | Re-parents a document. Body: `{ parentId: string \| null }`. Validates: target exists, caller can edit `:id` and the target (or null), and the move would not create a cycle. Bumps `version`. |
| DELETE | `/api/documents/:id` | Deletes a document and the entire subtree under it (FK cascade). One `document.deleted` audit event is emitted per dropped descendant. |
| GET / POST / DELETE | `/api/documents/:id/attachments[...]` | Attachment CRUD. |
| GET / POST / DELETE | `/api/documents/:id/comments[...]` | Comment CRUD. |
| GET / POST / DELETE | `/api/documents/:id/shares[...]` | Share grants (writes also create policy tuples). `GET` includes inherited grants — see [Permissions](#permissions). |

## Permissions

Document permissions follow a **parent-to-child inheritance** model. The effective permission of a user on a document is the strongest grant found on the document **or any of its ancestors**:

1. **Self grants** — `document_shares` rows where `document_id = doc.id`.
2. **Inherited grants** — for each ancestor `D₁, D₂, …, root`, all `document_shares` rows on that ancestor apply to the descendant.
3. **Override-escalate only** — when the same `(user, document)` pair has multiple grants in the chain, the strongest wins (`editor > viewer`). A child-level grant can **escalate** an inherited permission (parent viewer → child editor) but cannot **restrict** it (parent editor + child viewer ⇒ still editor). Explicit deny is not supported in this iteration.
4. **Ownership** — the creator of a document always has effective editor access on it. Children do not inherit ownership; each child has its own `creator_id`.
5. **Admin** — admins bypass all share checks.

The check is implemented in `document.service.ts::getDocumentPermission` via a recursive CTE walking `parent_id` upward; a 1 000-deep chain resolves in well under 50 ms. The same logic drives `listMyDocuments`, `getDocumentTreeForUser`, and every `assertAccess` in the routes — once a share is added at any node, every descendant immediately appears for the grantee.

### Share dialog (`GET /api/documents/:id/shares`)

Each row returned by `GET /api/documents/:id/shares` carries:

```json
{
  "id": "share-id",
  "documentId": "the doc that owns this row (may be an ancestor)",
  "targetType": "user" | "group",
  "targetId": "...",
  "permission": "viewer" | "editor",
  "createdAt": "...",
  "inheritedFrom": null | { "id": "ancestor-doc-id", "title": "Ancestor title" }
}
```

`inheritedFrom = null` means the share is on this document directly and is removable through the usual `DELETE /api/documents/:id/shares/:shareId`. `inheritedFrom = { ... }` means the share was placed on an ancestor; the UI renders such rows as non-removable. To revoke an inherited grant, navigate to the source document and remove it there.

### Adding shares

`POST /api/documents/:id/shares` returns `note: "Share applies recursively to all descendant documents."` so the caller is reminded that placing a share at this node also grants access to everything nested below. No additional rows are written — inheritance is computed at read time.

## Audit

`document.created`, `document.updated`, `document.deleted`, `document.attachment_uploaded`, `document.attachment_deleted`, `document.comment_added`, `document.comment_deleted`, `document.share_added`, `document.share_removed`.

`document.share_added` / `document.share_removed` fire only on explicit changes to `document_shares`. Inherited grants are computed on read and do not generate audit events of their own.

## Out of scope

- Document version history.
- Realtime collaborative editing (single-author updates only).
- Trash / soft delete.
