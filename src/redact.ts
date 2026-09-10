/**
 * API-key redaction for tool responses.
 *
 * Every tool result is handed to an LLM, which means it lands in provider logs
 * and in DreamFactory's own prompt logs. App API keys are live credentials, so
 * responses that can carry them are masked before they leave this process.
 *
 * Masked shape (applied to every object property named `api_key`, at any depth,
 * inside arrays and `{ resource: [...] }` wrappers alike):
 *
 *   { "api_key": null, "api_key_hint": "…5a88" }
 *
 * i.e. `api_key` becomes `null` and a sibling `api_key_hint` is added holding
 * "…" followed by the key's last 4 characters. Keys shorter than
 * MIN_HINT_KEY_LENGTH get a bare "…" hint so a short key is never disclosed
 * in full. A null / empty / non-string `api_key` yields `api_key_hint: null`.
 *
 * Set `MCP_EXPOSE_API_KEYS=true` to disable masking (not recommended).
 */
import type { DreamFactoryResult } from "./types";

/** Property name that is masked (exact match, as DreamFactory emits it). */
export const API_KEY_FIELD = "api_key";
/** Sibling property carrying the hint. */
export const HINT_FIELD = "api_key_hint";
/** Characters of the key revealed in the hint. */
export const HINT_CHARS = 4;
/** Keys shorter than this get a hint with no characters of the key. */
export const MIN_HINT_KEY_LENGTH = 16;
/** Prefix marking a hint as a truncated key. */
export const HINT_PREFIX = "…";

/** True when `MCP_EXPOSE_API_KEYS` opts out of masking. Read per call. */
export function apiKeysExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MCP_EXPOSE_API_KEYS ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** The non-reversible hint for one key value. */
export function apiKeyHint(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) return null;
  if (key.length < MIN_HINT_KEY_LENGTH) return HINT_PREFIX;
  return HINT_PREFIX + key.slice(-HINT_CHARS);
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = k === API_KEY_FIELD ? null : maskValue(v);
  }
  // Written last so an upstream `api_key_hint` can never carry the real key.
  if (Object.prototype.hasOwnProperty.call(src, API_KEY_FIELD)) {
    out[HINT_FIELD] = apiKeyHint(src[API_KEY_FIELD]);
  }
  return out;
}

/**
 * Return a copy of `value` with every `api_key` masked (see module doc).
 * The input is never mutated. Returns `value` untouched when masking is
 * disabled via `MCP_EXPOSE_API_KEYS`.
 */
export function maskApiKeys<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (apiKeysExposed(env)) return value;
  return maskValue(value) as T;
}

/** Mask `data` (success) or `details` (error) of a DreamFactory result. */
export function maskResult(result: DreamFactoryResult, env: NodeJS.ProcessEnv = process.env): DreamFactoryResult {
  if (apiKeysExposed(env)) return result;
  if (result.ok) return { ...result, data: maskApiKeys(result.data, env) };
  if (result.details === undefined) return result;
  return { ...result, details: maskApiKeys(result.details, env) };
}
