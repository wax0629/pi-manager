import fs from "node:fs";
import path from "node:path";
import { safeId, writeJsonAtomic } from "./store.mjs";
import { assertSupportedThinkingLevel, getThinkingLevelValue } from "./thinking.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function removeLegacyManagerFiles(runtimeDir) {
  const legacyDir = path.join(runtimeDir, ".pi");
  const legacyFiles = [
    path.join(legacyDir, "settings.json"),
    path.join(legacyDir, "models.json"),
    path.join(legacyDir, "extensions", "pi-manager-provider.ts")
  ];
  for (const filePath of legacyFiles) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // A missing legacy file is expected for new profiles.
    }
  }
  for (const dirPath of [path.join(legacyDir, "extensions"), legacyDir]) {
    try {
      fs.rmdirSync(dirPath);
    } catch {
      // Preserve any non-Manager files left in an older profile.
    }
  }
}

function piThinkingMap(provider, model) {
  return model.thinkingLevelMap || {};
}

function providerApiKeyEnvName(providerId) {
  const normalized = safeId(providerId).replaceAll("-", "_").toUpperCase();
  return `PI_MANAGER_${normalized || "PROVIDER"}_API_KEY`;
}

function resolveModelReference(providers, ref) {
  const normalizedRef = String(ref || "").trim();
  if (!normalizedRef) return null;
  const separatorIndex = normalizedRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedRef.length - 1) return null;
  const providerId = normalizedRef.slice(0, separatorIndex);
  const modelId = normalizedRef.slice(separatorIndex + 1);
  const provider = providers.find((item) => item.id === providerId);
  const model = provider?.models.find((item) => item.id === modelId);
  if (!provider || !model) return null;
  return { provider, model };
}

function buildEnabledModels(state) {
  const cycleRefs = Array.isArray(state.cycle?.modelRefs) ? state.cycle.modelRefs : [];
  const enabledModels = [];
  const seen = new Set();
  const missing = [];

  for (const rawRef of cycleRefs) {
    const ref = String(rawRef || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (!resolveModelReference(state.providers || [], ref)) missing.push(ref);
    else enabledModels.push(ref);
  }

  if (missing.length > 0) {
    throw new Error(`循环列表包含不存在的模型: ${missing.join(" / ")}`);
  }

  return enabledModels;
}

function buildModelOverrides(provider) {
  const modelOverrides = Object.fromEntries(
    provider.models.map((item) => [item.id, {
      contextWindow: item.contextWindow,
      ...(item.reasoning && item.thinkingLevelMap && Object.keys(item.thinkingLevelMap).length > 0
        ? { thinkingLevelMap: item.thinkingLevelMap }
        : {})
    }])
  );
  return Object.keys(modelOverrides).length > 0 ? modelOverrides : null;
}

function toPiModel(provider, model) {
  return {
    id: model.id,
    name: `${model.name} (${provider.name})`,
    reasoning: Boolean(model.reasoning),
    thinkingLevelMap: model.reasoning ? piThinkingMap(provider, model) : undefined,
    input: model.input || ["text"],
    cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow || 128000,
    maxTokens: model.maxTokens || 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens"
    }
  };
}

function buildModelsJson(state, credentials = {}) {
  const providers = {};
  for (const provider of state.providers || []) {
    if (provider.kind === "native-subscription") {
      const modelOverrides = buildModelOverrides(provider);
      if (modelOverrides) {
        providers[provider.piProvider || provider.id] = { modelOverrides };
      }
      continue;
    }

    const secret = String(credentials?.[provider.id] || "").trim();
    if (!secret) continue;

    providers[provider.id] = {
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      apiKey: `$${providerApiKeyEnvName(provider.id)}`,
      models: provider.models.map((item) => toPiModel(provider, item))
    };
  }
  return Object.keys(providers).length > 0 ? { providers } : null;
}

function buildCredentialExports(state, credentials) {
  return (state.providers || [])
    .filter((provider) => provider.kind !== "native-subscription")
    .flatMap((provider) => {
      const secret = credentials?.[provider.id];
      const normalized = String(secret || "").trim();
      if (!normalized) return [];
      return [{ name: providerApiKeyEnvName(provider.id), value: normalized }];
    });
}

function writeLauncher({ launcherPath, providerId, active, runtimeDir, targetProject, piExecutable, credentialExports = [] }) {
  const args = ["--no-extensions", "--provider", providerId, "--model", active.modelId];
  if (active.thinking) args.push("--thinking", active.thinking);

  const lines = [
    "#!/bin/zsh",
    "set -e",
    `cd ${shellQuote(targetProject)}`,
    `export PI_CODING_AGENT_DIR=${shellQuote(runtimeDir)}`,
    `export PI_CODING_AGENT_SESSION_DIR=${shellQuote(path.join(runtimeDir, "sessions"))}`
  ];
  for (const entry of credentialExports) {
    lines.push(`export ${entry.name}=${shellQuote(entry.value)}`);
  }
  lines.push(`exec ${shellQuote(piExecutable)} ${args.map(shellQuote).join(" ")}`);
  fs.writeFileSync(launcherPath, `${lines.join("\n")}\n`, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
}

export function writePiProfile({ dataDir, state, piExecutable = "pi", credentials = {} }) {
  const provider = state.providers.find((item) => item.id === state.active.providerId);
  if (!provider) throw new Error("当前渠道不存在");
  const model = provider.models.find((item) => item.id === state.active.modelId);
  if (!model) throw new Error("当前模型不存在");
  assertSupportedThinkingLevel(model, state.active.thinking);

  const runtimeDir = path.join(dataDir, "profiles", "active");
  const piDir = runtimeDir;
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runtimeDir, "sessions"), { recursive: true, mode: 0o700 });
  removeLegacyManagerFiles(runtimeDir);
  const settingsPath = path.join(piDir, "settings.json");
  const modelsPath = path.join(piDir, "models.json");
  const launcherPath = path.join(runtimeDir, process.platform === "darwin" ? "launch-pi.command" : "launch-pi.sh");
  const extensionPath = "";

  const native = provider.kind === "native-subscription";
  const settings = {
    defaultProvider: native ? provider.piProvider || provider.id : provider.id,
    defaultModel: model.id,
    enabledModels: buildEnabledModels(state)
  };
  writeJsonAtomic(settingsPath, settings);

  const modelsConfig = buildModelsJson(state, credentials);
  if (modelsConfig) {
    writeJsonAtomic(modelsPath, modelsConfig);
  } else {
    try {
      fs.unlinkSync(modelsPath);
    } catch {
      // No provider/model metadata needs to be injected for this profile.
    }
  }

  const credentialExports = buildCredentialExports(state, credentials);

  const manifestPath = path.join(runtimeDir, "profile.json");
  writeJsonAtomic(manifestPath, {
    version: 1,
    generatedAt: new Date().toISOString(),
    targetProject: state.targetProject,
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    thinking: state.active.thinking,
    thinkingValue: getThinkingLevelValue(model, state.active.thinking),
    cycleModelRefs: buildEnabledModels(state),
    mode: native ? "native-subscription" : "models-json"
  });

  writeLauncher({
    launcherPath,
    providerId: native ? provider.piProvider || provider.id : provider.id,
    active: state.active,
    runtimeDir,
    targetProject: state.targetProject,
    piExecutable,
    credentialExports
  });

  return { runtimeDir, extensionPath, settingsPath, modelsPath, launcherPath, manifestPath, mode: native ? "native-subscription" : "models-json" };
}

export { piThinkingMap, shellQuote, toPiModel, providerApiKeyEnvName, buildEnabledModels, buildModelOverrides };
