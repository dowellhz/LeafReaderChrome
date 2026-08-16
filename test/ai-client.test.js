import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderRequest,
  providerEndpoint,
  textFromModelResponse,
} from "../ai-providers.js";

test("keeps provider-specific endpoint shapes", () => {
  assert.equal(
    providerEndpoint("anthropic", "https://api.anthropic.com"),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    providerEndpoint("ollama", "http://localhost:11434"),
    "http://localhost:11434/api/chat",
  );
  assert.equal(
    providerEndpoint("openai", "https://example.test/v1"),
    "https://example.test/v1/chat/completions",
  );
  assert.equal(
    providerEndpoint("gemini", "https://example.test/v1beta/"),
    "https://example.test/v1beta",
  );
});

test("extracts OpenAI-compatible response text", () => {
  assert.equal(
    textFromModelResponse({ choices: [{ message: { content: "hello" } }] }),
    "hello",
  );
  assert.equal(
    textFromModelResponse({
      choices: [
        { message: { content: [{ text: "hello" }, { text: " world" }] } },
      ],
    }),
    "hello world",
  );
  assert.equal(textFromModelResponse({ output_text: "done" }), "done");
});

test("builds provider-specific request payloads", () => {
  const settings = { apiKey: "key", model: "model" };
  const messages = [{ role: "user", content: "hello" }];
  const gemini = buildProviderRequest({
    provider: "gemini",
    endpoint: "https://example.test/v1beta",
    settings,
    messages,
    prompt: "ping",
    test: false,
    language: "English",
    maxOutputTokens: 123,
  });
  assert.match(gemini.endpoint, /models\/model:generateContent\?key=key$/);
  assert.equal(gemini.body.generationConfig.maxOutputTokens, 123);
  const azure = buildProviderRequest({
    provider: "azure",
    endpoint: "https://example.test/chat/completions",
    settings,
    messages,
    prompt: "ping",
    test: false,
    language: "English",
    maxOutputTokens: 123,
  });
  assert.equal(azure.headers["api-key"], "key");
  assert.equal(azure.headers.Authorization, undefined);
});
