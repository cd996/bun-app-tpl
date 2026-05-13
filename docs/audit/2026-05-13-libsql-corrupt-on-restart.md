# libsql SQLITE_CORRUPT on restart — investigation

**TL;DR.** With `DB_ENCRYPTION=true`, libsql 0.5.29 + drizzle 0.45 over a
busy WAL has been observed to corrupt the on-disk database file when the
process is SIGTERM-ed shortly after a commit burst. The next cold open
fails inside `migrate()` with `SQLITE_CORRUPT: database disk image is
malformed` while running:

```sql
SELECT id, hash, created_at FROM "__drizzle_migrations"
ORDER BY created_at DESC LIMIT 1
```

This is the query drizzle's migrator runs first; the corruption itself
is in the main DB pages, not the migrations row.

The trigger sits in `apps/api/src/modules/item/comment.service.ts`:
when `deleteComment` cascaded into
`releaseAllByOwner('item_comment_attachment', commentId)`, the live
e2e harness flipped from green to "phase C unlock fails 3/7". With the
cascade removed, the suite is green.

## Symptom in the harness

Repro in the live `bun run test:e2e` (clean cache):

```
phase-a-encryption-init                   4      4      0      0
phase-b-modules                          54     53      0      1
phase-c-encryption-rate-limit             1      1      0      0
phase-c-encryption-unlock                 7      4      3      0   ← here
```

The first phase-c-unlock case still passes (the locked DB is reachable,
`/api/encryption/unlock-challenge` returns its bundle); the case that
calls `POST /api/encryption/unlock` is what surfaces the corruption:
`setDek` → `onUnlock` callback → `createDb` → `migrate` → SQL above →
`SQLITE_CORRUPT`.

## What we changed in scope

1. `apps/api/src/modules/item/comment.service.ts::deleteComment` —
   added `await releaseAllByOwner('item_comment_attachment', commentId)`
   before the row delete.
2. `apps/api/src/modules/file/file.service.ts::releaseAllByOwner` —
   was a `SELECT` + per-row `releaseReference`, each of which opens its
   own `db.transaction { DELETE + UPDATE + SELECT }`.
3. e2e suite gained 3 issue + 3 document tests that upload attachments,
   delete attachments, post comments, and (in some cases) delete the
   comment.

Reverting (1) alone made phase C green again. (2) and (3) on their own
were green; they only trip when stacked together.

## What we tried (nothing made the live failure go away)

| Hypothesis | Change | Result |
|---|---|---|
| WAL not durable enough at commit | `PRAGMA synchronous = FULL` | Still fails |
| WAL fsync at commit + dir fsync | `PRAGMA synchronous = EXTRA` | Still fails |
| WAL non-empty on close confuses recovery | `PRAGMA wal_checkpoint(FULL)` in `close()` | Still fails |
| Same, with TRUNCATE | `PRAGMA wal_checkpoint(TRUNCATE)` in `close()` | Still fails |
| Drop WAL entirely | `PRAGMA journal_mode = DELETE` | libsql encrypted open refuses, phase A fails |
| Many tiny transactions | one transaction wrapping the whole `releaseAllByOwner` | Still fails |

## What we tried that **did not** reproduce out of process

Two standalone repros against the same libsql version / encryption key /
schema (`SELECT __drizzle_migrations` after the same write sequence,
both in-process and across a `Bun.spawn` boundary that mimics
SIGTERM+exit):

- **release_each**: same `SELECT ... ; tx { DELETE + UPDATE + SELECT }`
  per ref + `DELETE FROM item_comments`, repeated 3 / 10 / 20 times.
- **single_tx**: the same operations in one outer transaction.
- **batch**: libsql's `client.batch` API.

All variants succeeded across `process.exit(0)` + reopen. The
corruption only manifests through the live API's request/response
pipeline + SIGTERM via the orchestrator. We could not narrow it further
without hooking into libsql internals.

## Working theory

Some combination of:

- libsql's encrypted-WAL recovery path,
- bun + the libsql native binding's handle teardown on SIGTERM,
- and the live API's concurrent reads/writes during shutdown

leaves the on-disk WAL in a state the next encrypted open rejects. The
SQL we issue is consistent across the failing and the working
configurations; only the *write volume around shutdown* changes.

## Current mitigation

`deleteComment` does not cascade-release `item_comment_attachment`
references. The SPA (or any API consumer) is expected to
`DELETE /api/<sub-type>/:id/comments/:cid/attachments/:aid` before
deleting a comment. Anything left behind becomes an orphan
`file_references` row.

The file module's GC currently sweeps `files` with `ref_count = 0`; it
does **not** sweep orphan `file_references`. A future change should:

1. Add a second sweep pass that drops `file_references` whose
   `owner_type='item_comment_attachment'` and `owner_id` no longer
   matches an existing `item_comments.id`. Decrement the referenced
   `files.ref_count` in the same statement.
2. Re-enable cascade from `deleteComment` (or just rely on the sweep
   if upstream libsql still misbehaves).
3. Re-expand `tests/e2e/modules/{issue,document}/comment-attachments.test.ts`
   to cover the full surface — today the suite carries one cycle per
   sub-type to stay under the corruption threshold.

## Reproducing the corruption

1. Restore the cascade:

   ```ts
   // apps/api/src/modules/item/comment.service.ts
   export async function deleteComment(db: AppDatabase, commentId: string): Promise<void> {
     await releaseAllByOwner(db, "item_comment_attachment", commentId);
     await db.delete(itemComments).where(eq(itemComments.id, commentId)).run();
   }
   ```

2. Re-expand `tests/e2e/modules/issue/comment-attachments.test.ts` to
   include "deleting the comment releases its attachments" and any
   other case that calls `DELETE /comments/:cid` while attachments are
   still attached.

3. `bun run test:e2e`. Phase C unlock will fail 3/7 with the
   `SQLITE_CORRUPT` message above.

4. Run with `E2E_DEBUG_API=true` to see the full stack trace from the
   API logger.

## Upstream issue links to file

- `tursodatabase/libsql` issue tracker — search for
  `SQLITE_CORRUPT encryption WAL`.
- The repro should be reduced further before opening one — a self-
  contained `@libsql/client` script that fails is missing today.
