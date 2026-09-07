import { upstreamUrl } from "./gateway.mjs";

const ERROR_CODES = {
  DNS: new Set(["ENOTFOUND", "EAI_AGAIN"]),
  TLS: new Set(["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]),
  TIMEOUT: new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT"]),
  NETWORK: new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"])
};

export const CONNECTION_TEST_CATEGORIES = Object.freeze({
  SUCCESS: "success",
  AUTH: "auth",
  NOT_FOUND: "not_found",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  DNS: "dns",
  TLS: "tls",
  NETWORK: "network",
  PROTOCOL: "protocol",
  SUBSCRIPTION: "subscription",
  UNKNOWN: "unknown"
});

function errorCode(error) {
  return String(error?.code || error?.cause?.code || "");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeResult({ provider, ok, category, message, detail, status, testedAt, durationMs }) {
  return {
    providerId: provider.id,
    providerName: provider.name,
    ok,
    category,
    message,
    detail,
    status,
    testedAt,
    durationMs
  };
}

export function classifyConnectionError(error) {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (ERROR_CODES.DNS.has(code) || /ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return { category: CONNECTION_TEST_CATEGORIES.DNS, message: `DNS 解析失败：${message}` };
  }
  if (ERROR_CODES.TLS.has(code) || /TLS|SSL|certificate/i.test(message)) {
    return { category: CONNECTION_TEST_CATEGORIES.TLS, message: `TLS/证书校验失败：${message}` };
  }
  if (ERROR_CODES.TIMEOUT.has(code) || /timeout|timed out/i.test(message)) {
    return { category: CONNECTION_TEST_CATEGORIES.TIMEOUT, message: `请求超时：${message}` };
  }
  if (ERROR_CODES.NETWORK.has(code) || /connect|refused|unreachable|reset/i.test(message)) {
    return { category: CONNECTION_TEST_CATEGORIES.NETWORK, message: `网络连接失败：${message}` };
  }
  if (/Invalid URL|unsupported protocol|protocol/i.test(message)) {
    return { category: CONNECTION_TEST_CATEGORIES.PROTOCOL, message: `协议或地址无效：${message}` };
  }
  return { category: CONNECTION_TEST_CATEGORIES.UNKNOWN, message: `连接测试失败：${message}` };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) {
    return { category: CONNECTION_TEST_CATEGORIES.AUTH, message: `认证失败（HTTP ${status}）` };
  }
  if (status === 404) {
    return { category: CONNECTION_TEST_CATEGORIES.NOT_FOUND, message: "模型端点不存在（HTTP 404）" };
  }
  if (status === 429) {
    return { category: CONNECTION_TEST_CATEGORIES.RATE_LIMIT, message: "触发限流（HTTP 429）" };
  }
  if (status >= 500) {
    return { category: CONNECTION_TEST_CATEGORIES.PROTOCOL, message: `上游服务异常（HTTP ${status}）` };
  }
  return { category: CONNECTION_TEST_CATEGORIES.PROTOCOL, message: `返回了非预期状态（HTTP ${status}）` };
}

export async function testProviderConnection({ provider, credential, detectPi, fetchImpl = fetch, timeoutMs = 4000 }) {
  const testedAt = new Date().toISOString();
  const startedAt = Date.now();

  if (provider.kind === "native-subscription") {
    const piInfo = detectPi();
    const ok = Boolean(piInfo.subscriptionReady);
    return normalizeResult({
      provider,
      ok,
      category: ok ? CONNECTION_TEST_CATEGORIES.SUCCESS : CONNECTION_TEST_CATEGORIES.AUTH,
      message: ok ? "Pi 原生认证可用" : "Pi 原生认证未就绪",
      detail: ok ? "已通过 Pi auth check" : "请先完成 /login 或检查 Pi 安装",
      status: ok ? 200 : 401,
      testedAt,
      durationMs: Date.now() - startedAt
    });
  }

  if (!provider.baseUrl) {
    return normalizeResult({
      provider,
      ok: false,
      category: CONNECTION_TEST_CATEGORIES.PROTOCOL,
      message: "供应商缺少 baseUrl",
      detail: "无法发起连接测试",
      status: 0,
      testedAt,
      durationMs: Date.now() - startedAt
    });
  }

  const headers = { accept: "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  const testUrl = upstreamUrl(provider.baseUrl, "models");

  let response;
  try {
    response = await fetchImpl(testUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const failed = classifyConnectionError(error);
    return normalizeResult({
      provider,
      ok: false,
      category: failed.category,
      message: failed.message,
      detail: testUrl,
      status: 0,
      testedAt,
      durationMs: Date.now() - startedAt
    });
  }

  if (response.ok) {
    return normalizeResult({
      provider,
      ok: true,
      category: CONNECTION_TEST_CATEGORIES.SUCCESS,
      message: "连接测试通过",
      detail: testUrl,
      status: response.status,
      testedAt,
      durationMs: Date.now() - startedAt
    });
  }

  const failed = classifyHttpStatus(response.status);
  return normalizeResult({
    provider,
    ok: false,
    category: failed.category,
    message: failed.message,
    detail: `${testUrl} · HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    status: response.status,
    testedAt,
    durationMs: Date.now() - startedAt
  });
}
