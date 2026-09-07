import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./gateway.mjs";
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
const store = createStore({ projectRoot, dataDir });
let piInfo = null;
let bridgeInfoCache = new Map();
let gatewayLastEvent = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function detectPi() {
  if (piInfo) return piInfo;
  const result = { installed: false, path: piExecutable, version: "", subscriptionReady: false };
  try {
    result.version = execFileSync(piExecutable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    result.installed = true;
  } catch {
    piInfo = result;
    return result;
  }
  try {
    const raw = execFileSync(piExecutable, ["auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(raw);
    result.subscriptionReady = Boolean(parsed.authenticated || parsed.ready || parsed.ok || parsed.status === "authenticated");
  } catch {
    result.subscriptionReady = false;
  }
  piInfo = result;
  return result;
}

async function providerPublicState(provider) {
  const credentialConfigured = store.credentialConfigured(provider);
  let status = provider.kind === "native-subscription"
    ? (detectPi().subscriptionReady ? "ready" : "not-configured")
    : (credentialConfigured ? "ready" : "not-configured");
  let detail = provider.kind === "native-subscription" ? "Pi 原生认证" : "凭据未写入 Manager";
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
    credentialEnv: provider.credentialEnv || undefined,
    credentialConfigured,
    status,
    detail,
    models: provider.models.map((model) => ({ ...model }))
  };
}

async function publicState() {
  const current = store.get();
  const providers = await Promise.all(current.providers.map(providerPublicState));
  const activeProvider = providers.find((provider) => provider.id === current.active.providerId);
  const activeModel = activeProvider?.models.find((model) => model.id === current.active.modelId);
  const gatewayStats = gateway.getStats();
  return {
    app: { name: "Pi Manager", version: "0.1.0", platform: process.platform },
    targetProject: current.targetProject,
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

function applyProfile() {
  const profile = writePiProfile({ dataDir: store.dataDir, state: store.get(), piExecutable });
  store.update((state) => {
    state.runtime.profilePath = profile.runtimeDir;
    state.runtime.extensionPath = profile.extensionPath;
    state.runtime.appliedRevision = state.runtime.configRevision;
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
  const activeProvider = store.provider(store.get().active.providerId);
  if (activeProvider?.kind !== "native-subscription" && store.get().gateway.enabled && !gateway.isRunning()) await startGateway();
  const profile = applyProfile();
  if (process.platform === "darwin") {
    await new Promise((resolve, reject) => {
      execFile("open", ["-a", "Terminal", profile.launcherPath], (error) => error ? reject(error) : resolve());
    });
  } else {
    const child = await import("node:child_process").then(({ spawn }) => spawn(profile.launcherPath, [], { cwd: store.get().targetProject, detached: true, stdio: "ignore" }));
    child.unref();
  }
  store.update((state) => { state.runtime.lastLaunchAt = new Date().toISOString(); });
  store.recordEvent("pi", "已启动 Pi", profile.launcherPath);
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

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, await publicState());
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
    if (provider.kind === "native-subscription" && !detectPi().subscriptionReady) {
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
  if (req.method === "POST" && pathname === "/api/apply") {
    const provider = store.provider(store.get().active.providerId);
    if (provider?.kind !== "native-subscription" && store.get().gateway.enabled && !gateway.isRunning()) await startGateway();
    const profile = applyProfile();
    sendJson(res, 200, { ok: true, profile, state: await publicState() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/pi/launch") {
    const profile = await launchPi();
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
  if (req.method === "POST" && pathname === "/api/providers") {
    const body = await parseBody(req);
    const provider = store.addProvider(body);
    sendJson(res, 201, { ok: true, provider, state: await publicState() });
    return;
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/providers/")) {
    const providerId = pathname.split("/")[3];
    const provider = store.provider(providerId);
    if (!provider) throw new Error("渠道不存在");
    const body = await parseBody(req);
    store.update((state) => {
      const current = state.providers.find((item) => item.id === providerId);
      if (body.name) current.name = String(body.name).trim();
      if (body.baseUrl) {
        let parsed;
        try {
          parsed = new URL(String(body.baseUrl).trim());
        } catch {
          throw new Error("Base URL 必须是有效的 http(s) 地址");
        }
        if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Base URL 必须是有效的 http(s) 地址");
        current.baseUrl = parsed.toString().replace(/\/$/, "");
      }
      if (Array.isArray(body.models) && body.models.length) current.models = body.models;
    });
    store.touchConfiguration();
    store.recordEvent("provider", `已更新渠道 ${provider.name}`, providerId);
    sendJson(res, 200, { ok: true, state: await publicState() });
    return;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/providers/") && !pathname.endsWith("/credential")) {
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
      await handleApi(req, res, url.pathname);
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
