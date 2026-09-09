import { upstreamUrl } from "./gateway.mjs";
import { classifyConnectionError, CONNECTION_TEST_CATEGORIES, sanitizeConnectionTestUrl } from "./provider-test.mjs";

function normalizeModels(payload) {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : null;
  if (!values) throw new Error("上游 /models 返回格式无法识别");

  const models = [];
  const seen = new Set();
  for (const item of values) {
    const source = typeof item === "string" ? { id: item } : item;
    const id = String(source?.id || source?.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: String(source?.name || source?.display_name || id).trim() || id,
      reasoning: Boolean(source?.reasoning || source?.supports_reasoning),
      input: Array.isArray(source?.input) && source.input.length ? source.input.map(String) : ["text"],
      contextWindow: Number(source?.contextWindow || source?.context_window || source?.context_length) || undefined,
      maxTokens: Number(source?.maxTokens || source?.max_tokens || source?.max_output_tokens) || undefined,
      ownedBy: String(source?.owned_by || source?.ownedBy || "").trim()
    });
  }
  return models;
}

function errorResult({ category, message, detail, status = 0, durationMs }) {
  return { ok: false, category, message, detail, status, durationMs, models: [] };
}

export async function discoverProviderModels({ baseUrl, apiKey = "", fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  let modelsUrl;
  try {
    modelsUrl = upstreamUrl(String(baseUrl || "").trim(), "models");
    const safeUrl = new URL(modelsUrl);
    safeUrl.username = "";
    safeUrl.password = "";
    modelsUrl = safeUrl.toString();
  } catch (error) {
    return errorResult({
      ...classifyConnectionError(error),
      detail: "Base URL 无效",
      durationMs: Date.now() - startedAt
    });
  }

  const headers = { accept: "application/json" };
  if (String(apiKey || "").trim()) headers.authorization = `Bearer ${String(apiKey).trim()}`;
  let response;
  try {
    response = await fetchImpl(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const failed = classifyConnectionError(error);
    return errorResult({
      category: failed.category,
      message: failed.message,
      detail: sanitizeConnectionTestUrl(modelsUrl),
      durationMs: Date.now() - startedAt
    });
  }

  if (!response.ok) {
    const status = response.status;
    const classified = status === 401 || status === 403
      ? { category: CONNECTION_TEST_CATEGORIES.AUTH, message: `认证失败（HTTP ${status}），请检查 API Key` }
      : status === 404
        ? { category: CONNECTION_TEST_CATEGORIES.NOT_FOUND, message: "上游没有提供 /models 目录，可手工填写模型" }
        : status === 429
          ? { category: CONNECTION_TEST_CATEGORIES.RATE_LIMIT, message: "上游模型目录触发限流，请稍后重试" }
          : { category: CONNECTION_TEST_CATEGORIES.PROTOCOL, message: `上游返回 HTTP ${status}` };
    return errorResult({
      ...classified,
      detail: sanitizeConnectionTestUrl(modelsUrl),
      status,
      durationMs: Date.now() - startedAt
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return errorResult({
      category: CONNECTION_TEST_CATEGORIES.PROTOCOL,
      message: "上游 /models 返回的不是有效 JSON",
      detail: sanitizeConnectionTestUrl(modelsUrl),
      status: response.status,
      durationMs: Date.now() - startedAt
    });
  }

  try {
    const models = normalizeModels(payload);
    return {
      ok: true,
      category: CONNECTION_TEST_CATEGORIES.SUCCESS,
      message: `已从上游读取 ${models.length} 个模型`,
      detail: sanitizeConnectionTestUrl(modelsUrl),
      status: response.status,
      durationMs: Date.now() - startedAt,
      models
    };
  } catch (error) {
    return errorResult({
      category: CONNECTION_TEST_CATEGORIES.PROTOCOL,
      message: error instanceof Error ? error.message : String(error),
      detail: sanitizeConnectionTestUrl(modelsUrl),
      status: response.status,
      durationMs: Date.now() - startedAt
    });
  }
}

export { normalizeModels };
