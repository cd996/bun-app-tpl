import type { Context } from "hono";

const RE_COMMA_SPLIT = /\s*,\s*/;

interface ClientIpConfig {
  readonly TRUST_PROXY: boolean;
}

/**
 * Get the real client IP address from a Hono context.
 *
 * Default behavior (TRUST_PROXY=false): forwarding headers are IGNORED to
 * prevent header-spoofing attacks; only the connection peer IP from the Bun
 * runtime (`c.env.IP.address`) is used.
 *
 * When TRUST_PROXY=true (operator explicitly opts in behind a sanitizing
 * proxy) the function honours `X-Real-IP` first, then the rightmost entry of
 * `X-Forwarded-For` (the hop closest to our process, controlled by the
 * trusted proxy).
 */
export function getClientIp(c: Context, config?: ClientIpConfig): string {
  const peerIp = c.env?.IP?.address;

  if (!config?.TRUST_PROXY) {
    return peerIp ?? "unknown";
  }

  const headers = c.req.header();
  const lowered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }

  const realIp = lowered["x-real-ip"];
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  const xff = lowered["x-forwarded-for"];
  if (xff && xff.trim()) {
    const parts = xff.split(RE_COMMA_SPLIT).filter(Boolean);
    const rightmost = parts.at(-1);
    if (rightmost) {
      return rightmost;
    }
  }

  return peerIp ?? "unknown";
}
