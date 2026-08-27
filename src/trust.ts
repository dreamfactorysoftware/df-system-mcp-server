/**
 * Trust boundary helpers for the HTTP front door.
 *
 * - `X-Mcp-Base-Url` tells the daemon where DreamFactory lives for a session.
 *   Because the daemon forwards the DreamFactory session token (and API key)
 *   to that URL, an untrusted caller must not be able to set it — otherwise
 *   anyone who can reach the daemon can exfiltrate tokens / SSRF. The header
 *   is honoured only when the request passed the internal-key gate, or when
 *   its origin is on the allowlist (DREAMFACTORY_URL origin + MCP_ALLOWED_BASE_URLS).
 * - The internal-key comparison is constant-time.
 */
import { timingSafeEqual } from "crypto";

/** Constant-time string comparison. Returns false for non-strings / length mismatch. */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Build the set of origins allowed in `X-Mcp-Base-Url` for callers that did
 * NOT pass the internal-key gate.
 *
 * @param defaultBaseUrl  the resolved DREAMFACTORY_URL (always allowed)
 * @param extra           comma-separated MCP_ALLOWED_BASE_URLS (origins or full URLs)
 */
export function buildAllowedOrigins(defaultBaseUrl: string, extra?: string): Set<string> {
  const out = new Set<string>();
  const d = originOf(defaultBaseUrl);
  if (d) out.add(d);
  for (const raw of (extra ?? "").split(",")) {
    const o = originOf(raw.trim());
    if (o) out.add(o);
  }
  return out;
}

/**
 * Decide whether a presented `X-Mcp-Base-Url` may be bound to a session.
 *
 * @returns the URL to bind, or `undefined` when it must be ignored.
 */
export function acceptBaseUrl(
  presented: string | undefined,
  opts: { internalKeyVerified: boolean; allowedOrigins: Set<string> },
): string | undefined {
  if (!presented) return undefined;
  const origin = originOf(presented);
  if (!origin) return undefined; // unparsable -> never bind
  if (opts.internalKeyVerified) return presented;
  return opts.allowedOrigins.has(origin) ? presented : undefined;
}
