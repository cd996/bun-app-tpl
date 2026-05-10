import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { ROOT_DIR } from "../root";
import { embeddedMigrations } from "./embedded-migrations";
import * as schema from "./schema";

const RE_HEX_64 = /^[0-9a-f]{64}$/;

/** Validate that an encryption key is a valid 64-char hex string. */
export function validateEncryptionKey(dekHex: string): void {
  if (!RE_HEX_64.test(dekHex)) {
    throw new Error("Invalid encryption key: expected 64-char lowercase hex string");
  }
}

export async function createDb(path: string, encryptionKey?: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (encryptionKey) {
    validateEncryptionKey(encryptionKey);
  }

  const client = createClient(
    encryptionKey
      ? { url: `file:${path}`, encryptionKey }
      : { url: `file:${path}` },
  );

  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");

  // Performance / footprint tuning. Some PRAGMAs are no-ops on libsql with
  // encryption enabled — swallow the error and continue rather than aborting
  // the whole bootstrap.
  for (const pragma of [
    "PRAGMA synchronous = NORMAL",
    "PRAGMA cache_size = -65536",
    "PRAGMA mmap_size = 268435456",
    "PRAGMA temp_store = MEMORY",
  ]) {
    try {
      await client.execute(pragma);
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.debug(`[db] ${pragma} skipped:`, err);
    }
  }

  const db = drizzle(client, { schema });

  await runMigrations(db);

  return Object.assign(db, {
    close: () => client.close(),
    // Used by encryption.service.rotateDek to flush WAL before the libsql
    // copy-client opens the same file.
    checkpoint: () => client.execute("PRAGMA wal_checkpoint(TRUNCATE)"),
  });
}

async function runMigrations(db: ReturnType<typeof drizzle>) {
  const fsMigrationsFolder = resolve(ROOT_DIR, "apps/api/drizzle");
  const journalPath = resolve(fsMigrationsFolder, "meta/_journal.json");

  if (existsSync(journalPath)) {
    await migrate(db, { migrationsFolder: fsMigrationsFolder });
  }
  else if (embeddedMigrations.size > 0) {
    const tmpMigrations = resolve(tmpdir(), `app-migrations-${process.pid}`);
    try {
      mkdirSync(resolve(tmpMigrations, "meta"), { recursive: true });
      for (const [name, content] of embeddedMigrations) {
        const filePath = resolve(tmpMigrations, name);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
      }
      await migrate(db, { migrationsFolder: tmpMigrations });
    }
    finally {
      rmSync(tmpMigrations, { recursive: true, force: true });
    }
  }
  else {
    throw new Error("No migrations available (neither filesystem nor embedded). Cannot ensure database schema.");
  }
}

export type AppDatabase = Awaited<ReturnType<typeof createDb>>;
