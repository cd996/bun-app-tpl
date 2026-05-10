import type { AppEnv } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

/**
 * Bearer-token gate for non-interactive automation (backup sidecar,
 * metrics scrape, etc.). Auths exclusively against `config.SERVICE_TOKEN`
 * via constant-time compare; if the env var is unset the middleware
 * answers 503 so ops can tell "not configured" from "wrong token".
 *
 * The token is intentionally NOT scoped per-route — operators get one
 * value and reuse it across the small surface that opts in. Combine with
 * the network-level access control (firewall / private network) for the
 * sidecar use case.
 */
export const serviceTokenRequired = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.get("config").SERVICE_TOKEN;
  if (!expected) {
    return c.json(
      { success: false, error: { code: "SERVICE_TOKEN_DISABLED", message: "Service-token authentication is not configured" } },
      503,
    );
  }

  const auth = c.req.header("authorization");
  const supplied = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
  if (!supplied) {
    return c.json(
      { success: false, error: { code: "UNAUTHORIZED", message: "Service token required" } },
      401,
    );
  }

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    return c.json(
      { success: false, error: { code: "UNAUTHORIZED", message: "Invalid service token" } },
      401,
    );
  }

  return next();
});
