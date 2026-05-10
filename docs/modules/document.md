# Document Module

Document workspace with folders, attachments, comments, and policy-based sharing.

## File layout

```text
apps/api/src/modules/document/
  schema.ts                  # document_folders / documents / *_attachments / *_comments / *_shares
  document.routes.ts
  document.service.ts
  attachment.service.ts
  comment.service.ts
  index.ts
```

## Database

| Table | Purpose |
|---|---|
| `document_folders` | Folder tree (one level; flat). |
| `documents` | Document records: title, content, tags, folder, creator. |
| `document_attachments` | File attachments. Stored in `data/uploads/document/`. |
| `document_comments` | Comments on a document. |
| `document_shares` | Per-document share grants (target user/group, viewer/editor). Tied into the policy module via `relation_tuples`. |

## Routes

Mounted under `protectedRoutes`. All routes require `authRequired`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/documents` | Lists documents the caller can read. |
| POST | `/api/documents` | Creates a document. |
| GET | `/api/documents/tags` | All tags in use. |
| GET | `/api/documents/users` | Active users (for share UI). |
| GET | `/api/documents/groups` | Groups (for share UI). |
| GET | `/api/documents/folders` | Folder list. |
| POST | `/api/documents/folders` | Creates a folder. |
| PATCH | `/api/documents/folders/:fid` | Renames a folder. |
| DELETE | `/api/documents/folders/:fid` | Deletes a folder. |
| GET | `/api/documents/:id` | Document detail. |
| PATCH | `/api/documents/:id` | Updates a document. |
| DELETE | `/api/documents/:id` | Deletes a document. |
| GET / POST / DELETE | `/api/documents/:id/attachments[...]` | Attachment CRUD. |
| GET / POST / DELETE | `/api/documents/:id/comments[...]` | Comment CRUD. |
| GET / POST / DELETE | `/api/documents/:id/shares[...]` | Share grants (writes also create policy tuples). |

## Audit

`document.created`, `document.updated`, `document.deleted`, `document.attachment_uploaded`, `document.attachment_deleted`, `document.comment_added`, `document.comment_deleted`, `document.share_added`, `document.share_removed`.

## Out of scope

- Document version history.
- Realtime collaborative editing (single-author updates only).
- Trash / soft delete.
