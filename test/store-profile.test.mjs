import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePiProfile } from "../src/profile.mjs";
import { createStore } from "../src/store.mjs";
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

  assert.throws(() => store.setCredential("openai-codex", "should-fail"), /原生订阅/);
  assert.throws(() => store.deleteCredential("openai-codex"), /原生订阅/);
  assert.throws(() => store.setCredential("qiniu", "   "), /凭据不能为空/);
});

test("manager-stored antigravity credentials take precedence over bridge env files", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
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

test("custom provider edits reject builtins, duplicate ids and emptying the catalog", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
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

  assert.throws(() => store.updateProvider("qiniu", { name: "Nope" }), /内置渠道不能编辑/);
  assert.throws(() => store.updateProvider("antigravity", { name: "Nope" }), /内置渠道不能编辑/);
  assert.throws(() => store.updateProvider("openai-codex", { name: "Nope" }), /内置渠道不能编辑/);
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

test("profile generation writes ready providers into models.json and keeps the launcher isolated", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  store.setCredential("qiniu", "qiniu-secret-value");
  store.addProvider({
    id: "demo-relay",
    name: "Demo Relay",
    baseUrl: "https://relay.example.test/v1",
    models: [{
      id: "demo-model",
      name: "Demo Model",
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 32000
    }],
    apiKey: "test-secret-value"
  });
  store.setActive({ providerId: "demo-relay", modelId: "demo-model", thinking: "high" });

  const profile = writePiProfile({
    dataDir: fixture.dataDir,
    state: store.get(),
    piExecutable: "/usr/bin/pi",
    credentials: {
      qiniu: "qiniu-secret-value",
      "demo-relay": "test-secret-value"
    }
  });
  const settings = JSON.parse(fs.readFileSync(profile.settingsPath, "utf8"));
  const models = JSON.parse(fs.readFileSync(profile.modelsPath, "utf8"));
  const launcher = fs.readFileSync(profile.launcherPath, "utf8");

  assert.equal(profile.mode, "models-json");
  assert.equal(profile.extensionPath, "");
  assert.equal(path.dirname(profile.settingsPath), profile.runtimeDir);
  assert.equal(fs.existsSync(path.join(profile.runtimeDir, ".pi", "settings.json")), false);
  assert.equal(settings.defaultProvider, "demo-relay");
  assert.equal(settings.defaultModel, "demo-model");
  assert.deepEqual(settings.enabledModels, [
    "qiniu/gpt-5.6-luna",
    "openai-codex/gpt-5.6-luna",
    "qiniu/gpt-5.6-sol"
  ]);
  assert.equal(models.providers["demo-relay"].baseUrl, "https://relay.example.test/v1");
  assert.equal(models.providers["demo-relay"].apiKey, "$PI_MANAGER_DEMO_RELAY_API_KEY");
  assert.equal(models.providers["qiniu"].baseUrl, "https://llmapi.qiniu.io/v1");
  assert.equal(models.providers["qiniu"].apiKey, "$PI_MANAGER_QINIU_API_KEY");
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.max, "max");
  assert.equal(launcher.includes(`export PI_CODING_AGENT_DIR='${profile.runtimeDir}'`), true);
  assert.equal(launcher.includes(`export PI_CODING_AGENT_SESSION_DIR='${path.join(profile.runtimeDir, "sessions")}'`), true);
  assert.equal(launcher.includes(`export PI_MANAGER_DEMO_RELAY_API_KEY='test-secret-value'`), true);
  assert.equal(launcher.includes(`export PI_MANAGER_QINIU_API_KEY='qiniu-secret-value'`), true);
  assert.equal(launcher.includes("PI_MANAGER_GATEWAY_KEY"), false);
  assert.equal(launcher.includes("'--provider' 'demo-relay'"), true);
  assert.equal(launcher.includes("'demo-model'"), true);
});

test("profile migration removes only known legacy Manager files", (t) => {
  const fixture = makeFixture(t);
  const legacyDir = path.join(fixture.dataDir, "profiles", "active", ".pi");
  const legacyExtensionsDir = path.join(legacyDir, "extensions");
  const sessionsDir = path.join(legacyDir, "sessions");
  fs.mkdirSync(legacyExtensionsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(legacyDir, "models.json"), "{}\n");
  fs.writeFileSync(path.join(legacyExtensionsDir, "pi-manager-provider.ts"), "old\n");
  fs.writeFileSync(path.join(sessionsDir, "keep.jsonl"), "session\n");

  const store = createStore(fixture);
  const profile = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });

  assert.equal(fs.existsSync(path.join(profile.runtimeDir, "settings.json")), true);
  assert.equal(fs.existsSync(path.join(profile.runtimeDir, ".pi", "settings.json")), false);
  assert.equal(fs.existsSync(path.join(sessionsDir, "keep.jsonl")), true);
});

