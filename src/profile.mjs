import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./store.mjs";
import { assertSupportedThinkingLevel, getThinkingLevelValue } from "./thinking.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function piThinkingMap(provider, model) {
  return model.thinkingLevelMap || {};
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

function writeLauncher({ launcherPath, provider, active, runtimeDir, extensionPath, targetProject, gateway, piExecutable }) {
  const native = provider.kind === "native-subscription";
  const args = ["--no-extensions"];
  if (!native) args.push("-e", extensionPath);
  args.push("--provider", native ? provider.piProvider || provider.id : "pi-manager");
  args.push("--model", active.modelId);
  if (active.thinking) args.push("--thinking", active.thinking);

  const lines = [
    "#!/bin/zsh",
    "set -e",
    `cd ${shellQuote(targetProject)}`
  ];
  if (!native) {
    lines.push(`export PI_CODING_AGENT_DIR=${shellQuote(runtimeDir)}`);
    lines.push(`export PI_MANAGER_GATEWAY_KEY=${shellQuote(gateway.clientKey)}`);
  }
  lines.push(`exec ${shellQuote(piExecutable)} ${args.map(shellQuote).join(" ")}`);
  fs.writeFileSync(launcherPath, `${lines.join("\n")}\n`, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
}

export function writePiProfile({ dataDir, state, piExecutable = "pi" }) {
  const provider = state.providers.find((item) => item.id === state.active.providerId);
  if (!provider) throw new Error("当前渠道不存在");
  const model = provider.models.find((item) => item.id === state.active.modelId);
  if (!model) throw new Error("当前模型不存在");
  assertSupportedThinkingLevel(model, state.active.thinking);
  const gateway = state.gateway || { host: "127.0.0.1", port: 8675, clientKey: "" };

  const runtimeDir = path.join(dataDir, "profiles", "active");
  const piDir = path.join(runtimeDir, ".pi");
  const extensionsDir = path.join(piDir, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
  const extensionPath = path.join(extensionsDir, "pi-manager-provider.ts");
  const settingsPath = path.join(piDir, "settings.json");
  const modelsPath = path.join(piDir, "models.json");
  const launcherPath = path.join(runtimeDir, process.platform === "darwin" ? "launch-pi.command" : "launch-pi.sh");

  const native = provider.kind === "native-subscription";
  const settings = native
    ? {
        defaultProvider: provider.piProvider || provider.id,
        defaultModel: model.id,
        enabledModels: [`${provider.piProvider || provider.id}/*`]
      }
    : {
        defaultProvider: "pi-manager",
        defaultModel: model.id,
        enabledModels: ["pi-manager/*"]
      };
  writeJsonAtomic(settingsPath, settings);

  if (native) {
    for (const filePath of [extensionPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Native subscriptions do not need a custom provider extension.
      }
    }
    const modelOverrides = Object.fromEntries(
      provider.models
        .filter((item) => item.reasoning && item.thinkingLevelMap && Object.keys(item.thinkingLevelMap).length > 0)
        .map((item) => [item.id, { thinkingLevelMap: item.thinkingLevelMap }])
    );
    if (Object.keys(modelOverrides).length > 0) {
      writeJsonAtomic(modelsPath, {
        providers: {
          [provider.piProvider || provider.id]: { modelOverrides }
        }
      });
    } else {
      try {
        fs.unlinkSync(modelsPath);
      } catch {
        // No model override is needed for this native profile.
      }
    }
  } else {
    try {
      fs.unlinkSync(modelsPath);
    } catch {
      // Custom providers use the generated extension instead of models.json.
    }
    const piModels = provider.models.map((item) => toPiModel(provider, item));
    const extension = [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      "",
      "export default function (pi: ExtensionAPI) {",
      "  pi.registerProvider(\"pi-manager\", {",
      `    name: ${JSON.stringify(`Pi Manager / ${provider.name}`)},`,
      `    baseUrl: ${JSON.stringify(`http://${gateway.host}:${gateway.port}/v1`)},`,
      '    apiKey: "$PI_MANAGER_GATEWAY_KEY",',
      '    api: "openai-completions",',
      `    models: ${JSON.stringify(piModels, null, 2)}`,
      "  });",
      "}",
      ""
    ].join("\n");
    fs.writeFileSync(extensionPath, extension, { mode: 0o600 });
    fs.chmodSync(extensionPath, 0o600);
  }

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
    mode: native ? "native-subscription" : "manager-gateway"
  });

  writeLauncher({
    launcherPath,
    provider,
    active: state.active,
    runtimeDir,
    extensionPath,
    targetProject: state.targetProject,
    gateway: state.gateway,
    piExecutable
  });

  return { runtimeDir, extensionPath, settingsPath, modelsPath, launcherPath, manifestPath, mode: native ? "native-subscription" : "manager-gateway" };
}

export { piThinkingMap, shellQuote, toPiModel };
