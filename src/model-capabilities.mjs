/**
 * Smart inference for model input capabilities (text vs text + image).
 * If the model definition explicitly provides a non-empty `input` array, respect it.
 * Otherwise, inspect the model id / name against known multimodal patterns.
 */
export function inferModelInputs(modelId, rawInput) {
  // If rawInput explicitly includes 'image', respect it.
  if (Array.isArray(rawInput) && rawInput.map(String).includes("image")) {
    return Array.from(new Set(rawInput.map(String).filter((i) => i === "text" || i === "image").concat("text")));
  }

  const id = String(modelId || "").toLowerCase();

  // Known pure-text models or patterns that do NOT support vision/image payloads:
  // - deepseek models (r1, v3, v4, coder)
  // - code-specialized models (codellama, starcoder, qwen-coder without vl)
  // - classic text models (text-embedding, gpt-3.5, davinci)
  if (
    id.includes("deepseek") ||
    id.includes("embedding") ||
    id.includes("gpt-3.5") ||
    id.includes("davinci") ||
    id.includes("babbage") ||
    id.includes("starcoder") ||
    id.includes("codellama") ||
    id.includes("whisper") ||
    id.includes("tts")
  ) {
    return ["text"];
  }

  // Known multimodal / vision-capable model patterns:
  // - GPT-4o, GPT-4.5, GPT-5*, GPT-6*, o1, o3, o4
  // - Claude 3, 3.5, 4, 5, Opus, Sonnet, Haiku
  // - Gemini, Gemma vision
  // - Grok 4, Grok vision
  // - Generic vision/multimodal indicators (vl, vision, omni, multimodal, 4o)
  const isMultimodal =
    /\bgpt-4o\b/i.test(id) ||
    id.includes("gpt-4o") ||
    id.includes("gpt-4.5") ||
    id.includes("gpt-5") ||
    id.includes("gpt-6") ||
    id.includes("claude-3") ||
    id.includes("claude-4") ||
    id.includes("claude-5") ||
    id.includes("opus") ||
    id.includes("sonnet") ||
    id.includes("haiku") ||
    id.includes("gemini") ||
    id.includes("grok-4") ||
    id.includes("vision") ||
    id.includes("-vl") ||
    id.includes("_vl") ||
    id.includes("4v") ||
    id.includes("multimodal") ||
    id.includes("omni") ||
    /\bo[134]\b/i.test(id) ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4");

  if (isMultimodal) {
    return ["text", "image"];
  }

  // Default for general unknown models: text-only to prevent unexpected HTTP 400 errors
  return ["text"];
}
