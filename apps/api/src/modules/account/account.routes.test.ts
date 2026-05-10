import { describe, expect, it } from "bun:test";
import { accountRoutes } from "./account.routes";

describe("accountRoutes aggregator", () => {
  it("returns an OpenAPIHono instance with mounted routes", () => {
    const router = accountRoutes();
    // Smoke check: the underlying hono router exposes `routes` after mounting.
    // We just want to confirm the aggregator constructed without throwing and
    // composed at least one sub-route.
    expect(router).toBeDefined();
    expect(typeof router.fetch).toBe("function");
    expect((router.routes as unknown[]).length).toBeGreaterThan(0);
  });
});
