/**
 * Shared types for df-system-mcp-server.
 */

/** Auth context resolved from incoming MCP request headers. */
export interface AuthContext {
  /** DreamFactory session token (admin or user). Forwarded as X-DreamFactory-Session-Token. */
  sessionToken?: string;
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
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
