import { resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import { ROOT_DIR } from "./root";

const RE_APP_NAME = /^[a-z][a-z0-9-]*$/;

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DB_PATH: z.string().default("data/db/app.db"),
  DB_ENCRYPTION: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  // Application slug — lowercase letters, digits, dashes. Used as the
  // backup filename prefix, localStorage namespace, etc.
  APP_NAME: z.string().regex(RE_APP_NAME, "APP_NAME must match /^[a-z][a-z0-9-]*$/").default("app"),
  // Human-readable display name used in HTML title, TOTP issuer, etc.
  APP_DISPLAY_NAME: z.string().min(1).default("App"),
  // URL prefix the app is mounted under. Empty (default) means the app is
  // served at root: SPA at "/" and API at "/api". When set, the value is
  // normalised so "app", "/app", and "/app/" all resolve to "/app".
  BASE_PATH: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FILE: z.string().default("data/logs/app.log"),
  // When true, write logs to stdout instead of LOG_FILE — preferred for
  // container deployments that capture stdout/stderr at the runtime level.
  LOG_TO_STDOUT: z.coerce.boolean().default(false),
  CORS_ORIGIN: z.string().optional(),

  // When true, honour `X-Real-IP` then the rightmost `X-Forwarded-For` entry
  // for client-IP resolution. Default is false: forwarding headers are
  // ignored and the connection peer IP is used. Only enable behind a
  // sanitising proxy that strips client-supplied forwarding headers.
  TRUST_PROXY: z.coerce.boolean().default(false),

  // Opt-in flag for the experimental DEK-rotation flow. When false (default)
  // the rotation endpoints respond with 501 Not Implemented.
  ENABLE_EXPERIMENTAL_DEK_ROTATION: z.coerce.boolean().default(false),

  // OAuth / OIDC is **runtime config**, not stored in the settings DB —
  // operators set these as env vars (or `OAUTH_ISSUER` + the discovery
  // cache) and the API reads them at boot. `seedSettingsFromEnv` does
  // mirror a subset into the settings table for the admin UI to display,
  // but the runtime path never reads from there.
  OAUTH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_ISSUER: z.string().url().optional(),
  OAUTH_AUTHORIZE_URL: z.string().url().optional(),
  OAUTH_TOKEN_URL: z.string().url().optional(),
  OAUTH_USERINFO_URL: z.string().url().optional(),
  OAUTH_PKCE: z.enum(["true", "false"]).default("true").transform(v => v === "true"),

  SESSION_MAX_AGE: z.coerce.number().int().positive().default(86400),

  // Audit retention. 0 = keep forever (default). Otherwise the audit module
  // runs an hourly sweep that drops events older than this many days.
  AUDIT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),

  // Attachment limits — apply to every upload-capable module (documents,
  // issues, …). Single source so per-file caps stay consistent.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_ATTACHMENTS_PER_RESOURCE: z.coerce.number().int().positive().default(20),
  // Total disk quota across all attachment tables. 0 = unlimited (default).
  // When set and an upload would push usage past this, the request returns
  // 413 PAYLOAD_TOO_LARGE.
  UPLOADS_TOTAL_BYTES: z.coerce.number().int().nonnegative().default(0),

  // ─── File module ─────────────────────────────────────────────────────
  // Storage backend selector. Built-in: `local`. Downstream projects can
  // register additional drivers (e.g. `s3`, `azure-blob`) and switch by
  // changing this value — no fork of the file module required.
  FILE_STORAGE_DRIVER: z.string().min(1).default("local"),
  // On-disk root for the local driver. Resolved against the project root
  // when relative.
  FILE_STORAGE_LOCAL_ROOT: z.string().default("data/uploads/files"),
  // GC mode. `async` (default): `releaseReference` only decrements
  // `ref_count`; a background sweep deletes the blob + the `files` row
  // once a minute. `sync`: the foreground request also performs the
  // driver delete — used by tests and local-only deployments that want
  // immediate disk reclamation.
  FILE_GC_MODE: z.enum(["async", "sync"]).default("async"),
  // Sweep interval for the GC. Set to 0 to disable the periodic sweep
  // entirely (orphans accumulate; admin runs a manual sweep).
  FILE_GC_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  // When true and the active driver implements `presignDownload`, file
  // downloads 302 to a short-lived signed URL rather than streaming
  // through the API. Per-deployment toggle; setting false forces every
  // download to flow through the API (easier audit / firewall).
  FILE_PRESIGN_ENABLED: z.coerce.boolean().default(true),
  // TTL for signed URLs in seconds. Short by design: a leaked URL stays
  // valid only briefly; re-issuing requires the consumer permission hook
  // to pass again.
  FILE_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  DEFAULT_ADMIN: z.string().default(""),

  ACCESS_URL: z.string().url().optional(),
  OIDC_LOGOUT_URL: z.string().url().optional(),

  // Bearer tokens for non-interactive tooling. Each scope is independent so
  // a leaked metrics scraper credential cannot also dump the database.
  // Constant-time compare; min length forces a real value.
  SERVICE_TOKEN_METRICS: z.string().min(32).optional(),
  SERVICE_TOKEN_BACKUP: z.string().min(32).optional(),
});

