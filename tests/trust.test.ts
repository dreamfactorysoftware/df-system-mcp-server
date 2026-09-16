/**
 * Unit tests for the X-Mcp-Base-Url trust boundary + constant-time compare.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptBaseUrl,
  buildAllowedOrigins,
  isLoopbackAddress,
  isLoopbackHost,
  safeEqual,
} from "../src/trust";

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

test("acceptBaseUrl: local callers of a loopback-bound daemon may name any origin", () => {
  const local = { internalKeyVerified: false, loopbackCaller: true, allowedOrigins: new Set<string>() };
  assert.equal(acceptBaseUrl("https://df.example.com/api/v2", local), "https://df.example.com/api/v2");
  assert.equal(acceptBaseUrl("garbage", local), undefined, "unparsable is still ignored");
  const remote = { internalKeyVerified: false, loopbackCaller: false, allowedOrigins: new Set<string>() };
  assert.equal(acceptBaseUrl("https://df.example.com/api/v2", remote), undefined);
});

test("isLoopbackHost: loopback listen addresses only", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", " LocalHost "]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["0.0.0.0", "::", "10.0.0.5", "web", "127.0.0.1.example.com", "", undefined]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test("isLoopbackAddress: IPv4, IPv6 and IPv4-mapped loopback peers only", () => {
  for (const a of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
    assert.equal(isLoopbackAddress(a), true, a);
  }
  for (const a of ["172.18.0.5", "::ffff:172.18.0.5", "fe80::1", "", undefined]) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});
