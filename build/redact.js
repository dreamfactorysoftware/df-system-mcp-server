"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_MASK = exports.HINT_PREFIX = exports.MIN_HINT_KEY_LENGTH = exports.HINT_CHARS = exports.HINT_FIELD = exports.API_KEY_FIELD = void 0;
exports.apiKeysExposed = apiKeysExposed;
exports.secretsExposed = secretsExposed;
exports.apiKeyHint = apiKeyHint;
exports.maskApiKeys = maskApiKeys;
exports.maskResult = maskResult;
exports.isSecretKey = isSecretKey;
exports.isSecretEntryName = isSecretEntryName;
exports.maskSecrets = maskSecrets;
exports.maskedPathsInArrays = maskedPathsInArrays;
exports.stripMaskedSecrets = stripMaskedSecrets;
/** Property name that is masked (exact match, as DreamFactory emits it). */
exports.API_KEY_FIELD = "api_key";
/** Sibling property carrying the hint. */
exports.HINT_FIELD = "api_key_hint";
/** Characters of the key revealed in the hint. */
exports.HINT_CHARS = 4;
/** Keys shorter than this get a hint with no characters of the key. */
exports.MIN_HINT_KEY_LENGTH = 16;
/** Prefix marking a hint as a truncated key. */
exports.HINT_PREFIX = "…";
/** DreamFactory's protection mask (df-core Protectable::$protectionMask). */
exports.SECRET_MASK = "**********";
function flagSet(value) {
    const v = (value ?? "").trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
}
/** True when `MCP_EXPOSE_API_KEYS` opts out of API-key masking. Read per call. */
function apiKeysExposed(env = process.env) {
    return flagSet(env.MCP_EXPOSE_API_KEYS);
}
/** True when `MCP_EXPOSE_SECRETS` opts out of secret masking. Read per call. */
function secretsExposed(env = process.env) {
    return flagSet(env.MCP_EXPOSE_SECRETS);
}
/** The non-reversible hint for one key value. */
function apiKeyHint(key) {
    if (typeof key !== "string" || key.length === 0)
        return null;
    if (key.length < exports.MIN_HINT_KEY_LENGTH)
        return exports.HINT_PREFIX;
    return exports.HINT_PREFIX + key.slice(-exports.HINT_CHARS);
}
function maskValue(value) {
    if (Array.isArray(value))
        return value.map(maskValue);
    if (value === null || typeof value !== "object")
        return value;
    const src = value;
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        out[k] = k === exports.API_KEY_FIELD ? null : maskValue(v);
    }
    // Written last so an upstream `api_key_hint` can never carry the real key.
    if (Object.prototype.hasOwnProperty.call(src, exports.API_KEY_FIELD)) {
        out[exports.HINT_FIELD] = apiKeyHint(src[exports.API_KEY_FIELD]);
    }
    return out;
}
/**
 * Return a copy of `value` with every `api_key` masked (see module doc).
 * The input is never mutated. Returns `value` untouched when masking is
 * disabled via `MCP_EXPOSE_API_KEYS`.
 */
