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

test("profile generation writes an isolated custom provider extension without the upstream key", (t) => {
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
      thinkingLevels: ["off", "low", "medium", "high"],
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 32000
    }],
    apiKey: "test-secret-value"
  });
  store.setActive({ providerId: "demo-relay", modelId: "demo-model", thinking: "high" });

  const profile = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });
  const settings = JSON.parse(fs.readFileSync(profile.settingsPath, "utf8"));
  const extension = fs.readFileSync(profile.extensionPath, "utf8");
  const launcher = fs.readFileSync(profile.launcherPath, "utf8");

  assert.equal(settings.defaultProvider, "pi-manager");
  assert.deepEqual(settings.enabledModels, [
    "qiniu/gpt-5.6-luna",
    "openai-codex/gpt-5.6-luna",
    "qiniu/gpt-5.6-sol"
  ]);
  assert.equal(extension.includes("test-secret-value"), false);
  assert.equal(extension.includes("https://relay.example.test"), false);
  assert.equal(extension.includes("http://127.0.0.1:8675/v1"), true);
  assert.equal(launcher.includes("PI_CODING_AGENT_DIR"), true);
  assert.equal(launcher.includes("--provider"), true);
  assert.equal(launcher.includes("'demo-model'"), true);
  assert.equal(launcher.includes("test-secret-value"), false);
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

  const profile = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });
  const extension = fs.readFileSync(profile.extensionPath, "utf8");

  assert.match(extension, /"medium": "balanced"/);
  assert.match(extension, /"high": "deep"/);
  assert.match(extension, /"xhigh": null/);
  assert.doesNotMatch(extension, /"max": "high"/);
});

test("native profiles write model thinking overrides to models.json", (t) => {
  const fixture = makeFixture(t);
  const store = createStore(fixture);
  store.setActive({ providerId: "openai-codex", modelId: "gpt-5.6-luna", thinking: "high" });
  const profile = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });
  const models = JSON.parse(fs.readFileSync(profile.modelsPath, "utf8"));

  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.max, "max");
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].thinkingLevelMap.xhigh, "xhigh");
  assert.equal(models.providers["openai-codex"].modelOverrides["gpt-5.6-luna"].contextWindow, 1050000);
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

  const profile = writePiProfile({ dataDir: fixture.dataDir, state: store.get(), piExecutable: "/usr/bin/pi" });
  const extension = fs.readFileSync(profile.extensionPath, "utf8");
  assert.match(extension, /"contextWindow": 256000/);
});
