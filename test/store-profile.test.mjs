import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeLiveModels, mergeLiveSettings } from "../src/pi-apply.mjs";
import { createStore } from "../src/store.mjs";
import { seedStoreProviders } from "../src/defaults.mjs";
import { getSupportedThinkingLevels } from "../src/thinking.mjs";

process.env.PI_MANAGER_DISABLE_KEYCHAIN = "1";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    projectRoot: root,
    dataDir: path.join(root, "manager-data")
  };
}

test("native catalog refresh persists new models and preserves saved model controls", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const summary = {
    id: "openai", name: "OpenAI", piProvider: "openai",
    models: [{ id: "gpt-6-astra", reasoning: true, contextWindow: 272000, thinkingLevelMap: { max: "max", xhigh: "xhigh" } }]
  };
  store.upsertNativeProvider(summary);
  store.setActive({ providerId: summary.id, modelId: "gpt-6-astra", thinking: "max" });
  store.updateCycleList(["openai/gpt-6-astra"]);
  store.updateThinkingMap({ providerId: summary.id, modelId: "gpt-6-astra", thinkingLevelMap: { max: "custom-max", xhigh: "custom-high" }, source: "user", verified: true });
  store.updateModelContextWindow({ providerId: summary.id, modelId: "gpt-6-astra", contextWindow: 500000 });
  const active = { ...store.get().active };
  const cycle = { ...store.get().cycle };
  const revision = store.get().runtime.configRevision;
  const refreshed = { ...summary, models: [...summary.models, { id: "gpt-6.1-sol", reasoning: true, contextWindow: 1050000, thinkingLevelMap: { max: "max", xhigh: "xhigh" } }] };
  store.upsertNativeProvider(refreshed);
  assert.equal(store.get().runtime.configRevision, revision + 1);
  assert.deepEqual(store.get().active, active);
  assert.deepEqual(store.get().cycle, cycle);
  const reloaded = createStore(fixture);
  const astra = reloaded.provider(summary.id).models.find((model) => model.id === "gpt-6-astra");
  assert.equal(astra.contextWindow, 500000);
  assert.equal(astra.thinkingLevelMap.max, "custom-max");
  assert.equal(astra.thinkingMapSource, "user");
  assert.equal(astra.thinkingMapVerified, true);
  assert.equal(reloaded.provider(summary.id).models.some((model) => model.id === "gpt-6.1-sol"), true);
  reloaded.setActive({ providerId: summary.id, modelId: "gpt-6.1-sol", thinking: "max" });
  assert.equal(reloaded.get().active.modelId, "gpt-6.1-sol");
  store.upsertNativeProvider(refreshed);
  store.upsertNativeProvider({ ...summary, models: [] });
  assert.equal(store.get().runtime.configRevision, revision + 1);
  assert.equal(store.provider(summary.id).models.length, 2);
});

test("new stores start without providers, cycle entries, or an active route", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);

  assert.deepEqual(store.get().providers, []);
  assert.deepEqual(store.get().cycle.modelRefs, []);
  assert.deepEqual(store.get().active, { providerId: "", modelId: "", thinking: "off" });

  const reloaded = createStore(fixture);
  assert.deepEqual(reloaded.get().providers, []);
  assert.deepEqual(reloaded.get().cycle.modelRefs, []);
  assert.deepEqual(reloaded.get().active, { providerId: "", modelId: "", thinking: "off" });
});

test("custom provider metadata and credential survive reload without leaking into state.json", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);

  const provider = store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: ["demo-model"],
    apiKey: "test-secret-value"
  });

  assert.equal(provider.id, "demo-relay");
  assert.equal(store.credentialConfigured(provider), true);
  assert.equal(store.credential(provider), "test-secret-value");
  assert.equal(store.get().runtime.configRevision > store.get().runtime.appliedRevision, true);

  const persistedState = fs.readFileSync(store.statePath, "utf8");
  assert.equal(persistedState.includes("test-secret-value"), false);

  const reloaded = createStore(fixture);
  assert.equal(reloaded.provider("demo-relay").name, "Demo Relay");
  assert.equal(reloaded.credential(reloaded.provider("demo-relay")), "test-secret-value");
});

test("new stores initialize and preserve a local gateway client key", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const firstKey = store.get().gateway.clientKey;

  assert.equal(typeof firstKey, "string");
  assert.equal(firstKey.length >= 32, true);
  assert.equal(JSON.parse(fs.readFileSync(store.statePath, "utf8")).gateway.clientKey, firstKey);

  const reloaded = createStore(fixture);
  assert.equal(reloaded.get().gateway.clientKey, firstKey);
});

