import type { Config } from "./config";
import type { AppDatabase } from "./db";
import type { Logger } from "./shared/lib/logger";
import type { AppEnv } from "./shared/lib/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { loadConfig } from "./config";
import { initPkceStore, logDefaultAdmins } from "./modules/account/auth/auth.service";
import { startAuditRetentionSweep } from "./modules/audit";
import { setAuditLogger } from "./modules/audit/audit.service";
import { bootstrapEncryption } from "./modules/encryption";
import { protectedRoutes, publicRoutes, setupRoutes } from "./routes";
import { getAuthConfig, seedSettingsFromEnv } from "./shared/lib/app-config";
import { createLogger } from "./shared/lib/logger";
import { csrfGuard } from "./shared/middleware/csrf";
import { errorHandler } from "./shared/middleware/error-handler";
import { loggingMiddleware } from "./shared/middleware/logging";
import { hasStaticAssets, serveStaticAssets } from "./shared/middleware/static";

// ─── Types ───

interface AppDeps {
  readonly config: Config;
  readonly db: AppDatabase;
  readonly logger: Logger;
}

export interface BootstrapResult {
  /** Current app — may be locked or full. Mutable via onUnlock. */
  readonly fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response>;
  /** Config object */
  readonly config: Config;
  /** Logger */
  readonly logger: Logger;
  /** Close DB connection (if unlocked). Call on shutdown. */
  readonly closeDb: () => void;
}

// ─── Bootstrap ───

/**
 * Bootstrap the application: load config, check encryption state,
 * and return a fetch handler that delegates to locked or full app.
 *
 * Used by both index.ts (production) and dev.ts (Vite dev server).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const config = await loadConfig();
  const logger = createLogger(config);

  // Mutable reference for hot-swapping locked → unlocked
  let currentApp: { fetch: (req: Request, env?: Record<string, unknown>) => Response | Promise<Response> };
  let closeDb: () => void = () => {};

  async function onDbReady(db: AppDatabase) {
    // Close the previous database handle (no-op on first call) so DEK rotation
    // can hot-swap the live db without leaking the old encrypted handle.
    closeDb();
    initPkceStore(db);
    currentApp = await buildFullApp({ config, db, logger });
    logDefaultAdmins(await getAuthConfig(db, config), logger);
    closeDb = () => db.close();
    logger.info("system fully operational");
  }

  const result = await bootstrapEncryption(config, logger, onDbReady);

  if (result.mode === "disabled") {
    await onDbReady(result.db);
  }
  else {
    currentApp = buildLockedApp(config, logger);
  }

  return {
    fetch: (req, env) => currentApp.fetch(req, env),
    config,
    logger,
    closeDb: () => closeDb(),
  };
}

// ─── Shared installers ───

function newApi(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Validation failed", details: result.error.flatten() } }, 422);
      }
    },
  });
}

// CORS_ORIGIN may be a comma-separated list. In development with no value,
// allow same-origin requests (any host) — dev usually goes through nsl which
// proxies to the SPA's vite port and the API's bun port under one host.
function resolveCorsOrigin(config: Config): string | string[] {
  if (config.CORS_ORIGIN) {
    const list = config.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
    return list.length === 1 ? list[0]! : list;
  }
  return config.NODE_ENV === "production" ? "" : "*";
}

function installCommonMiddleware(
  api: OpenAPIHono<AppEnv>,
  { config, logger, db }: { config: Config; logger: Logger; db?: AppDatabase },
): void {
  api.use("*", requestId());
  api.use("*", cors({ origin: resolveCorsOrigin(config) }));
  api.use("*", (c, next) => {
    if (db !== undefined) {
      c.set("db", db);
    }
    c.set("config", config);
    c.set("logger", logger);
    return next();
  });
  api.use("*", loggingMiddleware());
  api.use("*", csrfGuard);
}

// ─── Full App (unlocked) ───

export async function buildFullApp({ config, db, logger }: AppDeps) {
  const api = newApi();
  installCommonMiddleware(api, { config, logger, db });

  setAuditLogger(logger);
  await seedSettingsFromEnv(db, config);
  startAuditRetentionSweep(db, config, logger);

  api.route("/", publicRoutes());
  api.route("/", protectedRoutes());

  api.onError(errorHandler);

  return buildOuterApp(api, config);
}

// ─── Locked App (setup / unlock) ───

export function buildLockedApp(config: Config, logger: Logger) {
  const api = newApi();
  installCommonMiddleware(api, { config, logger });

  setAuditLogger(logger);

  api.route("/", publicRoutes());
  api.route("/", setupRoutes());

  api.all("*", (c) => {
    return c.json({ success: false, error: { code: "SYSTEM_LOCKED", message: "System is locked. Provide decryption key to unlock." } }, 503);
  });

  api.onError(errorHandler);

  return buildOuterApp(api, config);
}

// ─── Outer shell (shared by full & locked) ───

function buildOuterApp(api: OpenAPIHono<AppEnv>, config: Config) {
  const app = new OpenAPIHono<AppEnv>();
  const base = config.BASE_PATH;

  // Security headers for every response (API JSON + static SPA HTML/JS/CSS).
  // SPA bundles are hashed under BASE_PATH; styles need 'unsafe-inline' for
  // Tailwind v4 + base-ui runtime style injection. Scripts stay strict 'self'.
  // img data:/blob: covers QR codes and inline SVGs.
  //
  // The Scalar API-reference page at `/api/docs` runs an inline fetch-patch
  // and pulls the Scalar bundle from a CDN, which the strict policy below
  // would block. Branch into a relaxed-CSP variant just for that admin-only
  // route — its handler emits its own per-request Content-Security-Policy
  // (nonce + jsdelivr whitelist). All other security headers stay identical.
  const baseHeadersOptions = {
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    // HSTS deliberately disabled: pinning forces every future visit to https
    // and bricks LAN/dev TLS-termination edge cases. Operators that need it
    // should set it at the reverse proxy.
    strictTransportSecurity: false,
  } as const;
  const strictSecureHeaders = secureHeaders({
    ...baseHeadersOptions,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
  });
  // For the docs route we skip the secureHeaders CSP; the handler writes its
  // own nonce-gated policy and that header survives because nothing else
  // rewrites it post-handler.
  const docsSecureHeaders = secureHeaders(baseHeadersOptions);
  const DOCS_PATH = `${base}/api/docs`;
  app.use("*", async (c, next) => {
    const handler = c.req.path === DOCS_PATH ? docsSecureHeaders : strictSecureHeaders;
    return handler(c, next);
  });

  app.get("/", (c) => {
    return c.html(`<meta http-equiv="refresh" content="0;url=${base}/">`);
  });

  app.route(`${base}/api`, api);
  if (hasStaticAssets()) {
    app.get(`${base}/*`, serveStaticAssets(base));
  }

  return app;
}
