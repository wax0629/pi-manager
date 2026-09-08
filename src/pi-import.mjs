import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OPENAI_COMPAT_APIS = new Set(["openai-completions", "openai-responses"]);

export function resolvePiAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function classifyPiApiKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return { kind: "missing", env: "", hasLiteral: false };
  if (raw.startsWith("!")) return { kind: "command", env: "", hasLiteral: false };
  const braced = raw.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (braced) return { kind: "env", env: braced[1], hasLiteral: false };
  const plain = raw.match(/^\$([A-Z][A-Z0-9_]*)$/);
  if (plain) return { kind: "env", env: plain[1], hasLiteral: false };
  return { kind: "literal", env: "", hasLiteral: true };
}

function providerApi(config) {
  return String(config?.api || config?.models?.[0]?.api || "").trim();
}

export function isImportablePiProvider(id, config) {
  if (!id || !config || typeof config !== "object") return false;
  if (!Array.isArray(config.models) || config.models.length === 0) return false;
  if (!String(config.baseUrl || "").trim()) return false;
  const api = providerApi(config);
  return !api || OPENAI_COMPAT_APIS.has(api);
}

export function summarizePiProvider(id, config) {
  const apiKey = classifyPiApiKey(config?.apiKey);
  const models = Array.isArray(config?.models)
    ? config.models.map((model) => {
        if (typeof model === "string") return { id: model, name: model };
        return {
          id: String(model?.id || "").trim(),
          name: String(model?.name || model?.id || "").trim(),
          reasoning: Boolean(model?.reasoning),
          thinkingLevelMap: model?.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : undefined,
          input: Array.isArray(model?.input) ? model.input : ["text"],
          contextWindow: model?.contextWindow,
          maxTokens: model?.maxTokens,
          cost: model?.cost
        };
      }).filter((model) => model.id)
    : [];
  return {
    id: String(id),
    name: String(config?.name || id).trim() || String(id),
    baseUrl: String(config?.baseUrl || "").trim().replace(/\/$/, ""),
    api: providerApi(config) || "openai-completions",
    models,
    credentialEnv: apiKey.env,
    credentialKind: apiKey.kind,
    credentialConfigured: apiKey.kind === "env" || apiKey.kind === "literal" || apiKey.kind === "command"
  };
}

export function readPiModelsConfig(agentDir = resolvePiAgentDir()) {
  const modelsPath = path.join(agentDir, "models.json");
  let raw = "";
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { modelsPath, exists: false, providers: {} };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`无法解析 ${modelsPath}`);
  }
  const providers = parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  return { modelsPath, exists: true, providers };
}

export function previewPiProviderImport({ modelsConfig, existingProviders = [] }) {
  const existingById = new Map((existingProviders || []).map((provider) => [provider.id, provider]));
  const candidates = [];
  const skipped = [];

  for (const [id, config] of Object.entries(modelsConfig?.providers || {})) {
    if (!isImportablePiProvider(id, config)) {
      skipped.push({
        id,
        reason: Array.isArray(config?.models) && config.models.length
          ? "not-openai-compatible"
          : "missing-models-or-baseurl"
      });
      continue;
    }
    const summary = summarizePiProvider(id, config);
    const existing = existingById.get(id);
    candidates.push({
      ...summary,
      conflict: Boolean(existing),
      existingKind: existing?.kind || "",
      existingName: existing?.name || ""
    });
  }

  return {
    modelsPath: modelsConfig?.modelsPath || "",
    candidates,
    skipped,
    conflicts: candidates.filter((item) => item.conflict)
  };
}

export function literalApiKeyFromPiProvider(config) {
  const classified = classifyPiApiKey(config?.apiKey);
  return classified.kind === "literal" ? String(config.apiKey).trim() : "";
}
