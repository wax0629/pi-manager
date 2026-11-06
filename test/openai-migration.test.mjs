import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultState, seedStoreProviders } from "../src/defaults.mjs";
import { createStore } from "../src/store.mjs";
import { applyLivePiConfig, mergeLiveModels, restoreLivePiBackup } from "../src/pi-apply.mjs";

function fixture(t, providers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-openai-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = createDefaultState({ projectRoot: root });
  state.providers = providers;
  state.active = { providerId: "openai-codex", modelId: "gpt-test", thinking: "high" };
  state.cycle.modelRefs = ["openai-codex/gpt-test", "openai/gpt-test", "other/model"];
  state.runtime.configRevision = 3;
  state.runtime.appliedRevision = 3;
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  return { root, state, options: { projectRoot: root, dataDir: root } };
}

function legacyProvider() {
  return {
    id: "openai-codex",
    name: "OpenAI Codex (legacy)",
    kind: "native-subscription",
    piProvider: "openai-codex",
    models: [{
      id: "gpt-test", reasoning: true, contextWindow: 500000,
      thinkingLevelMap: { high: "custom-high", max: "custom-max" },
      thinkingMapSource: "user", thinkingMapVerified: true
    }]
  };
}

test("legacy native stores migrate routes, cycle refs and model controls exactly once", (t) => {
  const { options } = fixture(t, [legacyProvider()]);
  const store = createStore(options);
  assert.equal(store.provider("openai-codex"), undefined);
  assert.equal(store.provider("openai").piProvider, "openai");
  assert.equal(store.provider("openai").name, "OpenAI");
  assert.deepEqual(store.get().active, { providerId: "openai", modelId: "gpt-test", thinking: "high" });
  assert.deepEqual(store.get().cycle.modelRefs, ["openai/gpt-test", "other/model"]);
  const model = store.provider("openai").models[0];
  assert.equal(model.contextWindow, 500000);
  assert.equal(model.thinkingLevelMap.high, "custom-high");
  assert.equal(model.thinkingMapVerified, true);
  assert.equal(store.get().runtime.configRevision, 4);
  assert.equal(store.get().runtime.appliedRevision, 3);
  assert.deepEqual(createStore(options).snapshot(), store.snapshot());
});

test("migration merges existing native OpenAI models without overwriting newer controls", (t) => {
  const { options } = fixture(t, [legacyProvider(), {
    id: "openai", name: "OpenAI", kind: "native-subscription", piProvider: "openai",
    models: [{ id: "gpt-test", contextWindow: 750000 }, { id: "gpt-new" }]
  }]);
  const store = createStore(options);
  assert.equal(store.get().providers.length, 1);
  assert.deepEqual(store.provider("openai").models.map((model) => model.id), ["gpt-test", "gpt-new"]);
  assert.equal(store.provider("openai").models[0].contextWindow, 750000);
});

test("migration never hijacks custom relays with OpenAI or Codex IDs", (t) => {
  for (const providers of [
    [legacyProvider(), { id: "openai", kind: "openai-api", baseUrl: "https://relay.test/v1", models: [] }],
    [{ ...legacyProvider(), kind: "openai-api", baseUrl: "https://relay.test/v1" }]
  ]) {
    const { options } = fixture(t, providers);
    const store = createStore(options);
    assert.equal(store.get().active.providerId, "openai-codex");
    assert.equal(store.get().runtime.configRevision, 3);
    assert.equal(store.provider("openai-codex").kind, providers[0].kind);
  }
});

test("restoring a legacy snapshot cannot reintroduce the retired native route", (t) => {
  const { options, state } = fixture(t, [legacyProvider()]);
  const store = createStore(options);
  store.restoreConfiguration(state);
  assert.equal(store.get().active.providerId, "openai");
  assert.equal(store.provider("openai-codex"), undefined);
});

test("seed providers use the unified native OpenAI channel", (t) => {
  const { options } = fixture(t, []);
  const store = createStore(options);
  seedStoreProviders(store, { projectRoot: options.projectRoot });
  assert.equal(store.provider("openai").piProvider, "openai");
  assert.equal(store.provider("openai-codex"), undefined);
  assert.equal(store.get().cycle.modelRefs.includes("openai/gpt-5.6-luna"), true);
});

