import assert from "node:assert/strict";
import test from "node:test";
import { createPiAuthProbe, parsePiAuthCheck } from "../src/pi-auth.mjs";

test("Pi auth check normalizes ready and not-ready responses without credentials", () => {
  const ready = parsePiAuthCheck(JSON.stringify({ status: "ready", provider: "google", authType: "api_key" }), {
    providerId: "google",
    checkedAt: 100
  });
  const notReady = parsePiAuthCheck(JSON.stringify({ status: "not_ready", provider: "openai-codex", reason: "credentials_not_configured" }), {
    providerId: "openai-codex",
    checkedAt: 100
  });

  assert.deepEqual(ready, {
    providerId: "google",
    ready: true,
    status: "ready",
    authType: "api_key",
    reason: "",
    checkedAt: 100
  });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.reason, "credentials_not_configured");
  assert.equal(Object.hasOwn(notReady, "credential"), false);
});

test("Pi auth probe caches each provider briefly and refreshes after expiry", () => {
  let now = 1000;
  const calls = [];
  const responses = [
    JSON.stringify({ status: "ready", provider: "alpha", authType: "oauth" }),
    JSON.stringify({ status: "not_ready", provider: "alpha", reason: "expired" }),
    JSON.stringify({ status: "ready", provider: "beta", authType: "api_key" })
  ];
  const probe = createPiAuthProbe({
    executable: "/usr/local/bin/pi",
    cacheTtlMs: 1000,
    now: () => now,
    execFileSync: (_executable, args) => {
      calls.push(args);
      return responses.shift();
    }
  });

  assert.equal(probe.check("alpha").ready, true);
  now = 1500;
  assert.equal(probe.check("alpha").ready, true);
  assert.equal(calls.length, 1);

  assert.equal(probe.check("alpha", { force: true }).ready, false);
  assert.equal(calls.length, 2);

  now = 2001;
  assert.equal(probe.check("alpha").ready, false);
  assert.equal(probe.check("beta").ready, true);
  assert.deepEqual(calls, [
    ["auth", "check", "--provider", "alpha", "--json", "--no-refresh"],
    ["auth", "check", "--provider", "alpha", "--json", "--no-refresh"],
    ["auth", "check", "--provider", "beta", "--json", "--no-refresh"]
  ]);
});

test("Pi auth probe reports command failures as a safe status", () => {
  const probe = createPiAuthProbe({
    execFileSync: () => { throw new Error("command failed with sensitive context"); }
  });
  const result = probe.check("openai-codex");

  assert.equal(result.ready, false);
  assert.equal(result.status, "error");
  assert.equal(result.reason, "check_failed");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("Pi auth probe preserves a structured not-ready result from a non-zero command", () => {
  const probe = createPiAuthProbe({
    execFileSync: () => {
      throw Object.assign(new Error("auth required"), {
        stdout: JSON.stringify({ status: "not_ready", reason: "credentials_not_configured" })
      });
    }
  });
  const result = probe.check("openai-codex");

  assert.equal(result.ready, false);
  assert.equal(result.status, "not_ready");
  assert.equal(result.reason, "credentials_not_configured");
});
