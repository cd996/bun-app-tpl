import type { AppDatabase } from "@/db";
import type { AuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { upsertUser } from "./auth.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

function authConfig(defaultAdmins: readonly string[]): AuthConfig {
  return {
    sessionMaxAge: 86400,
    defaultAdmins,
  };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-auth-service-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("upsertUser DEFAULT_ADMIN bootstrap", () => {
  test("assigns admin only to the first matching user", async () => {
    const first = await upsertUser(
      db,
      { sub: "sub-admin", preferred_username: "admin", email: "admin@example.com" },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    const second = await upsertUser(
      db,
      { sub: "sub-second", preferred_username: "second", email: "second@example.com" },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    expect(first.role).toBe("admin");
    expect(second.role).toBe("user");
  });

  test("does not promote an existing user after DEFAULT_ADMIN changes", async () => {
    const created = await upsertUser(
      db,
      { sub: "sub-user", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    const updated = await upsertUser(
      db,
      { sub: "sub-user", preferred_username: "alice", email: "alice@example.com" },
      authConfig(["alice@example.com"]),
      logger,
    );

    const row = await db.select().from(users).where(eq(users.id, created.id)).get();

    expect(created.role).toBe("user");
    expect(updated.role).toBe("user");
    expect(row?.role).toBe("user");
  });
});
