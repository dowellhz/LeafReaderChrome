function chatEndpoint(endpoint) {
  const base = String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  return /\/chat\/completions(?:\?|$)/.test(base)
    ? base
    : `${base}/chat/completions`;
}

function providerEndpoint(provider, endpoint) {
  const base = String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (provider === "gemini") return base;
  // Anthropic uses its own Messages endpoint rather than Chat Completions.
  // Settings normally contain the full `/v1/messages` URL, which must not be
  // rewritten; allow a host/base URL as well.
  if (provider === "anthropic") {
    if (/\/v1\/messages(?:\?|$)/.test(base)) return base;
    return `${base}/v1/messages`;
  }
  // Ollama's native API is `/api/chat`, not the OpenAI-compatible
  // `/v1/chat/completions` route. Keep a complete native endpoint intact;
  // accept a host or `/api` base as a small convenience for custom installs.
  if (provider === "ollama") {
    if (/\/api\/chat(?:\?|$)/.test(base)) return base;
    return /\/api(?:\?|$)/.test(base) ? `${base}/chat` : `${base}/api/chat`;
  }
  return chatEndpoint(base);
}

function aiResponseLanguage(settings) {
  const selected =
    settings.language === "auto" || !settings.language
      ? chrome.i18n.getUILanguage()
      : settings.language;
  return /^zh(?:-|$)/i.test(selected) ? "简体中文" : "English";
}

function textFromModelResponse(data) {
  const message = data.choices?.[0]?.message;
  const content = message?.content;
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
  const completion = data.choices?.[0]?.text;
  if (typeof completion === "string" && completion.trim()) return completion;
  if (typeof data.output_text === "string" && data.output_text.trim())
    return data.output_text;
  const output = Array.isArray(data.output)
    ? data.output
        .flatMap((item) => item.content || [])
        .map((part) => part.text || part.value || "")
        .join("")
        .trim()
    : "";
  return output || "";
}

async function requestAI({
  instruction,
  text,
  context = "",
  history = [],
  test = false,
}) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const provider = settings.provider || "openai";
  const rawEndpoint = String(settings.endpoint || "").trim();
  const endpoint = providerEndpoint(provider, rawEndpoint);
  if (
    !endpoint ||
    !settings.model ||
    (!settings.apiKey && provider !== "ollama")
  )
    return {
      ok: false,
      error:
        "请先在 Settings 填写 AI endpoint、模型，以及（Ollama 以外的）API key。",
    };
  const language = aiResponseLanguage(settings);
  // A full paragraph translation can legitimately be longer than an
  // explanation. Reserve enough output room for the no-omission contract.
  const maxOutputTokens = test
    ? 128
    : /Translate every sentence in the selected text completely/i.test(
          String(instruction || ""),
        )
      ? 4000
      : 2200;
  const prompt = test
    ? "Reply with exactly: LeafReader AI connected."
    : `${instruction}\n\nText:\n${text}\n\nContext:\n${context}`;
  const priorMessages = Array.isArray(history)
    ? history
        .filter(
          (message) =>
            ["user", "assistant"].includes(message?.role) &&
            typeof message.content === "string",
        )
        .slice(-10)
    : [];
  const messages = test
    ? [
        {
          role: "user",
          content: "Reply with exactly: LeafReader AI connected.",
        },
      ]
    : [
        {
          role: "system",
          content: `You are a concise reading assistant. Reply in ${language}.`,
        },
        ...priorMessages,
        {
          role: "user",
          content: `${instruction}\n\nText:\n${text}\n\nContext:\n${context}`,
        },
      ];
  try {
    let request;
    if (provider === "anthropic")
      request = {
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
    else if (provider === "gemini")
      request = {
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
          generationConfig: {
            maxOutputTokens: maxOutputTokens,
            temperature: 0.2,
          },
        },
        read: (data) =>
          data.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join(""),
      };
    else if (provider === "ollama")
      request = {
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
    else
      request = {
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), test ? 30000 : 60000);
    let response;
    try {
      response = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        ok: false,
        error: `请求失败（HTTP ${response.status}）：${data.error?.message || data.message || "服务端未返回可读错误。"}`,
      };
    const content = request.read(data);
    if (!content) {
      const topLevel = Object.keys(data).slice(0, 10).join(", ") || "none";
      const choiceLevel = data.choices?.[0]
        ? Object.keys(data.choices[0]).slice(0, 10).join(", ")
        : "none";
      const messageLevel = data.choices?.[0]?.message
        ? Object.keys(data.choices[0].message).slice(0, 10).join(", ")
        : "none";
      const finishReason = data.choices?.[0]?.finish_reason || "none";
      return {
        ok: false,
        error: `请求成功，但没有找到文本内容。响应字段：${topLevel}；首个 choice 字段：${choiceLevel}；message 字段：${messageLevel}；结束原因：${finishReason}。请确认供应商类型、endpoint 和模型名称。`,
      };
    }
    const finishReason =
      data.choices?.[0]?.finish_reason ||
      data.stop_reason ||
      data.candidates?.[0]?.finishReason ||
      data.done_reason ||
      "";
    const truncated = /(?:length|max.?tokens?)/i.test(String(finishReason));
    const completed = `${String(content)}${truncated ? "\n\n> 回答达到模型的输出长度上限，可能未完整结束。请在下方继续追问“继续”。" : ""}`;
    return {
      ok: true,
      content: completed,
      endpoint: request.endpoint,
      truncated,
    };
  } catch (error) {
    return { ok: false, error: `无法连接到 AI 服务：${error.message}` };
  }
}

export { providerEndpoint, requestAI, textFromModelResponse };
