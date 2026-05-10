import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { encryptionStatusRoute } from "@/modules/encryption";
import { systemRoutes } from "@/modules/system";

export function publicRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.route("/", encryptionStatusRoute());
  app.route("/", systemRoutes());

  return app;
}
