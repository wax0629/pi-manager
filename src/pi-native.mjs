import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiAgentDir } from "./pi-import.mjs";

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
  if (typeof provider?.auth?.oauth?.login === "function") methods.push("oauth");
  if (typeof provider?.auth?.apiKey?.login === "function") methods.push("api_key");
  return methods;
}

function summarizeNativeProvider(runtime, provider) {
  const status = runtime.getProviderAuthStatus?.(provider.id) || { configured: false };
  return {
    id: provider.id,
    name: provider.name || provider.id,
    kind: "native-subscription",
    piProvider: provider.id,
    nativeRegistryId: provider.id,
    authMethods: providerAuthMethods(provider),
    authMethodLabels: {
      oauth: provider.auth?.oauth?.loginLabel || provider.auth?.oauth?.name || "",
      api_key: provider.auth?.apiKey?.name || ""
    },
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
  openUrl,
  refreshTimeoutMs = 15000
} = {}) {
  let runtimePromise;
  let refreshPromise;
  const sessions = new Map();
  const nativeRegistries = new WeakMap();

  function isNativeProvider(runtime, providerId) {
    // getRegisteredNativeProvider only contains native extensions, not builtins.
    return nativeRegistries.get(runtime)?.has(providerId)
      || Boolean(runtime.getRegisteredNativeProvider?.(providerId));
  }

  function loginProvider(runtime, providerId) {
    const provider = runtime.getProvider(providerId);
    if (!provider || !isNativeProvider(runtime, providerId)) throw new Error("Pi 原生渠道不存在");
    return provider;
  }

  function resetRuntime() {
    runtimePromise = undefined;
  }

  async function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const sdk = loadSdk ? await loadSdk() : await loadPiSdk(executable);
        if (!sdk?.ModelRuntime?.create) throw new Error("当前 Pi SDK 不支持 ModelRuntime");
        const options = { allowModelNetwork: false, authPath: path.join(agentDir, "auth.json") };
        const [runtime, nativeRegistry] = await Promise.all([
          sdk.ModelRuntime.create({ ...options, refreshOnCreate: true, modelsPath: path.join(agentDir, "models.json") }),
          // A registry without models.json overlays identifies Pi's own providers.
          // Skipping refresh avoids duplicate catalog/auth work or storage writes.
          sdk.ModelRuntime.create({ ...options, refreshOnCreate: false, modelsPath: null })
        ]);
        nativeRegistries.set(runtime, new Set(nativeRegistry.getProviders().map((provider) => provider.id)));
        return runtime;
      })().catch((error) => {
        resetRuntime();
        throw error;
      });
    }
    return runtimePromise;
  }

  async function refreshModels() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Pi 原生模型刷新超时，请稍后重试"));
          }, refreshTimeoutMs);
        });
        const refresh = async () => {
          // Reload credentials/config and restore Pi's catalog cache before fetching.
          resetRuntime();
          const runtime = await getRuntime();
          if (typeof runtime.refresh !== "function") throw new Error("当前 Pi SDK 不支持模型刷新，请更新 Pi");
          const configured = new Set((await runtime.listCredentials?.() || []).map((item) => item.providerId));
          const providers = runtime.getProviders()
            .filter((provider) => isNativeProvider(runtime, provider.id)
              && providerAuthMethods(provider).length > 0
              && (configured.has(provider.id) || runtime.getProviderAuthStatus?.(provider.id)?.configured))
            .map((provider) => provider.id);
          const result = await runtime.refresh({
            allowNetwork: process.env.PI_OFFLINE === undefined,
            force: true,
            providers,
            signal: controller.signal
          });
          if (result?.aborted) throw new Error("Pi 原生模型刷新超时，请稍后重试");
          if (result?.errors?.size) throw new Error(`Pi 原生模型刷新失败: ${[...result.errors.keys()].join(" / ")}`);
        };
        try {
          await Promise.race([refresh(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      })().finally(() => { refreshPromise = undefined; });
    }
    return refreshPromise;
  }

  async function listNativeProviders({ includeUnconfigured = false, refresh = false } = {}) {
    if (refresh) await refreshModels();
    const runtime = await getRuntime();
    const configured = new Set((await runtime.listCredentials?.() || []).map((item) => item.providerId));
    return runtime.getProviders()
      .filter((provider) => {
        const methods = providerAuthMethods(provider);
        if (methods.length === 0 || !isNativeProvider(runtime, provider.id)) return false;
        const isConfigured = configured.has(provider.id) || Boolean(runtime.getProviderAuthStatus?.(provider.id)?.configured);
        return includeUnconfigured || isConfigured;
      })
      .map((provider) => summarizeNativeProvider(runtime, provider))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getSession(loginId) {
    const session = sessions.get(String(loginId || ""));
    if (!session) throw new Error("登录会话不存在或已结束");
    return session;
  }

  function publicSession(session) {
    const redact = (value) => {
      let text = String(value || "");
      for (const secret of session.privateValues) text = text.replaceAll(secret, "[redacted]");
      return text;
    };
    return {
      loginId: session.id,
      providerId: session.providerId,
      type: session.type,
      status: session.status,
      authUrl: session.authUrl,
      instructions: redact(session.instructions),
      message: redact(session.message),
      links: session.links,
      deviceCode: session.deviceCode,
      prompt: session.prompt ? {
        ...session.prompt,
        message: redact(session.prompt.message),
        placeholder: redact(session.prompt.placeholder)
      } : null,
      error: session.error
    };
  }

  async function login({ providerId, type }) {
    const runtime = await getRuntime();
    const provider = loginProvider(runtime, providerId);
    const methods = providerAuthMethods(provider);
    const authType = type || (methods.includes("oauth") ? "oauth" : "api_key");
    if (!methods.includes(authType)) throw new Error(`该渠道不支持 ${authType} 登录`);

    const session = {
      id: crypto.randomUUID(),
      providerId,
      type: authType,
      status: "pending",
      authUrl: "",
      instructions: "",
      message: "",
      links: [],
      deviceCode: null,
      prompt: null,
      error: "",
      resolvePrompt: null,
      controller: new AbortController(),
      privateValues: new Set()
    };
    sessions.set(session.id, session);
    session.promise = Promise.resolve().then(() => runtime.login(providerId, authType, {
      signal: session.controller.signal,
      prompt(prompt) {
        const signal = prompt.signal
          ? AbortSignal.any([prompt.signal, session.controller.signal])
          : session.controller.signal;
        if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
        session.prompt = {
          id: crypto.randomUUID(),
          type: prompt.type,
          message: prompt.message,
          placeholder: prompt.placeholder || "",
          options: (prompt.options || []).map(({ id, label, description }) => ({ id, label, description }))
        };
        session.status = "need_prompt";
        return new Promise((resolve, reject) => {
          const finish = (callback, value) => {
            signal.removeEventListener("abort", onAbort);
            if (session.resolvePrompt === pending) {
              session.resolvePrompt = null;
              session.prompt = null;
              if (session.status === "need_prompt") session.status = "pending";
            }
            callback(value);
          };
          const onAbort = () => finish(reject, new Error("Login cancelled"));
          const pending = { resolve: (value) => finish(resolve, value) };
          session.resolvePrompt = pending;
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      notify(event) {
        if (session.controller.signal.aborted) return;
        if (event.type === "auth_url" && event.url) {
          session.authUrl = event.url;
          session.instructions = event.instructions || "";
          if (!session.prompt) session.status = "need_url";
          if (typeof openUrl === "function") {
            Promise.resolve().then(() => openUrl(event.url)).catch(() => {});
          }
        } else if (event.type === "device_code") {
          session.deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
          if (!session.prompt) session.status = "need_url";
        } else if (event.type === "info" || event.type === "progress") {
          session.message = event.message || "";
          session.links = (event.links || []).map(({ url, label }) => ({ url, label }));
        }
      }
    })).then(() => {
      if (session.controller.signal.aborted) return;
      session.status = "completed";
      session.prompt = null;
      resetRuntime();
    }).catch(() => {
      if (session.controller.signal.aborted) return;
      session.status = "error";
      // Provider errors may contain credentials or OAuth tokens.
      session.error = "Pi 原生登录失败，请重试";
    }).finally(() => {
      session.controller.abort();
      session.prompt = null;
      session.privateValues.clear();
      session.message = "";
      session.links = [];
      session.authUrl = "";
      session.instructions = "";
      session.deviceCode = null;
    });

    return publicSession(session);
  }

  function answerPrompt(loginId, value, promptId) {
    const session = getSession(loginId);
    if (!session.resolvePrompt) throw new Error("当前没有等待输入的登录步骤");
    if (session.prompt.id !== promptId) throw new Error("登录步骤已更新，请刷新后重试");
    if (typeof value !== "string") throw new Error("登录输入必须是文本");
    const answer = value;
    if (session.prompt.type === "select") {
      if (!session.prompt.options.some((option) => option.id === answer)) throw new Error("请选择有效的登录选项");
    } else if (answer) {
      session.privateValues.add(answer);
    }
    session.resolvePrompt.resolve(answer);
    return publicSession(session);
  }

  function cancelLogin(loginId) {
    const session = getSession(loginId);
    if (!["completed", "error", "cancelled"].includes(session.status)) {
      session.status = "cancelled";
      session.controller.abort();
    }
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
    loginProvider(runtime, providerId);
    await runtime.logout(providerId);
    resetRuntime();
    return { providerId, status: "logged_out" };
  }

  return {
    getRuntime,
    listNativeProviders,
    listLoginProviders: () => listNativeProviders({ includeUnconfigured: true }),
    login,
    loginStatus,
    answerPrompt,
    cancelLogin,
    logout
  };
}
