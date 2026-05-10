import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "@/shared/lib/types";
import { AppError } from "@/shared/lib/errors";

export function errorHandler(err: Error, c: Context<AppEnv>) {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
  }

  c.get("logger").error({ err }, "unhandled error");
  return c.json({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
}