test("stores repair a legacy empty gateway client key without changing other config", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const before = store.snapshotConfiguration();
  const persisted = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
  persisted.gateway.clientKey = "";
  fs.writeFileSync(store.statePath, `${JSON.stringify(persisted)}\n`);

  const repaired = createStore(fixture);
  assert.equal(repaired.get().gateway.clientKey.length >= 32, true);
  assert.notEqual(repaired.get().gateway.clientKey, "");
  assert.equal(JSON.parse(fs.readFileSync(repaired.statePath, "utf8")).gateway.clientKey, repaired.get().gateway.clientKey);
  assert.deepEqual(repaired.get().active, before.active);
  assert.deepEqual(repaired.get().cycle, before.cycle);
});

test("API and bridge credentials can be saved and cleared without leaking into state.json", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });

  store.setCredential("qiniu", "qiniu-ui-secret");
  store.setCredential("antigravity", "bridge-ui-secret");
  assert.equal(store.credential(store.provider("qiniu")), "qiniu-ui-secret");
  assert.equal(store.credential(store.provider("antigravity")), "bridge-ui-secret");
  assert.equal(store.credentialConfigured(store.provider("qiniu")), true);
  assert.equal(fs.readFileSync(store.statePath, "utf8").includes("qiniu-ui-secret"), false);
  assert.equal(fs.readFileSync(store.statePath, "utf8").includes("bridge-ui-secret"), false);

  store.deleteCredential("antigravity");
  assert.equal(store.credential(store.provider("antigravity")), "");
  assert.equal(store.credentialConfigured(store.provider("antigravity")), false);

  assert.throws(() => store.setCredential("openai", "should-fail"), /原生订阅/);
  assert.throws(() => store.deleteCredential("openai"), /原生订阅/);
  assert.throws(() => store.setCredential("qiniu", "   "), /凭据不能为空/);
});

test("manager-stored antigravity credentials take precedence over bridge env files", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const bridgePath = path.join(fixture.projectRoot, "antigravity-bridge");
  fs.mkdirSync(bridgePath, { recursive: true });
  fs.writeFileSync(path.join(bridgePath, ".env"), "API_KEY=from-bridge\n");
  store.update((state) => {
    const provider = state.providers.find((item) => item.id === "antigravity");
    if (provider) provider.bridgePath = bridgePath;
  });

  const provider = store.provider("antigravity");
  assert.equal(store.credential(provider), "from-bridge");
  assert.equal(store.credentialConfigured(provider), true);

  store.setCredential("antigravity", "from-manager");
  assert.equal(store.credential(store.provider("antigravity")), "from-manager");
  assert.equal(store.credentialConfigured(store.provider("antigravity")), true);

  store.deleteCredential("antigravity");
  assert.equal(store.credential(store.provider("antigravity")), "from-bridge");
  assert.equal(store.credentialConfigured(store.provider("antigravity")), true);
});

test("custom provider catalogs can add and remove models without dropping the default route", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: ["keep-model", "drop-model"]
  });
  store.updateCycleList(["demo-relay/keep-model", "demo-relay/drop-model", "qiniu/grok-4.6"]);

  const added = store.addProviderModel({
    providerId: "demo-relay",
    model: { id: "plus-model", name: "Plus Model", reasoning: true, contextWindow: 64000 }
  });
  assert.equal(added.id, "plus-model");
  assert.equal(store.provider("demo-relay").models.some((model) => model.id === "plus-model"), true);

  store.removeProviderModel({ providerId: "demo-relay", modelId: "drop-model" });
  assert.equal(store.provider("demo-relay").models.some((model) => model.id === "drop-model"), false);
  assert.deepEqual(store.get().cycle.modelRefs, ["demo-relay/keep-model", "qiniu/grok-4.6"]);

  store.setActive({ providerId: "demo-relay", modelId: "keep-model", thinking: "off" });
  assert.throws(
    () => store.removeProviderModel({ providerId: "demo-relay", modelId: "keep-model" }),
    /不能删除当前默认模型/
  );
  assert.throws(() => store.addProviderModel({ providerId: "openai", model: { id: "nope" } }), /只有 OpenAI 兼容 API 渠道可以增删模型/);
  assert.throws(() => store.removeProviderModel({ providerId: "openai", modelId: "gpt-5.6-luna" }), /只有 OpenAI 兼容 API 渠道可以增删模型/);
});

test("custom provider validation rejects unsupported URLs and empty model lists", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);

  assert.throws(
    () => store.addProvider({ name: "Bad URL", baseUrl: "ftp://relay.example.test", models: ["demo"] }),
    /http\(s\)/
  );
  assert.throws(
    () => store.addProvider({ name: "No Models", baseUrl: "https://relay.example.test/v1", models: [] }),
    /至少填写一个模型 ID/
  );
});

