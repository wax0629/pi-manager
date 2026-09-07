import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clone, createDefaultState } from "./defaults.mjs";
import { deleteSecret, getSecret, hasSecret, setSecret } from "./secrets.mjs";

function safeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const customProviderKinds = new Set(["openai-api"]);

function normalizeModel(item) {
  const source = typeof item === "string" ? { id: item, name: item } : item;
  if (!source || typeof source !== "object") return null;
  const id = String(source.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(source.name || id).trim() || id,
    reasoning: Boolean(source.reasoning),
    thinkingLevels: Array.isArray(source.thinkingLevels) && source.thinkingLevels.length
      ? source.thinkingLevels.map((level) => String(level))
      : ["off"],
    input: Array.isArray(source.input) && source.input.length ? source.input.map((item) => String(item)) : ["text"],
    contextWindow: Number(source.contextWindow) || 128000,
    maxTokens: Number(source.maxTokens) || 32000,
    cost: source.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    fs.chmodSync(temp, mode);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  fs.renameSync(temp, filePath);
}

function mergeProvider(defaultProvider, savedProvider) {
  return {
    ...defaultProvider,
    ...savedProvider,
    models: Array.isArray(savedProvider?.models) && savedProvider.models.length
      ? savedProvider.models
      : defaultProvider.models
  };
}

function normalizeState(defaultState, savedState) {
  if (!savedState || typeof savedState !== "object") return defaultState;
  const providersById = new Map((savedState.providers || []).map((provider) => [provider.id, provider]));
  const providers = defaultState.providers.map((provider) => mergeProvider(provider, providersById.get(provider.id)));
  for (const provider of savedState.providers || []) {
    if (!providers.some((item) => item.id === provider.id)) providers.push(provider);
  }
  const merged = {
    ...defaultState,
    ...savedState,
    active: { ...defaultState.active, ...(savedState.active || {}) },
    gateway: { ...defaultState.gateway, ...(savedState.gateway || {}) },
    providers,
    runtime: { ...defaultState.runtime, ...(savedState.runtime || {}) }
  };
  if (!merged.gateway.clientKey) merged.gateway.clientKey = crypto.randomBytes(24).toString("base64url");
  if (!Array.isArray(merged.runtime.events)) merged.runtime.events = [];
  if (!Number.isInteger(merged.runtime.configRevision) || merged.runtime.configRevision < 1) merged.runtime.configRevision = 1;
  if (!Number.isInteger(merged.runtime.appliedRevision) || merged.runtime.appliedRevision < 0) merged.runtime.appliedRevision = 0;
  return merged;
}

function defaultDataDir() {
  return process.env.PI_MANAGER_HOME || path.join(os.homedir(), ".pi-manager");
}

export function createStore({ projectRoot, dataDir = defaultDataDir() }) {
  ensureDir(dataDir);
  const statePath = path.join(dataDir, "state.json");
  const defaultState = createDefaultState({ projectRoot });
  let state;
  try {
    state = normalizeState(defaultState, JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch {
    state = normalizeState(defaultState, null);
  }
  if (!state.targetProject || !fs.existsSync(state.targetProject)) state.targetProject = projectRoot;
  writeJsonAtomic(statePath, state);

  const persist = () => writeJsonAtomic(statePath, state);

  const store = {
    dataDir,
    statePath,
    get() {
      return state;
    },
    snapshot() {
      return clone(state);
    },
    save() {
      persist();
    },
    update(mutator) {
      mutator(state);
      persist();
      return state;
    },
    provider(providerId) {
      return state.providers.find((provider) => provider.id === providerId);
    },
    credentialConfigured(provider) {
      return provider.kind === "native-subscription" || hasSecret({ dataDir, provider });
    },
    credential(provider) {
      return getSecret({ dataDir, provider });
    },
    setCredential(providerId, value) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      const result = setSecret({ dataDir, providerId, value });
      store.touchConfiguration();
      store.recordEvent("credential", `已更新 ${provider.name} 凭据`, result.storage);
      return result;
    },
    deleteCredential(providerId) {
      deleteSecret({ dataDir, providerId });
      const provider = store.provider(providerId);
      if (provider) {
        store.touchConfiguration();
        store.recordEvent("credential", `已移除 ${provider.name} 凭据`, "");
      }
    },
    touchConfiguration() {
      state.runtime.configRevision += 1;
      persist();
      return state.runtime.configRevision;
    },
    recordEvent(type, message, detail = "") {
      state.runtime.events = [
        { id: crypto.randomUUID(), at: new Date().toISOString(), type, message, detail },
        ...(state.runtime.events || [])
      ].slice(0, 60);
      persist();
    },
    setActive({ providerId, modelId, thinking }) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      const model = provider.models.find((item) => item.id === modelId);
      if (!model) throw new Error("模型不存在");
      const levels = model.thinkingLevels?.length ? model.thinkingLevels : ["off"];
      const nextThinking = thinking === undefined || thinking === null ? levels[levels.length - 1] : String(thinking);
      if (!levels.includes(nextThinking)) throw new Error(`模型 ${model.id} 不支持 Thinking: ${nextThinking}`);
      state.active = { providerId, modelId, thinking: nextThinking };
      store.touchConfiguration();
      store.recordEvent("route", `已切换到 ${provider.name} / ${model.name}`, nextThinking);
      return state.active;
    },
    addProvider({ id: requestedId, name, kind = "openai-api", baseUrl, models = [], credentialEnv = "", apiKey = "" }) {
      const normalizedName = String(name || "").trim();
      if (!normalizedName) throw new Error("渠道名称不能为空");
      if (!customProviderKinds.has(kind)) throw new Error("当前仅支持 OpenAI 兼容 API");
      let normalizedUrl;
      try {
        normalizedUrl = new URL(String(baseUrl || "").trim());
      } catch {
        throw new Error("Base URL 必须是有效的 http(s) 地址");
      }
      if (!/^https?:$/i.test(normalizedUrl.protocol)) throw new Error("Base URL 必须是有效的 http(s) 地址");
      const baseId = safeId(requestedId || normalizedName) || "provider";
      let id = baseId;
      let counter = 2;
      while (store.provider(id)) id = `${baseId}-${counter++}`;
      const normalizedModels = (Array.isArray(models) ? models : String(models).split(","))
        .map(normalizeModel)
        .filter(Boolean);
      if (!normalizedModels.length) throw new Error("至少填写一个模型 ID");
      const provider = { id, name: normalizedName, kind, baseUrl: normalizedUrl.toString().replace(/\/$/, ""), credentialEnv: String(credentialEnv || "").trim(), description: "自定义 OpenAI 兼容 API", models: normalizedModels };
      state.providers.push(provider);
      try {
        if (String(apiKey || "").trim()) setSecret({ dataDir, providerId: id, value: apiKey });
      } catch (error) {
        state.providers.pop();
        throw error;
      }
      store.touchConfiguration();
      store.recordEvent("provider", `已添加渠道 ${normalizedName}`, id);
      return provider;
    },
    removeProvider(providerId) {
      if (["qiniu", "antigravity", "openai-codex"].includes(providerId)) throw new Error("内置渠道不能删除");
      if (state.active.providerId === providerId) throw new Error("当前渠道正在使用，请先切换");
      const index = state.providers.findIndex((provider) => provider.id === providerId);
      if (index === -1) throw new Error("渠道不存在");
      const [removed] = state.providers.splice(index, 1);
      deleteSecret({ dataDir, providerId });
      store.touchConfiguration();
      store.recordEvent("provider", `已删除渠道 ${removed.name}`, providerId);
    }
  };

  return store;
}

export { safeId, writeJsonAtomic };
