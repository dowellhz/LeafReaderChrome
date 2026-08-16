const fields = ["language", "provider", "endpoint", "model", "apiKey", "font"];
const providers = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini",
    help: "OpenAI Chat Completions API。",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    help: "DeepSeek API；提供 Flash（更快）和 Pro（更强）模型。",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4.1-mini",
    help: "OpenRouter OpenAI-compatible API；模型使用 provider/model 格式。",
    models: [
      "openai/gpt-4.1-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.5-flash",
    ],
  },
  qwen: {
    endpoint:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    help: "阿里云百炼的 OpenAI 兼容模式。",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    help: "Groq OpenAI-compatible API。",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  siliconflow: {
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen2.5-7B-Instruct",
    help: "SiliconFlow OpenAI-compatible API。",
    models: ["Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-3-5-haiku-latest",
    help: "Anthropic Messages API。",
    models: ["claude-3-5-haiku-latest", "claude-sonnet-4-20250514"],
  },
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    help: "Gemini API；扩展会根据模型自动构造 generateContent 请求。",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  ollama: {
    endpoint: "http://localhost:11434/api/chat",
    model: "llama3.2",
    help: "本机 Ollama。无需 API key；请确保 Ollama 正在运行且模型已下载。",
    models: ["llama3.2", "qwen2.5", "deepseek-r1"],
  },
  azure: {
    endpoint: "",
    model: "",
    help: "填写完整 Azure deployment URL，例如 https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=2024-10-21。模型填 deployment 名称。",
    models: [],
  },
  custom: {
    endpoint: "",
    model: "",
    help: "任何返回 OpenAI Chat Completions 格式的服务。填写完整 endpoint，或填写以 /v1 结尾的基础地址。",
    models: [],
  },
};
const $ = (id) => document.querySelector(`#${id}`);
const currentSettings = () =>
  Object.fromEntries(fields.map((id) => [id, $(id).value.trim()]));
const showStatus = (message, error = false) => {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", error);
};
function downloadBackup(backup) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `leafreader-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function applyProvider(preserveValues = false) {
  const config = providers[$("provider").value] || providers.custom;
  if (!preserveValues || !$("endpoint").value)
    $("endpoint").value = config.endpoint;
  if (!preserveValues || !$("model").value) $("model").value = config.model;
  $("endpointHelp").textContent = config.help;
  $("keyRow").querySelector("input").placeholder =
    $("provider").value === "ollama" ? "Not needed for Ollama" : "API key";
  $("keyRow").classList.toggle("optional", $("provider").value === "ollama");
  $("modelSuggestions").replaceChildren(
    ...config.models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }),
  );
}
(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (
    settings.provider === "deepseek" &&
    settings.endpoint === "https://api.deepseek.com/v1/chat/completions"
  ) {
    settings.endpoint = providers.deepseek.endpoint;
    await chrome.storage.local.set({ settings });
  }
  for (const id of fields)
    $(id).value =
      settings[id] ||
      { language: "auto", font: "serif", provider: "openai" }[id] ||
      "";
  applyProvider(true);
})();
$("provider").onchange = () => {
  const config = providers[$("provider").value];
  $("endpoint").value = config.endpoint;
  $("model").value = config.model;
  applyProvider(true);
};
$("save").onclick = async () => {
  await chrome.storage.local.set({ settings: currentSettings() });
  showStatus("Saved");
  setTimeout(() => showStatus(""), 1800);
};
$("test").onclick = async () => {
  const button = $("test");
  await chrome.storage.local.set({ settings: currentSettings() });
  button.disabled = true;
  showStatus("Testing AI connection…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "AI_TEST" });
    showStatus(
      result?.ok
        ? `Connected: ${result.content}`
        : result?.error || "No response from extension background.",
      !result?.ok,
    );
  } catch (error) {
    showStatus(`Test failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
};
$("exportData").onclick = async () => {
  const button = $("exportData");
  button.disabled = true;
  try {
    const {
      settings = {},
      annotations = [],
      vocabulary = [],
    } = await chrome.storage.local.get([
      "settings",
      "annotations",
      "vocabulary",
    ]);
    const { aiConversations, sidePanelThreads } =
      await window.LeafReaderPanelStore.exportData();
    const exportedSettings = { ...settings };
    if (!$("includeApiKey").checked) delete exportedSettings.apiKey;
    const documents = await window.LeafReaderLibraryStore.readAll();
    downloadBackup({
      format: "leafreaderchrome-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      includesApiKey: Boolean($("includeApiKey").checked),
      settings: exportedSettings,
      annotations,
      vocabulary,
      aiConversations,
      sidePanelThreads,
      documents,
    });
    showStatus(
      `Exported ${documents.length} webpages, ${annotations.length} annotations, and ${vocabulary.length} words.`,
    );
  } catch (error) {
    showStatus(`Could not export backup: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
};
$("importData").onchange = async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const backup = window.LeafReaderBackup.validateBackup(
      JSON.parse(await file.text()),
      file.size,
    );
    if (
      !confirm(
        `Restore ${backup.documents.length} webpages, ${backup.annotations.length} annotations, and ${backup.vocabulary.length} words? Current LeafReader data will be replaced.`,
      )
    )
      return;
    const { settings: current = {} } =
      await chrome.storage.local.get("settings");
    const restoredSettings = { ...(backup.settings || {}) };
    if (!backup.includesApiKey) restoredSettings.apiKey = current.apiKey || "";
    await chrome.storage.local.set({
      settings: restoredSettings,
      annotations: backup.annotations,
      vocabulary: backup.vocabulary,
    });
    await window.LeafReaderPanelStore.replaceData(backup);
    await window.LeafReaderLibraryStore.replaceAll(backup.documents);
    for (const id of fields)
      $(id).value =
        restoredSettings[id] ||
        { language: "auto", font: "serif", provider: "openai" }[id] ||
        "";
    applyProvider(true);
    showStatus("Backup restored. Reopen the library to see restored webpages.");
  } catch (error) {
    showStatus(`Could not restore backup: ${error.message}`, true);
  }
};
$("runDiagnostics").onclick = async () => {
  const output = $("diagnostics");
  const button = $("runDiagnostics");
  button.disabled = true;
  output.textContent = "Checking…";
  output.classList.remove("error");
  try {
    const { annotations = [], vocabulary = [] } =
      await chrome.storage.local.get(["annotations", "vocabulary"]);
    const { aiConversations, sidePanelThreads } =
      await window.LeafReaderPanelStore.exportData();
    const documents = await window.LeafReaderLibraryStore.readAll();
    const voices = speechSynthesis.getVoices();
    const bytes = await chrome.storage.local.getBytesInUse();
    const configured = Boolean(
      currentSettings().endpoint &&
      currentSettings().model &&
      (currentSettings().apiKey || currentSettings().provider === "ollama"),
    );
    output.textContent = `Extension ${chrome.runtime.getManifest().version} · ${documents.length} webpages · ${annotations.length} annotations · ${vocabulary.length} words · ${Object.keys(aiConversations).length} AI conversations · ${Object.keys(sidePanelThreads).length} page trails · ${voices.length} browser voices · ${(bytes / 1024).toFixed(1)} KB local storage · AI ${configured ? "configured" : "not configured"}.`;
  } catch (error) {
    output.textContent = `Diagnostics failed: ${error.message}`;
    output.classList.add("error");
  } finally {
    button.disabled = false;
  }
};