test("custom providers can be edited without dropping model metadata or leaking secrets", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: [{
      id: "demo-model",
      name: "Demo Model",
      reasoning: true,
      thinkingLevelMap: { off: "none", medium: "balanced", high: "deep" },
      contextWindow: 256000
    }],
    apiKey: "old-secret"
  });
  store.updateCycleList(["demo-relay/demo-model", "qiniu/grok-4.6"]);

  const updated = store.updateProvider("demo-relay", {
    name: "Demo Relay West",
    baseUrl: "https://relay-west.example.test/v1/",
    models: ["demo-model", "demo-plus"],
    apiKey: "new-secret"
  });

  assert.equal(updated.name, "Demo Relay West");
  assert.equal(updated.baseUrl, "https://relay-west.example.test/v1");
  assert.equal(updated.models.length, 2);
  assert.equal(updated.models[0].thinkingLevelMap.medium, "balanced");
  assert.equal(updated.models[0].contextWindow, 256000);
  assert.equal(updated.models[1].id, "demo-plus");
  assert.equal(store.credential(updated), "new-secret");
  assert.equal(fs.readFileSync(store.statePath, "utf8").includes("new-secret"), false);

  const reloaded = createStore(fixture);
  const reloadedProvider = reloaded.provider("demo-relay");
  assert.equal(reloadedProvider.name, "Demo Relay West");
  assert.equal(reloadedProvider.models[0].thinkingLevelMap.high, "deep");
  assert.equal(reloaded.credential(reloadedProvider), "new-secret");
});

test("editing a custom provider can rename its id and rewrite cycle refs", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: ["demo-model", "stale-model"],
    apiKey: "rename-secret"
  });
  store.setActive({ providerId: "demo-relay", modelId: "demo-model", thinking: "off" });
  store.updateCycleList(["demo-relay/demo-model", "demo-relay/stale-model", "qiniu/grok-4.6"]);

  const renamed = store.updateProvider("demo-relay", {
    id: "west-relay",
    models: ["demo-model"]
  });

  assert.equal(renamed.id, "west-relay");
  assert.equal(store.provider("demo-relay"), undefined);
  assert.equal(store.get().active.providerId, "west-relay");
  assert.deepEqual(store.get().cycle.modelRefs, ["west-relay/demo-model", "qiniu/grok-4.6"]);
  assert.equal(store.credential(renamed), "rename-secret");
  assert.equal(store.credential({ id: "demo-relay" }), "");
});

test("custom provider edits reject native channels, duplicate ids and emptying the catalog", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: ["demo-model"]
  });
  store.addProvider({
    id: "other-relay",
    name: "Other Relay",
    baseUrl: "https://other.example.test/v1",
    models: ["other-model"]
  });

  assert.throws(() => store.updateProvider("openai", { name: "Nope" }), /只有 OpenAI 兼容 API 渠道可以编辑/);
  store.updateProvider("qiniu", { name: "七牛云改名" });
  assert.equal(store.provider("qiniu").name, "七牛云改名");
  assert.throws(
    () => store.updateProvider("demo-relay", { id: "other-relay" }),
    /Provider ID 已存在/
  );
  assert.throws(
    () => store.updateProvider("demo-relay", { id: "qiniu" }),
    /不能占用内置渠道 ID/
  );
  assert.throws(
    () => store.updateProvider("demo-relay", { baseUrl: "ftp://relay.example.test" }),
    /http\(s\)/
  );
  assert.throws(
    () => store.updateProvider("demo-relay", { models: [] }),
    /至少填写一个模型 ID/
  );
});

test("candidate route rejects unsupported thinking levels", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const before = store.snapshot().active;

  assert.throws(
    () => store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-sol", thinking: "max" }),
    /不支持 Thinking/
  );
  assert.deepEqual(store.get().active, before);
});

test("thinking maps preserve explicit upstream values and null extended levels", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const before = store.provider("qiniu").models.find((model) => model.id === "gpt-5.6-luna");

  assert.deepEqual(getSupportedThinkingLevels(before), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(before.thinkingLevelMap.max, null);

  store.updateThinkingMap({
    providerId: "qiniu",
    modelId: "gpt-5.6-luna",
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "quick",
      medium: "balanced",
      high: "deep",
      xhigh: null,
      max: null
    },
    source: "user",
    verified: true
  });

  const model = store.provider("qiniu").models.find((item) => item.id === "gpt-5.6-luna");
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "medium", "high"]);
  assert.equal(model.thinkingLevelMap.medium, "balanced");
  assert.equal(model.thinkingMapSource, "user");
  assert.equal(model.thinkingMapVerified, true);
});

