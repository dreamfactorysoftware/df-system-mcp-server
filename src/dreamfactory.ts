import type {
  AuthContext,
  DreamFactoryFetchOptions,
  DreamFactoryResult,
  ToolTextResponse,
} from "./types";

/**
 * Resolved DreamFactory base URL (e.g. http://web/api/v2). Trimmed of any trailing slash.
 */
export function getBaseUrl(): string {
  const raw = process.env.DREAMFACTORY_URL || "http://web/api/v2";
  return raw.replace(/\/+$/, "");
}

/**
 * Per-MCP-session auth registry.
 *
 * The MCP SDK passes a `sessionId` to tool handlers (the StreamableHTTPServerTransport
 * generates one on `initialize`). We map that sessionId to the DreamFactory session
 * token we extracted from the corresponding HTTP request's headers in index.ts.
 *
 * NB: this is in-memory; restart drops sessions, which is fine — MCP clients re-init.
 */
const authBySession = new Map<string, AuthContext>();

export function setAuthForSession(sessionId: string, ctx: AuthContext): void {
  authBySession.set(sessionId, ctx);
}

export function clearAuthForSession(sessionId: string): void {
  authBySession.delete(sessionId);
}

export function getAuthForSession(sessionId: string | undefined): AuthContext | undefined {
  if (!sessionId) return undefined;
  return authBySession.get(sessionId);
}

/** Number of sessions currently holding an auth context (for /health). */
export function countAuthSessions(): number {
  return authBySession.size;
}

/**
 * Build a query string from an object, skipping undefined values.
 */
function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Centralised HTTP client for DreamFactory.
 *
 * - Injects X-DreamFactory-Session-Token from the supplied AuthContext.
 * - Forwards X-DreamFactory-API-Key / X-DreamFactory-Trace-Id when bound.
 * - Uses the per-session base URL (X-Mcp-Base-Url) when present, else DREAMFACTORY_URL.
 * - Sets Accept: application/json (and Content-Type when a body is present).
 * - Never logs the session token.
 * - Returns a uniform { ok, status, data | error } envelope.
 */
export async function dreamFactoryFetch(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  opts: DreamFactoryFetchOptions = {},
): Promise<DreamFactoryResult> {
  const auth = opts.auth;
  if (!auth?.sessionToken) {
    return {
      ok: false,
      status: 401,
      error:
        "authentication required: no DreamFactory session token bound to this MCP session. " +
        "Send X-DreamFactory-Session-Token (or Authorization: Bearer ...) on the MCP HTTP request.",
    };
  }

  const base = (auth.baseUrl && auth.baseUrl.replace(/\/+$/, "")) || getBaseUrl();
  // Strip leading slash from path so caller can write "system/service" or "/system/service".
  const cleanPath = path.replace(/^\/+/, "");
  const url = `${base}/${cleanPath}${buildQuery(opts.query)}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-DreamFactory-Session-Token": auth.sessionToken,
  };
  if (auth.apiKey) headers["X-DreamFactory-API-Key"] = auth.apiKey;
  if (auth.traceId) headers["X-DreamFactory-Trace-Id"] = auth.traceId;

  let bodyInit: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }

  try {
    const res = await fetch(url, { method, headers, body: bodyInit });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      // DreamFactory error shape: { error: { code, message, context? } }
      let message = `HTTP ${res.status} ${res.statusText}`;
      if (parsed && typeof parsed === "object" && parsed !== null) {
        const errObj = (parsed as { error?: unknown }).error;
        if (errObj && typeof errObj === "object") {
          const msg = (errObj as { message?: unknown }).message;
          if (typeof msg === "string" && msg.length > 0) message = msg;
        } else if (typeof (parsed as { message?: unknown }).message === "string") {
          message = (parsed as { message: string }).message;
        }
      }
      return { ok: false, status: res.status, error: message, details: parsed };
    }

    return { ok: true, status: res.status, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never include headers or tokens in the error.
    return {
      ok: false,
      status: 0,
      error: `network error contacting DreamFactory at ${base}: ${message}`,
    };
  }
}

/**
 * Convert a DreamFactoryResult into the MCP tool text response shape.
 * Caller should pass a label that describes the operation for error context.
 */
export function toToolResponse(label: string, result: DreamFactoryResult): ToolTextResponse {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  const payload: Record<string, unknown> = {
    error: result.error,
    status: result.status,
    operation: label,
  };
  if (result.details !== undefined) payload.details = result.details;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
