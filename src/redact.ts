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
 *    caught too, where the secret sits next to a name (an RWS service's
 *    `headers: [{ name: "Authorization", value: "Basic …" }]`): a `value` is
 *    masked when its sibling `name` looks like a credential
 *    (`isSecretEntryName`) or its record is flagged `private: true` (private
 *    lookups). Other entries (Accept, limit, ...) stay readable, because
 *    debugging a connector depends on them. Curl options (an RWS service's
 *    `config.options`) are masked by option name: credential options such as
 *    PROXYUSERPWD, and the credential lines of HTTPHEADER / PROXYHEADER. A
 *    password inside any URL (`http://user:pass@proxy`) is replaced in place.
 *    Only non-empty strings, objects and arrays are replaced; null, empty
 *    strings, numbers and booleans pass through, so an unset value still shows
 *    as unset.
 *    Name rules can't know every service type, so df-mcp-server also sends a
 *    manifest built from DreamFactory's own model metadata (`$encrypted`,
 *    `$protected`, password and certificate schema fields). On a record with a
 *    `type` and a `config`, that type's `secret` fields are masked, and so are
 *    credential-named keys of its `maps` fields (user-named key/value maps such
 *    as a script service's `config`). The manifest only adds masking; without
 *    it the name rules still apply. `api_key` is masked here too, because
 *    service configs (gcm, rackspace, ...) carry one; the app tools mask it
 *    with a hint first, and `create_app` keeps it.
 *    The service type tools skip this layer: type metadata describes fields and
 *    holds no instance values, so masking it only corrupted descriptors.
 *    Set `MCP_EXPOSE_SECRETS=true` to disable (not recommended).
 *
 * The mask is never written back. `stripMaskedSecrets` drops properties whose
 * value is exactly `**********` from request bodies, so sending back a config
 * read through this server leaves the stored secret unchanged: DreamFactory
 * keeps config attributes that are left out. That only holds for a mask set
 * directly on the body or directly in a `config` object. Deeper down the
 * containing value is stored whole (RWS headers and parameters are deleted and
 * recreated, `options` is one attribute), and a partly masked string can't be
 * dropped at all, so `unwritableMaskPaths` finds those and the write is refused.
 */
import type { DreamFactoryResult, SecretFieldEntry, SecretFieldManifest } from "./types";

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
  /(^|_)(pass|passwd|password|passwords|passphrase|passcode|pwd|secret|secrets|private_key|private_keys|api_key|api_keys|apikey|apikeys|access_key|access_keys|license_key|licence_key|app_key|encryption_key|signing_key|master_key|account_key|token|tokens|credential|credentials|connection_string|dsn|authorization|auth|cookie)($|_)/;
/**
 * Entry names (header, parameter, lookup) whose `value` is a credential: Authorization,
 * Proxy-Authorization, Cookie, Set-Cookie, X-API-Key, and anything containing token, secret,
 * key, pass(word), session, credential, bearer, or `sig` at a word start (X-Hub-Signature).
 */
const SECRET_ENTRY_NAME = /(auth|token|secret|pass|key|cookie|session|credential|bearer|(^|[^a-z])sig)/i;
/** Curl options (name without CURLOPT_) that carry credentials; COOKIEFILE / COOKIEJAR paths are masked too. */
const CURL_SECRET_OPTION = /(USERPWD|PASSWD|PASSWORD|BEARER|COOKIE|POSTFIELDS|LOGIN_OPTIONS)/;
/** Curl options holding "Name: value" header lines. */
const CURL_HEADER_OPTION = /^(HTTPHEADER|PROXYHEADER)$/;
/** A password in a URL's userinfo: scheme://user:password@host. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/[^/@\s:]*):([^/@\s]+)@/i;
/** Suffixes that describe a secret rather than hold one (token_endpoint, password_policy, secret_type, ...). */
const DESCRIPTIVE_SUFFIX =
  /_(url|uri|endpoint|ttl|timeout|expires|expire|expiry|expiration|lifetime|length|size|hint|type|name|names|field|fields|header|headers|param|params|policy|required|enabled|disabled|mode|label|description|format|id|ids|count|at|date|time|path|location|method|prefix)$/;

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
}

/**
 * True when a property name looks like it holds a secret (`api_key_hint` is the hint, not the key).
 * A bare `key` doesn't count: DreamFactory uses it for the key half of key/value descriptors and
 * for identifiers (an AWS access key ID), and the manifest covers configs whose secret is `key`.
 */
