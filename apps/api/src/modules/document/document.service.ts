import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { and, count, desc, eq, like, or, sql } from "drizzle-orm";
import { groups } from "@/modules/account/groups/schema";
import { listActiveUsers as listActiveUsersFromAccount } from "@/modules/account/users/users.service";
import { documents, documentShares } from "@/modules/document/schema";
import { listGroupIdsForUser } from "@/modules/policy/policy.service";
import { nanoid } from "@/shared/lib/id";

// Re-export so existing callers (document.routes.ts) keep their imports.
// `listAllGroups` stays local because the account/groups module exposes
// `listGroups` with a different shape (includes memberCount).
export const listActiveUsers = listActiveUsersFromAccount;

interface ListParams {
  readonly q?: string | undefined;
  readonly tag?: string | undefined;
  readonly creatorId?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

interface ListMyParams extends ListParams {
  readonly userId: string;
}

const LIKE_SPECIAL_RE = /[%_]/g;

function escapeLike(v: string): string {
  return v.replace(LIKE_SPECIAL_RE, "\\$&");
}

// FTS5 query builder: split on whitespace, drop characters outside the
// alphanumeric / CJK range (collapses FTS5 operators / quotes / parens that
// would otherwise either fail to parse or misbehave under attacker control),
// and append `*` to enable prefix matching ("hello wor" → `hello* wor*`).
// Empty input returns "" so the caller can shortcut to "no rows".
// eslint-disable-next-line regexp/no-obscure-range, regexp/no-invisible-character, no-irregular-whitespace
const RE_FTS_KEEP = /[^\w一-鿿　-〿]+/g;
const RE_TOKEN_SPLIT = /\s+/;
function buildFtsQuery(raw: string): string {
  const tokens = raw
    .split(RE_TOKEN_SPLIT)
    .map(t => t.replace(RE_FTS_KEEP, ""))
    .filter(t => t.length > 0);
  return tokens.map(t => `${t}*`).join(" ");
}

function buildConditions(params: { q?: string | undefined; tag?: string | undefined }) {
  const conditions = [];
  if (params.q) {
    // FTS5: prefix-token AND across title + content. Falls back to a
    // never-true predicate when the input has no usable tokens (so the
    // caller correctly returns an empty page instead of every row).
    const fts = buildFtsQuery(params.q);
    conditions.push(
      fts.length === 0
        ? sql`1 = 0`
        : sql`${documents.id} IN (SELECT id FROM documents_fts WHERE documents_fts MATCH ${fts})`,
    );
  }
  if (params.tag) {
    // tags stored as JSON array, e.g. ["guide","internal"] — search with LIKE
    conditions.push(like(documents.tags, `%"${escapeLike(params.tag)}"%`));
  }
  return conditions;
}

export async function listDocuments(db: AppDatabase, params: ListParams = {}) {
  const { q, tag, creatorId, page = 1, limit = 20 } = params;

  const conditions = buildConditions({ q, tag });
  if (creatorId) {
    conditions.push(eq(documents.creatorId, creatorId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = await db.select({ value: count() }).from(documents).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(documents)
    .where(where)
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

/**
 * Returns a SQL fragment usable in a WHERE clause that matches `documents.id`
 * against every doc the user can read via a share — direct **or inherited
 * from an ancestor**. A share placed on a document grants the same access to
 * the entire subtree below it; the recursive CTE walks the parent chain
 * downward starting from each shared doc.
 *
 * Use with `or(eq(documents.creatorId, userId), userVisibleViaSharesCondition(...))`
 * to also include docs the user created.
 */
function userVisibleViaSharesCondition(userId: string, groupIds: readonly string[]): SQL {
  const groupClause = groupIds.length > 0
    ? sql`OR (s.target_type = 'group' AND s.target_id IN (${sql.join(groupIds.map(g => sql`${g}`), sql`, `)}))`
    : sql``;
  return sql`${documents.id} IN (
    WITH RECURSIVE visible(id) AS (
      SELECT s.document_id FROM ${documentShares} s
      WHERE (s.target_type = 'user' AND s.target_id = ${userId})
        ${groupClause}
      UNION
      SELECT d.id FROM ${documents} d JOIN visible v ON d.parent_id = v.id
    )
    SELECT id FROM visible
  )`;
}

export async function listMyDocuments(db: AppDatabase, params: ListMyParams) {
  const { userId, q, tag, page = 1, limit = 20 } = params;

  // The user's group ids are a small set — typically <10 — so it is safe to
  // inline as an `IN (...)`. Visibility now follows inheritance: a share on
  // an ancestor grants access to the whole subtree, computed via a recursive
  // CTE inside `userVisibleViaSharesCondition`.
  const groupIds = await listGroupIdsForUser(db, userId);

  const ownershipCondition = or(
    eq(documents.creatorId, userId),
    userVisibleViaSharesCondition(userId, groupIds),
  );

  const searchConditions = buildConditions({ q, tag });
  const where = searchConditions.length > 0
    ? and(ownershipCondition, ...searchConditions)
    : ownershipCondition;

  const totalRow = await db.select({ value: count() }).from(documents).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(documents)
    .where(where)
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

export async function getDocumentById(db: AppDatabase, id: string) {
  return await db.select().from(documents).where(eq(documents.id, id)).get();
}

export async function createDocument(db: AppDatabase, data: {
  title: string;
  content?: string | undefined;
  tags?: readonly string[] | undefined;
  parentId?: string | null | undefined;
  creatorId: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documents).values({
    id,
    title: data.title,
    content: data.content ?? null,
    tags: JSON.stringify(data.tags ?? []),
    parentId: data.parentId ?? null,
    version: 1,
    creatorId: data.creatorId,
    createdAt: now,
    updatedAt: now,
  }).run();
  if (data.tags && data.tags.length > 0)
    invalidateTagCache();
  return (await db.select().from(documents).where(eq(documents.id, id)).get())!;
}

/**
 * Returned by {@link updateDocument} and {@link moveDocument} when the caller's
 * `expectedVersion` no longer matches the stored row — another writer has
 * updated the document since the caller last read it.
 */
export interface VersionConflict {
  readonly conflict: true;
  readonly current: typeof documents.$inferSelect;
}

export function isVersionConflict(v: unknown): v is VersionConflict {
  return typeof v === "object" && v !== null && (v as { conflict?: unknown }).conflict === true;
}

export async function updateDocument(db: AppDatabase, id: string, data: {
  title?: string | undefined;
  content?: string | undefined;
  tags?: readonly string[] | undefined;
  parentId?: string | null | undefined;
  expectedVersion?: number | undefined;
}): Promise<typeof documents.$inferSelect | VersionConflict | undefined> {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };
  if (data.title !== undefined)
    setData.title = data.title;
  if (data.content !== undefined)
    setData.content = data.content;
  if (data.tags !== undefined)
    setData.tags = JSON.stringify(data.tags);
  if (data.parentId !== undefined)
    setData.parentId = data.parentId;
  // Always bump version on a successful write so subsequent reads observe a
  // strictly-monotonic counter — auto-save uses this to detect concurrent edits.
  setData.version = sql`${documents.version} + 1`;

  const where = data.expectedVersion !== undefined
    ? and(eq(documents.id, id), eq(documents.version, data.expectedVersion))
    : eq(documents.id, id);

  const result = await db.update(documents).set(setData).where(where).run();
  if (data.expectedVersion !== undefined && result.rowsAffected === 0) {
    // Either the doc is gone or the version doesn't match.
    const current = await db.select().from(documents).where(eq(documents.id, id)).get();
    if (current && current.version !== data.expectedVersion) {
      return { conflict: true, current };
    }
    return current;
  }

  if (data.tags !== undefined)
    invalidateTagCache();
  return await db.select().from(documents).where(eq(documents.id, id)).get();
}

export async function deleteDocument(db: AppDatabase, id: string) {
  // FK on documents.parent_id is ON DELETE CASCADE, so descendants drop in
  // the same statement and their attachments / comments / shares cascade
  // through their own foreign keys.
  await db.delete(documents).where(eq(documents.id, id)).run();
  invalidateTagCache();
}

/**
 * Recursively collect every descendant id of `id` (children, grandchildren …),
 * not including `id` itself. Used by the move-cycle guard.
 */
export async function listDescendantIds(db: AppDatabase, id: string): Promise<readonly string[]> {
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM ${documents} WHERE parent_id = ${id}
      UNION ALL
      SELECT d.id FROM ${documents} d JOIN descendants ON d.parent_id = descendants.id
    )
    SELECT id FROM descendants
  `);
  return rows.map(r => r.id);
}

export async function moveDocument(db: AppDatabase, id: string, parentId: string | null, expectedVersion?: number) {
  const now = new Date().toISOString();
  const where = expectedVersion !== undefined
    ? and(eq(documents.id, id), eq(documents.version, expectedVersion))
    : eq(documents.id, id);
  const result = await db
    .update(documents)
    .set({ parentId, updatedAt: now, version: sql`${documents.version} + 1` })
    .where(where)
    .run();
  if (expectedVersion !== undefined && result.rowsAffected === 0) {
    const current = await db.select().from(documents).where(eq(documents.id, id)).get();
    if (current && current.version !== expectedVersion) {
      return { conflict: true as const, current };
    }
    return current;
  }
  return await db.select().from(documents).where(eq(documents.id, id)).get();
}

export interface DocumentTreeNode {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly updatedAt: string;
  readonly childCount: number;
}

interface TreeRow {
  readonly id: string;
  readonly title: string;
  readonly parent_id: string | null;
  readonly updated_at: string;
  readonly creator_id: string;
}

/**
 * Returns a flat list of every document the caller can read, sorted siblings-
 * first by case-insensitive title. The router assembles a tree client-side or
 * walks it lazily. We deliberately keep `content` / `tags` out — tree payloads
 * stay light enough to support trees with 10k+ nodes.
 *
 * A user can read a document if (a) they created it, (b) it has a share
 * grant against their user id or any of their group ids, or (c) any
 * ancestor of the document has such a grant (inherited). Admins see
 * everything.
 */
export async function getDocumentTreeForUser(
  db: AppDatabase,
  user: { id: string; role: string },
): Promise<readonly DocumentTreeNode[]> {
  const isAdmin = user.role === "admin";

  // Pull only the columns we need; one query, no N+1.
  let rows: readonly TreeRow[];
  if (isAdmin) {
    rows = await db.all<TreeRow>(sql`
      SELECT id, title, parent_id, updated_at, creator_id
      FROM ${documents}
      ORDER BY LOWER(title) ASC
    `);
  }
  else {
    const groupIds = await listGroupIdsForUser(db, user.id);
    // Build an inline parameterised list. The set is small (typically <10).
    const groupClause = groupIds.length > 0
      ? sql`OR (s.target_type = 'group' AND s.target_id IN (${sql.join(groupIds.map(g => sql`${g}`), sql`, `)}))`
      : sql``;
    // Visible set = direct grants ∪ all descendants of any directly-granted
    // doc (inheritance). The recursive CTE walks the parent chain downward.
    rows = await db.all<TreeRow>(sql`
      WITH RECURSIVE visible(id) AS (
        SELECT s.document_id FROM ${documentShares} s
        WHERE (s.target_type = 'user' AND s.target_id = ${user.id})
          ${groupClause}
        UNION
        SELECT d.id FROM ${documents} d JOIN visible v ON d.parent_id = v.id
      )
      SELECT d.id, d.title, d.parent_id, d.updated_at, d.creator_id
      FROM ${documents} d
      WHERE d.creator_id = ${user.id}
        OR d.id IN (SELECT id FROM visible)
      ORDER BY LOWER(d.title) ASC
    `);
  }

  // Count children per parent in a single pass — no per-row query.
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.parent_id) {
      childCount.set(r.parent_id, (childCount.get(r.parent_id) ?? 0) + 1);
    }
  }

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    parentId: r.parent_id,
    updatedAt: r.updated_at,
    childCount: childCount.get(r.id) ?? 0,
  }));
}

export async function listAllGroups(db: AppDatabase) {
  return await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .orderBy(groups.name)
    .all();
}

// ── Share functions ──

export async function addDocumentShare(db: AppDatabase, data: {
  documentId: string;
  targetType: "user" | "group";
  targetId: string;
  permission: "viewer" | "editor";
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  // Upsert: on conflict update permission
  await db.insert(documentShares).values({
    id,
    documentId: data.documentId,
    targetType: data.targetType,
    targetId: data.targetId,
    permission: data.permission,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [documentShares.documentId, documentShares.targetType, documentShares.targetId],
    set: { permission: data.permission },
  }).run();
  // Return the actual row
  return await db.select().from(documentShares).where(and(
    eq(documentShares.documentId, data.documentId),
    eq(documentShares.targetType, data.targetType),
    eq(documentShares.targetId, data.targetId),
  )).get();
}

export async function removeDocumentShare(db: AppDatabase, shareId: string) {
  await db.delete(documentShares).where(eq(documentShares.id, shareId)).run();
}

export async function getDocumentShareById(db: AppDatabase, shareId: string) {
  return await db.select().from(documentShares).where(eq(documentShares.id, shareId)).get();
}

/**
 * Effective permission of `userId` on `documentId`, honoring **share
 * inheritance**: the document's own grants plus those of every ancestor
 * up to the root. Multiple grants for the same `(user, document)` resolve
 * by strongest wins (`editor > viewer`); there is no concept of explicit
 * deny — overrides can only escalate, not restrict. Returns `null` when
 * the user has no grant anywhere in the chain.
 *
 * The recursive CTE walks `parent_id` upward starting at `documentId`,
 * collecting share rows along the way. Performance: a 1 000-deep chain
 * resolves in well under 50 ms on SQLite — there is a row-touch per
 * ancestor, gated by the `idx_documents_parent` index.
 */
export async function getDocumentPermission(db: AppDatabase, documentId: string, userId: string): Promise<"editor" | "viewer" | null> {
  const groupIds = await listGroupIdsForUser(db, userId);

  const groupClause = groupIds.length > 0
    ? sql`OR (s.target_type = 'group' AND s.target_id IN (${sql.join(groupIds.map(g => sql`${g}`), sql`, `)}))`
    : sql``;

  const rows = await db.all<{ permission: "viewer" | "editor" }>(sql`
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM ${documents} WHERE id = ${documentId}
      UNION ALL
      SELECT d.id, d.parent_id
      FROM ${documents} d
      JOIN ancestors a ON d.id = a.parent_id
    )
    SELECT s.permission FROM ancestors a
    JOIN ${documentShares} s ON s.document_id = a.id
    WHERE (s.target_type = 'user' AND s.target_id = ${userId})
      ${groupClause}
  `);

  if (rows.length === 0)
    return null;
  return rows.some(r => r.permission === "editor") ? "editor" : "viewer";
}

export interface ShareWithSource {
  readonly id: string;
  readonly documentId: string;
  readonly targetType: "user" | "group";
  readonly targetId: string;
  readonly permission: "viewer" | "editor";
  readonly createdAt: string;
  readonly inheritedFrom: { readonly id: string; readonly title: string } | null;
}

/**
 * Lists every share that applies to `documentId` — its own shares plus
 * those inherited from any ancestor. Inherited rows carry
 * `inheritedFrom: { id, title }` pointing at the ancestor that owns the
 * grant; rows on the doc itself have `inheritedFrom: null`. Ordered with
 * self-shares first, then ancestors closest-up first.
 */
export async function listDocumentSharesWithInheritance(
  db: AppDatabase,
  documentId: string,
): Promise<readonly ShareWithSource[]> {
  const rows = await db.all<{
    share_id: string;
    document_id: string;
    target_type: "user" | "group";
    target_id: string;
    permission: "viewer" | "editor";
    created_at: string;
    depth: number;
    source_id: string;
    source_title: string;
  }>(sql`
    WITH RECURSIVE ancestors(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM ${documents} WHERE id = ${documentId}
      UNION ALL
      SELECT d.id, d.parent_id, a.depth + 1
      FROM ${documents} d
      JOIN ancestors a ON d.id = a.parent_id
    )
    SELECT s.id AS share_id, s.document_id, s.target_type, s.target_id,
           s.permission, s.created_at, a.depth,
           d.id AS source_id, d.title AS source_title
    FROM ancestors a
    JOIN ${documentShares} s ON s.document_id = a.id
    JOIN ${documents} d ON d.id = a.id
    ORDER BY a.depth ASC, s.created_at ASC
  `);
  return rows.map(r => ({
    id: r.share_id,
    documentId: r.document_id,
    targetType: r.target_type,
    targetId: r.target_id,
    permission: r.permission,
    createdAt: r.created_at,
    inheritedFrom: r.depth === 0 ? null : { id: r.source_id, title: r.source_title },
  }));
}

// listAllTags walks every document row + its JSON tags array — there is no
// index that accelerates that. The tag picker opens often; cache the result
// for a short window to flatten the load. Mutations call `invalidateTagCache`
// so a freshly-tagged document shows up in <30 s of inactivity.
const TAG_CACHE_TTL_MS = 30_000;
let tagCache: { db: unknown; loadedAt: number; tags: readonly string[] } | null = null;

export function invalidateTagCache(): void {
  tagCache = null;
}

/** Get all unique tags from all documents. */
export async function listAllTags(db: AppDatabase): Promise<readonly string[]> {
  if (tagCache && tagCache.db === db && Date.now() - tagCache.loadedAt < TAG_CACHE_TTL_MS) {
    return tagCache.tags;
  }
  const rows = await db.all<{ tag: string }>(
    sql`SELECT DISTINCT je.value AS tag FROM ${documents}, json_each(${documents.tags}) AS je WHERE je.value IS NOT NULL AND je.value != '' ORDER BY je.value`,
  );
  const tags = rows.map(r => r.tag);
  tagCache = { db, loadedAt: Date.now(), tags };
  return tags;
}
