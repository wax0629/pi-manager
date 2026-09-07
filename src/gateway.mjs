import crypto from "node:crypto";
import http from "node:http";
import { getThinkingLevelValue } from "./thinking.mjs";

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function sameSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function upstreamUrl(baseUrl, endpoint) {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(endpoint.replace(/^\//, ""), root).toString();
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function copyResponseHeaders(upstream, response) {
  for (const name of ["content-type", "cache-control", "x-request-id", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"]) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
}

async function pipeResponse(upstream, response) {
  copyResponseHeaders(upstream, response);
  response.statusCode = upstream.status;
  if (!upstream.body) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) response.write(Buffer.from(chunk));
  response.end();
}

export function createGateway({ getState, getCredential, onRequest = () => {} }) {
  let server = null;
  const stats = {
    requests: 0,
    successful: 0,
    failed: 0,
    lastRequestAt: null,
    lastError: null
  };

  function currentProvider() {
    const state = getState();
    return state.providers.find((provider) => provider.id === state.active.providerId);
  }

  function currentModel() {
    const state = getState();
    const provider = currentProvider();
    return provider?.models.find((model) => model.id === state.active.modelId);
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.end();
      return;
    }

    const state = getState();
    if (!sameSecret(bearerToken(req), state.gateway.clientKey)) {
      sendJson(res, 401, { error: { message: "Invalid Manager gateway key", type: "authentication_error" } });
      return;
    }

    const provider = currentProvider();
    if (url.pathname === "/health" && req.method === "GET") {
      const model = currentModel();
      sendJson(res, 200, {
        status: "ok",
        route: {
          providerId: provider?.id || "",
          modelId: state.active.modelId,
          thinking: state.active.thinking,
          upstreamThinking: getThinkingLevelValue(model, state.active.thinking)
        },
        stats
      });
      return;
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const models = provider?.models || [];
      sendJson(res, 200, {
        object: "list",
        data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: provider.id }))
      });
      return;
    }

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      sendJson(res, 404, { error: { message: "Not Found", type: "invalid_request_error" } });
      return;
    }

    stats.requests += 1;
    stats.lastRequestAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      if (!provider) throw new Error("当前渠道不存在");
      if (provider.kind === "native-subscription") throw new Error("官方订阅由 Pi 原生 provider 直连，不经过 Manager gateway");
      const body = await readJson(req);
      const requestedModel = String(body.model || "");
      const modelId = requestedModel.startsWith("pi-manager/") ? requestedModel.slice("pi-manager/".length) : requestedModel;
      if (!provider.models.some((model) => model.id === modelId)) throw new Error(`模型不可用: ${requestedModel || "(empty)"}`);
      const credential = getCredential(provider);
      if (!credential) throw new Error(`渠道 ${provider.name} 尚未配置凭据`);

      const upstreamResponse = await fetch(upstreamUrl(provider.baseUrl, "chat/completions"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json"
        },
        body: JSON.stringify({ ...body, model: modelId })
      });
      await pipeResponse(upstreamResponse, res);
      if (upstreamResponse.ok) stats.successful += 1;
      else stats.failed += 1;
      onRequest({ providerId: provider.id, modelId, status: upstreamResponse.status, durationMs: Date.now() - startedAt });
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error.message;
      onRequest({ providerId: provider?.id || "", modelId: state.active.modelId, status: 502, error: error.message, durationMs: Date.now() - startedAt });
      sendJson(res, 502, { error: { message: error.message, type: "upstream_error" } });
    }
  }

  return {
    getStats() {
      return { ...stats };
    },
    isRunning() {
      return Boolean(server);
    },
    start() {
      if (server) return Promise.resolve();
      const state = getState();
      return new Promise((resolve, reject) => {
        const nextServer = http.createServer((req, res) => {
          handle(req, res).catch((error) => sendJson(res, 500, { error: { message: error.message, type: "server_error" } }));
        });
        nextServer.once("error", (error) => {
          nextServer.close();
          reject(error);
        });
        nextServer.listen(state.gateway.port, state.gateway.host, () => {
          server = nextServer;
          resolve();
        });
      });
    },
    stop() {
      if (!server) return Promise.resolve();
      const oldServer = server;
      server = null;
      return new Promise((resolve) => oldServer.close(() => resolve()));
    }
  };
}

export { upstreamUrl };
