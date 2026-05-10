import type { AppEnv } from "@/shared/lib/types";
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __resetEncryptionStateForTests, beginOperation, endOperation, setDek, setInitialized, setOnUnlock } from "@/modules/encryption/state";
import { AppError } from "@/shared/lib/errors";
import { requireUnlocked } from "./encryption";

afterEach(() => {
  __resetEncryptionStateForTests();
});

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUnlocked);
  app.get("/p", c => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 503);
    }
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  return app;
}

describe("requireUnlocked", () => {
  test("503 SYSTEM_LOCKED when initialized but not unlocked", async () => {
    setInitialized(true);
    const res = await buildApp().request("/p");
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("SYSTEM_LOCKED");
  });

  test("passes through when uninitialized (setup mode is not 'locked')", async () => {
    const res = await buildApp().request("/p");
    expect(res.status).toBe(200);
  });

  test("passes through when DEK is set (system unlocked)", async () => {
    setOnUnlock(async () => {});
    beginOperation();
    try {
      await setDek("a".repeat(64));
    }
    finally {
      endOperation();
    }
    const res = await buildApp().request("/p");
    expect(res.status).toBe(200);
  });
});
