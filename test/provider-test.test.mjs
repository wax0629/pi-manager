import assert from "node:assert/strict";
import test from "node:test";
import { classifyConnectionError, CONNECTION_TEST_CATEGORIES, testProviderConnection } from "../src/provider-test.mjs";

test("connection error classification maps dns and tls failures", () => {
  const dns = classifyConnectionError(Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" }));
  const tls = classifyConnectionError(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }));

  assert.equal(dns.category, CONNECTION_TEST_CATEGORIES.DNS);
  assert.equal(tls.category, CONNECTION_TEST_CATEGORIES.TLS);
});

test("connection test reports auth and timeout categories", async () => {
  const provider = {
    id: "demo",
    name: "Demo",
    kind: "openai-api",
    baseUrl: "https://relay.example.test/v1"
  };
  const auth = await testProviderConnection({
    provider,
    credential: "secret",
    detectPi: () => ({ subscriptionReady: false }),
    fetchImpl: async () => new Response("{}", { status: 401 })
  });
  const timeout = await testProviderConnection({
    provider,
    credential: "secret",
    detectPi: () => ({ subscriptionReady: false }),
    fetchImpl: async () => { throw Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }); }
  });

  assert.equal(auth.ok, false);
  assert.equal(auth.category, CONNECTION_TEST_CATEGORIES.AUTH);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.category, CONNECTION_TEST_CATEGORIES.TIMEOUT);
});

test("native subscription test uses Pi auth state", async () => {
  let requestedProvider = "";
  const result = await testProviderConnection({
    provider: {
      id: "codex-account",
      name: "OpenAI Codex",
      kind: "native-subscription",
      piProvider: "openai-codex"
    },
    credential: "",
    detectPi: (providerId) => {
      requestedProvider = providerId;
      return { subscriptionReady: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.category, CONNECTION_TEST_CATEGORIES.SUCCESS);
  assert.equal(requestedProvider, "openai-codex");
});
