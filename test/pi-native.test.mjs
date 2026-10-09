import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeAuth, FEATURED_NATIVE_PROVIDERS } from "../src/pi-native.mjs";

function fakeSdk({ providers, loginImpl, refreshImpl, onCreate }) {
  return {
    ModelRuntime: {
      async create(options) {
        onCreate?.(options);
        return {
          getProviders: () => providers,
          getProvider: (id) => providers.find((provider) => provider.id === id),
          getRegisteredNativeProvider: (id) => providers.find((provider) => provider.id === id && provider.native !== false),
          getModels: (id) => providers.find((provider) => provider.id === id)?.models || [],
          getProviderAuthStatus: (id) => ({
            configured: Boolean(providers.find((provider) => provider.id === id)?.configured),
            source: "stored",
            label: "OAuth"
          }),
          listCredentials: async () => providers
            .filter((provider) => provider.configured)
            .map((provider) => ({ providerId: provider.id, type: "oauth" })),
          login: loginImpl,
          refresh: refreshImpl,
          logout: async (providerId) => {
            const provider = providers.find((item) => item.id === providerId);
            if (provider) provider.configured = false;
          }
        };
      }
    }
  };
}

const openaiCodex = {
  id: "openai-codex",
  name: "OpenAI Codex",
  configured: false,
  auth: {
    oauth: { login: async () => ({ type: "oauth" }) },
    apiKey: { login: async () => ({ type: "api_key" }) }
  },
  models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, contextWindow: 1050000, input: ["text", "image"] }]
};

test("lists featured native providers and their auth methods", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({ providers: [openaiCodex, { id: "obscure", name: "Obscure", auth: { apiKey: {} }, models: [] }] })
  });
  const providers = await nativeAuth.listFeaturedNativeProviders();
  assert.equal(providers.some((provider) => provider.id === "openai-codex"), true);
  assert.deepEqual(providers.find((provider) => provider.id === "openai-codex").authMethods, ["oauth", "api_key"]);
  assert.equal(providers.some((provider) => provider.id === "obscure"), false);
  assert.equal(FEATURED_NATIVE_PROVIDERS.includes("openai-codex"), true);
});

test("default native listing only shows configured providers", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({ providers: [{ ...openaiCodex, configured: false }] })
  });
  const providers = await nativeAuth.listNativeProviders();
  assert.equal(providers.some((provider) => provider.id === "openai-codex"), false);
});

test("native runtime restores Pi's local catalog and auth without a network refresh", async () => {
  const agentDir = path.join(os.tmpdir(), "pi-manager-native-cache-test");
  const nativeAuth = createNativeAuth({
    agentDir,
    loadSdk: async () => fakeSdk({
      providers: [{ ...openaiCodex, configured: true }],
      onCreate(options) {
        assert.equal(options.refreshOnCreate, true);
        assert.equal(options.allowModelNetwork, false);
        assert.equal(options.modelsPath, path.join(agentDir, "models.json"));
        assert.equal(options.authPath, path.join(agentDir, "auth.json"));
      },
      refreshImpl: async () => assert.fail("ordinary reads must not fetch models")
    })
  });
  assert.equal((await nativeAuth.listNativeProviders())[0].credentialConfigured, true);
});

test("explicit refresh reloads the runtime, bypasses catalog freshness and returns new models", async () => {
  let creates = 0;
  let refreshes = 0;
  const nativeAuth = createNativeAuth({
    loadSdk: async () => {
      const providers = [{ ...openaiCodex, configured: true, models: [...openaiCodex.models] }];
      return fakeSdk({
        providers,
        onCreate: () => { creates += 1; },
        refreshImpl: async (options) => {
          refreshes += 1;
          assert.equal(options.allowNetwork, process.env.PI_OFFLINE === undefined);
          assert.equal(options.force, true);
          assert.deepEqual(options.providers, ["openai-codex"]);
          assert.equal(options.signal instanceof AbortSignal, true);
          providers[0].models.push({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: true });
          return { aborted: false, errors: new Map() };
        }
      });
    }
  });
  const before = await nativeAuth.listNativeProviders();
  assert.equal(before[0].models.some((model) => model.id === "gpt-6.1-sol"), false);
  const results = await Promise.all([
    nativeAuth.listNativeProviders({ refresh: true }),
    nativeAuth.listNativeProviders({ refresh: true })
  ]);
  assert.equal(creates, 2);
  assert.equal(refreshes, 1);
  for (const providers of results) {
    assert.equal(providers[0].models.some((model) => model.id === "gpt-6.1-sol"), true);
  }
});