export type Config = z.infer<typeof configSchema>;

function resolvePath(p: string): string {
  return p.startsWith("/") ? p : resolve(ROOT_DIR, p);
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
}

const RE_TRAILING_SLASHES = /\/+$/;
const RE_SLASH_TRIM = /^\/+|\/+$/g;
const RE_DB_SUFFIX = /\.db$/;

async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  const url = `${issuer.replace(RE_TRAILING_SLASHES, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText} from ${url}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("json")) {
    throw new Error(`OIDC discovery returned non-JSON content-type: ${ctype}`);
  }
  // Bound the response body — discovery docs are well under 64 KB; an attacker
  // controlling the issuer (or MITM) could otherwise stream unlimited bytes.
  const text = await res.text();
  if (text.length > 64 * 1024) {
    throw new Error(`OIDC discovery response too large: ${text.length} bytes`);
  }
  return JSON.parse(text) as OidcDiscovery;
}

interface CachedDiscovery {
  readonly issuer: string;
  readonly fetchedAt: string;
  readonly discovery: OidcDiscovery;
}

// Discovery responses are read on cold boot only when the IdP is currently
// unreachable. A 24-hour ceiling on cache age lets a one-day IdP outage ride
// through without operator action, but an indefinitely-stale entry (IdP
// replaced, endpoint URLs rotated) gets a loud warning so the operator can
// notice that the pinned values may no longer point at a working server.
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a successful discovery response next to the DB. On subsequent
 * boots, when the IdP is unreachable we fall back to the cached values so
 * the API still serves traffic — at the cost of a stale endpoint URL until
 * the next successful refresh. The cache is keyed by issuer to invalidate
 * when the operator points the deployment at a different IdP. Beyond the
 * TTL we still return the cache (degraded mode is preferable to refusing
 * to boot) but emit a stale-cache warning so it shows up in the boot log.
 */
async function readDiscoveryCache(cachePath: string, issuer: string): Promise<OidcDiscovery | null> {
  try {
    const file = Bun.file(cachePath);
    if (!(await file.exists()))
      return null;
    const cached = await file.json() as CachedDiscovery;
    if (cached.issuer !== issuer)
      return null;
    const fetchedAt = Date.parse(cached.fetchedAt);
    if (Number.isFinite(fetchedAt)) {
      const ageMs = Date.now() - fetchedAt;
      if (ageMs > DISCOVERY_CACHE_TTL_MS) {
        const ageHours = Math.round(ageMs / 3_600_000);
        console.warn(
          `[config] OIDC discovery cache is stale (last successful refresh ${ageHours}h ago, TTL ${DISCOVERY_CACHE_TTL_MS / 3_600_000}h); endpoints may be outdated.`,
        );
      }
    }
    return cached.discovery;
  }
  catch {
    return null;
  }
}

async function writeDiscoveryCache(cachePath: string, issuer: string, discovery: OidcDiscovery): Promise<void> {
  try {
    const tmp = `${cachePath}.tmp`;
    await Bun.write(tmp, JSON.stringify({ issuer, fetchedAt: new Date().toISOString(), discovery } satisfies CachedDiscovery));
    const { renameSync } = await import("node:fs");
    renameSync(tmp, cachePath);
  }
  catch {
    // best-effort — discovery still works without the cache
  }
}

export async function loadConfig(): Promise<Config> {
  const result = configSchema.safeParse(Bun.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    console.error("Invalid configuration:", JSON.stringify(formatted, null, 2));
    process.exit(1);
  }
  const data = result.data;

  if (data.NODE_ENV === "production" && !data.CORS_ORIGIN) {
    console.error("CORS_ORIGIN is required in production");
    process.exit(1);
  }
  if (data.NODE_ENV === "production" && !data.ACCESS_URL) {
    console.error("ACCESS_URL is required in production (forwarded headers are not trusted to derive OAuth callback URLs).");
    process.exit(1);
  }
  // Refuse to boot in production when example sentinels from
  // `examples/compose/.env.example` / `dex.yaml` are still in place. Copying
  // the example without rotating these values leaves the deployment with a
  // globally-known client secret, a publicly-documented client id, and a
  // first-admin email any attacker can register at the IdP.
  const PRODUCTION_SENTINELS = [
    { field: "OAUTH_CLIENT_SECRET", value: data.OAUTH_CLIENT_SECRET, sentinel: "app-secret", hint: "Rotate it and the matching `secret` in dex.yaml / your IdP." },
    { field: "OAUTH_CLIENT_ID", value: data.OAUTH_CLIENT_ID, sentinel: "app", hint: "Register a real client id in your IdP." },
    { field: "DEFAULT_ADMIN", value: data.DEFAULT_ADMIN, sentinel: "admin@example.com", hint: "Set DEFAULT_ADMIN to the real first-admin email." },
  ] as const;
  if (data.NODE_ENV === "production") {
    for (const { field, value, sentinel, hint } of PRODUCTION_SENTINELS) {
      if (value === sentinel) {
        console.error(`${field} still uses the example value \`${sentinel}\`. ${hint}`);
        process.exit(1);
      }
    }
  }

  // Resolve OIDC endpoints from env vars if available (for initial seeding).
  // Discovery is best-effort: try the network first, fall back to the on-disk
  // cache so a deploy that boots while the IdP is degraded still serves
  // traffic with the last-known-good endpoints. A successful refresh
  // updates the cache for next boot.
  if ((!data.OAUTH_AUTHORIZE_URL || !data.OAUTH_TOKEN_URL || !data.OAUTH_USERINFO_URL) && data.OAUTH_ISSUER) {
    const cachePath = resolvePath(`${data.DB_PATH.replace(RE_DB_SUFFIX, "")}-oidc.json`);
    let discovery: OidcDiscovery | null = null;
    try {
      discovery = await fetchOidcDiscovery(data.OAUTH_ISSUER);
      await writeDiscoveryCache(cachePath, data.OAUTH_ISSUER, discovery);
    }
    catch {
      discovery = await readDiscoveryCache(cachePath, data.OAUTH_ISSUER);
      if (discovery) {
        console.warn("[config] OIDC discovery refresh failed; using cached endpoints from previous boot");
      }
    }
    if (discovery) {
      data.OAUTH_AUTHORIZE_URL ??= discovery.authorization_endpoint;
      data.OAUTH_TOKEN_URL ??= discovery.token_endpoint;
      data.OAUTH_USERINFO_URL ??= discovery.userinfo_endpoint;
      data.OIDC_LOGOUT_URL ??= discovery.end_session_endpoint;
    }
  }

  const trimmedBase = data.BASE_PATH.replace(RE_SLASH_TRIM, "");
  const basePath = trimmedBase ? `/${trimmedBase}` : "";

  return {
    ...data,
    BASE_PATH: basePath,
    DB_PATH: resolvePath(data.DB_PATH),
    LOG_FILE: resolvePath(data.LOG_FILE),
  };
}

export function parseDefaultAdmins(raw: string): readonly string[] {
  if (!raw.trim())
    return [];
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
