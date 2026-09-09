import assert from "node:assert/strict";
import test from "node:test";
import { discoverProviderModels, normalizeModels } from "../src/provider-discovery.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("normalizes OpenAI data models and removes duplicates", () => {
  const models = normalizeModels({ data: [
    { id: "gpt-a", name: "GPT A", context_window: 128000, max_output_tokens: 4096 },
    { id: "gpt-a", name: "duplicate" },
    { id: "gpt-b", owned_by: "team" }
  ] });
  assert.deepEqual(models, [
    { id: "gpt-a", name: "GPT A", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, ownedBy: "" },
    { id: "gpt-b", name: "gpt-b", reasoning: false, input: ["text"], contextWindow: undefined, maxTokens: undefined, ownedBy: "team" }
  ]);
});

test("discovers models with a bearer key and never exposes it in the result", async () => {
  let requestedUrl = "";
  let requestedAuth = "";
  const result = await discoverProviderModels({
    baseUrl: "https://user:pass@relay.example.test/v1",
    apiKey: "secret-api-key",
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedAuth = init.headers.authorization;
      return response({ data: [{ id: "gpt-a", name: "GPT A", reasoning: true }] });
    }
  });
  assert.equal(requestedUrl, "https://relay.example.test/v1/models");
  assert.equal(requestedAuth, "Bearer secret-api-key");
  assert.equal(result.ok, true);
  assert.equal(result.models[0].id, "gpt-a");
  assert.equal(JSON.stringify(result).includes("secret-api-key"), false);
  assert.equal(result.detail, "https://relay.example.test/v1/models");
});

test("returns actionable errors for auth, missing endpoint and invalid JSON", async () => {
  const auth = await discoverProviderModels({
    baseUrl: "https://relay.example.test/v1",
    fetchImpl: async () => response({}, 401)
  });
  assert.equal(auth.category, "auth");
  assert.match(auth.message, /API Key/);

  const missing = await discoverProviderModels({
    baseUrl: "https://relay.example.test/v1",
    fetchImpl: async () => response({}, 404)
  });
  assert.equal(missing.category, "not_found");
  assert.match(missing.message, /手工/);

  const invalid = await discoverProviderModels({
    baseUrl: "https://relay.example.test/v1",
    fetchImpl: async () => new Response("not-json", { status: 200 })
  });
  assert.equal(invalid.category, "protocol");
  assert.match(invalid.message, /有效 JSON/);
});
