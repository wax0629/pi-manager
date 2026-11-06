import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeAuth } from "../src/pi-native.mjs";

function fakeSdk({ providers, loginImpl, refreshImpl, onCreate }) {
  return {
    ModelRuntime: {
      async create(options) {
        if (options.modelsPath === null) {
          assert.equal(options.refreshOnCreate, false);
          assert.equal(options.allowModelNetwork, false);
          return { getProviders: () => providers.filter((provider) => provider.native !== false && !provider.extension) };
        }
        onCreate?.(options);
        return {
          getProviders: () => providers,
          getProvider: (id) => providers.find((provider) => provider.id === id),
          getRegisteredNativeProvider: (id) => providers.find((provider) => provider.id === id && provider.extension),
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
  id: "openai",
  name: "OpenAI",
  configured: false,
  auth: {
    oauth: { login: async () => ({ type: "oauth" }) },
    apiKey: { login: async () => ({ type: "api_key" }) }
  },
  models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, contextWindow: 1050000, input: ["text", "image"] }]
};

test("lists native login providers and SDK auth methods", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({ providers: [openaiCodex, { id: "obscure", name: "Obscure", auth: { apiKey: {} }, models: [] }] })
  });
  const providers = await nativeAuth.listLoginProviders();
  assert.equal(providers.some((provider) => provider.id === "openai"), true);
  assert.deepEqual(providers.find((provider) => provider.id === "openai").authMethods, ["oauth", "api_key"]);
  assert.equal(providers.some((provider) => provider.id === "obscure"), false);
});

test("default native listing only shows configured providers", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({ providers: [{ ...openaiCodex, configured: false }] })
  });
  const providers = await nativeAuth.listNativeProviders();
  assert.equal(providers.some((provider) => provider.id === "openai"), false);
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
          assert.deepEqual(options.providers, ["openai"]);
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
    { result: { aborted: false, errors: new Map([["openai", new Error("network unavailable")]]) }, message: /刷新失败: openai/ },
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
  assert.deepEqual(await nativeAuth.listLoginProviders(), []);
});

async function waitForStatus(auth, loginId, status) {
  for (let index = 0; index < 50; index += 1) {
    const session = await auth.loginStatus(loginId);
    if (session.status === status) return session;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`login did not reach ${status}`);
}

function answer(auth, session, value) {
  return auth.answerPrompt(session.loginId, value, session.prompt.id);
}

test("API key login follows each SDK prompt without reusing input or selecting defaults", async () => {
  const nativeAuth = createNativeAuth({
    loadSdk: async () => fakeSdk({
      providers: [openaiCodex],
      loginImpl: async (_providerId, type, interaction) => {
        assert.equal(type, "api_key");
        const mode = await interaction.prompt({ type: "select", message: "Credentials", options: [
          { id: "profile", label: "Local profile", description: "Use ambient credentials" },
          { id: "keys", label: "Access keys" }
        ] });
        assert.equal(mode, "keys");
        const first = await interaction.prompt({ type: "secret", message: "Access key" });
        assert.equal(first, "first-secret");
        const second = await interaction.prompt({ type: "secret", message: "Secret key" });
        assert.equal(second, " second-secret ");
        const region = await interaction.prompt({ type: "text", message: "Region (optional)", placeholder: "default" });
        assert.equal(region, "");
        return { type: "api_key", key: first };
      }
    })
  });
  const started = await nativeAuth.login({ providerId: "openai", type: "api_key" });
  let session = await waitForStatus(nativeAuth, started.loginId, "need_prompt");
  assert.equal(session.prompt.options[0].description, "Use ambient credentials");
  assert.throws(() => answer(nativeAuth, session, "invalid"), /有效的登录选项/);
  answer(nativeAuth, session, "keys");
  session = await waitForStatus(nativeAuth, started.loginId, "need_prompt");
  const oldPromptId = session.prompt.id;
  answer(nativeAuth, session, "first-secret");
  session = await waitForStatus(nativeAuth, started.loginId, "need_prompt");
  assert.throws(() => nativeAuth.answerPrompt(session.loginId, "stale", oldPromptId), /步骤已更新/);
  assert.equal(JSON.stringify(session).includes("first-secret"), false);
  answer(nativeAuth, session, " second-secret ");
  session = await waitForStatus(nativeAuth, started.loginId, "need_prompt");
  answer(nativeAuth, session, "");
  assert.equal((await waitForStatus(nativeAuth, started.loginId, "completed")).prompt, null);
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
  const started = await nativeAuth.login({ providerId: "openai", type: "oauth" });
  let waiting = started;
  for (let index = 0; index < 20 && waiting.status !== "need_prompt"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    waiting = await nativeAuth.loginStatus(started.loginId);
  }
  assert.equal(waiting.status, "need_prompt");
  assert.equal(waiting.authUrl, "https://auth.example.test/login");
  answer(nativeAuth, waiting, "abc-123");
  let done = await nativeAuth.loginStatus(started.loginId);
  for (let index = 0; index < 20 && done.status !== "completed"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await nativeAuth.loginStatus(started.loginId);
  }
  assert.equal(done.status, "completed");
});

