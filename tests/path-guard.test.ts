/**
 * Unit tests for the call_system_api path guard. No server needed.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardControlPlanePath } from "../src/path-guard";

test("path guard accepts plain control-plane paths", () => {
  for (const p of [
    "system/service",
    "/system/service",
    "system/email_template/3",
    "user/profile",
    "System/Cors",
    "system/service/mysql-prod",
  ]) {
    const r = guardControlPlanePath(p);
    assert.equal(r.ok, true, `${p} should be accepted: ${r.reason}`);
    assert.equal(r.path, p.replace(/^\/+/, ""));
  }
});

test("path guard rejects data-plane and traversal paths", () => {
  const rejected = [
    "db/_table/x",
    "/db/_table/x",
    "system/../db/_table/x",
    "/system/../db/_table/x",
    "system/./../db/_table/x",
    "/system/%2e%2e/db/_table/x",
    "/system/%2E%2E/db/_table/x",
    "system/..%2fdb/_table/x",
    "system\\..\\db\\_table\\x",
    "systemx/service",
    "http://attacker/api/v2/system/service",
    "//attacker/api/v2/system/service",
    "system/service#frag",
    "system/service?fields=*",
    "system/service\n",
    "",
    "..",
    "../system/service",
  ];
  for (const p of rejected) {
    const r = guardControlPlanePath(p);
    assert.equal(r.ok, false, `${JSON.stringify(p)} must be rejected`);
    assert.equal(r.path, undefined);
  }
  assert.equal(guardControlPlanePath(undefined).ok, false);
  assert.equal(guardControlPlanePath(42).ok, false);
});

test("path guard: resolved URL never leaves /api/v2/system or /api/v2/user", () => {
  // Property-style check: for any accepted path, resolving it against the real
  // base must land under an allowed prefix.
  const base = "http://web/api/v2/";
  const probes = [
    "system/service",
    "system/a/b/c",
    "user/session",
    "system/../db/_table/x",
    "system/%2e%2e/db/_table/x",
  ];
  for (const p of probes) {
    const r = guardControlPlanePath(p);
    if (!r.ok || !r.path) continue;
    const u = new URL(r.path, base);
    assert.ok(
      u.href.startsWith("http://web/api/v2/system/") || u.href.startsWith("http://web/api/v2/user/"),
      `${p} resolved to ${u.href}`,
    );
  }
});
