export function providerEndpoint(provider, endpoint) {
  const base = String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (provider === "gemini") return base;
  if (provider === "anthropic") {
    return /\/v1\/messages(?:\?|$)/.test(base) ? base : `${base}/v1/messages`;
  }
  if (provider === "ollama") {
    if (/\/api\/chat(?:\?|$)/.test(base)) return base;
    return /\/api(?:\?|$)/.test(base) ? `${base}/chat` : `${base}/api/chat`;
  }
  return /\/chat\/completions(?:\?|$)/.test(base)
    ? base
    : `${base}/chat/completions`;
}

export function textFromModelResponse(data) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "string" ? part : part.text || part.content || "",
      )
      .join("")
      .trim();
    if (text) return text;
  }
  if (typeof data.choices?.[0]?.text === "string")
    return data.choices[0].text.trim();
  if (typeof data.output_text === "string") return data.output_text.trim();
  return Array.isArray(data.output)
    ? data.output
        .flatMap((item) => item.content || [])
        .map((part) => part.text || part.value || "")
        .join("")
        .trim()
    : "";
}

export function buildProviderRequest({
  provider,
  endpoint,
  settings,
  messages,
  prompt,
  test,
  language,
  maxOutputTokens,
}) {
  if (provider === "anthropic") {
    return {
      endpoint,
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: settings.model,
        max_tokens: maxOutputTokens,
        system: `You are a concise reading assistant. Reply in ${language}.`,
        messages: test
          ? [{ role: "user", content: prompt }]
          : messages.filter((message) => message.role !== "system"),
      },
      read: (data) =>
        data.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
    };
  }
  if (provider === "gemini") {
    return {
      endpoint: `${endpoint}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      headers: { "content-type": "application/json" },
      body: {
        contents: (test
          ? [{ role: "user", content: prompt }]
          : messages.filter((message) => message.role !== "system")
        ).map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens, temperature: 0.2 },
      },
      read: (data) =>
        data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join(""),
    };
  }
  if (provider === "ollama") {
    return {
      endpoint,
      headers: { "content-type": "application/json" },
      body: {
        model: settings.model,
        messages,
        stream: false,
        options: { temperature: 0.2, num_predict: maxOutputTokens },
      },
      read: (data) => data.message?.content,
    };
  }
  return {
    endpoint,
    headers: {
      "Content-Type": "application/json",
      ...(provider === "azure"
        ? { "api-key": settings.apiKey }
        : { Authorization: `Bearer ${settings.apiKey}` }),
    },
    body: {
      model: settings.model,
      messages,
      temperature: 0.2,
      max_tokens: maxOutputTokens,
    },
    read: textFromModelResponse,
  };
}

export function responseFinishReason(data) {
  return (
    data.choices?.[0]?.finish_reason ||
    data.stop_reason ||
    data.candidates?.[0]?.finishReason ||
    data.done_reason ||
    ""
  );
}
