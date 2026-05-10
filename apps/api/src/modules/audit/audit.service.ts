import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { and, count, desc, eq, gte, like, lte } from "drizzle-orm";
import { auditEvents } from "@/modules/audit/schema";
import { ulid } from "@/shared/lib/id";

export interface AuditParams {
  readonly actorId: string;
  readonly actorName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly detail?: Record<string, unknown> | undefined;
  readonly ip: string;
  readonly userAgent: string;
  readonly result: "success" | "failure";
}

let _logger: Logger | undefined;

export function setAuditLogger(logger: Logger): void {
  _logger = logger;
}

/** Test-only: clear the cached audit logger so the next failed audit() falls through to console.error. */
export function __resetAuditLoggerForTests(): void {
  _logger = undefined;
}

export async function audit(db: AppDatabase, params: AuditParams): Promise<string | undefined> {
  try {
    const id = ulid();
    await db.insert(auditEvents).values({
      id,
      actorId: params.actorId,
      actorName: params.actorName,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName,
      detail: params.detail ? JSON.stringify(params.detail) : null,
      ip: params.ip,
      userAgent: params.userAgent,
      result: params.result,
      createdAt: new Date().toISOString(),
    }).run();
    return id;
  }
  catch (err) {
    if (_logger) {
      _logger.error({ err, action: params.action }, "Failed to write audit event");
    }
    else {
      console.error("[audit] Failed to write audit event:", err);
    }
    return undefined;
  }
}

interface ListAuditParams {
  readonly actorId?: string | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly result?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

export async function listAuditEvents(db: AppDatabase, params: ListAuditParams = {}) {
  const { actorId, action, resourceType, resourceId, result, from, to, page = 1, limit = 50 } = params;

  const conditions = [];
  if (actorId) {
    conditions.push(eq(auditEvents.actorId, actorId));
  }
  if (action) {
    if (action.endsWith(".*")) {
      conditions.push(like(auditEvents.action, `${action.slice(0, -1)}%`));
    }
    else {
      conditions.push(eq(auditEvents.action, action));
    }
  }
  if (resourceType) {
    conditions.push(eq(auditEvents.resourceType, resourceType));
  }
  if (resourceId) {
    conditions.push(eq(auditEvents.resourceId, resourceId));
  }
  if (result) {
    conditions.push(eq(auditEvents.result, result as "success" | "failure"));
  }
  if (from) {
    conditions.push(gte(auditEvents.createdAt, from));
  }
  if (to) {
    conditions.push(lte(auditEvents.createdAt, to));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = await db.select({ value: count() }).from(auditEvents).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

export async function getAuditEventById(db: AppDatabase, id: string) {
  return await db.select().from(auditEvents).where(eq(auditEvents.id, id)).get();
}
