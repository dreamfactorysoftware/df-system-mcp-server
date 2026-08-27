/**
 * Shared types for df-system-mcp-server.
 */

/** Auth / routing context resolved from incoming MCP request headers. */
export interface AuthContext {
  /** DreamFactory session token (admin or user). Forwarded as X-DreamFactory-Session-Token. */
  sessionToken?: string;
  /** Optional DreamFactory API key (from X-DreamFactory-API-Key). Forwarded verbatim. */
  apiKey?: string;
  /**
   * Per-session DreamFactory base URL (from X-Mcp-Base-Url, already ending in /api/v2).
   * Falls back to env DREAMFACTORY_URL when absent.
   */
  baseUrl?: string;
  /** Optional trace id (from X-DreamFactory-Trace-Id). Forwarded back on DF calls. */
  traceId?: string;
}

/** Subset of the DreamFactory service config the PHP proxy forwards to us. */
export interface McpServiceConfig {
  /** Tool names that must NOT be registered for this session. */
  disabled_tools?: unknown;
  /** Custom tools (data-plane feature) — ignored by the system server. */
  custom_tools?: unknown;
  [key: string]: unknown;
}

/** Options accepted by dreamFactoryFetch. */
export interface DreamFactoryFetchOptions {
  /** Optional JSON body (for POST/PATCH/PUT). */
  body?: unknown;
  /** Query string parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Per-request auth override (defaults pulled from header registry). */
  auth?: AuthContext;
}

/** Uniform success / failure envelope returned by dreamFactoryFetch. */
export type DreamFactoryResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string; details?: unknown };

/** Standard MCP text-content tool response. */
export interface ToolTextResponse {
  [key: string]: unknown;
  content: { [key: string]: unknown; type: "text"; text: string }[];
  isError?: boolean;
}
