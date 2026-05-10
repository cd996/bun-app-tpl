import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { sum } from "drizzle-orm";
import { documentAttachments } from "@/modules/document/schema";
import { todoAttachments } from "@/modules/todo/schema";
import { AppError } from "@/shared/lib/errors";

/**
 * Single source of truth for per-upload caps and the cross-module total
 * quota. Values come from `Config` (the boot-validated env schema). At boot,
 * `index.ts` calls `initUploadLimits(config)` to seed the internal state.
 * Until that happens — primarily under tests that exercise this module in
 * isolation — accessors fall back to reading `Bun.env` lazily so existing
 * tests keep working without explicit init.
 *
 * Exported as `let` so consumers see live ESM bindings: callers that read
 * `MAX_UPLOAD_BYTES` once per request see the latest value (helpful when
 * the running config is reloaded). The cached running-total counter is
 * private and mutated through {@link incrementUploadsUsed} / {@link
 * decrementUploadsUsed}; a 5-minute recompute reconciles drift caused by
 * out-of-band writes (e.g. SQL admin fixes, restored backups).
 */

const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;

interface InternalLimits {
  maxUploadBytes: number;
  maxAttachmentsPerResource: number;
  uploadsTotalBytes: number;
}

let initialized = false;
let limits: InternalLimits = readFromEnv();
let cachedUsedBytes: number | undefined;
let cacheLoadedAt = 0;

function readFromEnv(): InternalLimits {
  return {
    maxUploadBytes: Number(Bun.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
    maxAttachmentsPerResource: Number(Bun.env.MAX_ATTACHMENTS_PER_RESOURCE ?? 20),
    uploadsTotalBytes: Number(Bun.env.UPLOADS_TOTAL_BYTES ?? 0),
  };
}

function refresh(): void {
  if (!initialized)
    limits = readFromEnv();
}

/**
 * Seed upload limits from the validated config. Called once at boot from
 * `index.ts`. Safe to call again — replaces the snapshot wholesale.
 */
export function initUploadLimits(config: Config): void {
  initialized = true;
  limits = {
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxAttachmentsPerResource: config.MAX_ATTACHMENTS_PER_RESOURCE,
    uploadsTotalBytes: config.UPLOADS_TOTAL_BYTES,
  };
  // Wipe the cached counter; the next quota check will recompute from SQL.
  cachedUsedBytes = undefined;
  cacheLoadedAt = 0;
}

// Live ESM bindings — `let` ensures consumers read the current value, not a
// snapshot frozen at module load. `syncExports()` is invoked from every code
// path that depends on the value so `initUploadLimits()` (called at boot from
// index.ts) can swap the underlying numbers without restarting consumers.
// eslint-disable-next-line import/no-mutable-exports
export let MAX_UPLOAD_BYTES = limits.maxUploadBytes;
// eslint-disable-next-line import/no-mutable-exports
export let MAX_ATTACHMENTS_PER_RESOURCE = limits.maxAttachmentsPerResource;
// eslint-disable-next-line import/no-mutable-exports
export let UPLOADS_TOTAL_BYTES = limits.uploadsTotalBytes;

function syncExports(): void {
  refresh();
  MAX_UPLOAD_BYTES = limits.maxUploadBytes;
  MAX_ATTACHMENTS_PER_RESOURCE = limits.maxAttachmentsPerResource;
  UPLOADS_TOTAL_BYTES = limits.uploadsTotalBytes;
}

export function isWithinFileSize(size: number): boolean {
  syncExports();
  return size > 0 && size <= limits.maxUploadBytes;
}

async function recomputeUsedFromDb(db: AppDatabase): Promise<number> {
  const docRow = await db.select({ value: sum(documentAttachments.size) }).from(documentAttachments).get();
  const todoRow = await db.select({ value: sum(todoAttachments.size) }).from(todoAttachments).get();
  return Number(docRow?.value ?? 0) + Number(todoRow?.value ?? 0);
}

/**
 * Total bytes consumed by all attachments across every upload-capable
 * module. Once `initUploadLimits` has been called, the value is cached and
 * kept in sync via {@link incrementUploadsUsed} / {@link
 * decrementUploadsUsed}; a SQL recompute every {@link RECOMPUTE_INTERVAL_MS}
 * corrects drift. Before init (e.g. in unit tests that load this module
 * directly), every call recomputes from SQL — no cache, no carry-over
 * between tests.
 */
export async function getUploadsUsedBytes(db: AppDatabase): Promise<number> {
  if (!initialized)
    return await recomputeUsedFromDb(db);
  const now = Date.now();
  if (cachedUsedBytes === undefined || now - cacheLoadedAt > RECOMPUTE_INTERVAL_MS) {
    cachedUsedBytes = await recomputeUsedFromDb(db);
    cacheLoadedAt = now;
  }
  return cachedUsedBytes;
}

/**
 * Bump the cached upload counter when a new attachment is persisted.
 * No-op when the cache has not been populated yet — the next
 * {@link getUploadsUsedBytes} call will compute the fresh total from SQL.
 */
export function incrementUploadsUsed(bytes: number): void {
  if (bytes <= 0)
    return;
  if (cachedUsedBytes !== undefined)
    cachedUsedBytes += bytes;
}

/**
 * Decrement the cached upload counter when an attachment is deleted.
 * Floors at zero to avoid negative drift if a delete fires for a row
 * inserted before the cache was populated.
 */
export function decrementUploadsUsed(bytes: number): void {
  if (bytes <= 0)
    return;
  if (cachedUsedBytes !== undefined)
    cachedUsedBytes = Math.max(0, cachedUsedBytes - bytes);
}

/**
 * Throw 413 PAYLOAD_TOO_LARGE if accepting `additionalBytes` would push
 * cumulative usage past the configured total quota. No-op when the quota
 * is 0 (unlimited).
 */
export async function assertWithinTotalQuota(db: AppDatabase, additionalBytes: number): Promise<void> {
  syncExports();
  const limit = limits.uploadsTotalBytes;
  if (limit <= 0)
    return;
  const used = await getUploadsUsedBytes(db);
  if (used + additionalBytes > limit) {
    throw new AppError(
      `Upload quota exceeded. Limit: ${limit} bytes; used: ${used} bytes.`,
      413,
      "QUOTA_EXCEEDED",
    );
  }
}
