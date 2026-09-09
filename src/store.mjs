import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clone, createDefaultState } from "./defaults.mjs";
import { previewPiProviderImport, summarizePiProvider, literalApiKeyFromPiProvider } from "./pi-import.mjs";
import { deleteSecret, getSecret, hasSecret, setSecret } from "./secrets.mjs";
import {
  THINKING_MAP_SOURCES,
  assertSupportedThinkingLevel,
  getSupportedThinkingLevels,
  normalizeThinkingLevelMap,
  normalizeThinkingMapSource,
  validateThinkingLevelMap
} from "./thinking.mjs";

function safeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const customProviderKinds = new Set(["openai-api"]);
const BUILTIN_PROVIDER_IDS = new Set(["qiniu", "antigravity", "openai-codex"]);
const DEFAULT_CONTEXT_WINDOW = 128000;
const MAX_CONTEXT_WINDOW = 100000000;

function isBuiltinProviderId(providerId) {
  return BUILTIN_PROVIDER_IDS.has(String(providerId || "").trim());
}

function isEditableCustomProvider(provider) {
  return Boolean(provider) && provider.kind === "openai-api";
}

function canConfigureProviderCredential(provider) {
  return Boolean(provider) && provider.kind !== "native-subscription";
}

function assertHttpUrl(value) {
  let normalizedUrl;
  try {
    normalizedUrl = new URL(String(value || "").trim());
  } catch {
    throw new Error("Base URL 必须是有效的 http(s) 地址");
  }
  if (!/^https?:$/i.test(normalizedUrl.protocol)) throw new Error("Base URL 必须是有效的 http(s) 地址");
  return normalizedUrl.toString().replace(/\/$/, "");
}

function parseModelInputs(models) {
  if (Array.isArray(models)) return models;
  return String(models || "").split(",");
}

function mergeProviderModels(models, existingModels = []) {
  const existingById = new Map((existingModels || []).map((model) => [model.id, model]));
  const nextModels = [];
  const seen = new Set();
  for (const item of parseModelInputs(models)) {
    const incoming = typeof item === "string" ? { id: item.trim() } : item;
    const id = String(incoming?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const previous = existingById.get(id);
    const merged = normalizeModel(previous ? { ...previous, ...incoming, id } : incoming);
    if (merged) nextModels.push(merged);
  }
  return nextModels;
}

function normalizeContextWindow(value, fallback = DEFAULT_CONTEXT_WINDOW) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 && candidate <= MAX_CONTEXT_WINDOW
    ? candidate
    : fallback;
}

function assertContextWindow(value) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new Error("Context 长度必须是正整数");
  }
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_CONTEXT_WINDOW) {
    throw new Error(`Context 长度必须是 1-${MAX_CONTEXT_WINDOW} 之间的正整数`);
  }
  return candidate;
}