export function isSecretKey(name: string): boolean {
  const n = snakeCase(name);
  if (n === HINT_FIELD) return false;
  if (DESCRIPTIVE_SUFFIX.test(n)) return false;
  return SECRET_NAME.test(n);
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

function maskUrlPassword(s: string): string {
  return URL_USERINFO.test(s) ? s.replace(URL_USERINFO, `$1:${SECRET_MASK}@`) : s;
}

function maskHeaderLine(line: unknown, opts: MaskOptions): unknown {
  if (typeof line !== "string") return maskSecretsIn(line, opts);
  const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
  return m && isSecretEntryName(m[1]) ? `${m[1].trim()}: ${SECRET_MASK}` : maskUrlPassword(line);
}

/**
 * Curl options by name (CURLOPT_X or X) or by numeric constant, as RWS
 * RemoteWeb::cleanOptions accepts them.
 */
function maskCurlOptions(options: Record<string, unknown>, opts: MaskOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    const name = curlOptionName(k);
    if ((CURL_SECRET_OPTION.test(name) || isSecretKey(k)) && hasSecretValue(v)) {
      out[k] = SECRET_MASK;
    } else if (CURL_HEADER_OPTION.test(name) && Array.isArray(v)) {
      out[k] = v.map((line) => maskHeaderLine(line, opts));
    } else {
      out[k] = maskSecretsIn(v, opts);
    }
  }
  return out;
}

/** Numeric curl constants for the options above (PHP's CURLOPT_* values). */
const CURL_OPTION_CODES: Record<string, string> = {
  "10005": "USERPWD",
  "10006": "PROXYUSERPWD",
  "10015": "POSTFIELDS",
  "10022": "COOKIE",
  "10023": "HTTPHEADER",
  "10026": "KEYPASSWD",
  "10135": "COOKIELIST",
  "10174": "PASSWORD",
  "10176": "PROXYPASSWORD",
  "10205": "TLSAUTH_PASSWORD",
  "10220": "XOAUTH2_BEARER",
  "10224": "LOGIN_OPTIONS",
  "10228": "PROXYHEADER",
  "10252": "PROXY_TLSAUTH_PASSWORD",
  "10258": "PROXY_KEYPASSWD",
};

function curlOptionName(key: string): string {
  const k = key.trim();
  return CURL_OPTION_CODES[k] ?? k.toUpperCase().replace(/^CURLOPT_/, "");
}

/** Options for maskSecrets. */
export interface MaskOptions {
  /** Secret fields per service type, from df-mcp-server (see module doc). */
  manifest?: SecretFieldManifest;
  /** Leave `api_key` as it is: create_app returns the key it just minted on purpose. */
  keepApiKeys?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function manifestEntry(manifest: SecretFieldManifest | undefined, type: unknown): SecretFieldEntry | undefined {
  if (!manifest || typeof type !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(manifest, type) ? manifest[type] : undefined;
}

/** A service type's manifest entry applied to its config: secret fields, and credential-named keys of maps. */
export function maskConfigByManifest(config: Record<string, unknown>, entry: SecretFieldEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const field of entry.secret) {
    if (Object.prototype.hasOwnProperty.call(out, field) && hasSecretValue(out[field])) out[field] = SECRET_MASK;
  }
  for (const field of entry.maps) {
    const map = out[field];
    if (!isPlainObject(map)) continue;
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map)) {
      masked[k] = (isSecretEntryName(k) || isSecretKey(k)) && hasSecretValue(v) ? SECRET_MASK : v;
    }
    out[field] = masked;
  }
  return out;
}

/** Type names, as descriptors use them (the environment's login payloads: `{ "password": "string" }`). */
const TYPE_NAME = /^(string|text|bool|boolean|int|integer|number|float|double|array|object|date|datetime|timestamp)$/;

function isTypeName(v: unknown): boolean {
  return typeof v === "string" && TYPE_NAME.test(v);
}

/** A record that describes fields rather than holding values: at least two of its values are type names. */
function isTypeDescriptorRecord(src: Record<string, unknown>): boolean {
  let names = 0;
  for (const v of Object.values(src)) if (isTypeName(v) && ++names >= 2) return true;
  return false;
}

