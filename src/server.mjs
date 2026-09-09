import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./gateway.mjs";
import { createPiAuthProbe } from "./pi-auth.mjs";
import { applyLivePiConfig, restoreLivePiBackup } from "./pi-apply.mjs";
import { readPiModelsConfig, resolvePiAgentDir } from "./pi-import.mjs";
import { createNativeAuth } from "./pi-native.mjs";
import { sanitizeConnectionTestUrl, testProviderConnection } from "./provider-test.mjs";
import { writePiProfile } from "./profile.mjs";
import { createStore } from "./store.mjs";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(managerRoot, "..");
const bundledWebDir = path.join(managerRoot, "web", "dist");
const legacyPublicDir = path.join(managerRoot, "public");
const publicDir = process.env.PI_MANAGER_PUBLIC_DIR
  ? path.resolve(process.env.PI_MANAGER_PUBLIC_DIR)
  : fs.existsSync(legacyPublicDir) ? legacyPublicDir : bundledWebDir;
const dataDir = process.env.PI_MANAGER_HOME || path.join(os.homedir(), ".pi-manager");
const uiHost = process.env.PI_MANAGER_HOST || "127.0.0.1";
const uiPort = Number(process.env.PI_MANAGER_PORT || 8670);

function resolvePiExecutable() {
  if (process.env.PI_EXECUTABLE) return process.env.PI_EXECUTABLE;
  try {
    return execFileSync("which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "pi";
  } catch {
    return "pi";
  }
}

const piExecutable = resolvePiExecutable();
const piAuthProbe = createPiAuthProbe({ executable: piExecutable });
const store = createStore({ projectRoot, dataDir });
const nativeAuth = createNativeAuth({
  executable: piExecutable,
  agentDir: resolvePiAgentDir(),
  openUrl: async (url) => {
    if (process.platform === "darwin") {
      await new Promise((resolve, reject) => execFile("open", [url], (error) => error ? reject(error) : resolve()));
    }
  }
});
let piInfo = null;
let bridgeInfoCache = new Map();
let gatewayLastEvent = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveCycleEntries(current, providers) {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const refs = Array.isArray(current.cycle?.modelRefs) ? current.cycle.modelRefs : [];

  return refs.map((ref, index) => {
    const normalizedRef = String(ref || "").trim();
    const slashIndex = normalizedRef.indexOf("/");
    const providerId = slashIndex > 0 ? normalizedRef.slice(0, slashIndex) : "";
    const modelId = slashIndex > 0 ? normalizedRef.slice(slashIndex + 1) : "";
    const provider = providersById.get(providerId);
    const model = provider?.models.find((item) => item.id === modelId);
    const valid = Boolean(provider && model && provider.status === "ready");
    return {
      index,
      ref: normalizedRef,
      providerId,
      providerName: provider?.name || providerId,
      providerStatus: provider?.status || "missing",
      modelId,
      modelName: model?.name || modelId,
      valid,
      reason: !provider ? "provider-missing" : !model ? "model-missing" : provider.status !== "ready" ? "provider-unready" : "ok"
    };
  });
}

async function ensureCycleListReady() {
  const snapshot = await publicState();
  const invalid = snapshot.cycle.entries.filter((entry) => !entry.valid);
  if (invalid.length > 0) {
    throw new Error(`循环列表包含不可用模型: ${invalid.map((entry) => entry.ref).join(" / ")}`);
  }
}

function collectProviderCredentials() {
  const credentials = {};
  for (const provider of store.get().providers) {
    const secret = store.credential(provider);
    if (String(secret || "").trim()) {
      credentials[provider.id] = secret;
    }
  }
  return credentials;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function sendError(res, error, status = 400) {
  sendJson(res, status, { error: errorMessage(error) });
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function safeStaticPath(requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0]);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(publicDir, relative);
  return target.startsWith(`${publicDir}${path.sep}`) ? target : null;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

async function bridgeStatus(provider) {
  const cacheKey = provider.id;
  const previous = bridgeInfoCache.get(cacheKey);
  if (previous && Date.now() - previous.checkedAt < 4000) return previous;
  let running = false;
  try {
    const base = new URL(provider.baseUrl);
    base.pathname = base.pathname.replace(/\/v1\/?$/, "") || "/";
    base.search = "";
    const response = await fetch(new URL("health", base), { signal: AbortSignal.timeout(1500) });
    running = response.ok;
  } catch {
    running = false;
  }
  const result = { running, checkedAt: Date.now() };
  bridgeInfoCache.set(cacheKey, result);
  return result;
}

function detectPi(providerId = "openai-codex", { force = false } = {}) {
  if (!piInfo) {
    const detected = { installed: false, path: piExecutable, version: "" };
    try {
      detected.version = execFileSync(piExecutable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      detected.installed = true;
    } catch {
      // A missing Pi executable is represented as an unavailable environment.
    }
    piInfo = detected;
  }

  if (!piInfo.installed) {
    return { ...piInfo, subscriptionReady: false, authStatus: "unavailable", authType: "", authReason: "check_failed" };
  }

  const auth = piAuthProbe.check(providerId, { force });
  return {
    ...piInfo,
    subscriptionReady: auth.ready,
    authStatus: auth.status,
    authType: auth.authType,
    authReason: auth.reason
  };
}

function nativeAuthDetail(pi) {
  if (!pi?.installed) return "未检测到 Pi 可执行文件";
  if (pi.subscriptionReady) return pi.authType ? `Pi 原生认证已就绪（${pi.authType}）` : "Pi 原生认证已就绪";
  if (pi.authReason === "credentials_not_configured" || pi.authReason === "auth_required") return "尚未完成 Pi 原生授权";
  if (pi.authReason === "expired") return "Pi 原生认证已过期";
  if (pi.authReason === "check_failed" || pi.authReason === "invalid_response") return "无法读取 Pi 原生认证状态";
  return "Pi 原生认证未就绪";
}

async function providerPublicState(provider, { forceAuth = false, nativeSummary = null } = {}) {
  const credentialConfigured = provider.kind === "native-subscription"
    ? Boolean(nativeSummary?.credentialConfigured || detectPi(provider.piProvider || provider.id, { force: forceAuth }).subscriptionReady)
    : store.credentialConfigured(provider);
  const piNative = provider.kind === "native-subscription" ? detectPi(provider.piProvider || provider.id, { force: forceAuth }) : null;
  let status = provider.kind === "native-subscription"
    ? (credentialConfigured ? "ready" : "not-configured")
    : (credentialConfigured ? "ready" : "not-configured");
  let detail = provider.kind === "native-subscription"
    ? (nativeSummary?.authLabel || nativeAuthDetail(piNative))
    : "凭据未写入 Manager";
  if (provider.kind === "local-bridge") {
    const bridge = await bridgeStatus(provider);
    if (!bridge.running) {
      status = "offline";
      detail = "本地桥接未运行";
    } else if (!credentialConfigured) {
      status = "not-configured";
      detail = "桥接已运行，待配置访问密钥";
    } else {
      detail = "桥接在线，使用本地订阅";
    }
  } else if (provider.kind === "openai-api" && credentialConfigured) {
    detail = "API 凭据已配置";
  }
  return {
    ...provider,
    baseUrl: provider.baseUrl ? sanitizeConnectionTestUrl(provider.baseUrl) : undefined,
    credentialEnv: provider.credentialEnv || undefined,
    credentialConfigured,
    status,
    detail,
    models: provider.models.map((model) => ({ ...model }))
  };
}

async function mergeNativeProviders(providers, { forceAuth = false } = {}) {
  let nativeSummaries = [];
  try {
    nativeSummaries = await nativeAuth.listNativeProviders();
  } catch {
    return providers;
  }
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const merged = await Promise.all(providers.map((provider) => {
    const summary = nativeSummaries.find((item) => item.id === provider.id);
    if (!summary || provider.kind !== "native-subscription") return provider;
    return {
      ...provider,
      credentialConfigured: summary.credentialConfigured,
      status: summary.credentialConfigured ? "ready" : provider.status,
      detail: summary.authLabel || provider.detail,
      authMethods: summary.authMethods
    };
  }));
  for (const summary of nativeSummaries) {
    if (byId.has(summary.id)) continue;
    merged.push({
      ...summary,
      credentialConfigured: summary.credentialConfigured,
      status: summary.credentialConfigured ? "ready" : "not-configured",
      detail: summary.authLabel || (summary.credentialConfigured ? "Pi 原生认证已就绪" : "尚未完成 Pi 原生授权")
    });
  }
  return merged;
}

async function publicState({ forceAuth = false } = {}) {
  const current = store.get();
  const providers = await mergeNativeProviders(
    await Promise.all(current.providers.map((provider) => providerPublicState(provider, { forceAuth }))),
    { forceAuth }
  );
  const activeProvider = providers.find((provider) => provider.id === current.active.providerId);
  const activeModel = activeProvider?.models.find((model) => model.id === current.active.modelId);
  const gatewayStats = gateway.getStats();
  return {
    app: { name: "Pi Manager", version: "0.1.0", platform: process.platform },
    targetProject: current.targetProject,
    cycle: {
      modelRefs: Array.isArray(current.cycle?.modelRefs) ? current.cycle.modelRefs : [],
      entries: resolveCycleEntries(current, providers)
    },
    active: {
      ...current.active,
      providerName: activeProvider?.name || current.active.providerId,
      modelName: activeModel?.name || current.active.modelId,
      model: activeModel || null,
      providerKind: activeProvider?.kind || ""
    },
    providers,
    gateway: {
      enabled: current.gateway.enabled,
      host: current.gateway.host,
      port: current.gateway.port,
      running: gateway.isRunning(),
      stats: gatewayStats,
      lastEvent: gatewayLastEvent
    },
    configuration: {
      revision: current.runtime.configRevision,
      appliedRevision: current.runtime.appliedRevision,
      dirty: current.runtime.configRevision !== current.runtime.appliedRevision
    },
    runtime: { ...current.runtime, gatewayStats, piExecutable },
    pi: detectPi(),
    storage: { dataDir: store.dataDir, statePath: store.statePath },
    events: current.runtime.events || []
  };
}

async function applyLivePi() {
  await ensureCycleListReady();
  const result = applyLivePiConfig({
    agentDir: resolvePiAgentDir(),
    backupRoot: path.join(store.dataDir, "backups"),
    state: store.get(),
    credentials: collectProviderCredentials(),
    piExecutable
  });
  store.update((state) => {
    state.runtime.lastLiveImportAt = new Date().toISOString();
    state.runtime.lastLiveBackupDir = result.backupDir;
    state.runtime.lastLiveVerify = {
      ok: Boolean(result.verify?.ok),
      error: result.verify?.error || "",
      refs: Array.isArray(result.verify?.refs) ? result.verify.refs : []
    };
    state.runtime.lastError = result.verify?.ok ? null : (result.verify?.error || null);
  });
  store.recordEvent("pi", "已导入本机 Pi 配置", result.agentDir);
  return result;
}

function rollbackLivePi() {
  const backupDir = store.get().runtime.lastLiveBackupDir;
  const result = restoreLivePiBackup({
    agentDir: resolvePiAgentDir(),
    backupDir
  });
  store.update((state) => {
    state.runtime.lastLiveImportAt = null;
    state.runtime.lastError = null;
  });
  store.recordEvent("pi", "已回滚本机 Pi 配置", result.backupDir);
  return result;
}

function applyProfile() {
  const appliedSnapshot = store.snapshotConfiguration();
  const profile = writePiProfile({
    dataDir: store.dataDir,
    state: store.get(),
    piExecutable,
    credentials: collectProviderCredentials()
  });
  store.update((state) => {
    state.runtime.profilePath = profile.runtimeDir;
    state.runtime.extensionPath = profile.extensionPath;
    state.runtime.appliedRevision = state.runtime.configRevision;
    state.runtime.appliedSnapshot = appliedSnapshot;
    state.runtime.lastAppliedAt = new Date().toISOString();
    state.runtime.lastError = null;
  });
  store.recordEvent("profile", "已生成 Pi 受控 profile", profile.runtimeDir);
  return profile;
}

function validateTargetProject(targetProject) {
  if (!targetProject || typeof targetProject !== "string") throw new Error("项目目录不能为空");
  const resolved = path.resolve(targetProject);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("项目目录不存在");
  return resolved;
}

async function startGateway() {
  store.update((state) => { state.gateway.enabled = true; state.runtime.lastError = null; });
  try {
    await gateway.start();
    store.recordEvent("gateway", `本地网关已启动 :${store.get().gateway.port}`, "");
  } catch (error) {
    store.update((state) => { state.runtime.lastError = `网关启动失败: ${errorMessage(error)}`; });
    throw error;
  }
}

async function stopGateway() {
  await gateway.stop();
  store.update((state) => { state.gateway.enabled = false; });
  store.recordEvent("gateway", "本地网关已停止", "");
}

async function launchPi() {
  await ensureCycleListReady();
  const profile = applyProfile();
  const child = await import("node:child_process").then(({ spawn }) => spawn(profile.launcherPath, [], {
    cwd: store.get().targetProject,
    detached: true,
    stdio: "ignore"
  }));
  child.unref();
  store.update((state) => {
    state.runtime.lastLaunchAt = new Date().toISOString();
    state.runtime.lastLaunchPid = child.pid || null;
    state.runtime.lastStopAt = null;
  });
  store.recordEvent("pi", "已启动 Pi", profile.launcherPath);
  return profile;
}

async function stopPi() {
  const pid = store.get().runtime.lastLaunchPid;
  if (!pid) throw new Error("没有可停止的 Pi 进程");
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ESRCH") {
      throw error;
    }
  }
  store.update((state) => {
    state.runtime.lastLaunchPid = null;
    state.runtime.lastStopAt = new Date().toISOString();
    state.runtime.lastError = null;
  });
  store.recordEvent("pi", "已停止 Pi", String(pid));
}

function rollbackProfile() {
  store.restoreAppliedConfiguration();
  const profile = applyProfile();
  store.recordEvent("profile", "已回滚到上次成功应用的配置", profile.runtimeDir);
  return profile;
}

async function openBridge() {
  const provider = store.provider("antigravity");
  const url = provider?.baseUrl ? new URL(provider.baseUrl).origin : "http://127.0.0.1:8045";
  if (process.platform === "darwin") {
    await new Promise((resolve, reject) => execFile("open", [url], (error) => error ? reject(error) : resolve()));
  }
  return { url };
}

const gateway = createGateway({
  getState: () => store.get(),
  getCredential: (provider) => store.credential(provider),
  onRequest: (event) => {
    gatewayLastEvent = { ...event, at: new Date().toISOString() };
    if (event.error) store.recordEvent("request", `${event.providerId || "渠道"} 请求失败`, event.error);
  }
});

async function handleApi(req, res, pathname, { forceAuth = false } = {}) {
  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, await publicState({ forceAuth }));
    return;
  }
  if (req.method === "GET" && pathname === "/api/events") {
    sendJson(res, 200, { events: store.get().runtime.events || [] });
    return;
  }
  if (req.method === "POST" && pathname === "/api/route") {
    const body = await parseBody(req);
    const provider = store.provider(body.providerId);
    if (!provider) throw new Error("渠道不存在");
    const model = provider.models.find((item) => item.id === body.modelId);
    if (!model) throw new Error("模型不存在");
    if (provider.kind === "native-subscription" && !detectPi(provider.piProvider || provider.id).subscriptionReady) {
      throw new Error(`渠道 ${provider.name} 尚未完成 Pi 原生授权`);
    }
    if (provider.kind !== "native-subscription" && !store.credentialConfigured(provider)) {
      throw new Error(`渠道 ${provider.name} 尚未配置凭据`);
    }
    if (provider.kind === "local-bridge" && !(await bridgeStatus(provider)).running) {
      throw new Error(`渠道 ${provider.name} 的本地桥接未运行`);
    }
    store.setActive({ providerId: body.providerId, modelId: body.modelId, thinking: body.thinking });
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "PATCH" && pathname === "/api/models/thinking") {
    const body = await parseBody(req);
    store.updateThinkingMap(body);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "PATCH" && pathname === "/api/models/context-window") {
    const body = await parseBody(req);
    store.updateModelContextWindow(body);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/apply") {
    await ensureCycleListReady();
    const profile = applyProfile();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/login") {
    const body = await parseBody(req);
    const result = await nativeAuth.login({
      providerId: body.providerId,
      type: body.type,
      apiKey: body.apiKey
    });
    if (result.status === "completed") {
      const summaries = await nativeAuth.listNativeProviders();
      const summary = summaries.find((item) => item.id === body.providerId);
      if (summary) store.upsertNativeProvider(summary);
      piAuthProbe.clear(body.providerId);
    }
    sendJson(res, 200, { ok: true, login: result, state: await publicState({ forceAuth: true }) });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/api/pi/login/")) {
    const loginId = pathname.split("/")[4];
    const result = await nativeAuth.loginStatus(loginId);
    if (result.status === "completed") {
      const summaries = await nativeAuth.listNativeProviders();
      const summary = summaries.find((item) => item.id === result.providerId);
      if (summary) store.upsertNativeProvider(summary);
      piAuthProbe.clear(result.providerId);
    }
    sendJson(res, 200, { ok: true, login: result, state: await publicState({ forceAuth: true }) });
    return;
  }
  if (req.method === "POST" && pathname.startsWith("/api/pi/login/") && pathname.endsWith("/prompt")) {
    const loginId = pathname.split("/")[4];
    const body = await parseBody(req);
    const result = nativeAuth.answerPrompt(loginId, body.value);
    sendJson(res, 200, { ok: true, login: result, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/logout") {
    const body = await parseBody(req);
    const result = await nativeAuth.logout(body.providerId);
    piAuthProbe.clear(body.providerId);
    sendJson(res, 200, { ok: true, result, state: await publicState({ forceAuth: true }) });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/live-import") {
    const result = await applyLivePi();
    sendJson(res, 200, { ok: true, result, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/live-rollback") {
    const result = rollbackLivePi();
    sendJson(res, 200, { ok: true, result, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/profile/rollback") {
    const profile = rollbackProfile();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "PATCH" && pathname === "/api/models/cycle") {
    const body = await parseBody(req);
    store.updateCycleList(body.modelRefs);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/launch") {
    const profile = await launchPi();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/stop") {
    const profile = await stopPi();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/gateway/start") {
    const body = await parseBody(req);
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口必须在 1024-65535 之间");
      if (port !== store.get().gateway.port) {
        await gateway.stop();
        store.update((state) => { state.gateway.port = port; });
        store.touchConfiguration();
      }
    }
    await startGateway();
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/gateway/stop") {
    await stopGateway();
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/bridge/open") {
    sendJson(res, 200, { ok: true, ...(await openBridge()) });
    return;
  }
  if (req.method === "POST" && pathname.startsWith("/api/providers/") && pathname.endsWith("/test")) {
    const providerId = pathname.split("/")[3];
    const provider = store.provider(providerId);
    if (!provider) throw new Error("渠道不存在");
    const result = await testProviderConnection({
      provider,
      credential: store.credential(provider),
      detectPi: (providerId) => detectPi(providerId, { force: true })
    });
    store.recordEvent("provider-test", `已测试 ${provider.name}`, `${result.category} · ${result.message}`);
    sendJson(res, 200, { ok: true, result, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/project") {
    const body = await parseBody(req);
    const targetProject = validateTargetProject(body.targetProject);
    store.update((state) => {
      state.targetProject = targetProject;
      const bridge = state.providers.find((provider) => provider.id === "antigravity");
      const defaultBridge = path.join(projectRoot, "antigravity-bridge");
      if (bridge && (!bridge.bridgePath || bridge.bridgePath === defaultBridge)) bridge.bridgePath = path.join(targetProject, "antigravity-bridge");
    });
    store.touchConfiguration();
    store.recordEvent("project", "已更新 Pi 目标项目", targetProject);
    const profile = applyProfile();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname.startsWith("/api/providers/") && pathname.endsWith("/credential")) {
    const providerId = pathname.split("/")[3];
    const body = await parseBody(req);
    store.setCredential(providerId, body.value);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/providers/") && pathname.endsWith("/credential")) {
    const providerId = pathname.split("/")[3];
    store.deleteCredential(providerId);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "GET" && pathname === "/api/pi/import") {
    const modelsConfig = readPiModelsConfig(resolvePiAgentDir());
    sendJson(res, 200, { ok: true, preview: store.previewPiImport(modelsConfig) });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/import") {
    const body = await parseBody(req);
    const modelsConfig = readPiModelsConfig(resolvePiAgentDir());
    const result = store.importPiProviders({
      modelsConfig,
      overwrite: Boolean(body.overwrite)
    });
    sendJson(res, 200, { ok: true, result, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/providers") {
    const body = await parseBody(req);
    const provider = store.addProvider(body);
    sendJson(res, 201, { ok: true, provider, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname.startsWith("/api/providers/") && pathname.endsWith("/models")) {
    const providerId = pathname.split("/")[3];
    const body = await parseBody(req);
    store.addProviderModel({ providerId, model: body.model || body });
    sendJson(res, 201, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/providers/") && pathname.includes("/models/")) {
    const parts = pathname.split("/");
    const providerId = parts[3];
    const modelId = decodeURIComponent(parts[5] || "");
    store.removeProviderModel({ providerId, modelId });
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/providers/") && !pathname.endsWith("/credential") && !pathname.endsWith("/test") && !pathname.endsWith("/models")) {
    const providerId = pathname.split("/")[3];
    const body = await parseBody(req);
    const provider = store.updateProvider(providerId, body);
    sendJson(res, 200, { ok: true, provider, state: await publicState() });
    return;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/providers/") && !pathname.endsWith("/credential") && !pathname.includes("/models/")) {
    const providerId = pathname.split("/")[3];
    store.removeProvider(providerId);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  sendJson(res, 404, { error: "API Not Found" });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${uiHost}:${uiPort}`);
  res.setHeader("access-control-allow-origin", `http://${uiHost}:${uiPort}`);
  res.setHeader("x-content-type-options", "nosniff");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url.pathname, { forceAuth: url.searchParams.get("refresh") === "1" });
    } catch (error) {
      sendError(res, error, 400);
    }
    return;
  }
  const filePath = safeStaticPath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", contentType(filePath));
  res.setHeader("cache-control", "no-store");
  fs.createReadStream(filePath).pipe(res);
}

export async function startManagerServer({ host = uiHost, port = uiPort } = {}) {
  if (store.get().gateway.enabled) {
    try {
      await gateway.start();
    } catch (error) {
      store.update((state) => { state.runtime.lastError = `网关启动失败: ${errorMessage(error)}`; });
    }
  }
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(res, error, 500));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startManagerServer().then(() => {
    console.log(`Pi Manager running at http://${uiHost}:${uiPort}`);
    console.log(`Pi gateway: http://${store.get().gateway.host}:${store.get().gateway.port}/v1`);
  }).catch((error) => {
    console.error(`Pi Manager failed to start: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

export { managerRoot, projectRoot, publicDir, store, gateway, publicState, applyProfile, detectPi };
