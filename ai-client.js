import {
  buildProviderRequest,
  providerEndpoint,
  responseFinishReason,
  textFromModelResponse,
} from "./ai-providers.js";

function aiResponseLanguage(settings) {
  const selected =
    settings.language === "auto" || !settings.language
      ? chrome.i18n.getUILanguage()
      : settings.language;
  return /^zh(?:-|$)/i.test(selected) ? "简体中文" : "English";
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
    const request = buildProviderRequest({
      provider,
      endpoint,
      settings,
      messages,
      prompt,
      test,
      language,
      maxOutputTokens,
    });
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
      const finishReason = responseFinishReason(data) || "none";
      return {
        ok: false,
        error: `请求成功，但没有找到文本内容。响应字段：${topLevel}；首个 choice 字段：${choiceLevel}；message 字段：${messageLevel}；结束原因：${finishReason}。请确认供应商类型、endpoint 和模型名称。`,
      };
    }
    const finishReason = responseFinishReason(data);
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
