import type { Context } from "hono";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { AuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv, User } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { count as countFn, eq, lte } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { pkceChallenges, sessions } from "@/modules/account/auth/schema";
import { clearSessionCookie, readSessionId } from "@/modules/account/auth/session-cookie";
import { users } from "@/modules/account/users/schema";
import { getOAuthConfig } from "@/shared/lib/app-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

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

// --- User upsert ---

interface OAuthUserInfo {
  readonly sub: string;
  readonly preferred_username?: string;
  readonly username?: string;
  readonly name?: string;
  readonly email?: string;
  readonly picture?: string;
}

export async function upsertUser(
  db: AppDatabase,
  userInfo: OAuthUserInfo,
  authConfig: AuthConfig,
  logger: Logger,
): Promise<typeof users.$inferSelect> {
  const now = new Date().toISOString();
  const defaultAdmins = authConfig.defaultAdmins;
  // IdPs that don't expose a username claim (e.g. dex's password connector
  // without a configured `username` field) would otherwise leak the opaque
  // `sub` into a human-facing field. Fall back to a short random handle
  // instead — the user can still be identified by email/name in the UI.
  const username = (userInfo.preferred_username ?? userInfo.username ?? `u_${nanoid()}`).toLowerCase();
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

  // Bootstrap-admin assignment must be atomic with the insert. Two DEFAULT_ADMIN
  // callbacks racing on a fresh install would otherwise both observe
  // `adminCount=0` and both promote themselves — harmless (both are
  // legitimate DEFAULT_ADMIN entries) but the transaction also covers the
  // duplicate-sub race below.
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

    // Gate bootstrap on "no admin exists" rather than "no user exists" so a
    // non-admin signing up first doesn't lock out the DEFAULT_ADMIN. The
    // promotion still fires whenever a matching login lands while the
    // current admin set is empty (including after the only admin is
    // deleted / demoted), and non-admin users can sign up freely the whole
    // time.
    const adminRow = await tx.select({ value: countFn() }).from(users).where(eq(users.role, "admin")).get();
    const canBootstrapAdmin = (adminRow?.value ?? 0) === 0;
    const matchesDefaultAdmin = defaultAdmins.includes(username) || defaultAdmins.includes(email);
    const isAdmin = canBootstrapAdmin && matchesDefaultAdmin;

    if (isAdmin) {
      logger.info({ username }, "user assigned admin role via DEFAULT_ADMIN (no admin existed)");
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

/**
 * Resolves the request's session-cookie-bound user. Refreshes the OAuth
 * access token when the local session is expired but a refresh token is
 * available; otherwise tears down the session.
 */
export async function oauthSessionAuthProvider(db: AppDatabase, c: Context<AppEnv>): Promise<User | undefined> {
  const config = c.get("config");
  const sessionId = readSessionId(c);

  if (!sessionId)
    return undefined;

  const result = await getSessionWithUser(db, sessionId);
  if (!result) {
    clearSessionCookie(c, config.NODE_ENV);
    return undefined;
  }

  const { session, user } = result;

  if (user.status === "disabled") {
    await deleteSession(db, sessionId);
    clearSessionCookie(c, config.NODE_ENV);
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
        clearSessionCookie(c, config.NODE_ENV);
        return undefined;
      }
    }
    await deleteSession(db, sessionId);
    clearSessionCookie(c, config.NODE_ENV);
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