function maskApiKeys(value, env = process.env) {
    if (apiKeysExposed(env))
        return value;
    return maskValue(value);
}
/** Mask `data` (success) or `details` (error) of a DreamFactory result. */
function maskResult(result, env = process.env) {
    if (apiKeysExposed(env))
        return result;
    if (result.ok)
        return { ...result, data: maskApiKeys(result.data, env) };
    if (result.details === undefined)
        return result;
    return { ...result, details: maskApiKeys(result.details, env) };
}
/** Name segments that mark a secret, matched on the snake_case form of a property name. */
const SECRET_NAME = /(^|_)(pass|passwd|password|passphrase|pwd|secret|private_key|api_key|license_key|licence_key|app_key|encryption_key|signing_key|master_key|account_key|token|credential|credentials|connection_string|dsn|authorization|auth|cookie)($|_)/;
/** Entry names (header, parameter, lookup) whose `value` is a credential: Authorization, Cookie, X-API-Key, ... */
const SECRET_ENTRY_NAME = /(auth|token|secret|pass|key|cookie|session|credential|bearer|signature)/i;
/** Lists whose entries' `value`s are all masked: RWS headers and parameters carry credentials as plain values. */
const CREDENTIAL_LISTS = new Set(["headers", "parameters"]);
/** Suffixes that describe a secret rather than hold one (token_endpoint, password_policy, secret_type, ...). */
const DESCRIPTIVE_SUFFIX = /_(url|uri|endpoint|ttl|timeout|expires|expire|expiry|expiration|lifetime|length|size|hint|type|name|names|field|fields|header|headers|param|params|policy|required|enabled|disabled|mode|label|description|format|id|ids|count|at|date|time|path|location|method|prefix)$/;
function snakeCase(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[-\s.]+/g, "_")
        .toLowerCase();
}
/** True when a property name looks like it holds a secret. `api_key` has its own masking. */
function isSecretKey(name) {
    const n = snakeCase(name);
    if (n === exports.API_KEY_FIELD || n === exports.HINT_FIELD)
        return false;
    if (DESCRIPTIVE_SUFFIX.test(n))
        return false;
    return n === "key" || SECRET_NAME.test(n);
}
/** True when a name/value entry's name marks its `value` as a credential. */
function isSecretEntryName(name) {
    return typeof name === "string" && SECRET_ENTRY_NAME.test(name);
}
function hasSecretValue(v) {
    if (typeof v === "string")
        return v.length > 0 && v !== exports.SECRET_MASK;
    return v !== null && typeof v === "object";
}
function isPrivateRecord(src) {
    const p = src.private;
    return p === true || p === 1 || p === "1" || p === "true";
}
/** @param credentialEntry the object is a direct entry of a `headers` / `parameters` list */
function maskSecretsIn(value, credentialEntry = false) {
    if (Array.isArray(value))
        return value.map((v) => maskSecretsIn(v));
    if (value === null || typeof value !== "object")
        return value;
    const src = value;
    const secretEntryValue = credentialEntry || isPrivateRecord(src) || isSecretEntryName(src.name);
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        const secret = isSecretKey(k) || (k === "value" && secretEntryValue);
        if (secret && hasSecretValue(v)) {
            out[k] = exports.SECRET_MASK;
        }
        else if (Array.isArray(v) && CREDENTIAL_LISTS.has(snakeCase(k))) {
            out[k] = v.map((entry) => maskSecretsIn(entry, true));
        }
        else {
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
function maskSecrets(value, env = process.env) {
    if (secretsExposed(env))
        return value;
    return maskSecretsIn(value);
}
/**
 * Paths (e.g. `config.headers[2].value`) of SECRET_MASK values that sit inside
 * a list, at any depth below it. Dropping those can't keep the stored secret,
 * because DreamFactory replaces a list as a whole, so writes carrying them are
 * refused (see dreamFactoryFetch).
 */
function maskedPathsInArrays(value, path = "", insideList = false) {
    if (value === exports.SECRET_MASK)
        return insideList ? [path] : [];
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => maskedPathsInArrays(v, `${path}[${i}]`, true));
    }
    if (value === null || typeof value !== "object")
        return [];
    return Object.entries(value).flatMap(([k, v]) => maskedPathsInArrays(v, path ? `${path}.${k}` : k, insideList));
}
/**
 * Return a copy of a request body without properties whose value is exactly
 * SECRET_MASK, at any depth, so a masked secret is never written back over
 * the real one. Array elements are kept as they are; bodies with a mask inside
 * a list are refused before this runs (maskedPathsInArrays).
 */
function stripMaskedSecrets(value) {
    if (Array.isArray(value))
        return value.map(stripMaskedSecrets);
    if (value === null || typeof value !== "object")
        return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (v === exports.SECRET_MASK)
            continue;
        out[k] = stripMaskedSecrets(v);
    }
    return out;
}
//# sourceMappingURL=redact.js.map