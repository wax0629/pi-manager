import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildEnabledModels, buildModelOverrides, toPiModel } from "./profile.mjs";
import { resolvePiAgentDir } from "./pi-import.mjs";
import { writeJsonAtomic } from "./store.mjs";

const LIVE_FILES = ["settings.json", "models.json", "auth.json"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`无法解析 ${filePath}`);
  }
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  try {
    fs.chmodSync(destination, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  return true;
}

function timestampId(now = new Date()) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function parsePiListModels(output) {
  const refs = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+/);
    if (!match) continue;
    const [, providerId, modelId] = match;
    if (!providerId || providerId === "provider" || !modelId || modelId === "model") continue;
    refs.push(`${providerId}/${modelId}`);
  }
  return refs;
}

export function mergeLiveSettings(existing, state) {
  const provider = (state.providers || []).find((item) => item.id === state.active?.providerId);
  if (!provider) throw new Error("当前渠道不存在");
  const current = existing && typeof existing === "object" ? existing : {};
  return {
    ...current,
    defaultProvider: provider.kind === "native-subscription" ? provider.piProvider || provider.id : provider.id,
    defaultModel: state.active.modelId,
    defaultThinkingLevel: state.active.thinking,
    enabledModels: buildEnabledModels(state)
  };
}

export function mergeLiveModels(existing, state) {
  const current = existing && typeof existing === "object" ? existing : {};
  const providers = { ...(current.providers && typeof current.providers === "object" ? current.providers : {}) };

  for (const provider of state.providers || []) {
    if (provider.kind === "native-subscription") {
      const modelOverrides = buildModelOverrides(provider);
      const key = provider.piProvider || provider.id;
      if (modelOverrides) {
        providers[key] = { ...(providers[key] || {}), modelOverrides };
      }
      continue;
    }
    if (!provider.baseUrl) continue;
    const entry = {
      ...(providers[provider.id] || {}),
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      models: provider.models.map((model) => toPiModel(provider, model))
    };
    if (provider.credentialEnv) entry.apiKey = `$${provider.credentialEnv}`;
    else delete entry.apiKey;
    providers[provider.id] = entry;
  }

  return { ...current, providers };
}

export function mergeLiveAuth(existing, state, credentials = {}) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  for (const provider of state.providers || []) {
    if (provider.kind === "native-subscription") continue;
    const secret = String(credentials?.[provider.id] || "").trim();
    if (!secret) continue;
    const current = next[provider.id];
    if (current && typeof current === "object" && current.type === "oauth") continue;
    next[provider.id] = { type: "api_key", key: secret };
  }
  return next;
}

export function backupLivePiConfig({ agentDir, backupRoot, now = new Date() }) {
  ensureDir(backupRoot);
  const backupDir = path.join(backupRoot, timestampId(now));
  ensureDir(backupDir);
  const files = {};
  for (const name of LIVE_FILES) {
    files[name] = copyIfExists(path.join(agentDir, name), path.join(backupDir, name));
  }
  const manifest = {
    createdAt: now.toISOString(),
    agentDir,
    files
  };
  writeJsonAtomic(path.join(backupDir, "manifest.json"), manifest);
  return { backupDir, manifest };
}

export function restoreLivePiBackup({ agentDir, backupDir }) {
  if (!backupDir || !fs.existsSync(backupDir)) throw new Error("没有可回滚的本机 Pi 备份");
  ensureDir(agentDir);
  for (const name of LIVE_FILES) {
    const source = path.join(backupDir, name);
    const destination = path.join(agentDir, name);
    if (fs.existsSync(source)) {
      copyIfExists(source, destination);
      continue;
    }
    try {
      fs.unlinkSync(destination);
    } catch {
      // File was created by a later import and should disappear on rollback.
    }
  }
  return { agentDir, backupDir };
}

function verifyLiveModels({ agentDir, piExecutable, enabledModels, listModels }) {
  if (typeof listModels === "function") {
    const output = listModels({ agentDir, piExecutable });
    return { ok: true, output: String(output || ""), refs: parsePiListModels(output) };
  }
  if (!piExecutable) {
    return { ok: false, output: "", refs: [], error: "未提供 Pi 可执行文件" };
  }
  try {
    const output = execFileSync(piExecutable, ["--list-models", "--offline"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const refs = parsePiListModels(output);
    const missing = (enabledModels || []).filter((ref) => !refs.includes(ref));
    return {
      ok: missing.length === 0,
      output,
      refs,
      missing,
      error: missing.length ? `Pi 未列出循环列表模型: ${missing.join(" / ")}` : ""
    };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    return {
      ok: false,
      output: stdout,
      refs: parsePiListModels(stdout),
      error: stderr || (error instanceof Error ? error.message : String(error))
    };
  }
}

export function applyLivePiConfig({
  agentDir = resolvePiAgentDir(),
  backupRoot,
  state,
  credentials = {},
  piExecutable = "pi",
  listModels,
  now = new Date()
}) {
  if (!backupRoot) throw new Error("缺少备份目录");
  ensureDir(agentDir);
  const settingsPath = path.join(agentDir, "settings.json");
  const modelsPath = path.join(agentDir, "models.json");
  const authPath = path.join(agentDir, "auth.json");
  const existingSettings = readJsonIfExists(settingsPath);
  const existingModels = readJsonIfExists(modelsPath);
  const existingAuth = readJsonIfExists(authPath);
  const nextSettings = mergeLiveSettings(existingSettings, state);
  const nextModels = mergeLiveModels(existingModels, state);
  const nextAuth = mergeLiveAuth(existingAuth, state, credentials);
  const backup = backupLivePiConfig({ agentDir, backupRoot, now });

  try {
    writeJsonAtomic(settingsPath, nextSettings);
    writeJsonAtomic(modelsPath, nextModels);
    writeJsonAtomic(authPath, nextAuth, 0o600);
  } catch (error) {
    restoreLivePiBackup({ agentDir, backupDir: backup.backupDir });
    throw error;
  }

  const verify = verifyLiveModels({
    agentDir,
    piExecutable,
    enabledModels: nextSettings.enabledModels,
    listModels
  });

  return {
    agentDir,
    backupDir: backup.backupDir,
    settingsPath,
    modelsPath,
    authPath,
    enabledModels: nextSettings.enabledModels,
    defaultProvider: nextSettings.defaultProvider,
    defaultModel: nextSettings.defaultModel,
    verify
  };
}
