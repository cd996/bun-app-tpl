import type { AppDatabase } from "@/db";
import { and, count, desc, eq, exists, inArray, isNull, like, or, sql } from "drizzle-orm";
import { groups } from "@/modules/account/groups/schema";
import { listActiveUsers as listActiveUsersFromAccount } from "@/modules/account/users/users.service";
import { documentFolders, documents, documentShares } from "@/modules/document/schema";
import { listGroupIdsForUser } from "@/modules/policy/policy.service";
import { nanoid } from "@/shared/lib/id";

// Re-export so existing callers (document.routes.ts) keep their imports.
// `listAllGroups` stays local because the account/groups module exposes
// `listGroups` with a different shape (includes memberCount).
export const listActiveUsers = listActiveUsersFromAccount;

interface ListParams {
  readonly q?: string | undefined;
  readonly tag?: string | undefined;
  readonly folderId?: string | undefined;
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

function buildConditions(params: { q?: string | undefined; tag?: string | undefined; folderId?: string | undefined }) {
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
  if (params.folderId !== undefined) {
    if (params.folderId === "") {
      // unfiled documents
      conditions.push(isNull(documents.folderId));
    }
    else {
      conditions.push(eq(documents.folderId, params.folderId));
    }
  }
  return conditions;
}

export async function listDocuments(db: AppDatabase, params: ListParams = {}) {
  const { q, tag, folderId, creatorId, page = 1, limit = 20 } = params;

  const conditions = buildConditions({ q, tag, folderId });
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

export async function listMyDocuments(db: AppDatabase, params: ListMyParams) {
  const { userId, q, tag, folderId, page = 1, limit = 20 } = params;

  // The user's group ids are a small set — typically <10 — so it is safe to
  // inline as an `IN (...)`. The bulk of the join is collapsed into a single
  // EXISTS subquery against documentShares so we avoid the previous
  // "fetch ids then re-query" round-trip.
  const groupIds = await listGroupIdsForUser(db, userId);

  const shareMatchesUser = and(
    eq(documentShares.documentId, documents.id),
    eq(documentShares.targetType, "user"),
    eq(documentShares.targetId, userId),
  );
  const shareMatchesGroup = groupIds.length > 0
    ? and(
        eq(documentShares.documentId, documents.id),
        eq(documentShares.targetType, "group"),
        inArray(documentShares.targetId, [...groupIds]),
      )
    : undefined;
  const shareCondition = shareMatchesGroup
    ? or(shareMatchesUser, shareMatchesGroup)
    : shareMatchesUser;

  const sharedExists = exists(
    db.select({ one: sql`1` }).from(documentShares).where(shareCondition),
  );

  const ownershipCondition = or(eq(documents.creatorId, userId), sharedExists);

  const searchConditions = buildConditions({ q, tag, folderId });
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
  folderId?: string | null | undefined;
  creatorId: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documents).values({
    id,
    title: data.title,
    content: data.content ?? null,
    tags: JSON.stringify(data.tags ?? []),
    folderId: data.folderId ?? null,
    creatorId: data.creatorId,
    createdAt: now,
    updatedAt: now,
  }).run();
  if (data.tags && data.tags.length > 0)
    invalidateTagCache();
  return (await db.select().from(documents).where(eq(documents.id, id)).get())!;
}

export async function updateDocument(db: AppDatabase, id: string, data: {
  title?: string | undefined;
  content?: string | undefined;
  tags?: readonly string[] | undefined;
  folderId?: string | null | undefined;
}) {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };
  if (data.title !== undefined)
    setData.title = data.title;
  if (data.content !== undefined)
    setData.content = data.content;
  if (data.tags !== undefined)
    setData.tags = JSON.stringify(data.tags);
  if (data.folderId !== undefined)
    setData.folderId = data.folderId;
  await db.update(documents).set(setData).where(eq(documents.id, id)).run();
  if (data.tags !== undefined)
    invalidateTagCache();
  return await db.select().from(documents).where(eq(documents.id, id)).get();
}

export async function deleteDocument(db: AppDatabase, id: string) {
  await db.delete(documents).where(eq(documents.id, id)).run();
  invalidateTagCache();
}

export async function listAllGroups(db: AppDatabase) {
  return await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .orderBy(groups.name)
    .all();
}

// ── Share functions ──

export async function listDocumentShares(db: AppDatabase, documentId: string) {
  return await db.select().from(documentShares).where(eq(documentShares.documentId, documentId)).all();
}

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

export async function getDocumentPermission(db: AppDatabase, documentId: string, userId: string): Promise<"editor" | "viewer" | null> {
  // Check direct user share
  const userShare = await db.select({ permission: documentShares.permission }).from(documentShares).where(and(
    eq(documentShares.documentId, documentId),
    eq(documentShares.targetType, "user"),
    eq(documentShares.targetId, userId),
  )).get();

  // Check group shares
  const groupIds = await listGroupIdsForUser(db, userId);

  let groupPermission: string | null = null;
  if (groupIds.length > 0) {
    const groupShares = await db.select({ permission: documentShares.permission }).from(documentShares).where(and(
      eq(documentShares.documentId, documentId),
      eq(documentShares.targetType, "group"),
      inArray(documentShares.targetId, [...groupIds]),
    )).all();
    // Highest permission wins
    if (groupShares.some(s => s.permission === "editor")) {
      groupPermission = "editor";
    }
    else if (groupShares.length > 0) {
      groupPermission = "viewer";
    }
  }

  // Return highest of user share and group share permissions
  if (userShare?.permission === "editor" || groupPermission === "editor")
    return "editor";
  if (userShare || groupPermission)
    return "viewer";
  return null;
}

// ── Folder functions ──

export async function listFolders(db: AppDatabase, creatorId?: string) {
  const conditions = creatorId ? [eq(documentFolders.creatorId, creatorId)] : [];
  return await db.select().from(documentFolders).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(documentFolders.name).all();
}

export async function getFolderById(db: AppDatabase, id: string) {
  return await db.select().from(documentFolders).where(eq(documentFolders.id, id)).get();
}

export async function getFolderByName(db: AppDatabase, name: string) {
  return await db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.name, name))
    .get();
}

export async function createFolder(db: AppDatabase, data: { name: string; creatorId: string }) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documentFolders).values({
    id,
    name: data.name,
    creatorId: data.creatorId,
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(documentFolders).where(eq(documentFolders.id, id)).get())!;
}

export async function updateFolder(db: AppDatabase, id: string, data: { name: string }) {
  const now = new Date().toISOString();
  await db.update(documentFolders).set({ name: data.name, updatedAt: now }).where(eq(documentFolders.id, id)).run();
  return await db.select().from(documentFolders).where(eq(documentFolders.id, id)).get();
}

export async function deleteFolder(db: AppDatabase, id: string) {
  // Move documents in this folder to unfiled
  await db.update(documents).set({ folderId: null }).where(eq(documents.folderId, id)).run();
  await db.delete(documentFolders).where(eq(documentFolders.id, id)).run();
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
