export const PI_THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

export const THINKING_MAP_SOURCES = Object.freeze([
  "provider-default",
  "provider-docs",
  "request-probe",
  "user"
]);

const extendedThinkingLevels = new Set(["xhigh", "max"]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildThinkingLevelMap({ reasoning, thinkingLevels = [] }) {
  if (!reasoning) return { off: "none" };

  const supported = new Set(thinkingLevels);
  const map = { off: "none" };
  for (const level of PI_THINKING_LEVELS) {
    if (level === "off") continue;
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

export function normalizeThinkingLevelMap(value, { reasoning = true, thinkingLevels } = {}) {
  if (!reasoning) return { off: "none" };

  if (value !== undefined) {
    if (!isRecord(value)) return {};
    const normalized = {};
    for (const [level, mapped] of Object.entries(value)) {
      if (!PI_THINKING_LEVELS.includes(level)) continue;
      if (mapped === null) normalized[level] = null;
      else if (typeof mapped === "string" && mapped.trim()) normalized[level] = mapped.trim();
    }
    return normalized;
  }

  if (Array.isArray(thinkingLevels)) return buildThinkingLevelMap({ reasoning, thinkingLevels });
  return {};
}

export function validateThinkingLevelMap(value, { reasoning = true } = {}) {
  if (!isRecord(value)) throw new Error("Thinking 映射必须是对象");

  const normalized = {};
  for (const [level, mapped] of Object.entries(value)) {
    if (!PI_THINKING_LEVELS.includes(level)) throw new Error(`未知 Thinking 等级: ${level}`);
    if (mapped !== null && (typeof mapped !== "string" || !mapped.trim())) {
      throw new Error(`${level} 的上游值必须是非空字符串或 null`);
    }
    normalized[level] = mapped === null ? null : mapped.trim();
  }

  if (!reasoning) {
    for (const [level, mapped] of Object.entries(normalized)) {
      if (level !== "off" && mapped !== null) throw new Error("非 reasoning 模型只能配置 off");
    }
    if (normalized.off === null) throw new Error("非 reasoning 模型必须保留 off");
    return { off: normalized.off || "none" };
  }

  return normalized;
}

export function normalizeThinkingMapSource(value) {
  return THINKING_MAP_SOURCES.includes(value) ? value : "provider-default";
}

export function getSupportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap || {};
  return PI_THINKING_LEVELS.filter((level) => {
    if (hasOwn(map, level)) return map[level] !== null;
    return !extendedThinkingLevels.has(level);
  });
}

export function getThinkingLevelValue(model, level) {
  if (!PI_THINKING_LEVELS.includes(level)) return undefined;
  const map = model?.thinkingLevelMap || {};
  if (hasOwn(map, level)) return map[level];
  return extendedThinkingLevels.has(level) ? null : undefined;
}

export function assertSupportedThinkingLevel(model, level) {
  const normalizedLevel = String(level || "");
  if (getSupportedThinkingLevels(model).includes(normalizedLevel)) return normalizedLevel;
  const available = getSupportedThinkingLevels(model).join(" / ") || "无可用等级";
  throw new Error(`模型 ${model?.id || "(unknown)"} 不支持 Thinking: ${normalizedLevel || "(empty)"}；可用：${available}`);
}

