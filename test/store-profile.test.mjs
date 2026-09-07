import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePiProfile } from "../src/profile.mjs";
import { createStore } from "../src/store.mjs";

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
  assert.deepEqual(settings.enabledModels, ["pi-manager/*"]);
  assert.equal(extension.includes("test-secret-value"), false);
  assert.equal(extension.includes("https://relay.example.test"), false);
  assert.equal(extension.includes("http://127.0.0.1:8675/v1"), true);
  assert.equal(launcher.includes("PI_CODING_AGENT_DIR"), true);
  assert.equal(launcher.includes("--provider"), true);
  assert.equal(launcher.includes("'demo-model'"), true);
  assert.equal(launcher.includes("test-secret-value"), false);
});
