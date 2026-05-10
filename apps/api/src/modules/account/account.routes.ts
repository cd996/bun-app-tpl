import type { AppEnv } from "@/shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { authRoutes } from "./auth";
import { groupRoutes } from "./groups";
import { userRoutes } from "./users";

export function accountRoutes() {
  const router = new OpenAPIHono<AppEnv>();
  router.route("/", authRoutes());
  router.route("/", userRoutes());
  router.route("/", groupRoutes());
  return router;
}
