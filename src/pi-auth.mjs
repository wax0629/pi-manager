import { execFileSync as defaultExecFileSync } from "node:child_process";

const READY_STATUSES = new Set(["ready", "authenticated"]);
const AUTH_TYPES = new Set(["api_key", "oauth", "subscription"]);
const AUTH_REASONS = new Set([
  "auth_required",
  "check_failed",
  "credentials_not_configured",
  "expired",
  "invalid_credentials",
  "invalid_response",
  "unknown_provider"
]);

function booleanFlag(value) {
  return value === true || value === "true";
}

function safeAuthType(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  return AUTH_TYPES.has(normalized) ? normalized : "";
}

function safeReason(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  return AUTH_REASONS.has(normalized) ? normalized : "";
}

export function parsePiAuthCheck(raw, { providerId = "", checkedAt = Date.now() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ""));
  } catch {
    return {
      providerId,
      ready: false,
      status: "error",
      authType: "",
      reason: "invalid_response",
      checkedAt
    };
  }

  const status = typeof parsed?.status === "string" ? parsed.status.trim().toLowerCase() : "unknown";
  const ready = READY_STATUSES.has(status)
    || booleanFlag(parsed?.authenticated)
    || booleanFlag(parsed?.ready)
    || booleanFlag(parsed?.ok);
  return {
    providerId,
    ready,
    status,
    authType: safeAuthType(parsed?.authType),
    reason: safeReason(parsed?.reason),
    checkedAt
  };
}

export function createPiAuthProbe({
  executable = "pi",
  cacheTtlMs = 2000,
  now = () => Date.now(),
  execFileSync = defaultExecFileSync
} = {}) {
  const cache = new Map();

  function check(providerId, { force = false } = {}) {
    const normalizedProviderId = String(providerId || "").trim();
    const checkedAt = Number(now());
    if (!normalizedProviderId) {
      return parsePiAuthCheck("", { providerId: normalizedProviderId, checkedAt });
    }

    const previous = cache.get(normalizedProviderId);
    if (!force && previous && checkedAt - previous.checkedAt < cacheTtlMs) return previous;

    let result;
    try {
      const raw = execFileSync(executable, ["auth", "check", "--provider", normalizedProviderId, "--json", "--no-refresh"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      result = parsePiAuthCheck(raw, { providerId: normalizedProviderId, checkedAt });
    } catch (error) {
      const stdout = typeof error?.stdout === "string"
        ? error.stdout
        : Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : "";
      result = stdout.trim()
        ? parsePiAuthCheck(stdout, { providerId: normalizedProviderId, checkedAt })
        : {
            providerId: normalizedProviderId,
            ready: false,
            status: "error",
            authType: "",
            reason: "check_failed",
            checkedAt
          };
    }
    cache.set(normalizedProviderId, result);
    return result;
  }

  function clear(providerId) {
    if (providerId === undefined) cache.clear();
    else cache.delete(String(providerId || "").trim());
  }

  return { check, clear };
}
