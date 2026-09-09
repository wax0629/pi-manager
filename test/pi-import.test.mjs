import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyPiApiKey,
  previewPiProviderImport,
  readPiModelsConfig
} from "../src/pi-import.mjs";
import { createStore } from "../src/store.mjs";

process.env.PI_MANAGER_DISABLE_KEYCHAIN = "1";

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-import-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    projectRoot: root,
    dataDir: path.join(root, "manager-data"),
    agentDir: path.join(root, "pi-agent")
  };
}

function writeModels(agentDir, providers) {
  fs.mkdirSync(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  fs.writeFileSync(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`);
  return modelsPath;
}

test("classifies env, literal and command API key references", () => {
  assert.deepEqual(classifyPiApiKey("$QINIU_API_KEY"), { kind: "env", env: "QINIU_API_KEY", hasLiteral: false });
  assert.deepEqual(classifyPiApiKey("${API_KEY}"), { kind: "env", env: "API_KEY", hasLiteral: false });
  assert.equal(classifyPiApiKey("sk-antigravity-secret").kind, "literal");
  assert.equal(classifyPiApiKey("!security find-generic-password -ws x").kind, "command");
  assert.equal(classifyPiApiKey("").kind, "missing");
});

test("preview lists openai-compatible providers and skips native overrides", (t) => {
  const fixture = makeFixture(t);
  writeModels(fixture.agentDir, {
    qiniu: {
      name: "Qiniu Cloud (七牛云)",
      baseUrl: "https://llmapi.qiniu.io/v1",
      api: "openai-completions",
      apiKey: "$QINIU_API_KEY",
      models: [{ id: "grok-4.6", name: "Grok 4.6", reasoning: true, contextWindow: 500000 }]
    },
    antigravity: {
      name: "Google Antigravity",
      baseUrl: "http://127.0.0.1:8045/v1",
      api: "openai-completions",
      apiKey: "sk-from-pi",
      models: [{ id: "gemini-3.8-flash-tiered", reasoning: true }]
    },
    "openai-codex": {
      modelOverrides: { "gpt-5.6-luna": { contextWindow: 1050000 } }
    }
  });
  const modelsConfig = readPiModelsConfig(fixture.agentDir);
  const preview = previewPiProviderImport({
    modelsConfig,
    existingProviders: [{ id: "qiniu", name: "七牛云", kind: "openai-api" }]
  });

  assert.equal(preview.candidates.length, 2);
  assert.equal(preview.candidates.find((item) => item.id === "qiniu").conflict, true);
  assert.equal(preview.candidates.find((item) => item.id === "antigravity").credentialKind, "literal");
  assert.equal(preview.skipped.some((item) => item.id === "openai-codex"), true);
});

test("import copies openai-compatible catalogs without writing secrets into state.json", (t) => {
  const fixture = makeFixture(t);
  const modelsPath = writeModels(fixture.agentDir, {
    "company-relay": {
      name: "Company Relay",
      baseUrl: "https://relay.example.test/v1/",
      api: "openai-completions",
      apiKey: "sk-imported-secret",
      models: [{
        id: "relay-model",
        name: "Relay Model",
        reasoning: true,
        thinkingLevelMap: { off: "none", high: "high" },
        contextWindow: 256000
      }]
    },
    antigravity: {
      name: "Google Antigravity",
      baseUrl: "http://127.0.0.1:8045/v1",
      api: "openai-completions",
      apiKey: "$API_KEY",
      models: [{ id: "gemini-3.8-flash-tiered", reasoning: true, contextWindow: 1000000 }]
    }
  });
  const original = fs.readFileSync(modelsPath, "utf8");
  const store = createStore({ projectRoot: fixture.projectRoot, dataDir: fixture.dataDir });
  const modelsConfig = readPiModelsConfig(fixture.agentDir);

  assert.throws(
    () => store.importPiProviders({ modelsConfig, overwrite: false }),
    /已存在/
  );

  const result = store.importPiProviders({ modelsConfig, overwrite: true });
  assert.equal(result.imported.includes("company-relay"), true);
  assert.equal(result.imported.includes("antigravity"), true);

  const imported = store.provider("company-relay");
  assert.equal(imported.baseUrl, "https://relay.example.test/v1");
  assert.equal(imported.models[0].thinkingLevelMap.high, "high");
  assert.equal(imported.models[0].contextWindow, 256000);
  assert.equal(store.credential(imported), "sk-imported-secret");
  assert.equal(fs.readFileSync(store.statePath, "utf8").includes("sk-imported-secret"), false);
  assert.equal(store.provider("antigravity").credentialEnv, "API_KEY");
  assert.equal(fs.readFileSync(modelsPath, "utf8"), original);
});
