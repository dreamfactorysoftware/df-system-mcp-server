/**
 * Redaction for tool responses.
 *
 * Every tool result is handed to an LLM, which means it lands in provider logs
 * and in DreamFactory's own prompt logs. Two layers keep live credentials out:
 *
 * 1. API keys (`maskApiKeys`, applied by the tools that return apps). Every
 *    object property named `api_key`, at any depth, is masked as
 *
 *      { "api_key": null, "api_key_hint": "…5a88" }
 *
 *    i.e. `api_key` becomes `null` and a sibling `api_key_hint` holds "…" plus
 *    the key's last 4 characters. Keys shorter than MIN_HINT_KEY_LENGTH get a
 *    bare "…" hint so a short key is never disclosed in full. A null / empty /
 *    non-string `api_key` yields `api_key_hint: null`. `create_app` skips this
 *    layer so the caller can see the key it just minted.
 *    Set `MCP_EXPOSE_API_KEYS=true` to disable (not recommended).
 *
 * 2. Other secrets (`maskSecrets`, applied to EVERY tool response). DreamFactory
 *    returns more than API keys: `system/environment` includes the platform
 *    `license_key`, and service configs include credentials the config model
 *    doesn't mark protected (SMTP and AD passwords, the MCP service's
 *    `oauth_client_secret`, cloud email keys). Any property whose name looks
 *    like a secret (see `isSecretKey`) is replaced with DreamFactory's own
 *    protection mask `**********`. Credentials stored as name/value entries are
 *    caught too, because there the secret sits next to a harmless-looking name
 *    (an RWS service's `headers: [{ name: "Authorization", value: "Basic …" }]`):
 *    every `value` in a `headers` or `parameters` list is masked, as is any
 *    `value` whose sibling `name` looks like a credential (`isSecretEntryName`)
 *    or whose record is flagged `private: true` (private lookups). Only
 *    non-empty strings, objects and arrays are replaced; null, numbers and
 *    booleans pass through.
 *    Set `MCP_EXPOSE_SECRETS=true` to disable (not recommended).
 *
 * The mask is never written back. `stripMaskedSecrets` drops object properties
 * whose value is exactly `**********` from request bodies, so sending back a
 * config read through this server leaves the stored secret unchanged
 * (DreamFactory keeps omitted config properties). A mask inside a list can't be
 * dropped safely: DreamFactory replaces such lists as a whole (RWS headers and
 * parameters are deleted and recreated on save), so `maskedPathsInArrays` finds
 * them and the write is refused instead.
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
/** DreamFactory's protection mask (df-core Protectable::$protectionMask). */
export const SECRET_MASK = "**********";

function flagSet(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** True when `MCP_EXPOSE_API_KEYS` opts out of API-key masking. Read per call. */
export function apiKeysExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagSet(env.MCP_EXPOSE_API_KEYS);
}

/** True when `MCP_EXPOSE_SECRETS` opts out of secret masking. Read per call. */
export function secretsExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagSet(env.MCP_EXPOSE_SECRETS);
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

/** Name segments that mark a secret, matched on the snake_case form of a property name. */
const SECRET_NAME =
  /(^|_)(pass|passwd|password|passphrase|pwd|secret|private_key|api_key|license_key|licence_key|app_key|encryption_key|signing_key|master_key|account_key|token|credential|credentials|connection_string|dsn|authorization|auth|cookie)($|_)/;
/** Entry names (header, parameter, lookup) whose `value` is a credential: Authorization, Cookie, X-API-Key, ... */
const SECRET_ENTRY_NAME = /(auth|token|secret|pass|key|cookie|session|credential|bearer|signature)/i;
/** Lists whose entries' `value`s are all masked: RWS headers and parameters carry credentials as plain values. */
const CREDENTIAL_LISTS = new Set(["headers", "parameters"]);
/** Suffixes that describe a secret rather than hold one (token_endpoint, password_policy, secret_type, ...). */
const DESCRIPTIVE_SUFFIX =
  /_(url|uri|endpoint|ttl|timeout|expires|expire|expiry|expiration|lifetime|length|size|hint|type|name|names|field|fields|header|headers|param|params|policy|required|enabled|disabled|mode|label|description|format|id|ids|count|at|date|time|path|location|method|prefix)$/;

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
}

/** True when a property name looks like it holds a secret. `api_key` has its own masking. */
export function isSecretKey(name: string): boolean {
  const n = snakeCase(name);
  if (n === API_KEY_FIELD || n === HINT_FIELD) return false;
  if (DESCRIPTIVE_SUFFIX.test(n)) return false;
  return n === "key" || SECRET_NAME.test(n);
}

/** True when a name/value entry's name marks its `value` as a credential. */
export function isSecretEntryName(name: unknown): boolean {
  return typeof name === "string" && SECRET_ENTRY_NAME.test(name);
}

function hasSecretValue(v: unknown): boolean {
  if (typeof v === "string") return v.length > 0 && v !== SECRET_MASK;
  return v !== null && typeof v === "object";
}

function isPrivateRecord(src: Record<string, unknown>): boolean {
  const p = src.private;
  return p === true || p === 1 || p === "1" || p === "true";
}

/** @param credentialEntry the object is a direct entry of a `headers` / `parameters` list */
function maskSecretsIn(value: unknown, credentialEntry = false): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecretsIn(v));
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const secretEntryValue = credentialEntry || isPrivateRecord(src) || isSecretEntryName(src.name);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    const secret = isSecretKey(k) || (k === "value" && secretEntryValue);
    if (secret && hasSecretValue(v)) {
      out[k] = SECRET_MASK;
    } else if (Array.isArray(v) && CREDENTIAL_LISTS.has(snakeCase(k))) {
      out[k] = v.map((entry) => maskSecretsIn(entry, true));
    } else {
      out[k] = maskSecretsIn(v);
    }
  }
  return out;
}

/**
 * Return a copy of `value` with secret-looking properties replaced by
 * SECRET_MASK (see module doc). The input is never mutated. Returns `value`
 * untouched when masking is disabled via `MCP_EXPOSE_SECRETS`.
 */
export function maskSecrets<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (secretsExposed(env)) return value;
  return maskSecretsIn(value) as T;
}

/**
 * Paths (e.g. `config.headers[2].value`) of SECRET_MASK values that sit inside
 * a list, at any depth below it. Dropping those can't keep the stored secret,
 * because DreamFactory replaces a list as a whole, so writes carrying them are
 * refused (see dreamFactoryFetch).
 */
export function maskedPathsInArrays(value: unknown, path = "", insideList = false): string[] {
  if (value === SECRET_MASK) return insideList ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => maskedPathsInArrays(v, `${path}[${i}]`, true));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    maskedPathsInArrays(v, path ? `${path}.${k}` : k, insideList),
  );
}

/**
 * Return a copy of a request body without properties whose value is exactly
 * SECRET_MASK, at any depth, so a masked secret is never written back over
 * the real one. Array elements are kept as they are; bodies with a mask inside
 * a list are refused before this runs (maskedPathsInArrays).
 */
export function stripMaskedSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripMaskedSecrets) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === SECRET_MASK) continue;
    out[k] = stripMaskedSecrets(v);
  }
  return out as T;
}
