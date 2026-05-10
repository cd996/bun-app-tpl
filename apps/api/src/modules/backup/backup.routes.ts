import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { backupExportRoutes } from "./export.routes";
import { backupImportRoutes } from "./restore.routes";

export function backupRoutes() {
  const router = new OpenAPIHono<AppEnv>();
  router.route("/", backupExportRoutes());
  router.route("/", backupImportRoutes());
  return router;
}
