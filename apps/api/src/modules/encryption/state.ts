/**
 * In-memory encryption state.
 *
 * The DEK (Data Encryption Key) is NEVER retained in process memory after use.
 * After unlock, the DEK is passed to the onUnlock callback (which opens the DB)
 * and immediately discarded. For admin operations that need the DEK (rotate,
 * change-master), the client must re-provide it via challenge-response — the DEK
 * exists in server memory only for the duration of that single operation.
 */
import { generateKeyPair } from "@app/shared";

export type EncryptionStatus = "uninitialized" | "locked" | "unlocked" | "disabled";

interface State {
  /** Whether the system has been unlocked (DB is open). DEK is NOT stored. */
  unlocked: boolean;
  /** Whether encryption has been initialized (meta file exists). */
  initialized: boolean;
  /** Whether an unlock or init operation is in progress. */
  operationInProgress: boolean;
  /** Callback to invoke when the system is unlocked. */
  onUnlock: ((dek: string) => void | Promise<void>) | null;
  /** Whether DB encryption is disabled via DB_ENCRYPTION=false. */
  encryptionDisabled: boolean;
  /**
   * Last DB error code (startup or unlock failure). Fixed enum so we never
   * echo libsql / IO error strings to anonymous /encryption/status callers.
   */
  dbError: DbErrorCode | null;
}

export type DbErrorCode
  = "unlock_failed"
    | "rotation_failed"
    | "init_failed"
    | "io_error"
    | "internal_error";

const state: State = {
  unlocked: false,
  initialized: false,
  operationInProgress: false,
  onUnlock: null,
  encryptionDisabled: false,
  dbError: null,
};

// --- Bootstrap token for /encryption/init ---
let bootstrapToken: string | null = null;

export function setBootstrapToken(token: string): void {
  bootstrapToken = token;
}

export function getBootstrapToken(): string | null {
  return bootstrapToken;
}

export function setEncryptionDisabled(v: boolean): void {
  state.encryptionDisabled = v;
  if (v) {
    state.unlocked = true;
  }
}

export function isEncryptionDisabled(): boolean {
  return state.encryptionDisabled;
}

export function setInitialized(v: boolean): void {
  state.initialized = v;
}

export function isInitialized(): boolean {
  return state.initialized;
}

/**
 * Mark the system as unlocked and (re)open the live database with the given
 * DEK. The callback stays registered so that DEK rotation can re-fire it to
 * rebuild the app context with a fresh database handle. The DEK itself is
 * NOT retained in memory — admin operations that need it receive it via
 * challenge-response.
 */
export async function setDek(dek: string): Promise<void> {
  if (!state.operationInProgress) {
    throw new Error("setDek called without beginOperation");
  }
  const callback = state.onUnlock;
  if (callback) {
    await callback(dek);
  }
  state.unlocked = true;
}

/** Try to acquire the operation lock. Returns true if acquired. */
export function beginOperation(): boolean {
  if (state.operationInProgress)
    return false;
  state.operationInProgress = true;
  return true;
}

/** Release the operation lock. */
export function endOperation(): void {
  state.operationInProgress = false;
}

export function isUnlocked(): boolean {
  return state.unlocked;
}

export function isSystemLocked(): boolean {
  return state.initialized && !state.unlocked;
}

export function setDbError(code: DbErrorCode | null): void {
  state.dbError = code;
}

export function getDbError(): DbErrorCode | null {
  return state.dbError;
}

export function getStatus(): EncryptionStatus {
  if (state.encryptionDisabled)
    return "disabled";
  if (!state.initialized)
    return "uninitialized";
  if (!state.unlocked)
    return "locked";
  return "unlocked";
}

export function setOnUnlock(cb: (dek: string) => void | Promise<void>): void {
  state.onUnlock = cb;
}

// --- Ephemeral challenge store for secure unlock transport ---

interface Challenge {
  /** Hex-encoded ephemeral private key (server-side only). */
  readonly privateKey: string;
  /** Hex-encoded ephemeral public key (sent to client). */
  readonly publicKey: string;
  /** Expiry timestamp (ms). */
  readonly expiresAt: number;
  /** Issuing client IP — used for the per-IP outstanding-challenge cap. */
  readonly ip: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGES = 100;
// Per-IP cap stops a single attacker from occupying the global slot pool
// during the 5-minute TTL and starving legitimate operators. The cap sits
// above the unlock-flow limiter (UNLOCK_MAX_ATTEMPTS = 10) so it never
// pre-empts that gate, while still keeping any one peer under a third of
// the global pool. Two attackers from distinct IPs cannot both fill 100
// slots either; the global cap remains the ceiling.
const MAX_CHALLENGES_PER_IP = 30;
const challenges = new Map<string, Challenge>();

/** Create a new ephemeral challenge for the unlock flow. Returns challengeId + publicKey. */
export function createChallenge(ip: string = "anon"): { challengeId: string; ephemeralPublicKey: string } {
  pruneExpiredChallenges();

  if (challenges.size >= MAX_CHALLENGES) {
    throw new Error("Too many pending challenges. Try again later.");
  }

  let perIp = 0;
  for (const ch of challenges.values()) {
    if (ch.ip === ip)
      perIp++;
  }
  if (perIp >= MAX_CHALLENGES_PER_IP) {
    throw new Error("Too many pending challenges from this client. Try again later.");
  }

  const kp = generateKeyPair();
  const challengeId = crypto.randomUUID();

  challenges.set(challengeId, {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    ip,
  });

  return { challengeId, ephemeralPublicKey: kp.publicKey };
}

/** Consume a challenge by its ID. Returns the ephemeral private key, or null if expired/missing. */
export function consumeChallenge(challengeId: string): string | null {
  const challenge = challenges.get(challengeId);
  if (!challenge)
    return null;

  if (Date.now() > challenge.expiresAt) {
    challenges.delete(challengeId);
    return null;
  }

  challenges.delete(challengeId);
  return challenge.privateKey;
}

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [id, ch] of challenges) {
    if (now > ch.expiresAt)
      challenges.delete(id);
  }
}

/**
 * Test-only: drop all encryption state so subsequent tests start from a clean
 * slate. Module-level state would otherwise leak between integration tests
 * (e.g. one test sets `initialized=true` and a later test inherits it).
 */
export function __resetEncryptionStateForTests(): void {
  state.unlocked = false;
  state.initialized = false;
  state.operationInProgress = false;
  state.onUnlock = null;
  state.encryptionDisabled = false;
  state.dbError = null;
  bootstrapToken = null;
  challenges.clear();
}
