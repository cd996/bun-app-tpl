import type { Context } from "hono";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { AuthConfig, OAuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv, User } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { count as countFn, eq, lte } from "drizzle-orm";
import { deleteCookie, getCookie } from "hono/cookie";
import { customAlphabet } from "nanoid";
import { pkceChallenges, sessions } from "@/modules/account/auth/schema";
import { users } from "@/modules/account/users/schema";
import { getOAuthConfig } from "@/shared/lib/app-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);
const RE_TOKEN_PATH = /\/token\/?$/;

// --- PKCE helpers ---

interface PkceEntry {
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

const PKCE_TTL_MS = 5 * 60 * 1000;

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = new Bun.CryptoHasher("sha256").update(verifier).digest();
  return Buffer.from(digest).toString("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// --- PKCE store (SQLite-backed) ---

let _pkceDb: AppDatabase | undefined;

export function initPkceStore(db: AppDatabase): void {
  _pkceDb = db;
}

function getPkceDb(): AppDatabase {
  if (!_pkceDb)
    throw new Error("PKCE store not initialized — call initPkceStore(db) first");
  return _pkceDb;
}

async function cleanExpiredPkce(): Promise<void> {
  const db = getPkceDb();
  const now = Date.now();
  await db.delete(pkceChallenges).where(lte(pkceChallenges.expiresAt, now)).run();
}

// --- Service functions ---

export async function createPkceChallenge(redirectUri: string) {
  const db = getPkceDb();
  await cleanExpiredPkce();

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const expiresAt = Date.now() + PKCE_TTL_MS;

  await db.insert(pkceChallenges).values({
    state,
    codeVerifier,
    redirectUri,
    expiresAt,
  }).run();

  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { state, codeVerifier, codeChallenge };
}

export async function consumePkceEntry(state: string): Promise<PkceEntry | undefined> {
  const db = getPkceDb();
  await cleanExpiredPkce();

  const row = await db.select().from(pkceChallenges).where(eq(pkceChallenges.state, state)).get();
  if (!row)
    return undefined;

  await db.delete(pkceChallenges).where(eq(pkceChallenges.state, state)).run();

  // Defence in depth: cleanExpiredPkce ran first, but a row could still be
  // racing past its TTL. Reject explicitly rather than returning a stale entry.
  if (Date.now() > row.expiresAt)
    return undefined;

  return {
    codeVerifier: row.codeVerifier,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}

export function buildAuthorizeUrl(oauth: OAuthConfig, callbackUrl: string, state: string, codeChallenge?: string): string {
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  if (oauth.pkce && codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

// --- Token exchange ---

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly token_type: string;
}

export async function exchangeCodeForTokens(
  oauth: OAuthConfig,
  callbackUrl: string,
  code: string,
  codeVerifier?: string,
  logger?: Logger,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl,
    client_id: oauth.clientId,
  });
  if (oauth.pkce && codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }
  if (oauth.clientSecret) {
    body.set("client_secret", oauth.clientSecret);
  }

  const res = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    logger?.error({ status: res.status, errorBody: text.slice(0, 200) }, "OAuth token exchange failed");
    throw new Error("OAuth token exchange failed");
  }

  return res.json() as Promise<TokenResponse>;
}

// --- Userinfo ---

interface OAuthUserInfo {
  readonly sub: string;
  readonly preferred_username?: string;
  readonly username?: string;
  readonly name?: string;
  readonly email?: string;
  readonly picture?: string;
}

export async function fetchUserInfo(oauth: OAuthConfig, accessToken: string, logger?: Logger): Promise<OAuthUserInfo> {
  const res = await fetch(oauth.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    logger?.error({ status: res.status, errorBody: text.slice(0, 200) }, "OAuth userinfo fetch failed");
    throw new Error("OAuth userinfo fetch failed");
  }

  return res.json() as Promise<OAuthUserInfo>;
}

// --- Token refresh ---

interface RefreshResult {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

export async function refreshAccessToken(oauth: OAuthConfig, refreshToken: string): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: oauth.clientId,
  });
  if (oauth.clientSecret) {
    body.set("client_secret", oauth.clientSecret);
  }

  const res = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status})`);
  }

  return res.json() as Promise<RefreshResult>;
}

// --- Token revocation ---

export async function revokeAccessToken(oauth: OAuthConfig, accessToken: string): Promise<void> {
  if (!oauth.tokenUrl)
    return;
  // Try standard RFC 7009 revocation endpoint (tokenUrl base + /revoke)
  const revocationUrl = oauth.tokenUrl.replace(RE_TOKEN_PATH, "/revoke");
  if (revocationUrl === oauth.tokenUrl)
    return; // Cannot derive revocation URL

  try {
    const body = new URLSearchParams({
      token: accessToken,
      token_type_hint: "access_token",
      client_id: oauth.clientId,
    });
    if (oauth.clientSecret) {
      body.set("client_secret", oauth.clientSecret);
    }

    await fetch(revocationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5_000),
    });
  }
  catch {
    // Best-effort revocation — do not fail logout if provider is unreachable
  }
}

// --- User upsert ---

export async function upsertUser(
  db: AppDatabase,
  userInfo: OAuthUserInfo,
  authConfig: AuthConfig,
  logger: Logger,
): Promise<typeof users.$inferSelect> {
  const now = new Date().toISOString();
  const defaultAdmins = authConfig.defaultAdmins;
  const username = (userInfo.preferred_username ?? userInfo.username ?? userInfo.sub).toLowerCase();
  const email = (userInfo.email ?? "").toLowerCase();

  const existing = await db.select().from(users).where(eq(users.oauthSub, userInfo.sub)).get();

  if (existing) {
    await db.update(users)
      .set({
        name: userInfo.name ?? existing.name,
        email: userInfo.email ?? existing.email,
        avatar: userInfo.picture ?? existing.avatar,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();

    return { ...existing, lastLoginAt: now, updatedAt: now };
  }

  // Bootstrap-admin assignment must be atomic with the insert. Two callbacks
  // racing on a fresh install would otherwise both observe `userCount=0` and
  // — if both also matched DEFAULT_ADMIN — both promote themselves; or if one
  // matched and the other did not, the unmatched login could lock out the
  // legitimate admin from ever bootstrapping. Wrap in a transaction and
  // re-check the count under the same lock.
  return await db.transaction(async (tx) => {
    // Double-check inside the tx: another concurrent callback could have just
    // created the same user. If so, fall through to update behaviour.
    const dupe = await tx.select().from(users).where(eq(users.oauthSub, userInfo.sub)).get();
    if (dupe) {
      await tx.update(users)
        .set({
          name: userInfo.name ?? dupe.name,
          email: userInfo.email ?? dupe.email,
          avatar: userInfo.picture ?? dupe.avatar,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, dupe.id))
        .run();
      return { ...dupe, lastLoginAt: now, updatedAt: now };
    }

    const userCount = await tx.select({ value: countFn() }).from(users).get();
    const canBootstrapAdmin = (userCount?.value ?? 0) === 0;
    const matchesDefaultAdmin = defaultAdmins.includes(username) || defaultAdmins.includes(email);
    const isAdmin = canBootstrapAdmin && matchesDefaultAdmin;

    // When DEFAULT_ADMIN is set and the first arrival doesn't match, refuse
    // to create a non-admin first user — otherwise the legitimate admin
    // can never bootstrap because `userCount === 0` is gone forever.
    if (canBootstrapAdmin && defaultAdmins.length > 0 && !matchesDefaultAdmin) {
      logger.warn({ username, email }, "first login rejected: DEFAULT_ADMIN not yet bootstrapped");
      throw new Error(
        "Initial admin must complete first login before other users can sign up. "
        + "DEFAULT_ADMIN does not match this account.",
      );
    }

    if (isAdmin) {
      logger.info({ username }, "initial user assigned admin role via DEFAULT_ADMIN");
    }

    const newUser = {
      id: nanoid(),
      oauthSub: userInfo.sub,
      username,
      name: userInfo.name ?? username,
      email: userInfo.email ?? "",
      avatar: userInfo.picture ?? null,
      role: isAdmin ? "admin" as const : "user" as const,
      status: "active" as const,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(users).values(newUser).run();
    return newUser;
  });
}

// --- Session CRUD ---

export async function createSession(
  db: AppDatabase,
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number | undefined,
): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();

  await db.insert(sessions).values({
    id,
    userId,
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  }).run();

  return id;
}

export async function getSessionWithUser(db: AppDatabase, sessionId: string) {
  // Single JOIN — every authenticated request runs this. Drizzle's `.get()`
  // returns the first row; we then split it into the two domain shapes the
  // callers expect. Halves the per-request DB round-trip count compared to
  // the previous "fetch session → fetch user" sequence.
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row)
    return undefined;
  return row;
}

export async function updateSessionTokens(
  db: AppDatabase,
  sessionId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number | undefined,
) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (expiresIn ?? 3600) * 1000).toISOString();

  await db.update(sessions)
    .set({
      accessToken,
      refreshToken: refreshToken ?? undefined,
      expiresAt,
      updatedAt: now,
    })
    .where(eq(sessions.id, sessionId))
    .run();
}

export async function deleteSession(db: AppDatabase, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export async function deleteUserSessions(db: AppDatabase, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function isSessionExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

export function logDefaultAdmins(authConfig: AuthConfig, logger: Logger) {
  if (authConfig.defaultAdmins.length > 0) {
    logger.info(`Default admin configured: ${authConfig.defaultAdmins.join(", ")}`);
  }
}

// --- AuthProvider implementation (registered with the shared middleware) ---

const SESSION_COOKIE = "session_id";

/**
 * Resolves the request's session-cookie-bound user. Refreshes the OAuth
 * access token when the local session is expired but a refresh token is
 * available; otherwise tears down the session.
 */
export async function oauthSessionAuthProvider(db: AppDatabase, c: Context<AppEnv>): Promise<User | undefined> {
  const config = c.get("config");
  const sessionId = getCookie(c, SESSION_COOKIE);

  if (!sessionId)
    return undefined;

  const result = await getSessionWithUser(db, sessionId);
  if (!result) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return undefined;
  }

  const { session, user } = result;

  if (user.status === "disabled") {
    await deleteSession(db, sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return undefined;
  }

  if (isSessionExpired(session.expiresAt)) {
    if (session.refreshToken) {
      try {
        await refreshSessionWithMutex(db, session.id, session.refreshToken, config);
        return user;
      }
      catch {
        await deleteSession(db, sessionId);
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return undefined;
      }
    }
    await deleteSession(db, sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return undefined;
  }

  return user;
}

// Per-session mutex for refresh-token grants. Most IdPs treat refresh tokens
// as single-use; two parallel requests on the same expired session will
// otherwise both call /token, the IdP rotates the refresh token after the
// first, the second gets `invalid_grant`, and we end up storing the second
// (failed) response over the first (succeeded). Coalesce on a single in-flight
// promise per session id.
const refreshInFlight = new Map<string, Promise<void>>();

async function refreshSessionWithMutex(
  db: AppDatabase,
  sessionId: string,
  refreshToken: string,
  config: Config,
): Promise<void> {
  const existing = refreshInFlight.get(sessionId);
  if (existing)
    return existing;

  const work = (async () => {
    const oauth = getOAuthConfig(config);
    const { refreshTokens } = await import("./oidc");
    const refreshed = await refreshTokens({ oauth, appConfig: config, refreshToken });
    await updateSessionTokens(
      db,
      sessionId,
      refreshed.access_token,
      refreshed.refresh_token,
      refreshed.expires_in,
    );
  })();
  refreshInFlight.set(sessionId, work);
  try {
    await work;
  }
  finally {
    if (refreshInFlight.get(sessionId) === work)
      refreshInFlight.delete(sessionId);
  }
}
