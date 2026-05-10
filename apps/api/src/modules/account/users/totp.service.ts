import type { AppDatabase } from "@/db";
import { randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import * as QRCode from "qrcode";
import { totpChallenges, userTotpDevices } from "@/modules/account/users/schema";
import { nanoid } from "@/shared/lib/id";

const TOTP_ISSUER = Bun.env.APP_DISPLAY_NAME ?? "App";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function createTotpInstance(secret: string, username: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

// ── Device management ──

export async function listTotpDevices(db: AppDatabase, userId: string) {
  return await db
    .select({
      id: userTotpDevices.id,
      name: userTotpDevices.name,
      verified: userTotpDevices.verified,
      createdAt: userTotpDevices.createdAt,
    })
    .from(userTotpDevices)
    .where(eq(userTotpDevices.userId, userId))
    .all();
}

export async function createTotpDevice(db: AppDatabase, userId: string, name: string, username: string) {
  const secret = new Secret({ size: 20 });
  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(userTotpDevices).values({
    id,
    userId,
    name,
    secret: secret.base32,
    verified: false,
    createdAt: now,
  }).run();

  const totp = createTotpInstance(secret.base32, username);
  const uri = totp.toString();
  const qrCode = await QRCode.toDataURL(uri);

  return { id, name, secret: secret.base32, uri, qrCode };
}

export async function confirmTotpDevice(db: AppDatabase, deviceId: string, userId: string, code: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const device = await tx.select().from(userTotpDevices).where(
      and(eq(userTotpDevices.id, deviceId), eq(userTotpDevices.userId, userId)),
    ).get();

    if (!device || device.verified)
      return false;

    const totp = createTotpInstance(device.secret, "");
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null)
      return false;

    // RFC 6238 §5.2 — reject replay of a code at the same/earlier timestep.
    const usedTimestep = Math.floor(Date.now() / 30000) + delta;
    if (usedTimestep <= device.lastUsedTimestep)
      return false;

    await tx.update(userTotpDevices)
      .set({ verified: true, lastUsedTimestep: usedTimestep })
      .where(eq(userTotpDevices.id, deviceId))
      .run();

    return true;
  });
}

export async function deleteTotpDevice(db: AppDatabase, deviceId: string, userId: string): Promise<boolean> {
  const device = await db.select().from(userTotpDevices).where(
    and(eq(userTotpDevices.id, deviceId), eq(userTotpDevices.userId, userId)),
  ).get();

  if (!device)
    return false;

  await db.delete(userTotpDevices).where(eq(userTotpDevices.id, deviceId)).run();
  return true;
}

// ── Verification ──

/**
 * In-memory per-user TOTP failure tracker. The IP-keyed limiter on
 * /account/auth/totp-verify caps brute-force from one IP, but a determined
 * attacker rotating IPs can still grind a single user. Lock the *user*
 * after N consecutive failures and force them to restart the OAuth flow
 * (which mints a new TOTP challenge and resets the counter).
 *
 * Module-level state survives DEK rotation (in-process); a real restart
 * resets it, which is acceptable — the attacker's challenge expires too.
 */
const TOTP_USER_LOCKOUT_THRESHOLD = 5;
const TOTP_USER_LOCKOUT_MS = 15 * 60 * 1000;
const totpUserFailures = new Map<string, { failures: number; lockedUntil: number | null }>();

function getTotpUserState(userId: string): { failures: number; lockedUntil: number | null } {
  let entry = totpUserFailures.get(userId);
  if (!entry) {
    entry = { failures: 0, lockedUntil: null };
    totpUserFailures.set(userId, entry);
  }
  return entry;
}

