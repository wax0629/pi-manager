import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiAgentDir } from "./pi-import.mjs";

export const FEATURED_NATIVE_PROVIDERS = Object.freeze([
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google",
  "xai",
  "openrouter"
]);

export function resolvePiPackageDir(executable) {
  try {
    const real = fs.realpathSync(executable);
    if (real.endsWith(`${path.sep}dist${path.sep}bundle${path.sep}cli.js`)) {
      return path.resolve(path.dirname(real), "../..");
    }
  } catch {
    // The executable may be missing in tests.
  }
  return "";
}

export async function loadPiSdk(executable) {
  const packageDir = resolvePiPackageDir(executable);
  if (!packageDir) throw new Error("无法定位本机 Pi 安装包");
  return import(pathToFileURL(path.join(packageDir, "dist/index.js")).href);
}

function providerAuthMethods(provider) {
  const methods = [];
  if (provider?.auth?.oauth) methods.push("oauth");
  if (provider?.auth?.apiKey?.login) methods.push("api_key");
  return methods;
}

function summarizeNativeProvider(runtime, provider) {
  const status = runtime.getProviderAuthStatus?.(provider.id) || { configured: false };
  return {
    id: provider.id,
    name: provider.name || provider.id,
    kind: "native-subscription",
    piProvider: provider.id,
    authMethods: providerAuthMethods(provider),
    credentialConfigured: Boolean(status.configured),
    authSource: status.source || "",
    authLabel: status.label || "",
    models: (runtime.getModels?.(provider.id) || []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      thinkingLevelMap: model.thinkingLevelMap || {},
      thinkingLevels: [],
      thinkingMapSource: "provider-default",
      thinkingMapVerified: false,
      input: Array.isArray(model.input) && model.input.length ? model.input : ["text"],
      contextWindow: Number(model.contextWindow) || 128000,
      maxTokens: Number(model.maxTokens) || 32000,
      cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }))
  };
}

export function createNativeAuth({
  executable = "pi",
  agentDir = resolvePiAgentDir(),
  loadSdk,
  openUrl
} = {}) {
  let runtimePromise;
  const sessions = new Map();

  function resetRuntime() {
    runtimePromise = undefined;
  }

  async function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const sdk = loadSdk ? await loadSdk() : await loadPiSdk(executable);
        if (!sdk?.ModelRuntime?.create) throw new Error("当前 Pi SDK 不支持 ModelRuntime");
        return sdk.ModelRuntime.create({
          refreshOnCreate: false,
          allowModelNetwork: false,
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: fs.existsSync(path.join(agentDir, "models.json")) ? path.join(agentDir, "models.json") : null
        });
      })();
    }
    return runtimePromise;
  }

  async function listNativeProviders() {
    const runtime = await getRuntime();
    const configured = new Set((await runtime.listCredentials?.() || []).map((item) => item.providerId));
    const featured = new Set(FEATURED_NATIVE_PROVIDERS);
    return runtime.getProviders()
      .filter((provider) => {
        const methods = providerAuthMethods(provider);
        if (methods.length === 0) return false;
        return featured.has(provider.id) || configured.has(provider.id) || Boolean(runtime.getProviderAuthStatus?.(provider.id)?.configured);
      })
      .map((provider) => summarizeNativeProvider(runtime, provider));
  }

  function getSession(loginId) {
    const session = sessions.get(String(loginId || ""));
    if (!session) throw new Error("登录会话不存在或已结束");
    return session;
  }

  function publicSession(session) {
    return {
      loginId: session.id,
      providerId: session.providerId,
      type: session.type,
      status: session.status,
      authUrl: session.authUrl,
      prompt: session.prompt,
      error: session.error
    };
  }

  async function login({ providerId, type, apiKey = "" }) {
    const runtime = await getRuntime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error("Pi 原生渠道不存在");
    const methods = providerAuthMethods(provider);
    const authType = type || (methods.includes("oauth") ? "oauth" : "api_key");
    if (!methods.includes(authType)) throw new Error(`该渠道不支持 ${authType} 登录`);

    if (authType === "api_key") {
      const key = String(apiKey || "").trim();
      if (!key) throw new Error("API Key 不能为空");
      await runtime.login(providerId, "api_key", {
        async prompt(prompt) {
          if (prompt.type === "select") return prompt.options?.[0]?.id || "";
          return key;
        },
        notify() {}
      });
      resetRuntime();
      return { status: "completed", providerId, type: "api_key" };
    }

    const session = {
      id: crypto.randomUUID(),
      providerId,
      type: "oauth",
      status: "pending",
      authUrl: "",
      prompt: null,
      error: "",
      resolvePrompt: null
    };
    sessions.set(session.id, session);
    session.promise = runtime.login(providerId, "oauth", {
      async prompt(prompt) {
        session.prompt = {
          type: prompt.type,
          message: prompt.message,
          placeholder: prompt.placeholder || "",
          options: prompt.options || []
        };
        session.status = "need_prompt";
        return await new Promise((resolve, reject) => {
          session.resolvePrompt = { resolve, reject };
        });
      },
      notify(event) {
        if (event.type === "auth_url" && event.url) {
          session.authUrl = event.url;
          session.status = "need_url";
          if (typeof openUrl === "function") {
            Promise.resolve(openUrl(event.url)).catch(() => {});
          }
        }
      }
    }).then(() => {
      session.status = "completed";
      session.prompt = null;
      resetRuntime();
      return publicSession(session);
    }).catch((error) => {
      session.status = "error";
      session.error = error instanceof Error ? error.message : String(error);
      throw error;
    });

    return publicSession(session);
  }

  function answerPrompt(loginId, value) {
    const session = getSession(loginId);
    if (!session.resolvePrompt) throw new Error("当前没有等待输入的登录步骤");
    const answer = String(value || "").trim();
    if (!answer) throw new Error("登录输入不能为空");
    session.resolvePrompt.resolve(answer);
    session.resolvePrompt = null;
    session.prompt = null;
    session.status = "pending";
    return publicSession(session);
  }

  async function loginStatus(loginId) {
    const session = getSession(loginId);
    if (session.promise && session.status === "pending") {
      try {
        await Promise.race([session.promise, new Promise((resolve) => setTimeout(resolve, 20))]);
      } catch {
        // Status is already recorded on the session.
      }
    }
    return publicSession(session);
  }

  async function logout(providerId) {
    const runtime = await getRuntime();
    await runtime.logout(providerId);
    resetRuntime();
    return { providerId, status: "logged_out" };
  }

  return {
    getRuntime,
    listNativeProviders,
    login,
    loginStatus,
    answerPrompt,
    logout
  };
}
