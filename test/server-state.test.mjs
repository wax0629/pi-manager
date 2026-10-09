import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("public state synchronizes native catalogs into the selectable, persisted model list", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-native-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.PI_MANAGER_HOME = root;
  process.env.PI_EXECUTABLE = path.join(root, "missing-pi");
  const { publicState, store } = await import("../src/server.mjs");
  const unavailableAuth = { listNativeProviders: async () => assert.fail("a store without native providers must not require Pi") };
  const empty = await publicState({ auth: unavailableAuth, refreshModels: true, forceAuth: true });
  assert.equal(empty.providers.length, 0);
  const summary = {
    id: "openai-codex", name: "OpenAI Codex", credentialConfigured: true,
    authMethods: ["oauth"], authLabel: "OAuth",
    models: [{ id: "gpt-6-astra", reasoning: true, thinkingLevelMap: { max: "max" } }]
  };
  store.upsertNativeProvider(summary);
  const requestedRefreshes = [];
  const auth = {
    async listNativeProviders({ refresh }) {
      requestedRefreshes.push(refresh);
      return [
        { ...summary, models: refresh ? [...summary.models, { id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: { max: "max" } }] : store.provider(summary.id).models },
        { id: "google", name: "Google", credentialConfigured: true, authMethods: ["api_key"], models: [{ id: "gemini-test" }] }
      ];
    }
  };
  const initial = await publicState({ auth });
  assert.equal(initial.providers.length, 1);
  assert.equal(initial.providers[0].models.length, 1);
  const refreshed = await publicState({ auth, refreshModels: true, forceAuth: true });
  assert.deepEqual(requestedRefreshes, [false, true]);
  const provider = refreshed.providers.find((item) => item.id === summary.id);
  assert.equal(provider.models.some((model) => model.id === "gpt-6.1-sol"), true);
  assert.equal(provider.status, "ready");
  assert.deepEqual(provider.authMethods, ["oauth"]);
  store.setActive({ providerId: summary.id, modelId: "gpt-6.1-sol", thinking: "max" });
  const next = await publicState({ auth });
  assert.equal(next.active.model.id, "gpt-6.1-sol");
  const saved = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
  assert.equal(saved.providers[0].models.some((model) => model.id === "gpt-6.1-sol"), true);
  const failingAuth = { listNativeProviders: async () => { throw new Error("catalog unavailable"); } };
  await assert.rejects(() => publicState({ auth: failingAuth, refreshModels: true }), /catalog unavailable/);
  const fallback = await publicState({ auth: failingAuth });
  assert.equal(fallback.providers[0].models.length, 2);
});
