/**
 * Control-plane path guard for `call_system_api`.
 *
 * The tool accepts an arbitrary path relative to `/api/v2` and must only ever
 * reach `system/*` or `user/*`. A naive `startsWith('system/')` check is
 * bypassable with dot-segments (`system/../db/_table/x`) because WHATWG URL
 * normalisation in `fetch` collapses them before the request is issued, so we
 * validate the *resolved* URL rather than the raw string and additionally
 * reject anything that could change meaning between here and the wire.
 */

const ALLOWED_PREFIXES = ["system/", "user/"] as const;

/** Sentinel base — only used for resolution; never contacted. */
const RESOLVE_BASE = "http://df.invalid/api/v2/";

export interface PathGuardResult {
  ok: boolean;
  /** Canonical path (no leading slash, no query/fragment) when ok. */
  path?: string;
  reason?: string;
}

/**
 * Returns `{ ok: true, path }` when `raw` is a safe control-plane path,
 * otherwise `{ ok: false, reason }`. Never throws.
 */
export function guardControlPlanePath(raw: unknown): PathGuardResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "path must be a non-empty string" };
  }
  const clean = raw.replace(/^\/+/, "");

  // Anything that can alter the path after our check is rejected outright:
  // backslashes (treated as '/' by WHATWG), percent-encoded dots/slashes,
  // fragments/queries (use the `query` argument), scheme/authority prefixes,
  // whitespace and control characters.
  if (/[\\#?]/.test(clean)) return { ok: false, reason: "path contains a forbidden character (\\ # ?)" };
  if (/%(2e|2f|5c)/i.test(clean)) return { ok: false, reason: "percent-encoded dots/slashes are not allowed" };
  if (/[\s\x00-\x1f\x7f]/.test(clean)) return { ok: false, reason: "path contains whitespace or control characters" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) {
    return { ok: false, reason: "absolute URLs are not allowed" };
  }

  // Reject '.' / '..' segments explicitly (belt) ...
  for (const seg of clean.split("/")) {
    if (seg === "." || seg === "..") return { ok: false, reason: "dot-segments are not allowed" };
  }

  // ... and validate the resolved URL (braces): origin must be untouched and
  // the resolved pathname must still sit under /api/v2/system/ or /api/v2/user/.
  let resolved: URL;
  try {
    resolved = new URL(clean, RESOLVE_BASE);
  } catch {
    return { ok: false, reason: "path is not a valid URL path" };
  }
  const base = new URL(RESOLVE_BASE);
  if (resolved.origin !== base.origin) return { ok: false, reason: "path escapes the DreamFactory origin" };
  if (!resolved.pathname.startsWith(base.pathname)) return { ok: false, reason: "path escapes /api/v2" };
  const rel = resolved.pathname.slice(base.pathname.length);
  const lower = rel.toLowerCase();
  if (!ALLOWED_PREFIXES.some((p) => lower.startsWith(p))) {
    return { ok: false, reason: "path is restricted to 'system/*' and 'user/*' endpoints" };
  }
  // The canonical path must equal what the caller gave — if URL resolution
  // changed it, something was smuggled in.
  if (rel !== clean) return { ok: false, reason: "path changed under URL normalisation" };

  return { ok: true, path: rel };
}
