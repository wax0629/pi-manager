function piThinkingMap(provider, model) {
  return model.thinkingLevelMap || {};
}

function resolveModelReference(providers, ref) {
  const normalizedRef = String(ref || "").trim();
  if (!normalizedRef) return null;
  const separatorIndex = normalizedRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= normalizedRef.length - 1) return null;
  const providerId = normalizedRef.slice(0, separatorIndex);
  const modelId = normalizedRef.slice(separatorIndex + 1);
  const provider = providers.find((item) => item.id === providerId);
  const model = provider?.models.find((item) => item.id === modelId);
  if (!provider || !model) return null;
  return { provider, model };
}

function buildEnabledModels(state) {
  const cycleRefs = Array.isArray(state.cycle?.modelRefs) ? state.cycle.modelRefs : [];
  const enabledModels = [];
  const seen = new Set();
  const missing = [];

  for (const rawRef of cycleRefs) {
    const ref = String(rawRef || "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (!resolveModelReference(state.providers || [], ref)) missing.push(ref);
    else enabledModels.push(ref);
  }

  if (missing.length > 0) {
    throw new Error(`循环列表包含不存在的模型: ${missing.join(" / ")}`);
  }

  return enabledModels;
}

function buildModelOverrides(provider) {
  const modelOverrides = Object.fromEntries(
    provider.models.map((item) => [item.id, {
      contextWindow: item.contextWindow,
      ...(item.reasoning && item.thinkingLevelMap && Object.keys(item.thinkingLevelMap).length > 0
        ? { thinkingLevelMap: item.thinkingLevelMap }
        : {})
    }])
  );
  return Object.keys(modelOverrides).length > 0 ? modelOverrides : null;
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

export { toPiModel, buildEnabledModels, buildModelOverrides };
