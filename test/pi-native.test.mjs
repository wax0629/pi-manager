import assert from "node:assert/strict";
import test from "node:test";
import { createNativeAuth, FEATURED_NATIVE_PROVIDERS } from "../src/pi-native.mjs";

function fakeSdk({ providers, loginImpl }) {
  return {
    ModelRuntime: {
      async create() {
        return {
          getProviders: () => providers,
          getProvider: (id) => providers.find((provider) => provider.id === id),
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
  const providers = await nativeAuth.listNativeProviders();
  assert.equal(providers.some((provider) => provider.id === "openai-codex"), true);
  assert.deepEqual(providers.find((provider) => provider.id === "openai-codex").authMethods, ["oauth", "api_key"]);
  assert.equal(providers.some((provider) => provider.id === "obscure"), false);
  assert.equal(FEATURED_NATIVE_PROVIDERS.includes("openai-codex"), true);
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
