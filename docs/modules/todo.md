# Todo Module

Personal task tracking with attachments and comments.

## File layout

```text
apps/api/src/modules/todo/
  schema.ts              # todos / todo_attachments / todo_comments
  todo.routes.ts
  todo.service.ts
  attachment.service.ts
  comment.service.ts
  attachment.test.ts
  comment.test.ts
  todo.test.ts
  index.ts
```

## Database

| Table | Purpose |
|---|---|
| `todos` | Task records: title, description, status, priority, creator, assignee, due date. |
| `todo_attachments` | File attachments owned by a todo. Stored in `data/uploads/todo/`. |
| `todo_comments` | Threaded comments on a todo. |

Soft delete is not used; deletes cascade to attachments and comments.

## Routes

Mounted at `/api/todos` under `protectedRoutes` (`requireUnlocked` + per-route `authRequired`).

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/todos` | Authenticated | Lists todos (filterable by status, priority, assignee). |
| POST | `/api/todos` | Authenticated | Creates a todo. |
| GET | `/api/todos/:id` | Authenticated | Todo detail. |
| PATCH | `/api/todos/:id` | Authenticated | Updates a todo. |
| DELETE | `/api/todos/:id` | Authenticated | Deletes a todo. |
| GET | `/api/todos/:id/attachments` | Authenticated | Lists attachments. |
| POST | `/api/todos/:id/attachments` | Authenticated | Uploads an attachment (multipart). |
| GET | `/api/todos/:id/attachments/:aid` | Authenticated | Downloads an attachment. |
| DELETE | `/api/todos/:id/attachments/:aid` | Authenticated | Deletes an attachment. |
| GET | `/api/todos/:id/comments` | Authenticated | Lists comments. |
| POST | `/api/todos/:id/comments` | Authenticated | Adds a comment. |
| DELETE | `/api/todos/:id/comments/:cid` | Authenticated | Deletes a comment. |

## Audit

`todo.created`, `todo.assigned`, `todo.status_changed`, `todo.updated`, `todo.deleted`, `todo.attachment_uploaded`, `todo.attachment_deleted`, `todo.comment_added`, `todo.comment_deleted`.

## Out of scope

- Subtasks, recurring tasks, reminders.
- Cross-user todo sharing beyond the assignee field (no policy tuples for todos in current schema).