function normalizeModel(item) {
  const source = typeof item === "string" ? { id: item, name: item } : item;
  if (!source || typeof source !== "object") return null;
  const id = String(source.id || "").trim();
  if (!id) return null;
  const reasoning = Boolean(source.reasoning);
  const legacyThinkingLevels = Array.isArray(source.thinkingLevels)
    ? source.thinkingLevels.map((level) => String(level))
    : undefined;
  const thinkingLevelMap = normalizeThinkingLevelMap(source.thinkingLevelMap, {
    reasoning,
    thinkingLevels: legacyThinkingLevels
  });
  return {
    id,
    name: String(source.name || id).trim() || id,
    reasoning,
    thinkingLevels: getSupportedThinkingLevels({ reasoning, thinkingLevelMap }),
    thinkingLevelMap,
    thinkingMapSource: normalizeThinkingMapSource(source.thinkingMapSource),
    thinkingMapVerified: Boolean(source.thinkingMapVerified),
    input: Array.isArray(source.input) && source.input.length ? source.input.map((item) => String(item)) : ["text"],
    contextWindow: normalizeContextWindow(source.contextWindow),
    maxTokens: Number(source.maxTokens) || 32000,
    cost: source.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function normalizeCycleModelRefs(value) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  const seen = new Set();
  for (const item of value) {
    const ref = String(item || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function captureConfigurationSnapshot(state) {
  return clone({
    targetProject: state.targetProject,
    active: state.active,
    cycle: state.cycle,
    gateway: state.gateway,
    providers: state.providers
  });
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
      ? savedProvider.models.map(normalizeModel).filter(Boolean)
      : defaultProvider.models
  };
}

function normalizeState(defaultState, savedState) {
  if (!savedState || typeof savedState !== "object") return defaultState;
  const providersById = new Map((savedState.providers || []).map((provider) => [provider.id, provider]));
  const providers = defaultState.providers.map((provider) => mergeProvider(provider, providersById.get(provider.id)));
  for (const provider of savedState.providers || []) {
    if (!providers.some((item) => item.id === provider.id)) {
      providers.push({
        ...provider,
        models: Array.isArray(provider.models) ? provider.models.map(normalizeModel).filter(Boolean) : []
      });
    }
  }
  const merged = {
    ...defaultState,
    ...savedState,
    active: { ...defaultState.active, ...(savedState.active || {}) },
    cycle: Object.prototype.hasOwnProperty.call(savedState, "cycle")
      ? {
          modelRefs: Array.isArray(savedState.cycle?.modelRefs)
            ? normalizeCycleModelRefs(savedState.cycle.modelRefs)
            : [...defaultState.cycle.modelRefs]
        }
      : { ...defaultState.cycle },
    gateway: { ...defaultState.gateway, ...(savedState.gateway || {}) },
    providers,
    runtime: { ...defaultState.runtime, ...(savedState.runtime || {}) }
  };
  if (!merged.gateway.clientKey) merged.gateway.clientKey = crypto.randomBytes(24).toString("base64url");
  if (!Array.isArray(merged.runtime.events)) merged.runtime.events = [];
  if (merged.runtime.appliedSnapshot === undefined) merged.runtime.appliedSnapshot = null;
  if (!Number.isInteger(merged.runtime.configRevision) || merged.runtime.configRevision < 1) merged.runtime.configRevision = 1;
  if (!Number.isInteger(merged.runtime.appliedRevision) || merged.runtime.appliedRevision < 0) merged.runtime.appliedRevision = 0;
  if (merged.runtime.lastLiveImportAt === undefined) merged.runtime.lastLiveImportAt = null;
  if (!merged.runtime.lastLiveBackupDir) merged.runtime.lastLiveBackupDir = "";
  if (merged.runtime.lastLiveVerify === undefined) merged.runtime.lastLiveVerify = null;
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
    snapshotConfiguration() {
      return captureConfigurationSnapshot(state);
    },
    restoreConfiguration(snapshot) {
      const normalized = normalizeState(defaultState, snapshot);
      state.targetProject = normalized.targetProject;
      state.active = normalized.active;
      state.cycle = normalized.cycle;
      state.gateway = normalized.gateway;
      state.providers = normalized.providers;
      persist();
      return state;
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
      if (!canConfigureProviderCredential(provider)) throw new Error("原生订阅渠道请使用 Pi 登录，不能在此配置 API key");
      const result = setSecret({ dataDir, providerId, value });
      store.touchConfiguration();
      store.recordEvent("credential", `已更新 ${provider.name} 凭据`, result.storage);
      return result;
    },
    deleteCredential(providerId) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      if (!canConfigureProviderCredential(provider)) throw new Error("原生订阅渠道请使用 Pi 登录，不能在此配置 API key");
      deleteSecret({ dataDir, providerId });
      store.touchConfiguration();
      store.recordEvent("credential", `已移除 ${provider.name} 凭据`, "");
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
      const levels = getSupportedThinkingLevels(model);
      const nextThinking = thinking === undefined || thinking === null ? levels[levels.length - 1] : String(thinking);
      assertSupportedThinkingLevel(model, nextThinking);
      state.active = { providerId, modelId, thinking: nextThinking };
      store.touchConfiguration();
      store.recordEvent("route", `已切换到 ${provider.name} / ${model.name}`, nextThinking);
      return state.active;
    },
    updateThinkingMap({ providerId, modelId, thinkingLevelMap, source = "user", verified = false }) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      const model = provider.models.find((item) => item.id === modelId);
      if (!model) throw new Error("模型不存在");
      if (!THINKING_MAP_SOURCES.includes(source)) throw new Error(`未知 Thinking 映射来源: ${source}`);
      const normalizedMap = validateThinkingLevelMap(thinkingLevelMap, { reasoning: model.reasoning });
      const nextModel = { ...model, thinkingLevelMap: normalizedMap };
      const nextLevels = getSupportedThinkingLevels(nextModel);
      if (state.active.providerId === providerId && state.active.modelId === modelId) {
        assertSupportedThinkingLevel(nextModel, state.active.thinking);
      }
      model.thinkingLevelMap = normalizedMap;
      model.thinkingLevels = nextLevels;
      model.thinkingMapSource = source;
      model.thinkingMapVerified = Boolean(verified);
      store.touchConfiguration();
      store.recordEvent("model", `已更新 ${provider.name} / ${model.name} Thinking 映射`, source);
      return model;
    },
    addProviderModel({ providerId, model }) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      if (!isEditableCustomProvider(provider)) throw new Error("只有 OpenAI 兼容 API 渠道可以增删模型");
      const incoming = typeof model === "string" ? { id: model } : model;
      const nextModel = normalizeModel(incoming);
      if (!nextModel) throw new Error("模型 ID 不能为空");
      if (provider.models.some((item) => item.id === nextModel.id)) throw new Error("模型 ID 已存在");
      provider.models.push(nextModel);
      store.touchConfiguration();
      store.recordEvent("model", `已添加 ${provider.name} / ${nextModel.name}`, nextModel.id);
      return nextModel;
    },
    removeProviderModel({ providerId, modelId }) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      if (!isEditableCustomProvider(provider)) throw new Error("只有 OpenAI 兼容 API 渠道可以增删模型");
      const normalizedModelId = String(modelId || "").trim();
      const index = provider.models.findIndex((item) => item.id === normalizedModelId);
      if (index === -1) throw new Error("模型不存在");
      if (provider.models.length === 1) throw new Error("至少保留一个模型");
      if (state.active.providerId === providerId && state.active.modelId === normalizedModelId) {
        throw new Error("不能删除当前默认模型，请先切换默认模型");
      }
      const [removed] = provider.models.splice(index, 1);
      state.cycle.modelRefs = normalizeCycleModelRefs(
        state.cycle.modelRefs.filter((ref) => ref !== `${providerId}/${normalizedModelId}`)
      );
      store.touchConfiguration();
      store.recordEvent("model", `已删除 ${provider.name} / ${removed.name}`, normalizedModelId);
      return removed;
    },
    updateModelContextWindow({ providerId, modelId, contextWindow }) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      const model = provider.models.find((item) => item.id === modelId);
      if (!model) throw new Error("模型不存在");
      const nextContextWindow = assertContextWindow(contextWindow);
      model.contextWindow = nextContextWindow;
      store.touchConfiguration();
      store.recordEvent("model", `已更新 ${provider.name} / ${model.name} Context 长度`, String(nextContextWindow));
      return model;
    },
    updateCycleList(modelRefs) {
      const nextRefs = normalizeCycleModelRefs(modelRefs);
      state.cycle.modelRefs = nextRefs;
      store.touchConfiguration();
      store.recordEvent("model", "已更新循环列表", nextRefs.join(" / "));
      return nextRefs;
    },
    restoreAppliedConfiguration() {
      const appliedSnapshot = state.runtime.appliedSnapshot;
      if (!appliedSnapshot || typeof appliedSnapshot !== "object") {
        throw new Error("没有可回滚的已应用配置");
      }
      store.restoreConfiguration(appliedSnapshot);
      state.runtime.configRevision += 1;
      state.runtime.lastError = null;
      persist();
      return state;
    },
    addProvider({ id: requestedId, name, kind = "openai-api", baseUrl, models = [], credentialEnv = "", apiKey = "" }) {
      const normalizedName = String(name || "").trim();
      if (!normalizedName) throw new Error("渠道名称不能为空");
      if (!customProviderKinds.has(kind)) throw new Error("当前仅支持 OpenAI 兼容 API");
      const normalizedUrl = assertHttpUrl(baseUrl);
      const baseId = safeId(requestedId || normalizedName) || "provider";
      if (isBuiltinProviderId(baseId) && requestedId) throw new Error("不能占用内置渠道 ID");
      let id = baseId;
      let counter = 2;
      while (store.provider(id)) id = `${baseId}-${counter++}`;
      const normalizedModels = mergeProviderModels(models);
      if (!normalizedModels.length) throw new Error("至少填写一个模型 ID");
      const provider = {
        id,
        name: normalizedName,
        kind,
        baseUrl: normalizedUrl,
        credentialEnv: String(credentialEnv || "").trim(),
        description: "自定义 OpenAI 兼容 API",
        models: normalizedModels
      };
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
    updateProvider(providerId, {
      id: requestedId,
      name,
      baseUrl,
      models,
      apiKey
    } = {}) {
      const provider = store.provider(providerId);
      if (!provider) throw new Error("渠道不存在");
      if (!isEditableCustomProvider(provider)) throw new Error("只有 OpenAI 兼容 API 渠道可以编辑");

      const nextName = name === undefined ? provider.name : String(name || "").trim();
      if (!nextName) throw new Error("渠道名称不能为空");
      const nextBaseUrl = baseUrl === undefined ? provider.baseUrl : assertHttpUrl(baseUrl);
      const nextModels = models === undefined
        ? provider.models
        : mergeProviderModels(models, provider.models);
      if (!nextModels.length) throw new Error("至少填写一个模型 ID");

      const nextId = requestedId === undefined || requestedId === null || String(requestedId).trim() === ""
        ? provider.id
        : (safeId(requestedId) || provider.id);
      if (nextId !== provider.id) {
        if (isBuiltinProviderId(nextId)) throw new Error("不能占用内置渠道 ID");
        if (store.provider(nextId)) throw new Error("Provider ID 已存在");
      }

      const nextModelIds = new Set(nextModels.map((model) => model.id));
      if (state.active.providerId === provider.id && !nextModelIds.has(state.active.modelId)) {
        throw new Error("不能删除当前正在使用的模型，请先切换默认模型");
      }

      const previousId = provider.id;
      const previousSecret = store.credential(provider);
      provider.name = nextName;
      provider.baseUrl = nextBaseUrl;
      provider.models = nextModels;
      if (nextId !== previousId) {
        provider.id = nextId;
        if (state.active.providerId === previousId) state.active.providerId = nextId;
        state.cycle.modelRefs = state.cycle.modelRefs.map((ref) => {
          const slash = String(ref).indexOf("/");
          if (slash <= 0) return ref;
          const refProviderId = ref.slice(0, slash);
          return refProviderId === previousId ? `${nextId}${ref.slice(slash)}` : ref;
        });
        if (previousSecret) {
          setSecret({ dataDir, providerId: nextId, value: previousSecret });
          deleteSecret({ dataDir, providerId: previousId });
        }
      }
      state.cycle.modelRefs = normalizeCycleModelRefs(state.cycle.modelRefs.filter((ref) => {
        const slash = String(ref).indexOf("/");
        if (slash <= 0) return true;
        const refProviderId = ref.slice(0, slash);
        const refModelId = ref.slice(slash + 1);
        if (refProviderId !== provider.id) return true;
        return nextModelIds.has(refModelId);
      }));

      if (apiKey !== undefined) {
        const normalizedKey = String(apiKey || "").trim();
        if (normalizedKey) setSecret({ dataDir, providerId: provider.id, value: normalizedKey });
      }

      store.touchConfiguration();
      store.recordEvent("provider", `已更新渠道 ${nextName}`, provider.id);
      return provider;
    },
    removeNativeProvider(providerId) {
      const existing = store.provider(providerId);
      if (!existing || existing.kind !== "native-subscription") return false;
      state.providers = state.providers.filter((provider) => provider.id !== providerId);
      state.cycle.modelRefs = normalizeCycleModelRefs(
        state.cycle.modelRefs.filter((ref) => !String(ref).startsWith(`${providerId}/`))
      );
      if (state.active.providerId === providerId) {
        state.active = { providerId: "", modelId: "", thinking: "off" };
      }
      store.touchConfiguration();
      store.recordEvent("provider", `已移除 Pi 原生渠道 ${existing.name}`, providerId);
      return true;
    },
    removeProvider(providerId) {
      const existing = store.provider(providerId);
      if (existing?.kind === "native-subscription") throw new Error("原生订阅渠道不能从这里删除，请先退出登录");
      if (state.active.providerId === providerId) throw new Error("当前渠道正在使用，请先切换");
      const index = state.providers.findIndex((provider) => provider.id === providerId);
      if (index === -1) throw new Error("渠道不存在");
      const [removed] = state.providers.splice(index, 1);
      deleteSecret({ dataDir, providerId });
      state.cycle.modelRefs = normalizeCycleModelRefs(
        state.cycle.modelRefs.filter((ref) => !String(ref).startsWith(`${providerId}/`))
      );
      store.touchConfiguration();
      store.recordEvent("provider", `已删除渠道 ${removed.name}`, providerId);
    },
    previewPiImport(modelsConfig) {
      return previewPiProviderImport({
        modelsConfig,
        existingProviders: state.providers
      });
    },
    upsertNativeProvider(summary) {
      const existing = store.provider(summary.id);
      const models = mergeProviderModels(summary.models || [], existing?.models || []);
      if (existing) {
        if (existing.kind === "native-subscription") {
          existing.name = summary.name || existing.name;
          existing.piProvider = summary.piProvider || existing.piProvider || existing.id;
          if (models.length) existing.models = models;
        }
        return existing;
      }
      const provider = {
        id: summary.id,
        name: summary.name || summary.id,
        kind: "native-subscription",
        piProvider: summary.piProvider || summary.id,
        description: "Pi 原生渠道",
        models
      };
      state.providers.push(provider);
      store.touchConfiguration();
      store.recordEvent("provider", `已接入 Pi 原生渠道 ${provider.name}`, provider.id);
      return provider;
    },
    importPiProviders({ modelsConfig, overwrite = false, providerIds } = {}) {
      const selectedIds = Array.isArray(providerIds)
        ? [...new Set(providerIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : [];
      if (!selectedIds.length) throw new Error("请先勾选要导入的渠道");
      const preview = store.previewPiImport(modelsConfig);
      const selected = preview.candidates.filter((item) => selectedIds.includes(item.id));
      if (!selected.length) throw new Error("勾选的渠道不可导入");
      const selectedConflicts = selected.filter((item) => item.conflict);
      if (!overwrite && selectedConflicts.length > 0) {
        const ids = selectedConflicts.map((item) => item.id).join(", ");
        throw new Error(`以下渠道已存在，需确认后才能覆盖: ${ids}`);
      }
      const imported = [];
      const skipped = [...preview.skipped];
      for (const id of selectedIds) {
        if (!preview.candidates.some((item) => item.id === id)) {
          skipped.push({ id, reason: "not-selected-or-unavailable" });
        }
      }
      for (const candidate of selected) {
        const source = modelsConfig?.providers?.[candidate.id];
        if (!source) continue;
        const summary = summarizePiProvider(candidate.id, source);
        const models = mergeProviderModels(summary.models, store.provider(candidate.id)?.models || []);
        if (!models.length) {
          skipped.push({ id: candidate.id, reason: "missing-models-or-baseurl" });
          continue;
        }
        const existing = store.provider(candidate.id);
        if (existing) {
          if (existing.kind === "native-subscription") {
            skipped.push({ id: candidate.id, reason: "native-subscription" });
            continue;
          }
          existing.name = summary.name;
          existing.kind = existing.id === "antigravity" ? "local-bridge" : "openai-api";
          existing.baseUrl = summary.baseUrl;
          existing.credentialEnv = summary.credentialEnv || existing.credentialEnv || "";
          existing.description = existing.description || "从本机 Pi models.json 导入";
          existing.models = models;
        } else {
          state.providers.push({
            id: summary.id,
            name: summary.name,
            kind: summary.id === "antigravity" ? "local-bridge" : "openai-api",
            baseUrl: summary.baseUrl,
            credentialEnv: summary.credentialEnv,
            description: "从本机 Pi models.json 导入",
            models
          });
        }
        const literalKey = literalApiKeyFromPiProvider(source);
        if (literalKey) setSecret({ dataDir, providerId: summary.id, value: literalKey });
        imported.push(summary.id);
      }
      if (imported.length > 0) {
        store.touchConfiguration();
        store.recordEvent("provider", `已从本机 Pi 导入 ${imported.length} 个渠道`, imported.join(", "));
      }
      return { imported, skipped, conflicts: selectedConflicts, modelsPath: preview.modelsPath };
    }
  };

  return store;
}

export { safeId, writeJsonAtomic, isBuiltinProviderId, isEditableCustomProvider, canConfigureProviderCredential };