test("live import migrates native overrides, preserves credentials and remains reversible", (t) => {
  const { options, root } = fixture(t, [legacyProvider()]);
  const store = createStore(options);
  store.updateCycleList(["openai/gpt-test"]);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const originalModels = { providers: {
    "openai-codex": { modelOverrides: { "legacy-only": { contextWindow: 64000 } } },
    openai: { modelOverrides: { "already-native": { contextWindow: 128000 } } },
    other: { baseUrl: "https://other.test/v1" }
  } };
  const originalAuth = { openai: { type: "oauth", refresh: "keep-private" }, "openai-codex": { type: "oauth", refresh: "keep-legacy" } };
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "openai-codex" }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(originalModels));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(originalAuth));
  const result = applyLivePiConfig({
    agentDir, backupRoot: path.join(root, "backups"), state: store.get(),
    listModels: () => "provider model context\nopenai gpt-test 500K\n"
  });
  const settings = JSON.parse(fs.readFileSync(result.settingsPath, "utf8"));
  const models = JSON.parse(fs.readFileSync(result.modelsPath, "utf8"));
  assert.equal(settings.defaultProvider, "openai");
  assert.equal(settings.defaultModel, "gpt-test");
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.enabledModels, ["openai/gpt-test"]);
  assert.equal(models.providers["openai-codex"], undefined);
  assert.equal(models.providers.openai.modelOverrides["gpt-test"].contextWindow, 500000);
  assert.equal(models.providers.openai.modelOverrides["gpt-test"].thinkingLevelMap.high, "custom-high");
  assert.equal(models.providers.openai.modelOverrides["legacy-only"].contextWindow, 64000);
  assert.equal(models.providers.openai.modelOverrides["already-native"].contextWindow, 128000);
  assert.deepEqual(models.providers.other, originalModels.providers.other);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.authPath, "utf8")), originalAuth);
  assert.equal(result.verify.ok, true);
  assert.equal(result.sync.synchronized, true);
  assert.deepEqual(mergeLiveModels(models, store.get()), models);
  restoreLivePiBackup({ agentDir, backupDir: result.backupDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.modelsPath, "utf8")), originalModels);
});

test("native model override migration preserves a custom legacy endpoint", () => {
  const endpoint = { baseUrl: "https://relay.test/v1", models: [{ id: "relay-model" }] };
  const models = mergeLiveModels({ providers: { "openai-codex": endpoint } }, {
    providers: [{ ...legacyProvider(), id: "openai", piProvider: "openai" }]
  });
  assert.deepEqual(models.providers["openai-codex"], endpoint);
  assert.equal(models.providers.openai.modelOverrides["gpt-test"].contextWindow, 500000);
});

test("providers discovered in the installed SDK retain their canonical IDs across reloads", (t) => {
  const { options } = fixture(t, []);
  const store = createStore(options);
  for (const id of ["openai", "openai-codex"]) {
    store.upsertNativeProvider({
      id, name: id, piProvider: id, nativeRegistryId: id,
      models: [{ id: `${id}-model`, reasoning: true, thinkingLevelMap: { high: "high" } }]
    });
  }
  store.setActive({ providerId: "openai-codex", modelId: "openai-codex-model", thinking: "high" });
  store.updateCycleList(["openai-codex/openai-codex-model", "openai/openai-model"]);
  const reloaded = createStore(options);
  assert.equal(reloaded.provider("openai-codex").piProvider, "openai-codex");
  assert.equal(reloaded.get().active.providerId, "openai-codex");
  assert.deepEqual(reloaded.get().cycle, store.get().cycle);
  const models = mergeLiveModels({ providers: { "openai-codex": { modelOverrides: { "keep-codex": { contextWindow: 64000 } } } } }, reloaded.get());
  assert.equal(models.providers["openai-codex"].modelOverrides["keep-codex"].contextWindow, 64000);
  assert.equal(models.providers["openai-codex"].modelOverrides["openai-codex-model"].thinkingLevelMap.high, "high");
  assert.equal(models.providers.openai.modelOverrides["keep-codex"], undefined);
});