function maskSecretsIn(value: unknown, opts: MaskOptions): unknown {
  if (typeof value === "string") return maskUrlPassword(value);
  if (Array.isArray(value)) return value.map((v) => maskSecretsIn(v, opts));
  if (value === null || typeof value !== "object") return value;
  let src = value as Record<string, unknown>;
  const entry = manifestEntry(opts.manifest, src.type);
  if (entry && isPlainObject(src.config)) src = { ...src, config: maskConfigByManifest(src.config, entry) };
  const secretEntryValue = isPrivateRecord(src) || isSecretEntryName(src.name);
  // In a descriptor record a type name is a description, not a value; anything else is still masked.
  const descriptor = isTypeDescriptorRecord(src);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    const secret =
      (isSecretKey(k) && !(opts.keepApiKeys && k === API_KEY_FIELD)) || (k === "value" && secretEntryValue);
    if (secret && hasSecretValue(v) && !(descriptor && isTypeName(v))) {
      out[k] = SECRET_MASK;
    } else if (k === "options" && isPlainObject(v)) {
      out[k] = maskCurlOptions(v, opts);
    } else {
      out[k] = maskSecretsIn(v, opts);
    }
  }
  return out;
}

/** Caps on a manifest received over the wire, so a caller can't make every response scan unbounded lists. */
const MANIFEST_MAX_TYPES = 500;
const MANIFEST_MAX_FIELDS = 200;
const MANIFEST_MAX_NAME = 128;

function manifestNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= MANIFEST_MAX_NAME)
    .slice(0, MANIFEST_MAX_FIELDS);
}

/**
 * Validate a secret-field manifest from the proxy envelope (`_mcpSecretFields`). Invalid
 * entries are dropped; returns undefined when nothing usable is left. A manifest only adds
 * masking, so taking one from a caller can't expose anything.
 */
export function parseSecretFieldManifest(raw: unknown): SecretFieldManifest | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: SecretFieldManifest = Object.create(null);
  let count = 0;
  for (const [type, entry] of Object.entries(raw)) {
    if (count >= MANIFEST_MAX_TYPES) break;
    if (!isPlainObject(entry) || type.length === 0 || type.length > MANIFEST_MAX_NAME) continue;
    const secret = manifestNames(entry.secret);
    const maps = manifestNames(entry.maps);
    if (secret.length === 0 && maps.length === 0) continue;
    out[type] = { secret, maps };
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * Return a copy of `value` with secret-looking properties replaced by
 * SECRET_MASK (see module doc). The input is never mutated. Returns `value`
 * untouched when masking is disabled via `MCP_EXPOSE_SECRETS`.
 */
export function maskSecrets<T>(value: T, env: NodeJS.ProcessEnv = process.env, options: MaskOptions = {}): T {
  if (secretsExposed(env)) return value;
  // MCP_EXPOSE_API_KEYS opts every api_key out, including the ones in service configs.
  return maskSecretsIn(value, { ...options, keepApiKeys: options.keepApiKeys || apiKeysExposed(env) }) as T;
}

/**
 * Paths (e.g. `config.headers[2].value`, `config.options.PROXYUSERPWD`) of masks
 * in a request body that can't be dropped to keep the stored secret, so writes
 * carrying them are refused (see dreamFactoryFetch):
 * - a SECRET_MASK anywhere except directly on the body or directly in a
 *   `config` object, because deeper values (lists such as RWS headers and
 *   parameters, objects such as `options`) are stored whole
 * - a string that contains the mask but isn't only the mask
 *   ("http://user:**********@proxy", "Authorization: **********")
 */
export function unwritableMaskPaths(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string, droppable: boolean): void => {
    if (typeof v === "string") {
      if (v === SECRET_MASK ? !droppable : v.includes(SECRET_MASK)) out.push(path);
    } else if (Array.isArray(v)) {
      v.forEach((e, i) => visit(e, `${path}[${i}]`, false));
    } else if (v !== null && typeof v === "object") {
      // `droppable` for this object's own properties: the body itself, or a `config` directly on it.
      const own = path === "" || (droppable && /(^|\.)config$/.test(path));
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        visit(child, path ? `${path}.${k}` : k, own);
      }
    }
  };
  if (value !== null && typeof value === "object") visit(value, "", true);
  return out;
}

/**
 * Return a copy of a request body without properties whose value is exactly
 * SECRET_MASK, so a masked secret is never written back over the real one.
 * Array elements are kept as they are; bodies with a mask that can't be
 * dropped safely are refused before this runs (unwritableMaskPaths).
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
