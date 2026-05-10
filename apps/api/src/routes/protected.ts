import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { accountRoutes } from "@/modules/account";
import { auditRoutes } from "@/modules/audit";
import { backupRoutes } from "@/modules/backup";
import { documentRoutes } from "@/modules/document";
import { encryptionProtectedRoutes } from "@/modules/encryption";
import { policyRoutes } from "@/modules/policy";
import { settingsRoutes } from "@/modules/settings";
import { openapiRoutes } from "@/modules/system";
import { todoRoutes } from "@/modules/todo";
// requireUnlocked is defense-in-depth: protectedRoutes is only mounted by
// buildFullApp (after the DB has been decrypted), but the middleware also
// catches the case where the system gets re-locked at runtime (e.g. master
// key rotation) before this app instance is rebuilt.
import { requireUnlocked } from "@/shared/middleware/encryption";

export function protectedRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", requireUnlocked);

  app.route("/", accountRoutes());
  app.route("/", todoRoutes());
  app.route("/", policyRoutes());
  app.route("/", documentRoutes());
  app.route("/", settingsRoutes());
  app.route("/", auditRoutes());
  app.route("/", encryptionProtectedRoutes());
  app.route("/", backupRoutes());
  app.route("/", openapiRoutes());

  return app;
}
