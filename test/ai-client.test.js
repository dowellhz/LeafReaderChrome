import assert from "node:assert/strict";
import test from "node:test";

import { providerEndpoint, textFromModelResponse } from "../ai-client.js";

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