test("candidate route rejects unsupported thinking levels", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
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

test("candidate route changes remain unapplied until profile application", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const before = store.snapshot();

  store.setActive({ providerId: "qiniu", modelId: "gpt-5.6-sol", thinking: "high" });

  assert.notDeepEqual(store.get().active, before.active);
  assert.equal(store.get().runtime.configRevision > before.runtime.configRevision, true);
  assert.equal(store.get().runtime.appliedRevision, before.runtime.appliedRevision);
});

test("rollback restores the last applied configuration snapshot", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
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

  store.updateCycleList([
    "qiniu/grok-4.6",
    "openai-codex/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);

  const reloaded = createStore(fixture);
  assert.deepEqual(reloaded.get().cycle.modelRefs, [
    "qiniu/grok-4.6",
    "openai-codex/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);

  const profile = writePiProfile({ dataDir: fixture.dataDir, state: reloaded.get(), piExecutable: "/usr/bin/pi" });
  const settings = JSON.parse(fs.readFileSync(profile.settingsPath, "utf8"));
  assert.deepEqual(settings.enabledModels, [
    "qiniu/grok-4.6",
    "openai-codex/gpt-5.6-luna",
    "qiniu/gpt-5.6-luna"
  ]);
});

test("profile generation rejects missing cycle references", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  store.updateCycleList(["missing-provider/missing-model"]);

  assert.throws(
    () => writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" }),
    /不存在的模型/
  );
});

test("profile writes the saved thinking map without silently downgrading levels", (t) => {
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

  const profile = writePiProfile({
    dataDir: fixture.dataDir,
    state: store.get(),
    piExecutable: "/usr/bin/pi",
    credentials: { "demo-relay": "test-secret-value" }
  });
  const models = JSON.parse(fs.readFileSync(profile.modelsPath, "utf8"));

  assert.equal(profile.extensionPath, "");
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"medium":"balanced"/);
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"high":"deep"/);
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"xhigh":null/);
  assert.doesNotMatch(JSON.stringify(models.providers["demo-relay"]), /"max":"high"/);
});

test("native profiles write model thinking overrides to models.json", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  const profile = writePiProfile({
    dataDir: fixture.dataDir,
    state: store.get(),
    piExecutable: "/usr/bin/pi"
  });
  const models = JSON.parse(fs.readFileSync(profile.modelsPath, "utf8"));
  const launcher = fs.readFileSync(profile.launcherPath, "utf8");

  store.setActive({ providerId: "openai-codex", modelId: "gpt-5.6-luna", thinking: "high" });
  const republished = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });
  const republishedModels = JSON.parse(fs.readFileSync(republished.modelsPath, "utf8"));
  const republishedLauncher = fs.readFileSync(republished.launcherPath, "utf8");

  assert.equal(profile.extensionPath, "");
  assert.equal(launcher.includes(`export PI_CODING_AGENT_DIR='${profile.runtimeDir}'`), true);
  assert.equal(launcher.includes(`export PI_CODING_AGENT_SESSION_DIR='${path.join(profile.runtimeDir, "sessions")}'`), true);
  assert.equal(launcher.includes("'--provider' 'qiniu'"), true);
  assert.equal(republished.extensionPath, "");
  assert.equal(republishedLauncher.includes(`export PI_CODING_AGENT_DIR='${republished.runtimeDir}'`), true);
  assert.equal(republishedLauncher.includes("'--provider' 'openai-codex'"), true);
  assert.equal(republishedLauncher.includes("PI_MANAGER_GATEWAY_KEY"), false);
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.max, "max");
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.xhigh, "xhigh");
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].contextWindow, 1050000);
  assert.equal(republishedModels.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.max, "max");
  assert.equal(republishedModels.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.xhigh, "xhigh");
  assert.equal(republishedModels.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].contextWindow, 1050000);
});

test("profile injects an edited context window for custom providers", (t) => {
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

  const profile = writePiProfile({
    dataDir: fixture.dataDir,
    state: store.get(),
    piExecutable: "/usr/bin/pi",
    credentials: { "demo-relay": "test-secret-value" }
  });
  const models = JSON.parse(fs.readFileSync(profile.modelsPath, "utf8"));
  assert.equal(profile.extensionPath, "");
  assert.match(JSON.stringify(models.providers["demo-relay"]), /"contextWindow":256000/);
});
