import type { OAuthConfig } from "@/shared/lib/app-config";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { refreshAccessToken, revokeAccessToken } from "./auth.service";

function makeOAuth(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    clientId: "app",
    clientSecret: "shh",
    authorizeUrl: "https://idp.example.com/authorize",
    tokenUrl: "https://idp.example.com/token",
    userinfoUrl: "https://idp.example.com/userinfo",
    pkce: true,
    ...over,
  };
}

const fetchCalls: { url: string; init: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

describe("refreshAccessToken", () => {
  test("posts grant_type=refresh_token + form-encoded credentials and returns parsed body", async () => {
    stubFetch(() => new Response(JSON.stringify({
      access_token: "a-new-token",
      refresh_token: "a-new-refresh",
      expires_in: 3600,
    }), { headers: { "Content-Type": "application/json" } }));

    const result = await refreshAccessToken(makeOAuth(), "old-refresh");

    expect(result.access_token).toBe("a-new-token");
    expect(result.refresh_token).toBe("a-new-refresh");
    expect(result.expires_in).toBe(3600);

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://idp.example.com/token");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(call.init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe("app");
    expect(params.get("client_secret")).toBe("shh");
  });

  test("omits client_secret when the OAuth config doesn't carry one (public client)", async () => {
    stubFetch(() => new Response(JSON.stringify({ access_token: "x" }), { headers: { "Content-Type": "application/json" } }));

    await refreshAccessToken(makeOAuth({ clientSecret: undefined }), "r");

    const params = new URLSearchParams(fetchCalls[0]!.init.body as string);
    expect(params.has("client_secret")).toBe(false);
  });

  test("throws when the IdP returns a non-2xx", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    await expect(refreshAccessToken(makeOAuth(), "r")).rejects.toThrow(/401/);
  });
});

describe("revokeAccessToken", () => {
  test("calls /revoke (derived from /token) with the access-token + token_type_hint", async () => {
    stubFetch(() => new Response(null, { status: 200 }));

    await revokeAccessToken(makeOAuth(), "the-token");

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe("https://idp.example.com/revoke");
    const params = new URLSearchParams(fetchCalls[0]!.init.body as string);
    expect(params.get("token")).toBe("the-token");
    expect(params.get("token_type_hint")).toBe("access_token");
    expect(params.get("client_id")).toBe("app");
    expect(params.get("client_secret")).toBe("shh");
  });

  test("is a best-effort no-op when revocation URL cannot be derived from tokenUrl", async () => {
    stubFetch(() => new Response(null, { status: 200 }));

    // No trailing /token — derivation returns the same URL, the function bails.
    await revokeAccessToken(makeOAuth({ tokenUrl: "https://idp.example.com/oauth2" }), "t");

    expect(fetchCalls.length).toBe(0);
  });

  test("swallows network errors so logout can complete even if the IdP is unreachable", async () => {
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });

    await expect(revokeAccessToken(makeOAuth(), "t")).resolves.toBeUndefined();
    expect(fetchCalls.length).toBe(1);
  });

  test("swallows non-2xx responses (best-effort)", async () => {
    stubFetch(() => new Response("server down", { status: 503 }));
    await expect(revokeAccessToken(makeOAuth(), "t")).resolves.toBeUndefined();
  });
});
