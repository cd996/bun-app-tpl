import { describe, expect, it } from "bun:test";
import { ApiClient } from "../../lib/api";

describe("/api/health (live, encrypted, unlocked)", () => {
  it("returns 200 + status:ok", async () => {
    const c = new ApiClient();
    const res = await c.json<{ status: string }>("/api/health");
    expect(res.status).toBe("ok");
  });

  it("/api/health/ready returns 200 + status:ready when unlocked + DB reachable", async () => {
    const c = new ApiClient();
    const res = await c.raw("/api/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ready");
  });

  it("anonymous /api/encryption/status payload is minimal (no leaks)", async () => {
    const c = new ApiClient();
    const res = await c.json<{ data: Record<string, unknown> }>("/api/encryption/status");
    // Critical: an unauth caller must not see kdfSalt / encryptedDek /
    // dekVersion / challenge — these go through the protected /encryption
    // surface or the locked-only /encryption/unlock-challenge.
    expect(res.data).not.toHaveProperty("kdfSalt");
    expect(res.data).not.toHaveProperty("encryptedDek");
    expect(res.data).not.toHaveProperty("dekVersion");
    expect(res.data).not.toHaveProperty("challenge");
    expect(res.data.initialized).toBe(true);
    expect(res.data.locked).toBe(false);
    expect(res.data.status).toBe("unlocked");
  });

  it("/api/openapi.json requires admin (not reachable anonymously)", async () => {
    const c = new ApiClient();
    const res = await c.raw("/api/openapi.json");
    expect(res.status).toBe(401);
  });
});
