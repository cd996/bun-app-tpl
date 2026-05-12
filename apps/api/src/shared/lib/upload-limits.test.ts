import type { AppDatabase } from "@/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { documentAttachments, documents } from "@/modules/document/schema";
import { AppError } from "@/shared/lib/errors";
import { assertWithinTotalQuota, getUploadsUsedBytes, isWithinFileSize, MAX_UPLOAD_BYTES } from "./upload-limits";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "upload-limits-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedDocAttachment(size: number) {
  const userId = nanoid();
  const docId = nanoid();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id: userId,
    oauthSub: `sub_${userId}`,
    username: `u_${userId}`,
    name: "u",
    email: `${userId}@example.com`,
    createdAt: now,
    updatedAt: now,
  }).run();

  await db.insert(documents).values({
    id: docId,
    title: "t",
    creatorId: userId,
    createdAt: now,
    updatedAt: now,
  }).run();

  await db.insert(documentAttachments).values({
    id: nanoid(),
    documentId: docId,
    filename: "x.txt",
    filepath: `/tmp/${nanoid()}`,
    mimetype: "text/plain",
    size,
    uploadedBy: userId,
    createdAt: now,
  }).run();
}

describe("isWithinFileSize", () => {
  test("rejects zero", () => {
    expect(isWithinFileSize(0)).toBe(false);
  });
  test("accepts under cap", () => {
    expect(isWithinFileSize(MAX_UPLOAD_BYTES - 1)).toBe(true);
  });
  test("accepts at cap", () => {
    expect(isWithinFileSize(MAX_UPLOAD_BYTES)).toBe(true);
  });
  test("rejects over cap", () => {
    expect(isWithinFileSize(MAX_UPLOAD_BYTES + 1)).toBe(false);
  });
});

describe("getUploadsUsedBytes", () => {
  test("returns 0 on empty tables", async () => {
    expect(await getUploadsUsedBytes(db)).toBe(0);
  });

  test("sums attachment sizes across modules", async () => {
    await seedDocAttachment(1024);
    await seedDocAttachment(2048);
    expect(await getUploadsUsedBytes(db)).toBe(3072);
  });
});

describe("assertWithinTotalQuota", () => {
  const originalQuota = process.env.UPLOADS_TOTAL_BYTES;

  afterEach(() => {
    if (originalQuota === undefined)
      delete process.env.UPLOADS_TOTAL_BYTES;
    else
      process.env.UPLOADS_TOTAL_BYTES = originalQuota;
  });

  test("no-op when UPLOADS_TOTAL_BYTES is 0 (the default)", async () => {
    delete process.env.UPLOADS_TOTAL_BYTES;
    await expect(assertWithinTotalQuota(db, 1024 * 1024 * 1024)).resolves.toBeUndefined();
  });

  test("passes when used + additional is exactly at the limit", async () => {
    await seedDocAttachment(900);
    process.env.UPLOADS_TOTAL_BYTES = "1000";
    await expect(assertWithinTotalQuota(db, 100)).resolves.toBeUndefined();
  });

  test("throws 413 QUOTA_EXCEEDED when usage + additional would exceed the limit", async () => {
    await seedDocAttachment(900);
    process.env.UPLOADS_TOTAL_BYTES = "1000";
    try {
      await assertWithinTotalQuota(db, 200);
      expect.unreachable("should have thrown");
    }
    catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.statusCode).toBe(413);
      expect(e.code).toBe("QUOTA_EXCEEDED");
      expect(e.message).toMatch(/Upload quota exceeded/);
    }
  });
});
