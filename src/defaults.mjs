import crypto from "node:crypto";
import path from "node:path";
import { buildThinkingLevelMap } from "./thinking.mjs";

function catalogModel(model) {
  return {
    ...model,
    thinkingLevelMap: buildThinkingLevelMap(model),
    thinkingMapSource: "provider-default",
    thinkingMapVerified: false
  };
}

const qiniuModels = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 5, output: 20, cacheRead: 0.5, cacheWrite: 5 }
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 4 }
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 4 }
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    family: "Grok",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    input: ["text", "image"],
    contextWindow: 500000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 }
  }
].map(catalogModel);

const antigravityModels = [
  {
    id: "gemini-3.8-flash-tiered",
    name: "Gemini 3.8 Flash Tiered",
    family: "Gemini",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    id: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro High",
    family: "Gemini",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
].map(catalogModel);

const codexModels = [
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    family: "GPT-5.6",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
].map(catalogModel);

export function createSeedProviders({ projectRoot }) {
  const bridgePath = path.join(projectRoot, "antigravity-bridge");
  return [
    {
      id: "qiniu",
      name: "七牛云",
      kind: "openai-api",
      baseUrl: "https://llmapi.qiniu.io/v1",
      credentialEnv: "QINIU_API_KEY",
      description: "OpenAI 兼容 API",
      models: qiniuModels
    },
    {
      id: "antigravity",
      name: "Google Antigravity",
      kind: "local-bridge",
      baseUrl: "http://127.0.0.1:8045/v1",
      bridgePath,
      credentialEnv: "API_KEY",
      description: "本地订阅桥接",
      models: antigravityModels
    },
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      kind: "native-subscription",
      piProvider: "openai-codex",
      description: "Pi 原生官方订阅",
      models: codexModels
    }
  ];
}

export function seedStoreProviders(store, { projectRoot } = {}) {
  const root = projectRoot || store.get().targetProject;
  store.update((state) => {
    state.providers = createSeedProviders({ projectRoot: root });
    state.active = {
      providerId: "qiniu",
      modelId: "gpt-5.6-luna",
      thinking: "medium"
    };
    state.cycle = {
      modelRefs: [
        "qiniu/gpt-5.6-luna",
        "openai-codex/gpt-5.6-luna",
        "qiniu/gpt-5.6-sol"
      ]
    };
  });
  return store;
}

export function createDefaultState({ projectRoot }) {
  return {
    version: 1,
    targetProject: projectRoot,
    active: {
      providerId: "",
      modelId: "",
      thinking: "off"
    },
    cycle: {
      modelRefs: []
    },
    gateway: {
      enabled: true,
      host: "127.0.0.1",
      port: 8675,
      clientKey: crypto.randomBytes(24).toString("base64url")
    },
    providers: [],
    runtime: {
      profilePath: "",
      extensionPath: "",
      configRevision: 1,
      appliedRevision: 0,
      appliedSnapshot: null,
      lastAppliedAt: null,
      lastLaunchAt: null,
      lastLaunchPid: null,
      lastStopAt: null,
      lastError: null,
      lastLiveImportAt: null,
      lastLiveBackupDir: "",
      lastLiveVerify: null,
      events: []
    }
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