export function isTotpUserLocked(userId: string): { locked: boolean; retryAfterSeconds: number } {
  const entry = totpUserFailures.get(userId);
  if (!entry || entry.lockedUntil === null)
    return { locked: false, retryAfterSeconds: 0 };
  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    entry.lockedUntil = null;
    entry.failures = 0;
    return { locked: false, retryAfterSeconds: 0 };
  }
  return { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

function recordTotpFailure(userId: string): void {
  const state = getTotpUserState(userId);
  state.failures += 1;
  if (state.failures >= TOTP_USER_LOCKOUT_THRESHOLD) {
    state.lockedUntil = Date.now() + TOTP_USER_LOCKOUT_MS;
  }
}

function recordTotpSuccess(userId: string): void {
  totpUserFailures.delete(userId);
}

/** Test hook — drop the in-memory failure tracker between specs. */
export function __resetTotpFailureTrackerForTests(): void {
  totpUserFailures.clear();
}

export async function hasVerifiedTotp(db: AppDatabase, userId: string): Promise<boolean> {
  const device = await db.select({ id: userTotpDevices.id }).from(userTotpDevices).where(
    and(eq(userTotpDevices.userId, userId), eq(userTotpDevices.verified, true)),
  ).get();
  return !!device;
}

export async function verifyTotpCode(db: AppDatabase, userId: string, code: string): Promise<boolean> {
  // Refuse before talking to the DB if the user is currently locked. The
  // caller surfaces this via { locked, retryAfterSeconds } from
  // isTotpUserLocked() — we still return false here so legacy boolean
  // callers reject the attempt safely.
  if (isTotpUserLocked(userId).locked)
    return false;

  const ok = await db.transaction(async (tx) => {
    const devices = await tx.select().from(userTotpDevices).where(
      and(eq(userTotpDevices.userId, userId), eq(userTotpDevices.verified, true)),
    ).all();

    for (const device of devices) {
      const totp = createTotpInstance(device.secret, "");
      const delta = totp.validate({ token: code, window: 1 });
      if (delta === null)
        continue;

      // RFC 6238 §5.2 — same code (or earlier window) cannot be redeemed twice.
      const usedTimestep = Math.floor(Date.now() / 30000) + delta;
      if (usedTimestep <= device.lastUsedTimestep)
        continue;

      await tx.update(userTotpDevices)
        .set({ lastUsedTimestep: usedTimestep })
        .where(eq(userTotpDevices.id, device.id))
        .run();
      return true;
    }

    return false;
  });

  if (ok)
    recordTotpSuccess(userId);
  else
    recordTotpFailure(userId);
  return ok;
}

// ── Login TOTP challenge ──

export async function createTotpChallenge(
  db: AppDatabase,
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number | undefined,
  redirectUri: string,
): Promise<string> {
  await cleanExpiredChallenges(db);

  const id = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  await db.insert(totpChallenges).values({
    id,
    userId,
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresIn: expiresIn ?? null,
    redirectUri,
    expiresAt,
  }).run();

  return id;
}

export async function consumeTotpChallenge(db: AppDatabase, challengeId: string) {
  await cleanExpiredChallenges(db);

  const row = await db.select().from(totpChallenges).where(eq(totpChallenges.id, challengeId)).get();
  if (!row)
    return undefined;

  await db.delete(totpChallenges).where(eq(totpChallenges.id, challengeId)).run();

  return {
    userId: row.userId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresIn: row.expiresIn,
    redirectUri: row.redirectUri,
  };
}

async function cleanExpiredChallenges(db: AppDatabase) {
  await db.delete(totpChallenges).where(lte(totpChallenges.expiresAt, Date.now())).run();
}

// ── Step-up challenge token (for sensitive ops) ──

const STEP_UP_TTL_MS = 10 * 60 * 1000;
const STEP_UP_PRUNE_THRESHOLD = 1000;
const stepUpTokens = new Map<string, { userId: string; expiresAt: number }>();

function pruneExpiredStepUpTokens(): void {
  if (stepUpTokens.size <= STEP_UP_PRUNE_THRESHOLD)
    return;
  const now = Date.now();
  for (const [token, entry] of stepUpTokens) {
    if (entry.expiresAt <= now)
      stepUpTokens.delete(token);
  }
}

export function issueStepUpToken(userId: string): string {
  pruneExpiredStepUpTokens();
  const token = randomBytes(32).toString("hex");
  stepUpTokens.set(token, { userId, expiresAt: Date.now() + STEP_UP_TTL_MS });
  return token;
}

export function validateStepUpToken(token: string, userId: string): boolean {
  const entry = stepUpTokens.get(token);
  if (!entry || entry.userId !== userId || entry.expiresAt <= Date.now()) {
    if (entry)
      stepUpTokens.delete(token);
    return false;
  }
  // Single-use: consume on first successful validation.
  stepUpTokens.delete(token);
  return true;
}
