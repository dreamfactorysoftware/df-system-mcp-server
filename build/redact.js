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
exports.unwritableMaskPaths = unwritableMaskPaths;
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
function maskUrlPassword(s) {
    return URL_USERINFO.test(s) ? s.replace(URL_USERINFO, `$1:${exports.SECRET_MASK}@`) : s;
}
function maskHeaderLine(line) {
    if (typeof line !== "string")
        return maskSecretsIn(line);
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    return m && isSecretEntryName(m[1]) ? `${m[1].trim()}: ${exports.SECRET_MASK}` : maskUrlPassword(line);
}
/**
 * Curl options by name (CURLOPT_X or X) or by numeric constant, as RWS
 * RemoteWeb::cleanOptions accepts them.
 */
function maskCurlOptions(options) {
    const out = {};
    for (const [k, v] of Object.entries(options)) {
        const name = curlOptionName(k);
        if ((CURL_SECRET_OPTION.test(name) || isSecretKey(k)) && hasSecretValue(v)) {
            out[k] = exports.SECRET_MASK;
        }
        else if (CURL_HEADER_OPTION.test(name) && Array.isArray(v)) {
            out[k] = v.map(maskHeaderLine);
        }
        else {
            out[k] = maskSecretsIn(v);
        }
    }
    return out;
}
/** Numeric curl constants for the options above (PHP's CURLOPT_* values). */
const CURL_OPTION_CODES = {
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
function curlOptionName(key) {
    const k = key.trim();
    return CURL_OPTION_CODES[k] ?? k.toUpperCase().replace(/^CURLOPT_/, "");
}
function maskSecretsIn(value) {
    if (typeof value === "string")
        return maskUrlPassword(value);
    if (Array.isArray(value))
        return value.map(maskSecretsIn);
    if (value === null || typeof value !== "object")
        return value;
    const src = value;
    const secretEntryValue = isPrivateRecord(src) || isSecretEntryName(src.name);
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        const secret = isSecretKey(k) || (k === "value" && secretEntryValue);
        if (secret && hasSecretValue(v)) {
            out[k] = exports.SECRET_MASK;
        }
        else if (k === "options" && v !== null && typeof v === "object" && !Array.isArray(v)) {
            out[k] = maskCurlOptions(v);
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
 * Paths (e.g. `config.headers[2].value`, `config.options.PROXYUSERPWD`) of masks
 * in a request body that can't be dropped to keep the stored secret, so writes
 * carrying them are refused (see dreamFactoryFetch):
 * - a SECRET_MASK anywhere except directly on the body or directly in a
 *   `config` object, because deeper values (lists such as RWS headers and
 *   parameters, objects such as `options`) are stored whole
 * - a string that contains the mask but isn't only the mask
 *   ("http://user:**********@proxy", "Authorization: **********")
 */
function unwritableMaskPaths(value) {
    const out = [];
    const visit = (v, path, droppable) => {
        if (typeof v === "string") {
            if (v === exports.SECRET_MASK ? !droppable : v.includes(exports.SECRET_MASK))
                out.push(path);
        }
        else if (Array.isArray(v)) {
            v.forEach((e, i) => visit(e, `${path}[${i}]`, false));
        }
        else if (v !== null && typeof v === "object") {
            // `droppable` for this object's own properties: the body itself, or a `config` directly on it.
            const own = path === "" || (droppable && /(^|\.)config$/.test(path));
            for (const [k, child] of Object.entries(v)) {
                visit(child, path ? `${path}.${k}` : k, own);
            }
        }
    };
    if (value !== null && typeof value === "object")
        visit(value, "", true);
    return out;
}
/**
 * Return a copy of a request body without properties whose value is exactly
 * SECRET_MASK, so a masked secret is never written back over the real one.
 * Array elements are kept as they are; bodies with a mask that can't be
 * dropped safely are refused before this runs (unwritableMaskPaths).
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