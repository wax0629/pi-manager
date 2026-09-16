import assert from "node:assert/strict";
import test from "node:test";
import { inferModelInputs } from "../src/model-capabilities.mjs";

test("infers text+image for modern multimodal models", () => {
  const multimodalIds = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "claude-3-5-sonnet-20241022",
    "claude-opus-5",
    "claude-haiku-4",
    "gemini-2.5-flash",
    "gemini-3.8-flash-tiered",
    "grok-4.6",
    "qwen2.5-vl-72b",
    "glm-4v",
    "o1",
    "o3-mini",
    "o4-preview"
  ];

  for (const id of multimodalIds) {
    assert.deepEqual(inferModelInputs(id), ["text", "image"], `Expected ${id} to be multimodal`);
  }
});

test("infers text-only for pure text, reasoning and embedding models", () => {
  const textOnlyIds = [
    "deepseek-r1",
    "deepseek-v3",
    "deepseek/deepseek-v4.1-flash",
    "text-embedding-3-small",
    "starcoder-16b",
    "codellama-34b",
    "gpt-3.5-turbo"
  ];

  for (const id of textOnlyIds) {
    assert.deepEqual(inferModelInputs(id), ["text"], `Expected ${id} to be text-only`);
  }
});

test("respects explicit valid input array overrides", () => {
  assert.deepEqual(inferModelInputs("custom-text-model", ["text", "image"]), ["text", "image"]);
  assert.deepEqual(inferModelInputs("custom-text-model", ["text"]), ["text"]);
  assert.deepEqual(inferModelInputs("deepseek-r1", ["text"]), ["text"]);
});