test("explicit refresh reports catalog failures and timeouts instead of claiming success", async () => {
  const outcomes = [
    { result: { aborted: false, errors: new Map([["openai-codex", new Error("network unavailable")]]) }, message: /刷新失败: openai-codex/ },
    { result: { aborted: true, errors: new Map() }, message: /刷新超时/ }
  ];
  for (const { result, message } of outcomes) {
    const nativeAuth = createNativeAuth({
      loadSdk: async () => fakeSdk({ providers: [{ ...openaiCodex, configured: true }], refreshImpl: async () => result })
    });
    await assert.rejects(() => nativeAuth.listNativeProviders({ refresh: true }), message);
    assert.equal((await nativeAuth.listNativeProviders()).length, 1);
  }
});

test("native runtime initialization can recover after a failed SDK load", async () => {
  let attempts = 0;
  const nativeAuth = createNativeAuth({
    loadSdk: async () => {
      if (++attempts === 1) throw new Error("temporary SDK load failure");
      return fakeSdk({ providers: [{ ...openaiCodex, configured: true }] });
    }
  });
  await assert.rejects(() => nativeAuth.listNativeProviders(), /temporary SDK load failure/);
  assert.equal((await nativeAuth.listNativeProviders()).length, 1);
});

test("models.json providers are not treated as native subscription cards", async () => {
  const antigravity = {
    id: "antigravity",
    name: "Google Antigravity",
    configured: true,
    native: false,
    auth: { apiKey: { login: async () => ({ type: "api_key" }) } },
    models: [{ id: "gemini-3.8-flash-tiered" }]
  };
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({ providers: [antigravity] })
  });

  assert.deepEqual(await nativeAuth.listNativeProviders(), []);
  assert.deepEqual(await nativeAuth.listFeaturedNativeProviders(), []);
});

test("api key login rejects empty keys and completes with a provided key", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({
      providers: [openaiCodex],
      loginImpl: async (_providerId, type, interaction) => {
        assert.equal(type, "api_key");
        const value = await interaction.prompt({ type: "secret", message: "API key" });
        assert.equal(value, "sk-test");
        return { type: "api_key", key: value };
      }
    })
  });
  await assert.rejects(() => nativeAuth.login({ providerId: "openai-codex", type: "api_key" }), /API Key 不能为空/);
  const result = await nativeAuth.login({ providerId: "openai-codex", type: "api_key", apiKey: "sk-test" });
  assert.equal(result.status, "completed");
});

test("oauth login exposes auth url and accepts a follow-up prompt", async () => {
  const nativeAuth = createNativeAuth({
    openUrl: async () => {},
    loadSdk: async () => fakeSdk({
      providers: [openaiCodex],
      loginImpl: async (_providerId, type, interaction) => {
        assert.equal(type, "oauth");
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/login" });
        const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
        assert.equal(code, "abc-123");
        return { type: "oauth" };
      }
    })
  });
  const started = await nativeAuth.login({ providerId: "openai-codex", type: "oauth" });
  assert.equal(started.authUrl, "https://auth.example.test/login");
  let waiting = started;
  for (let index = 0; index < 20 && waiting.status !== "need_prompt"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    waiting = await nativeAuth.loginStatus(started.loginId);
  }
  assert.equal(waiting.status, "need_prompt");
  nativeAuth.answerPrompt(started.loginId, "abc-123");
  let done = await nativeAuth.loginStatus(started.loginId);
  for (let index = 0; index < 20 && done.status !== "completed"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await nativeAuth.loginStatus(started.loginId);
  }
  assert.equal(done.status, "completed");
});
