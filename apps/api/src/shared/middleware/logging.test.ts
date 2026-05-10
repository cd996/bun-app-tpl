import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { loggingMiddleware } from "./logging";

interface LogCall {
  ctx: Record<string, unknown>;
  msg: string;
}

function buildApp(): { app: Hono<AppEnv>; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const stub: Logger = {
    debug: () => {},
    info: (ctx: unknown, msg?: string) => calls.push({ ctx: ctx as Record<string, unknown>, msg: msg ?? "" }),
    warn: () => {},
    error: () => {},
    fatal: () => {},
    flush: () => {},
  } as unknown as Logger;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("logger", stub);
    c.set("requestId", "test-rid");
    return next();
  });
  app.use("*", loggingMiddleware());
  app.get("/p", c => c.json({ ok: true }));
  app.get("/api/health", c => c.json({ status: "ok" }));
  app.get("/api/health/ready", c => c.json({ status: "ready" }));
  app.options("/p", c => c.body(null, 204));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  return { app, calls };
}

describe("loggingMiddleware", () => {
  test("logs method, path, status, duration, requestId on success", async () => {
    const { app, calls } = buildApp();
    const res = await app.request("/p");
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.msg).toBe("request completed");
    expect(c.ctx.method).toBe("GET");
    expect(c.ctx.path).toBe("/p");
    expect(c.ctx.status).toBe(200);
    expect(c.ctx.requestId).toBe("test-rid");
    expect(typeof c.ctx.duration).toBe("number");
    expect(c.ctx.duration as number).toBeGreaterThanOrEqual(0);
  });

  test("does not log /api/health, /api/health/ready, or OPTIONS preflights", async () => {
    const { app, calls } = buildApp();
    await app.request("/api/health");
    await app.request("/api/health/ready");
    await app.request("/p", { method: "OPTIONS" });
    expect(calls.length).toBe(0);
  });

  test("logs even when the handler throws", async () => {
    const { app, calls } = buildApp();
    app.onError((_err, c) => c.json({ error: { code: "X", message: "x" } }, 500));
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(calls.length).toBe(1);
    expect(calls[0]!.ctx.path).toBe("/boom");
  });
});