test("new builtins and registered native extensions appear without a maintained allowlist", async () => {
  const newBuiltin = { ...openaiCodex, id: "new-native", name: "New native", configured: true,
    auth: { apiKey: { name: "Access credentials", login: async () => ({ type: "api_key" }) } } };
  const extension = { ...openaiCodex, id: "extension-native", extension: true, configured: true };
  const ambient = { id: "ambient-only", auth: { apiKey: { resolve() {} } }, configured: true };
  const custom = { ...openaiCodex, id: "custom", native: false, configured: true };
  const providers = [newBuiltin, extension, ambient, custom, openaiCodex];
  let refreshed;
  let loggedOut;
  const sdk = fakeSdk({ providers, refreshImpl: async ({ providers }) => { refreshed = providers; return {}; } });
  const create = sdk.ModelRuntime.create;
  sdk.ModelRuntime.create = async (options) => ({ ...await create(options), logout: async (id) => { loggedOut = id; } });
  const auth = createNativeAuth({ loadSdk: async () => sdk });
  const available = await auth.listLoginProviders();
  assert.deepEqual(available.map((p) => p.id).sort(), ["extension-native", "new-native", "openai"]);
  assert.deepEqual(available.find((p) => p.id === "new-native").authMethods, ["api_key"]);
  assert.equal(available.find((p) => p.id === "new-native").authMethodLabels.api_key, "Access credentials");
  assert.deepEqual((await auth.listNativeProviders({ refresh: true })).map((p) => p.id).sort(), ["extension-native", "new-native"]);
  assert.deepEqual(refreshed.sort(), ["extension-native", "new-native"]);
  await auth.logout("new-native");
  assert.equal(loggedOut, "new-native");
  await assert.rejects(() => auth.login({ providerId: "custom" }), /原生渠道不存在/);
  await assert.rejects(() => auth.logout("custom"), /原生渠道不存在/);
});

test("API-key-only native providers choose their supported method", async () => {
  const auth = createNativeAuth({ loadSdk: async () => fakeSdk({
    providers: [{ id: "new-key-only", auth: { apiKey: { login() {} } }, models: [] }],
    loginImpl: async (_id, type) => { assert.equal(type, "api_key"); }
  }) });
  const session = await auth.login({ providerId: "new-key-only" });
  assert.equal((await waitForStatus(auth, session.loginId, "completed")).type, "api_key");
  await assert.rejects(() => auth.login({ providerId: "new-key-only", type: "oauth" }), /不支持 oauth/);
});

test("device authorization and SDK information remain visible while waiting", async () => {
  const auth = createNativeAuth({ loadSdk: async () => fakeSdk({ providers: [openaiCodex],
    loginImpl: async (_id, _type, interaction) => {
      interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://auth.example.test/device" });
      interaction.notify({ type: "info", message: "Use your work account", links: [{ url: "https://example.test/help", label: "Help" }] });
      await interaction.prompt({ type: "text", message: "Continue" });
    }
  }) });
  const started = await auth.login({ providerId: "openai" });
  const session = await waitForStatus(auth, started.loginId, "need_prompt");
  assert.equal(session.userCode, "ABCD-EFGH");
  assert.equal(session.authUrl, "https://auth.example.test/device");
  assert.equal(session.message, "Use your work account");
  assert.equal(session.links[0].label, "Help");
  auth.cancelLogin(started.loginId);
  assert.equal((await auth.loginStatus(started.loginId)).status, "cancelled");
});

test("OAuth callbacks can abort a manual prompt and advance to the next SDK step", async () => {
  const promptController = new AbortController();
  const auth = createNativeAuth({ loadSdk: async () => fakeSdk({ providers: [openaiCodex],
    loginImpl: async (_id, _type, interaction) => {
      await assert.rejects(() => interaction.prompt({ type: "manual_code", message: "Manual code", signal: promptController.signal }), /cancelled/);
      const value = await interaction.prompt({ type: "text", message: "Next step" });
      assert.equal(value, "done");
    }
  }) });
  const started = await auth.login({ providerId: "openai" });
  const oldSession = await waitForStatus(auth, started.loginId, "need_prompt");
  promptController.abort();
  await new Promise((resolve) => setImmediate(resolve));
  const next = await waitForStatus(auth, started.loginId, "need_prompt");
  assert.equal(next.prompt.message, "Next step");
  assert.throws(() => answer(auth, oldSession, "stale"), /步骤已更新/);
  answer(auth, next, "done");
  await waitForStatus(auth, started.loginId, "completed");
});

