/**
 * Unit tests for the X-Mcp-Base-Url trust boundary + constant-time compare.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptBaseUrl, buildAllowedOrigins, safeEqual } from "../src/trust";

test("safeEqual: equal strings only", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
  assert.equal(safeEqual("abc", undefined), false);
  assert.equal(safeEqual("", ""), true);
});

test("buildAllowedOrigins: DREAMFACTORY_URL origin + MCP_ALLOWED_BASE_URLS", () => {
  const set = buildAllowedOrigins("http://web/api/v2", " https://df.example.com/api/v2, http://127.0.0.1:8080 ,bogus");
  assert.deepEqual([...set].sort(), ["http://127.0.0.1:8080", "http://web", "https://df.example.com"]);
});

test("acceptBaseUrl: untrusted callers are limited to the allowlist", () => {
  const allowedOrigins = buildAllowedOrigins("http://web/api/v2");
  const untrusted = { internalKeyVerified: false, allowedOrigins };
  assert.equal(acceptBaseUrl("http://attacker/api/v2", untrusted), undefined);
  assert.equal(acceptBaseUrl("http://web:80/api/v2", untrusted), "http://web:80/api/v2");
  assert.equal(acceptBaseUrl("http://web/api/v2", untrusted), "http://web/api/v2");
  assert.equal(acceptBaseUrl("https://web/api/v2", untrusted), undefined, "scheme is part of the origin");
  assert.equal(acceptBaseUrl("not a url", untrusted), undefined);
  assert.equal(acceptBaseUrl(undefined, untrusted), undefined);
});

test("acceptBaseUrl: internal-key-verified callers may name any origin", () => {
  const trusted = { internalKeyVerified: true, allowedOrigins: new Set<string>() };
  assert.equal(acceptBaseUrl("http://10.0.0.5:8080/api/v2", trusted), "http://10.0.0.5:8080/api/v2");
  assert.equal(acceptBaseUrl("garbage", trusted), undefined, "unparsable is still ignored");
});
