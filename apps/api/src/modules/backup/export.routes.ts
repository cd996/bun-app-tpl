import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { isEncryptionDisabled } from "@/modules/encryption/state";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";
import { streamJsonBackup, verifyDek } from "./export.service";
import { getDataModules, getModuleNames } from "./registry";

const RE_TIMESTAMP_CHARS = /[:.]/g;

export function backupExportRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  // Service-token export — for automated sidecar / cron jobs. Skips the
  // session-cookie + DEK-challenge dance (the sidecar has no master
  // password) and instead trusts a long-lived bearer issued out-of-band.
  // The route is intentionally minimal: the caller picks all modules and
  // the API streams everything currently in the running, unlocked DB.
  router.post("/backup/export-via-token", serviceTokenRequired, async (c) => {
    const db = c.get("db");
    const { modules, body } = streamJsonBackup(db, [...getModuleNames()]);
    const timestamp = new Date().toISOString().replace(RE_TIMESTAMP_CHARS, "-").slice(0, 19);
    await audit(db, {
      actorId: "system",
      actorName: "system:backup-sidecar",
      action: "backup.export",
      resourceType: "system",
      resourceId: "database",
      resourceName: "database-backup-export",
      detail: { modules, via: "service-token" },
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "service-token",
      result: "success",
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${Bun.env.APP_NAME ?? "app"}-backup-${timestamp}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // Everything else under this router is session-auth gated.
  router.use("*", authRequired);

  router.get("/backup/modules", adminRequired, (c) => {
    const registry = getDataModules();
    return c.json({
      modules: getModuleNames().map(name => ({
        name,
        deps: registry[name]!.deps,
      })),
    });
  });

  router.post("/backup/export", adminRequired, async (c) => {
    const config = c.get("config");
    const db = c.get("db");
    const user = c.get("user")!;

    const bodySchema = z.object({
      modules: z.array(z.string()).min(1),
      challengeId: z.string().uuid().optional(),
      encryptedDek: z.string().min(1).optional(),
    });
    const body = bodySchema.parse(await c.req.json());

    const known = new Set(getModuleNames());
    const invalidModules = body.modules.filter(m => !known.has(m));
    if (invalidModules.length > 0) {
      throw new AppError(`Unknown modules: ${invalidModules.join(", ")}`, 400, "INVALID_MODULES");
    }

    if (!isEncryptionDisabled()) {
      if (!body.challengeId || !body.encryptedDek) {
        throw new AppError("Encryption verification required", 400, "ENCRYPTION_REQUIRED");
      }

      const { consumeChallenge } = await import("@/modules/encryption/state");
      const { eciesDecrypt, hexToBytes } = await import("@app/shared");

      const ephPrivKey = consumeChallenge(body.challengeId);
      if (!ephPrivKey) {
        throw new AppError("Challenge expired or invalid. Refresh and try again.", 400, "INVALID_CHALLENGE");
      }

      const encryptedBytes = hexToBytes(body.encryptedDek);
      let dekHex: string;
      try {
        const dekBytes = await eciesDecrypt(ephPrivKey, encryptedBytes);
        dekHex = Array.from(dekBytes, b => b.toString(16).padStart(2, "0")).join("");
      }
      catch {
        throw new AppError("Invalid decryption key", 403, "INVALID_KEY");
      }

      try {
        await verifyDek(config.DB_PATH, dekHex);
      }
      catch {
        throw new AppError("Invalid decryption key", 403, "INVALID_KEY");
      }
    }

    const { modules, body: stream } = streamJsonBackup(db, body.modules);
    const timestamp = new Date().toISOString().replace(RE_TIMESTAMP_CHARS, "-").slice(0, 19);

    // Emit the audit row before the stream starts — once the response body
    // begins flowing, the request is committed; failure mid-stream still
    // wants the "export attempted" row in the audit log.
    await audit(db, {
      actorId: user.id,
      actorName: user.name,
      action: "backup.export",
      resourceType: "system",
      resourceId: "database",
      resourceName: "database-backup-export",
      detail: { modules },
      ip: getClientIp(c),
      userAgent: c.req.header("user-agent") ?? "unknown",
      result: "success",
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${Bun.env.APP_NAME ?? "app"}-backup-${timestamp}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  return router;
}
