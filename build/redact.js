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
exports.maskConfigByManifest = maskConfigByManifest;
exports.parseSecretFieldManifest = parseSecretFieldManifest;
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
const SECRET_NAME = /(^|_)(pass|passwd|password|passwords|passphrase|passcode|pwd|secret|secrets|private_key|private_keys|api_key|api_keys|apikey|apikeys|access_key|access_keys|license_key|licence_key|app_key|encryption_key|signing_key|master_key|account_key|token|tokens|credential|credentials|connection_string|dsn|authorization|auth|cookie)($|_)/;
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
/**
 * True when a property name looks like it holds a secret (`api_key_hint` is the hint, not the key).
 * A bare `key` doesn't count: DreamFactory uses it for the key half of key/value descriptors and
 * for identifiers (an AWS access key ID), and the manifest covers configs whose secret is `key`.
 */
function isSecretKey(name) {
    const n = snakeCase(name);
    if (n === exports.HINT_FIELD)
        return false;
    if (DESCRIPTIVE_SUFFIX.test(n))
        return false;
    return SECRET_NAME.test(n);
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
function maskHeaderLine(line, opts) {
    if (typeof line !== "string")
        return maskSecretsIn(line, opts);
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    return m && isSecretEntryName(m[1]) ? `${m[1].trim()}: ${exports.SECRET_MASK}` : maskUrlPassword(line);
}
/**
 * Curl options by name (CURLOPT_X or X) or by numeric constant, as RWS
 * RemoteWeb::cleanOptions accepts them.
 */
function maskCurlOptions(options, opts) {
    const out = {};
    for (const [k, v] of Object.entries(options)) {
        const name = curlOptionName(k);
        if ((CURL_SECRET_OPTION.test(name) || isSecretKey(k)) && hasSecretValue(v)) {
            out[k] = exports.SECRET_MASK;
        }
        else if (CURL_HEADER_OPTION.test(name) && Array.isArray(v)) {
            out[k] = v.map((line) => maskHeaderLine(line, opts));
        }
        else {
            out[k] = maskSecretsIn(v, opts);
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
function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
function manifestEntry(manifest, type) {
    if (!manifest || typeof type !== "string")
        return undefined;
    return Object.prototype.hasOwnProperty.call(manifest, type) ? manifest[type] : undefined;
}
/** A service type's manifest entry applied to its config: secret fields, and credential-named keys of maps. */
function maskConfigByManifest(config, entry) {
    const out = { ...config };
    for (const field of entry.secret) {
        if (Object.prototype.hasOwnProperty.call(out, field) && hasSecretValue(out[field]))
            out[field] = exports.SECRET_MASK;
    }
    for (const field of entry.maps) {
        const map = out[field];
        if (!isPlainObject(map))
            continue;
        const masked = {};
        for (const [k, v] of Object.entries(map)) {
            masked[k] = (isSecretEntryName(k) || isSecretKey(k)) && hasSecretValue(v) ? exports.SECRET_MASK : v;
        }
        out[field] = masked;
    }
    return out;
}
/** Type names, as descriptors use them (the environment's login payloads: `{ "password": "string" }`). */
const TYPE_NAME = /^(string|text|bool|boolean|int|integer|number|float|double|array|object|date|datetime|timestamp)$/;
function isTypeName(v) {
    return typeof v === "string" && TYPE_NAME.test(v);
}
/** A record that describes fields rather than holding values: at least two of its values are type names. */
function isTypeDescriptorRecord(src) {
    let names = 0;
    for (const v of Object.values(src))
        if (isTypeName(v) && ++names >= 2)
            return true;
    return false;
}
function maskSecretsIn(value, opts) {
    if (typeof value === "string")
        return maskUrlPassword(value);
    if (Array.isArray(value))
        return value.map((v) => maskSecretsIn(v, opts));
    if (value === null || typeof value !== "object")
        return value;
    let src = value;
    const entry = manifestEntry(opts.manifest, src.type);
    if (entry && isPlainObject(src.config))
        src = { ...src, config: maskConfigByManifest(src.config, entry) };
    const secretEntryValue = isPrivateRecord(src) || isSecretEntryName(src.name);
    // In a descriptor record a type name is a description, not a value; anything else is still masked.
    const descriptor = isTypeDescriptorRecord(src);
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        const secret = (isSecretKey(k) && !(opts.keepApiKeys && k === exports.API_KEY_FIELD)) || (k === "value" && secretEntryValue);
        if (secret && hasSecretValue(v) && !(descriptor && isTypeName(v))) {
            out[k] = exports.SECRET_MASK;
        }
        else if (k === "options" && isPlainObject(v)) {
            out[k] = maskCurlOptions(v, opts);
        }
        else {
            out[k] = maskSecretsIn(v, opts);
        }
    }
    return out;
}
/** Caps on a manifest received over the wire, so a caller can't make every response scan unbounded lists. */
const MANIFEST_MAX_TYPES = 500;
const MANIFEST_MAX_FIELDS = 200;
const MANIFEST_MAX_NAME = 128;
function manifestNames(list) {
    if (!Array.isArray(list))
        return [];
    return list
        .filter((n) => typeof n === "string" && n.length > 0 && n.length <= MANIFEST_MAX_NAME)
        .slice(0, MANIFEST_MAX_FIELDS);
}
/**
 * Validate a secret-field manifest from the proxy envelope (`_mcpSecretFields`). Invalid
 * entries are dropped; returns undefined when nothing usable is left. A manifest only adds
 * masking, so taking one from a caller can't expose anything.
 */
function parseSecretFieldManifest(raw) {
    if (!isPlainObject(raw))
        return undefined;
    const out = Object.create(null);
    let count = 0;
    for (const [type, entry] of Object.entries(raw)) {
        if (count >= MANIFEST_MAX_TYPES)
            break;
        if (!isPlainObject(entry) || type.length === 0 || type.length > MANIFEST_MAX_NAME)
            continue;
        const secret = manifestNames(entry.secret);
        const maps = manifestNames(entry.maps);
        if (secret.length === 0 && maps.length === 0)
            continue;
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
function maskSecrets(value, env = process.env, options = {}) {
    if (secretsExposed(env))
        return value;
    // MCP_EXPOSE_API_KEYS opts every api_key out, including the ones in service configs.
    return maskSecretsIn(value, { ...options, keepApiKeys: options.keepApiKeys || apiKeysExposed(env) });
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