// Routes that exist only while the system is locked: encryption init / unlock.
// Once `buildFullApp` swaps in, these routes go away — re-init / re-unlock
// would be no-ops anyway (they self-check via 409 ALREADY_INITIALIZED /
// ALREADY_UNLOCKED), but keeping them off the unlocked app reduces attack surface.
import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { encryptionPublicRoutes } from "@/modules/encryption";

export function setupRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.route("/", encryptionPublicRoutes());

  return app;
}
