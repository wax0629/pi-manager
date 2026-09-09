import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyLivePiConfig,
  mergeLiveAuth,
  mergeLiveModels,
  mergeLiveSettings,
  parsePiListModels,
  restoreLivePiBackup
} from "../src/pi-apply.mjs";
import { createStore } from "../src/store.mjs";
import { seedStoreProviders } from "../src/defaults.mjs";

process.env.PI_MANAGER_DISABLE_KEYCHAIN = "1";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apply-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    projectRoot: root,
    dataDir: path.join(root, "manager-data"),
    agentDir: path.join(root, "pi-agent"),
    backupRoot: path.join(root, "manager-data", "backups")
  };
}

test("parsePiListModels extracts provider/model refs and skips the header", () => {
  const refs = parsePiListModels(`provider     model                    context
qiniu        grok-4.6                 500K
antigravity  gemini-3.8-flash-tiered  1M
`);
  assert.deepEqual(refs, ["qiniu/grok-4.6", "antigravity/gemini-3.8-flash-tiered"]);
});

test("live import merges settings and models while preserving unrelated fields", (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.agentDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), `${JSON.stringify({
    theme: "light",
    packages: ["npm:pi-web-access"],
    defaultProvider: "google",
    defaultModel: "gemini-3.8-flash"
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture.agentDir, "models.json"), `${JSON.stringify({
    providers: {
      keepme: {
        baseUrl: "https://keep.example.test/v1",
        api: "openai-completions",
        models: [{ id: "keep-model" }]
      }
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture.agentDir, "auth.json"), `${JSON.stringify({
    google: { type: "oauth", refresh: "keep-refresh", access: "keep-access", expires: 1 }
  }, null, 2)}\n`);

  const store = createStore({ projectRoot: fixture.projectRoot, dataDir: fixture.dataDir });
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.setCredential("qiniu", "qiniu-live-secret");
  store.addProvider({
    id: "company-relay",
    name: "Company Relay",
    baseUrl: "https://relay.example.test/v1",
    models: [{ id: "relay-model", reasoning: true, thinkingLevelMap: { high: "deep" }, contextWindow: 256000 }],
    apiKey: "relay-secret"
  });
  store.updateCycleList(["qiniu/grok-4.6", "company-relay/relay-model"]);
  store.setActive({ providerId: "qiniu", modelId: "grok-4.6", thinking: "high" });

  const result = applyLivePiConfig({
    agentDir: fixture.agentDir,
    backupRoot: fixture.backupRoot,
    state: store.get(),
    credentials: {
      qiniu: "qiniu-live-secret",
      "company-relay": "relay-secret"
    },
    listModels: () => "provider model\nqiniu grok-4.6 500K\ncompany-relay relay-model 256K\n"
  });

  const settings = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8"));
  const models = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "models.json"), "utf8"));
  const auth = JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "auth.json"), "utf8"));

  assert.equal(settings.theme, "light");
  assert.deepEqual(settings.packages, ["npm:pi-web-access"]);
  assert.equal(settings.defaultProvider, "qiniu");
  assert.equal(settings.defaultModel, "grok-4.6");
  assert.deepEqual(settings.enabledModels, ["qiniu/grok-4.6", "company-relay/relay-model"]);
  assert.equal(models.providers.keepme.models[0].id, "keep-model");
  assert.equal(models.providers["company-relay"].models[0].contextWindow, 256000);
  assert.equal(models.providers["company-relay"].models[0].thinkingLevelMap.high, "deep");
  assert.equal(models.providers.qiniu.apiKey, "$QINIU_API_KEY");
  assert.equal(auth.google.type, "oauth");
  assert.equal(auth.qiniu.type, "api_key");
  assert.equal(auth.qiniu.key, "qiniu-live-secret");
  assert.equal(fs.existsSync(path.join(result.backupDir, "settings.json")), true);
  assert.equal(result.verify.ok, true);
});

test("live rollback restores the previous agent files", (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.agentDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.agentDir, "settings.json"), `${JSON.stringify({ defaultProvider: "google" }, null, 2)}\n`);
  const store = createStore({ projectRoot: fixture.projectRoot, dataDir: fixture.dataDir });
  seedStoreProviders(store, { projectRoot: fixture.projectRoot });
  store.setCredential("qiniu", "qiniu-live-secret");
  store.setActive({ providerId: "qiniu", modelId: "grok-4.6", thinking: "medium" });

  const applied = applyLivePiConfig({
    agentDir: fixture.agentDir,
    backupRoot: fixture.backupRoot,
    state: store.get(),
    credentials: { qiniu: "qiniu-live-secret" },
    listModels: () => "provider model\nqiniu grok-4.6 500K\n"
  });

  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8")).defaultProvider, "qiniu");
  restoreLivePiBackup({ agentDir: fixture.agentDir, backupDir: applied.backupDir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "settings.json"), "utf8")).defaultProvider, "google");
});

test("merge helpers refuse to overwrite oauth credentials", () => {
  const auth = mergeLiveAuth(
    { "openai-codex": { type: "oauth", refresh: "keep" } },
    { providers: [{ id: "openai-codex", kind: "native-subscription" }, { id: "qiniu", kind: "openai-api" }] },
    { "openai-codex": "should-not-write", qiniu: "qiniu-secret" }
  );
  assert.equal(auth["openai-codex"].type, "oauth");
  assert.equal(auth.qiniu.key, "qiniu-secret");
  const settings = mergeLiveSettings({ theme: "dark" }, {
    active: { providerId: "qiniu", modelId: "grok-4.6", thinking: "high" },
    cycle: { modelRefs: ["qiniu/grok-4.6"] },
    providers: [{ id: "qiniu", kind: "openai-api", models: [{ id: "grok-4.6" }] }]
  });
  assert.equal(settings.theme, "dark");
  const models = mergeLiveModels({ providers: { other: { baseUrl: "https://x.test" } } }, {
    providers: [{
      id: "qiniu",
      name: "七牛云",
      kind: "openai-api",
      baseUrl: "https://llmapi.qiniu.io/v1",
      credentialEnv: "QINIU_API_KEY",
      models: [{ id: "grok-4.6", name: "Grok 4.6", reasoning: true, contextWindow: 500000, input: ["text"] }]
    }]
  });
  assert.equal(models.providers.other.baseUrl, "https://x.test");
  assert.equal(models.providers.qiniu.apiKey, "$QINIU_API_KEY");
});
