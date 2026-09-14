"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HINT_PREFIX = exports.MIN_HINT_KEY_LENGTH = exports.HINT_CHARS = exports.HINT_FIELD = exports.API_KEY_FIELD = void 0;
exports.apiKeysExposed = apiKeysExposed;
exports.apiKeyHint = apiKeyHint;
exports.maskApiKeys = maskApiKeys;
exports.maskResult = maskResult;
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
/** True when `MCP_EXPOSE_API_KEYS` opts out of masking. Read per call. */
function apiKeysExposed(env = process.env) {
    const v = (env.MCP_EXPOSE_API_KEYS ?? "").trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
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
//# sourceMappingURL=redact.js.map