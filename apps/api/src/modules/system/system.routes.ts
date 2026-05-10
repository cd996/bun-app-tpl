import type { AppEnv } from "@/shared/lib/types";
import { randomBytes } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { BUILD_INFO } from "@/build-info";
import { isSystemLocked } from "@/modules/encryption/state";
import { gaugeSet, renderPrometheus } from "@/shared/lib/metrics";
import { MAX_ATTACHMENTS_PER_RESOURCE, MAX_UPLOAD_BYTES, UPLOADS_TOTAL_BYTES } from "@/shared/lib/upload-limits";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";

const SCALAR_CDN_ORIGIN = "https://cdn.jsdelivr.net";

function renderScalarDocsHtml(nonce: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">
      // CSRF: the API rejects mutating requests that arrive without
      // X-Requested-With. Patch fetch before Scalar loads so the try-it-out
      // panel sends the header automatically.
      (function () {
        var origFetch = window.fetch.bind(window);
        var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };
        window.fetch = function (input, init) {
          init = init || {};
          var method = (init.method || (input && input.method) || "GET").toUpperCase();
          if (!SAFE[method]) {
            var headers = new Headers(init.headers || (input && input.headers) || {});
            if (!headers.has("X-Requested-With"))
              headers.set("X-Requested-With", "XMLHttpRequest");
            init = Object.assign({}, init, { headers: headers });
          }
          return origFetch(input, init);
        };
      })();
    </script>
    <script nonce="${nonce}" src="${SCALAR_CDN_ORIGIN}/npm/@scalar/api-reference"></script>
    <script nonce="${nonce}">
      Scalar.createApiReference("#app", { url: "openapi.json" });
    </script>
  </body>
</html>`;
}

export function systemRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  // Liveness: the process is alive and the event loop responds. Always 200
  // unless the runtime itself is wedged. Used by k8s livenessProbe / Docker
  // HEALTHCHECK to decide whether to restart the container.
  router.get("/health", c => c.json({ status: "ok" }));

  // Readiness: the process is alive AND can serve traffic — DB reachable,
  // not stuck in setup/locked. Used by k8s readinessProbe / load balancer
  // pool draining. 503 when not ready so traffic is steered elsewhere.
  router.get("/health/ready", async (c) => {
    if (isSystemLocked()) {
      c.status(503);
      return c.json({ status: "locked" });
    }
    const db = c.get("db");
    if (!db) {
      c.status(503);
      return c.json({ status: "no_db" });
    }
    try {
      await db.run(sql`SELECT 1`);
    }
    catch (err) {
      c.get("logger").error({ err }, "readiness probe: db ping failed");
      c.status(503);
      return c.json({ status: "db_unavailable" });
    }
    return c.json({ status: "ready" });
  });

  // GET /system/version — admin-only build provenance. Surfaces the same
  // identifiers as `app --version` so an operator can confirm what's running
  // without shelling into the container.
  router.get("/system/version", authRequired, adminRequired, c => c.json({
    success: true,
    data: BUILD_INFO,
  }));

  // GET /metrics — prometheus exposition. Gated by the SERVICE_TOKEN bearer
  // (when configured), so a scrape job authenticates with a long-lived,
  // session-cookie-free credential. Operators that don't run a metrics
  // pipeline simply leave SERVICE_TOKEN unset; the endpoint then 503s.
  router.get("/metrics", serviceTokenRequired, (c) => {
    // Refresh a few derived gauges right before each scrape so the
    // exposition reflects the current state instead of the last write.
    gaugeSet(
      "encryption_locked",
      "1 when the system is currently locked, 0 when unlocked.",
      isSystemLocked() ? 1 : 0,
    );
    return c.text(renderPrometheus(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  // GET /system/upload-limits — auth-required so we don't leak the cap to
  // anonymous probes. Frontend uses this to render accurate hints client-side.
  router.get("/system/upload-limits", authRequired, c => c.json({
    success: true,
    data: {
      maxFileSize: MAX_UPLOAD_BYTES,
      maxAttachmentsPerResource: MAX_ATTACHMENTS_PER_RESOURCE,
      totalQuota: UPLOADS_TOTAL_BYTES > 0 ? UPLOADS_TOTAL_BYTES : null,
    },
  }));

  return router;
}

export function openapiRoutes() {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/openapi.json", authRequired, adminRequired);
  router.use("/docs", authRequired, adminRequired);

  router.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "API",
      version: "0.1.0",
    },
  });

  // Custom HTML wrapper around the Scalar standalone bundle so we can patch
  // window.fetch before mount. The patch injects `X-Requested-With:
  // XMLHttpRequest` on every mutating request — without it, csrfGuard rejects
  // the try-it-out flow with 403 CSRF_REJECTED. The relative `openapi.json`
  // URL resolves against the current document path so it works under any
  // BASE_PATH (e.g. /app/api/docs → /app/api/openapi.json).
  router.get("/docs", (c) => {
    // Per-route CSP: the global policy is `script-src 'self'` (no inline,
    // no cross-origin), which would block both the bundled fetch-patch
    // script and the Scalar CDN bundle. Override with a nonce-gated policy
    // that allows the two inline blocks below plus the jsdelivr CDN, then
    // forbids everything else (XSS still blocked because attacker-injected
    // scripts won't carry our per-request nonce). connect-src is widened
    // to 'self' so the try-it-out panel can hit /api/* endpoints.
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' ${SCALAR_CDN_ORIGIN}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${SCALAR_CDN_ORIGIN}`,
      `font-src 'self' data: ${SCALAR_CDN_ORIGIN}`,
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    c.header("Content-Security-Policy", csp);
    return c.html(renderScalarDocsHtml(nonce));
  });

  return router;
}
