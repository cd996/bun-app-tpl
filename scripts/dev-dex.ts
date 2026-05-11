#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Single-command dev: bundled dex IdP + the regular Vite/API dev server.
 *
 * Usage:  bun run dev:dex
 *
 * Implementation:
 *   1. Ensure the dex binary exists in tests/e2e/.cache/dex (extract from
 *      the official OCI image — no docker daemon needed).
 *   2. Render a per-run dex config under tests/e2e/.cache/dev-dex/config.yaml
 *      with redirect URI derived from BASE_PATH / APP_NAME / ACCESS_URL.
 *   3. Spawn dex; wait for the discovery endpoint.
 *   4. Spawn `bun run --filter @app/* dev` with matching OAUTH_* env so the
 *      API picks up the bundled IdP without any .env editing.
 *   5. Forward Ctrl-C to both processes; tear down when either exits.
 */
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const E2E_DIR = join(ROOT, "tests/e2e");
const DEX_BIN = join(E2E_DIR, ".cache/dex");
const DEX_DEV_DIR = join(E2E_DIR, ".cache/dev-dex");
const DEX_CONFIG = join(DEX_DEV_DIR, "config.yaml");
const DEX_PORT = Number(process.env.DEV_DEX_PORT ?? 5567);
const DEV_PORT = process.env.PORT ?? "3000";
const APP_NAME = process.env.APP_NAME ?? "app";
// Normalise BASE_PATH like apps/api/src/config.ts: empty means root, otherwise
// "/<x>" with no trailing slash. The OAuth callback URL is built from
// ACCESS_URL + this prefix, so an unset BASE_PATH yields a root-mounted
// callback (e.g. http://localhost:3000/api/account/auth/callback).
const trimmedBase = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "");
const BASE_PATH = trimmedBase ? `/${trimmedBase}` : "";
const ACCESS_URL = process.env.ACCESS_URL ?? `http://localhost:${DEV_PORT}`;
const DEFAULT_ADMIN = process.env.DEFAULT_ADMIN ?? "admin@example.com";

if (!existsSync(DEX_BIN)) {
  console.log("[dev-dex] installing dex binary…");
  await $`bash ${join(E2E_DIR, "scripts/install-dex.sh")}`;
}

mkdirSync(DEX_DEV_DIR, { recursive: true });
const dexConfig = `issuer: http://127.0.0.1:${DEX_PORT}/dex
storage:
  type: memory
web:
  http: 127.0.0.1:${DEX_PORT}
  allowedOrigins: ["*"]
oauth2:
  skipApprovalScreen: true
expiry:
  idTokens: 8h
  refreshTokens:
    validIfNotUsedFor: 24h
staticClients:
  - id: ${APP_NAME}
    secret: ${APP_NAME}-secret
    redirectURIs:
      - ${ACCESS_URL}${BASE_PATH}/api/account/auth/callback
    name: ${APP_NAME} dev
enablePasswordDB: true
staticPasswords:
  # bcrypt of "admin" — local dev only.
  - email: ${DEFAULT_ADMIN}
    hash: "$2b$10$ZDM1j7ol1V4C0pDIyN.uu.eitELj7.LOvYhkA5nXLi/yBoP9.mynC"
    username: admin
    userID: dev-admin
  - email: user@example.com
    hash: "$2b$10$ZDM1j7ol1V4C0pDIyN.uu.eitELj7.LOvYhkA5nXLi/yBoP9.mynC"
    username: user
    userID: dev-user
`;
writeFileSync(DEX_CONFIG, dexConfig);

const dexBase = `http://127.0.0.1:${DEX_PORT}/dex`;

console.log(`[dev-dex] starting dex on ${dexBase}`);
const dex: Subprocess = Bun.spawn([DEX_BIN, "serve", DEX_CONFIG], {
  stdout: "inherit",
  stderr: "inherit",
});

const deadline = Date.now() + 15_000;
let dexReady = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${dexBase}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      dexReady = true;
      break;
    }
  }
  catch {
    // not yet
  }
  await Bun.sleep(250);
}
if (!dexReady) {
  console.error("[dev-dex] dex did not become ready in 15s; aborting");
  dex.kill();
  process.exit(1);
}
console.log(`[dev-dex] dex ready · login: admin@example.com / admin`);

console.log(`[dev-dex] starting dev server (DEFAULT_ADMIN=${DEFAULT_ADMIN})`);
const dev: Subprocess = Bun.spawn(["bun", "run", "--filter", "@app/*", "dev"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    APP_NAME,
    BASE_PATH,
    ACCESS_URL,
    OAUTH_ISSUER: dexBase,
    OAUTH_CLIENT_ID: APP_NAME,
    OAUTH_CLIENT_SECRET: `${APP_NAME}-secret`,
    OAUTH_PKCE: "true",
    DEFAULT_ADMIN,
  },
});

let stopped = false;
async function stop(): Promise<void> {
  if (stopped)
    return;
  stopped = true;
  console.log("\n[dev-dex] shutting down");
  dev.kill();
  dex.kill();
  await dev.exited.catch(() => {});
  await dex.exited.catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

// If either child exits early, take the other one down with it.
void Promise.race([dex.exited, dev.exited]).then(() => void stop());

// Keep the script alive while children run.
await new Promise(() => {});
