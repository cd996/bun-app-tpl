#!/usr/bin/env bun
// One-command dev: launches the bundled dex IdP and the app's dev server in
// the same process group. If OAUTH_ISSUER points elsewhere, dex is skipped
// and the user is sent back to `bun run dev`.
/* eslint-disable no-console */
import type { Subprocess } from "bun";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "..");
const APP_NAME = process.env.APP_NAME ?? "app";

const issuer = process.env.OAUTH_ISSUER;
// Match the dex-<app> subdomain convention this template uses; tolerant of
// arbitrary host suffix (nsl wildcards, *.localhost, custom dev TLS).
const BUNDLED_DEX = new RegExp(`(?:^|//)dex-${APP_NAME}[.\\-]`, "i");
const wantsBundledDex = !issuer || BUNDLED_DEX.test(issuer);

if (!wantsBundledDex) {
  console.log(`[dev-all] OAUTH_ISSUER=${issuer} — not the bundled dex.`);
  console.log("[dev-all] Skipping dex. Run `bun run dev` directly; the app reads OAUTH_* from .env.");
  process.exit(0);
}

const children: Subprocess[] = [];

function spawn(cmd: string[], label: string): Subprocess {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  children.push(proc);
  void proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[dev-all] ${label} exited (code=${code}); shutting down siblings`);
      void shutdown();
    }
  });
  return proc;
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown)
    return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    }
    catch {}
  }
  await Promise.allSettled(children.map(c => c.exited));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("[dev-all] starting dex + dev server");
spawn(["bun", "scripts/dev-dex.ts"], "dex");

// Poll the issuer URL the app will use; 20s ceiling so a broken dex doesn't
// hang the dev session.
const deadline = Date.now() + 20_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${issuer ?? `http://dex-${APP_NAME}.localhost:3355`}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      ready = true;
      break;
    }
  }
  catch {}
  await Bun.sleep(300);
}
if (!ready) {
  console.error("[dev-all] dex did not become ready in 20s; aborting");
  void shutdown();
  process.exit(1);
}

console.log("[dev-all] dex ready, starting dev server");
spawn(["bun", "run", "dev"], "dev");

await new Promise(() => {});
