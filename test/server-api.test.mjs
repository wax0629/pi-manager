import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A small installed SDK fixture exercises the real package loader and HTTP API.
function installPiFixture(root) {
  const packageDir = path.join(root, "pi-package");
  const executable = path.join(packageDir, "dist/bundle/cli.js");
  const aiDir = path.join(packageDir, "node_modules/@earendil-works/pi-ai");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(aiDir, "package.json"), JSON.stringify({ type: "module", exports: { "./providers/all": "./all.js" } }));
  fs.writeFileSync(path.join(aiDir, "all.js"), `
    export function builtinProviders() {
      return [{ id: "new-native", name: "New native", auth: { apiKey: { name: "Native access keys", login() {} } } }];
    }
  `);
  fs.writeFileSync(path.join(packageDir, "dist/index.js"), `
    import fs from "node:fs";
    import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
    let models = [{ id: "old-model", name: "Old model", reasoning: true, thinkingLevelMap: { high: "high" } }];
    export class ModelRuntime {
      static async create({ authPath, modelsPath }) {
        if (modelsPath === null) return { getProviders: builtinProviders };
        const providers = [...builtinProviders(), { id: "custom-relay", name: "Custom relay", auth: { apiKey: { login() {} } } }];
        const credentials = () => fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : {};
        return {
          getProviders: () => providers,
          getProvider: (id) => providers.find(p => p.id === id),
          getRegisteredNativeProvider: () => undefined,
          getModels: () => models,
          getProviderAuthStatus: (id) => ({ configured: Boolean(credentials()[id]), source: "stored", label: "API key" }),
          listCredentials: async () => Object.keys(credentials()).map(providerId => ({ providerId, type: "api_key" })),
          async login(id, type, interaction) {
            if (type !== "api_key") throw new Error("unsupported method");
            const mode = await interaction.prompt({ type: "select", message: "Mode", options: [{ id: "keys", label: "Access keys" }, { id: "profile", label: "Profile" }] });
            const region = await interaction.prompt({ type: "text", message: "Region (optional)" });
            const key = await interaction.prompt({ type: "secret", message: "Access key" });
            const token = await interaction.prompt({ type: "secret", message: "Session token" });
            if (mode !== "keys" || region !== "" || key !== "integration-key" || token !== "integration-token") throw new Error("wrong answers");
            fs.writeFileSync(authPath, JSON.stringify({ ...credentials(), [id]: { type, key, env: { SESSION_TOKEN: token } } }));
          },
          async logout(id) {
            const next = credentials(); delete next[id];
            fs.writeFileSync(authPath, JSON.stringify(next));
          },
          async refresh({ providers: ids, force }) {
            if (ids.includes("custom-relay")) throw new Error("custom provider refreshed as native");
            if (force) models = [...models.filter(m => m.id !== "new-model"), { id: "new-model", reasoning: true, thinkingLevelMap: { high: "high" } }];
            return { aborted: false, errors: new Map() };
          }
        };
      }
    }
  `);
  fs.writeFileSync(executable, `#!/usr/bin/env node
    if (process.argv.includes("--version")) console.log("Pi fixture 1.0");
    else if (process.argv.includes("--list-models")) console.log("provider model context\\nnew-native new-model 128K\\n");
    else console.log(JSON.stringify({ status: "ready", authType: "api_key" }));
  `, { mode: 0o700 });
  return executable;
}

test("HTTP APIs preserve live import and follow the installed native auth registry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-server-api-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const originalSettings = '{"theme":"light"}\n';
  fs.writeFileSync(path.join(agentDir, "settings.json"), originalSettings);
  const env = { PI_MANAGER_HOME: path.join(root, "manager"), PI_CODING_AGENT_DIR: agentDir,
    PI_EXECUTABLE: installPiFixture(root), PI_MANAGER_DISABLE_KEYCHAIN: "1" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const { startManagerServer, store, gateway } = await import("../src/server.mjs");
  const server = await startManagerServer({ port: 0 });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await gateway.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, method = "GET", body) {
    const response = await fetch(`${base}${url}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  }

  await t.test("removed profile APIs return 404 and project changes create no isolated files", async () => {
    const before = store.snapshot();
    for (const route of ["/api/apply", "/api/pi/launch", "/api/pi/stop", "/api/profile/rollback"]) {
      const response = await fetch(`${base}${route}`, { method: "POST" });
      assert.equal(response.status, 404, route);
    }
    assert.deepEqual(store.snapshot(), before);
    const updated = await request("/api/project", "POST", { targetProject: root });
    assert.equal(updated.state.targetProject, root);
    assert.equal("profile" in updated, false);
    assert.equal(fs.existsSync(path.join(store.dataDir, "profiles/active")), false);
    assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), originalSettings);
  });

  await t.test("native login, prompt IDs, catalog refresh and logout work over HTTP", async () => {
    const available = await request("/api/pi/native-providers");
    assert.deepEqual(available.providers.map(p => p.id), ["new-native"]);
    assert.deepEqual(available.providers[0].authMethods, ["api_key"]);
    const started = await request("/api/pi/login", "POST", { providerId: "new-native" });
    const loginId = started.login.loginId;
    async function wait(status) {
      for (let i = 0; i < 20; i++) {
        const current = await request(`/api/pi/login/${loginId}`);
        assert.doesNotMatch(JSON.stringify(current), /integration-key|integration-token/);
        if (current.login.status === status) return current;
      }
      assert.fail(`login did not reach ${status}`);
    }
    for (const [expectedType, value] of [["select", "keys"], ["text", ""], ["secret", "integration-key"], ["secret", "integration-token"]]) {
      const current = await wait("need_prompt");
      assert.equal(current.login.prompt.type, expectedType);
      await request(`/api/pi/login/${loginId}/prompt`, "POST", { value, promptId: current.login.prompt.id });
    }
    const completed = await wait("completed");
    assert.equal(completed.state.providers[0].id, "new-native");
    assert.equal(completed.state.providers[0].status, "ready");
    const refreshed = await request("/api/state?refresh=1");
    assert.equal(refreshed.providers[0].models.some(m => m.id === "new-model"), true);
    assert.equal(JSON.parse(fs.readFileSync(store.statePath, "utf8")).providers[0].models.some(m => m.id === "new-model"), true);
    await request("/api/route", "POST", { providerId: "new-native", modelId: "new-model", thinking: "high" });
    await request("/api/models/cycle", "PATCH", { modelRefs: ["new-native/new-model"] });
  });

  await t.test("live import and rollback remain available without an isolated profile", async () => {
    const imported = await request("/api/pi/live-import", "POST");
    assert.equal(imported.result.verify.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).enabledModels, ["new-native/new-model"]);
    assert.equal(fs.existsSync(path.join(store.dataDir, "profiles/active")), false);
    await request("/api/pi/live-rollback", "POST");
    assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), originalSettings);
    const loggedOut = await request("/api/pi/logout", "POST", { providerId: "new-native" });
    assert.deepEqual(loggedOut.state.providers, []);
  });
});