test("asynchronous login errors are handled without exposing provider credentials", async () => {
  const auth = createNativeAuth({ loadSdk: async () => fakeSdk({ providers: [openaiCodex],
    loginImpl: async (_id, _type, interaction) => {
      const secret = await interaction.prompt({ type: "secret", message: "Key" });
      interaction.notify({ type: "progress", message: `Checking ${secret}` });
      await interaction.prompt({ type: "text", message: "Continue" });
      throw new Error(`Invalid token: ${secret}`);
    }
  }) });
  const started = await auth.login({ providerId: "openai", type: "api_key" });
  answer(auth, await waitForStatus(auth, started.loginId, "need_prompt"), "never-echo-this-key");
  const waiting = await waitForStatus(auth, started.loginId, "need_prompt");
  assert.equal(JSON.stringify(waiting).includes("never-echo-this-key"), false);
  answer(auth, waiting, "");
  const failed = await waitForStatus(auth, started.loginId, "error");
  assert.equal(failed.prompt, null);
  assert.equal(failed.error, "Pi 原生登录失败，请重试");
  assert.equal(JSON.stringify(failed).includes("never-echo-this-key"), false);
});

test("explicit refresh times out even if an SDK call does not settle on abort", async () => {
  let signal;
  const auth = createNativeAuth({ refreshTimeoutMs: 10, loadSdk: async () => fakeSdk({
    providers: [{ ...openaiCodex, configured: true }],
    refreshImpl: async (options) => { signal = options.signal; return new Promise(() => {}); }
  }) });
  await assert.rejects(() => auth.listNativeProviders({ refresh: true }), /刷新超时/);
  assert.equal(signal.aborted, true);
});

const xai = {
  id: "xai",
  name: "xAI",
  configured: false,
  auth: {
    oauth: { login: async () => ({ type: "oauth" }) },
    apiKey: { login: async () => ({ type: "api_key" }) }
  },
  models: [{ id: "grok-4", name: "Grok 4", reasoning: true }]
};

test("xAI subscription login surfaces the device code and opens only an https verification URL", async () => {
  const opened = [];
  let finishLogin;
  const nativeAuth = createNativeAuth({
    openUrl: async (url) => { opened.push(url); },
    loadSdk: async () => fakeSdk({
      providers: [xai],
      loginImpl: async (_providerId, type, interaction) => {
        assert.equal(type, "oauth");
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
          intervalSeconds: 5,
          expiresInSeconds: 900,
          deviceCode: "secret-device-code"
        });
        await new Promise((resolve) => { finishLogin = resolve; });
        return { type: "oauth" };
      }
    })
  });

  const started = await nativeAuth.login({ providerId: "xai", type: "oauth" });
  let waiting = started;
  for (let index = 0; index < 20 && waiting.status !== "need_device_code"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    waiting = await nativeAuth.loginStatus(started.loginId);
  }

  assert.equal(waiting.status, "need_device_code");
  assert.equal(waiting.userCode, "ABCD-1234");
  assert.equal(waiting.authUrl, "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
  assert.equal(waiting.expiresInSeconds, 900);
  assert.equal(waiting.prompt, null);
  assert.equal("deviceCode" in waiting, false);
  assert.equal(JSON.stringify(waiting).includes("secret-device-code"), false);
  assert.deepEqual(opened, ["https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"]);

  finishLogin();
  let done = waiting;
  for (let index = 0; index < 20 && done.status !== "completed"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await nativeAuth.loginStatus(started.loginId);
  }
  assert.equal(done.status, "completed");
  assert.equal(done.userCode, "ABCD-1234");
});

test("xAI device-code login does not open a non-https verification URI", async () => {
  const opened = [];
  const rejections = [];
  const onRejection = (error) => { rejections.push(error); };
  process.on("unhandledRejection", onRejection);
  try {
    const nativeAuth = createNativeAuth({
      openUrl: async (url) => { opened.push(url); },
      loadSdk: async () => fakeSdk({
        providers: [xai],
        loginImpl: async (_providerId, _type, interaction) => {
          interaction.notify({
            type: "device_code",
            userCode: "ABCD-1234",
            verificationUri: "file:///etc/passwd",
            expiresInSeconds: 900
          });
          throw new Error("Device flow timed out");
        }
      })
    });

    const started = await nativeAuth.login({ providerId: "xai", type: "oauth" });
    let failed = started;
    for (let index = 0; index < 20 && failed.status !== "error"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      failed = await nativeAuth.loginStatus(started.loginId);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(failed.status, "error");
    assert.equal(failed.userCode, "ABCD-1234");
    assert.equal(failed.authUrl, "");
    assert.equal(failed.error, "Pi 原生登录失败，请重试");
    assert.deepEqual(opened, []);
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