test("thinking map cannot invalidate the active default route", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });

  assert.throws(
    () => store.updateThinkingMap({
      providerId: "qiniu",
      modelId: "gpt-5.6-luna",
      thinkingLevelMap: { medium: null }
    }),
    /不支持 Thinking/
  );
});

test("context window updates persist and reject invalid values", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });

  store.updateModelContextWindow({
    providerId: "qiniu",
    modelId: "gpt-5.6-luna",
    contextWindow: 640000
  });

  assert.equal(store.provider("qiniu").models.find((model) => model.id === "gpt-5.6-luna").contextWindow, 640000);
  const reloaded = createStore(fixture);
  assert.equal(reloaded.provider("qiniu").models.find((model) => model.id === "gpt-5.6-luna").contextWindow, 640000);

  for (const value of [0, -1, 1.5, "", "1.5", 100000001]) {
    assert.throws(
      () => reloaded.updateModelContextWindow({ providerId: "qiniu", modelId: "gpt-5.6-luna", contextWindow: value }),
      /Context 长度/
    );
  }
});

test("candidate route changes do not write live Pi configuration", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const before = store.snapshot();

  store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-sol", thinking: "high" });

  assert.notDeepEqual(store.get().active, before.active);
  assert.equal(store.get().runtime.configRevision > before.runtime.configRevision, true);
  assert.equal(store.get().runtime.appliedRevision, before.runtime.appliedRevision);
});

test("rollback restores the last applied configuration snapshot", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const appliedSnapshot = store.snapshotConfiguration();

  store.update((state) => {
    state.runtime.appliedSnapshot = appliedSnapshot;
    state.runtime.appliedRevision = state.runtime.configRevision;
  });
  store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-sol", thinking: "high" });
  store.updateCycleList(["qiniu/grok-4.6"]);

  const beforeRollbackRevision = store.get().runtime.configRevision;
  store.restoreAppliedConfiguration();

  assert.deepEqual(store.get().active, appliedSnapshot.active);
  assert.deepEqual(store.get().cycle.modelRefs, appliedSnapshot.cycle.modelRefs);
  assert.equal(store.get().runtime.configRevision, beforeRollbackRevision + 1);
});

test("cycle list updates persist and write enabledModels in order", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-luna", thinking: "medium" });

  store.updateCycleList([
    "qiniu/grok-4.6",
    "openai/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);

  const reloaded = createStore(fixture);
  assert.deepEqual(reloaded.get().cycle.modelRefs, [
    "qiniu/grok-4.6",
    "openai/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);

  const settings = mergeLiveSettings({}, reloaded.get());
  assert.deepEqual(settings.enabledModels, [
    "qiniu/grok-4.6",
    "openai/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);
});

test("live settings reject missing cycle references", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-luna", thinking: "medium" });
  store.updateCycleList(["missing-provider/missing-model"]);

  assert.throws(
    () => mergeLiveSettings({}, store.get()),
    /不存在的模型/
  );
});

test("live models preserve the saved thinking map without silently downgrading levels", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: [{
      id: "demo-model",
      name: "Demo Model",
      reasoning: true,
      thinkingLevelMap: { off: "none", medium: "balanced", high: "deep", xhigh: null, max: null }
    }],
    apiKey: "test-secret-value"
  });
  store.setActive({ providerId: "demo-relay", modelId: "demo-model", thinking: "high" });

  const models = mergeLiveModels({}, store.get());

  assert.match(JSON.stringify(models.providers["demo-relay"]), /"medium":"balanced"/);
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"high":"deep"/);
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"xhigh":null/);
  assert.doesNotMatch(JSON.stringify(models.providers["demo-relay"]), /"max":"high"/);
});

test("live native models retain thinking and context overrides", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  const models = mergeLiveModels({}, store.get());
  const overrides = models.providers.openai.modelOverrides["gpt-5.6-luna"];
  assert.equal(overrides.thinkingLevelMap.max, "max");
  assert.equal(overrides.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(overrides.contextWindow, 1050000);
});

test("live models include an edited context window for custom providers", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const provider = store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: [{ id: "demo-model", contextWindow: 128000 }],
    apiKey: "test-secret-value"
  });
  store.setActive({ providerId: provider.id, modelId: "demo-model", thinking: "off" });
  store.updateModelContextWindow({ providerId: provider.id, modelId: "demo-model", contextWindow: 256000 });

  const models = mergeLiveModels({}, store.get());
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"contextWindow":256000/);
});
