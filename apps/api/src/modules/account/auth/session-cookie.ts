import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * Single source of truth for the session cookie name + read / write / clear.
 *
 * In production we prefix with `__Host-`: browsers refuse to honour the
 * cookie unless it is Secure + Path=/ + no Domain attribute, which blocks
 * subdomain-takeover and cross-host clobbering of the session cookie. In
 * development (plain HTTP) the `__Host-` prefix is incompatible with the
 * missing Secure flag, so we fall back to the plain name. Reads accept
 * either name so that flipping NODE_ENV between starts on the same
 * browser doesn't strand the user mid-session.
 *
 * The OAuth state cookie applies the same prefix pattern in
 * `auth.routes.ts` — keep both consistent if you tune one.
 */

const SESSION_COOKIE_PROD = "__Host-session_id";
const SESSION_COOKIE_DEV = "session_id";

export function sessionCookieName(env: "production" | "development" | "test"): string {
  return env === "production" ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

/**
 * Regex that matches the session cookie in a raw `Cookie` header under
 * either name. Used by the CSRF guard to detect "this request has a
 * session cookie" without parsing the whole header.
 */
export const RE_ANY_SESSION_COOKIE = /(?:^|;\s*)(?:__Host-)?session_id=/;

export function readSessionId(c: Context<AppEnv>): string | undefined {
  // Prefer the prod-prefixed name (when the request actually carries it),
  // fall back to the plain name for dev / staging on plain HTTP.
  return getCookie(c, SESSION_COOKIE_PROD) ?? getCookie(c, SESSION_COOKIE_DEV);
}

/**
 * Set the session cookie under the environment-appropriate name. The
 * `__Host-` rules force `Secure` + `Path=/` + no `Domain`, so we always
 * emit those attributes in production; SameSite=Lax stays as the CSRF
 * baseline.
 */
export function writeSessionCookie(
  c: Context<AppEnv>,
  env: "production" | "development" | "test",
  sessionId: string,
  maxAge: number,
): void {
  const isProd = env === "production";
  setCookie(c, sessionCookieName(env), sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

/**
 * Clear the session cookie. We delete both the env-active name and the
 * other variant so a flipped NODE_ENV between issue and clear (e.g.
 * promotion from staging to prod with the same browser) still tears
 * down stale cookies.
 *
 * The `__Host-` prefixed variant *must* carry `Secure` — hono's
 * `deleteCookie` defers to `setCookie`, which throws otherwise. We only
 * emit that one in production, where the response is HTTPS and the
 * Secure attribute is valid.
 */
export function clearSessionCookie(c: Context<AppEnv>, env: "production" | "development" | "test"): void {
  if (env === "production") {
    // In prod the only cookie that could exist is the __Host- variant;
    // delete it with Secure so hono accepts the call.
    deleteCookie(c, SESSION_COOKIE_PROD, { path: "/", secure: true });
  }
  // In dev/test the only cookie that could exist is the plain name.
  // Production deletes this too — harmless if absent — to cover the
  // env-flip case described above.
  deleteCookie(c, SESSION_COOKIE_DEV, { path: "/" });
}
