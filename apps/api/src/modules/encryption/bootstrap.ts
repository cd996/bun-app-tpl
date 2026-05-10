import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { createDb } from "@/db";
import { readEncryptionMeta } from "./meta";
import { setBootstrapToken, setEncryptionDisabled, setInitialized, setOnUnlock } from "./state";

// ─── Types ───

export type EncryptionBootResult
  = | { mode: "disabled"; db: AppDatabase }
    | { mode: "locked" | "setup" };

/**
 * Bootstrap the encryption subsystem.
 *
 * - `DB_ENCRYPTION=false` → validates no previously-encrypted DB exists,
 *   opens a plaintext database, and returns it directly.
 * - `DB_ENCRYPTION=true`  → configures bootstrap token, reads encryption
 *   meta, sets up the onUnlock callback, and returns `locked` or `setup`.
 *
 * @param config Application configuration.
 * @param logger Logger instance.
 * @param onDbReady Called when the database becomes available (immediately
 *   for disabled mode is handled by the caller; for encrypted mode it is
 *   invoked inside the onUnlock flow).
 */
export async function bootstrapEncryption(
  config: Config,
  logger: Logger,
  onDbReady: (db: AppDatabase) => Promise<void>,
): Promise<EncryptionBootResult> {
  if (!config.DB_ENCRYPTION) {
    const meta = readEncryptionMeta(config.DB_PATH);
    if (meta) {
      throw new Error(
        "DB_ENCRYPTION is disabled but the database was previously encrypted. "
        + "Remove DB_ENCRYPTION=false to use the encrypted database, "
        + "or delete the existing database and meta.db to start fresh.",
      );
    }
    setEncryptionDisabled(true);
    logger.info("DB_ENCRYPTION disabled, opening database without encryption");
    const db = await createDb(config.DB_PATH);
    return { mode: "disabled", db };
  }

  const meta = readEncryptionMeta(config.DB_PATH);
  const tokenFile = resolve(dirname(config.DB_PATH), "bootstrap-token.txt");

  // Bootstrap token for /encryption/init. Generated fresh at every boot;
  // only published while the system is in setup mode (meta.db absent) and
  // discarded once initialization completes. The token is single-use by
  // design — once /encryption/init succeeds, the value is no longer
  // accepted anywhere and rotating it on restart is harmless.
  const bootstrapToken = randomBytes(32).toString("hex");
  setBootstrapToken(bootstrapToken);
  if (!meta) {
    // Setup mode — operator needs the token to finish initialization.
    process.stderr.write(
      `[encryption] BOOTSTRAP_TOKEN (one-time, expires after /encryption/init): ${bootstrapToken}\n`,
    );
    // Also drop a sibling file alongside the DB so operators who can't see
    // stderr (e.g. running under a service manager) can still recover it.
    // The file is removed on the success path of /encryption/init AND on any
    // subsequent boot once meta exists (defence against a failed init that
    // left the file behind).
    try {
      mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
      try {
        chmodSync(dirname(tokenFile), 0o700);
      }
      catch {
        // perms may be denied on shared mounts — best-effort
      }
      writeFileSync(tokenFile, `${bootstrapToken}\n`, { mode: 0o600 });
      logger.warn({ tokenFile }, "encryption setup pending; bootstrap token written to file (delete after /encryption/init)");
    }
    catch (err) {
      logger.error({ err }, "failed to write bootstrap-token.txt; operator must read the value from stderr");
    }
  }
  else {
    // Meta exists → init has already succeeded at some point. Sweep any stale
    // bootstrap-token.txt left by an earlier failed attempt; the in-memory
    // token rotated this boot and never matches the file content anyway.
    try {
      rmSync(tokenFile, { force: true });
    }
    catch {
      // best-effort
    }
  }

  setOnUnlock(async (dek: string) => {
    logger.info("system unlocked, opening encrypted database");
    const db = await createDb(config.DB_PATH, dek);
    await onDbReady(db);
  });

  if (meta) {
    setInitialized(true);
    logger.info("encryption initialized, starting in locked mode");
    return { mode: "locked" };
  }

  logger.info("encryption not initialized, starting in setup mode");
  return { mode: "setup" };
}
