# LeafReader desktop ↔ LeafReader Chrome：功能差距审计

更新：2026-08-16  
比较对象：本机 **Leaf Reader 1.7.10**（`/Applications/Leaf Reader.app`）与本项目当前工作区 `leafreaderchrome`。本项目当前产品范围已明确为**网页阅读**，不再以 PDF、EPUB 或 DOCX 本地文档能力作为交付目标。

## 结论

Chrome 版目前是一个**以网页为边界的阅读辅助扩展**，不是桌面 Leaf Reader 的完整移植。

它覆盖了网页划词、Chrome 原生右侧栏、AI、笔记/词汇记录、网页阅读模式、朗读、备份与恢复；仍不追求桌面版的本地文档、离线词典和本地语音引擎对等能力。

本文中“已实现”指仓库中已有代码。已完成 JavaScript/Manifest 静态检查，以及隔离 Chrome 中的真实网页回归：内容脚本注入、划词工具栏、原生 Side Panel、笔记保存与页面标注、网页提取进入阅读器、词汇 lemma 归并、设置诊断、备份导出与恢复均无运行时异常。AI 流程以仅在本机监听的 OpenAI-compatible mock 验证请求、`choices[0].message.content` 解析、Anthropic/Gemini/Ollama 原生请求路径和 Markdown 侧栏渲染；另有一次用户授权的 DeepSeek Flash 最小真实连通性测试成功。测试配置均使用隔离浏览器配置文件并在结束时清除。

## 对比总表

| 领域 | 桌面 Leaf Reader | Chrome 当前状态 | 差距等级 |
| --- | --- | --- | --- |
| 网页划词与右侧 AI view | 原生选择回调、右侧 AI view、选区定位 | 划词菜单 + Chrome 原生 Side Panel | 部分实现 |
| 网页沉浸阅读 | 读取、搜索、位置恢复、标记恢复 | 文章提取、阅读模式、搜索、进度 | 部分实现 |
| PDF / EPUB / DOCX | 本地文档阅读与定位 | 不在本项目网页版范围 | 不适用 |
| 本地词典 | 内置 ECDICT，词性/音标/频率/词形 | 在线 English Dictionary API，失败无离线回退 | **P1** |
| 词汇学习 | 个人词库画像、频次、置信度、学习状态、SRS | 保存词条与可选释义 | **P1** |
| 笔记 | Markdown、收藏、精确 locator、导出 | 纯文本笔记/高亮，定位不可靠，无导出 | **P1** |
| TTS | Kokoro/Piper/Supertonic 等本地运行时、声音下载、分句和朗读高亮 | 浏览器 `SpeechSynthesis` | **P1** |
| AI 对话与提示 | 单词/段落/难句/翻译/总结/追问/文档 Agent；会话保存和导出 | 翻译、解释、总结；结果一次性展示 | **P1** |
| 文档 Agent | Embeddings、检索缓存、章节/页码依据 | 未实现 | **P0** |
| 模型提供方 | OpenAI、Azure、Claude、本地 OpenAI 兼容等 | OpenAI 兼容、Claude、Gemini、Ollama 与多家预设 | 部分实现 |
| 数据与可迁移性 | SQLite、缓存、备份/恢复、Keychain 凭据 | IndexedDB + `chrome.storage.local` | **P1** |
| 自动化质量保障 | 未从安装包中确认测试范围 | 静态检查 + 隔离 Chrome 网页划词/Side Panel 冒烟测试 | 部分实现 |

## 当前 Chrome 版已实现的能力

### 网页与界面

- 从当前网页提取 `article` / `main` 等候选正文，进入独立沉浸阅读页。
- 当前网页划词显示操作菜单：翻译、词典、保存单词、高亮、笔记、朗读、AI 解释。
- 使用 Chrome 原生 Side Panel 承载划词结果、AI 文本与笔记编辑，而非网页浮层。
- 阅读页提供书架、最近打开排序、阅读进度、字体/行高/宽度、深色模式与页内搜索。

### 文件与记录

- 文档内容存入 IndexedDB；设置、笔记与词汇存入 `chrome.storage.local`。
- 支持基本高亮、笔记和个人词汇记录。

### AI 与 TTS

- AI 请求通过扩展 Service Worker 发送，避免内容脚本受目标网页 CORS 限制。
- 可选供应商：OpenAI、DeepSeek、OpenRouter、通义千问兼容接口、Groq、SiliconFlow、Anthropic、Gemini、Ollama、Azure OpenAI 和自定义 OpenAI 兼容接口。
- 设置页有 **Test AI connection**，复用实际调用协议做最小请求并显示错误。
- TTS 使用浏览器原生 `SpeechSynthesis`；网页划词使用语言字符判断，阅读页根据界面语言选择 `zh-CN` 或 `en-US`。

## 未实现或仅部分实现的功能

### P0：应先完成

#### 1. 网页文章问答与检索质量

桌面版包含 OpenAI、Jina、Voyage embeddings 设置，以及“Current Book AI Analysis Data”和可清除的分析缓存。AI 提示也要求以当前页、章节、邻近页和检索结果为证据并标注页码。

Chrome 版已对网页正文分块并以关键词检索相关片段，回答可用 `[S1]` 等来源编号跳回正文；它没有也不会建立 PDF 页码或本地文档索引。

待补：可选的语义向量检索、来源覆盖率提示，以及对低相关度回答的明确降级提示。

#### 2. 自动化与真实浏览器测试

已验证内容脚本注入、划词菜单和原生 Side Panel 打开。仍未覆盖 Chrome 存储写入、朗读状态和不同 AI 协议的自动回归。

建议：

- 单元测试：endpoint 规范化、各供应商请求/响应解析、标注锚点恢复。
- Chrome E2E：用 Playwright 载入未打包扩展，验证划词菜单、Side Panel、笔记保存和阅读进度。
- 网络 mock：覆盖 OpenAI-compatible、Anthropic、Gemini、Ollama 的成功、401、429、超时和错误格式。
- 手动回归：中文/英文 TTS、Chrome 重启后的记录恢复、动态网页更新后的标注重定位。

### P1：核心阅读体验差距

#### 3. 标注、笔记与定位

桌面版笔记表存储 `locator_json`、更新时间和收藏状态；网页端脚本可恢复高亮、跳到记录、移除记录，且记录词汇的上下文、出现序号和滚动进度。

Chrome 版保存 quote/context，但网页刷新后不会对普通网页自动恢复标记；Side Panel 中新建的笔记也不会通知页面添加高亮。没有收藏、编辑、按文档筛选、跳转、删除网页标记、Markdown、图片占位或导出。

建议：采用 `URL + content fingerprint + normalized text range + occurrence index + surrounding context` 的锚点模型；加入标记恢复/冲突提示、笔记编辑和 Markdown/JSON 导出。网页 DOM 变化时需提供“重新定位”能力。

#### 4. 词典、个人词汇与复习

桌面版内置 `ECDICT/ecdict.db`；个人词库记录 lemma、词形出现次数、查询次数、AI 解释次数、文档覆盖数、掌握置信度、学习状态和复习正误。

Chrome 版依赖一个在线英文词典；仅保存一个词和可选定义，缺少词形归并、中文释义、频率标签、学习列表、SRS/复习和词汇统计。

建议：将 ECDICT 转为扩展可查询的压缩索引或 IndexedDB；实现 lemma 化、重复合并、词汇卡片和间隔重复。在线 AI 应是补充而不是唯一词典。

#### 7. TTS

桌面版资源包含 Kokoro CoreML、Piper、Supertonic、KittenTTS 等运行时、声音清单、下载/校验、诊断、音频缓存；网页脚本会分句并使用 `leaf-reader-tts` 高亮当前朗读句。

Chrome 版只调用 `SpeechSynthesisUtterance`：

- 依赖 Chrome / macOS 当前可用声音，某些声音可能是联网声音；
- 没有声音选择、语速/音高、暂停/恢复、队列、断点续读；
- 阅读页把正文截断到 18,000 字符，未分句；
- 没有当前句高亮、音频缓存、离线模型或诊断。

建议：近期先补语音选择、速率、暂停/继续、可靠分句和随读高亮；中长期若需要离线高质量语音，需单独设计 native host 或远程 TTS 服务，Chrome 扩展本身不能直接复用 macOS App 的 CoreML 二进制。

#### 8. AI 工作流与对话管理

桌面版提示覆盖单词、句段解释、难句拆解、翻译、总结、追问、阅读区提问、文档 Agent、笔记续写和笔记 Markdown 整理；还支持保存和导出 AI 会话、AI 来源下划线。

Chrome 版有翻译、解释、阅读摘要和一次性的全局提问，缺少：

- 难句结构分析的专用入口；
- 可继续的 AI 聊天历史与会话导出；
- 笔记续写/整理；
- 回答和原文之间的可点击来源标记；
- 依文档当前页、章节和检索结果约束回答。

建议：先实现每文档 AI 会话和 Markdown 导出，再实现提示模板选择、来源引用和 Agent 检索。

### P2：完善与运营能力

- 书架封面提取、收藏夹、集合/标签、文档删除确认、导入拖放。
- EPUB 目录、章节导航、阅读统计、快捷键和更完整的主题排版。
- 设置的导入/导出、笔记和词汇的备份/恢复、存储用量和清理页面。
- API Key 使用更合适的加密凭据存储；Chrome `storage.local` 不等同于桌面版 Keychain。
- 诊断页：模型请求、TTS 声音、文档解析、存储迁移和错误日志。
- 国际化、无障碍、隐私说明、权限最小化与 Chrome Web Store 发布材料。

## 模型提供方：兼容性说明

设置页的“多供应商”是协议适配，不表示每个模型的所有高级能力都完成：

| 协议 | 当前实现 | 限制 |
| --- | --- | --- |
| OpenAI-compatible | Chat Completions + Bearer key | 不支持 Responses API、流式输出、工具调用、图像输入 |
| Azure OpenAI | Chat Completions + `api-key` | 需要用户提供完整 deployment URL；未单独管理 API version |
| Anthropic | Messages API | 文本请求；没有流式、缓存控制或工具调用 |
| Gemini | `generateContent` | 文本请求；没有安全设置、流式或多模态 |
| Ollama | `/api/chat` | 需要本机服务；没有模型发现、下载或健康检查以外的管理 |

“Test AI connection”是所有请求共同路径的小请求，适合验证 endpoint、模型、key 和协议基本可用；它不能替代长上下文、限流、流式、代理或各模型实际回答质量的测试。

## 推荐实施顺序

1. **网页稳定性基线**：扩展重载、Side Panel、划词与各 AI 协议的回归。
2. **网页锚点与笔记闭环**：恢复、跳转、编辑、收藏、删除与导出。
3. **词典与复习**：lemma 归并、词汇卡、统计、间隔复习；AI 只是补充。
4. **TTS 控制与分句高亮**：声音、速率、暂停/继续、断点续读。
5. **AI 网页工作流**：提示模板、会话、来源引用、保存与导出。
6. **备份、诊断、隐私审计与发布**。

## 交付路线图与验收条件

以下路线图是 Chrome 版的实际开发计划。每一阶段完成前，下一阶段不会被视作“已经具备”。

| 阶段 | 范围 | 完成定义 |
| --- | --- | --- |
| 0. 稳定性基线 | 扩展重载安全、原生 Side Panel、AI 测试、Markdown、静态回归与手动回归清单 | 语法/Manifest 检查通过；重载后旧页面不会抛未处理异常；Chrome GUI 中可验证划词、侧栏、笔记和设置 |
| 1. 网页注释与数据可携带 | URL + 精确文本 + 前后上下文 + 文本位置锚点；恢复/跳转、编辑笔记、收藏、Markdown/JSON 导出 | 刷新或重启后仍能恢复；导出的数据可读且可重新导入 |
| 2. 词典与复习 | 本地词典索引、lemma 归并、词汇卡、统计、间隔复习 | 无 AI 时可查常见英语词；同一词不重复建档；可完成一轮复习 |
| 3. TTS | 声音与速率选择、暂停/继续、分句、当前句高亮、断点恢复 | 中英文长网页可稳定控制朗读；不重复朗读或截断正文 |
| 4. AI 阅读工作流 | 提示模板、会话、原文来源、导出 | 回答可追溯到网页原文；会话可继续和导出 |
| 5. 发布质量 | 备份/恢复、诊断、隐私/权限审计、无障碍、打包说明 | 新机器可安装、数据可迁移、失败有可操作错误提示 |

### 阶段 0 的当前状态

- 已修复：旧版重复创建右键菜单导致的 Service Worker 报错；划词菜单改为扩展内浮动菜单，结果使用 Chrome 原生 Side Panel。
- 已修复：扩展重新加载后，旧 content script 的消息发送会安全失败而不是留下未处理 Promise。
- 已补：多供应商 AI 配置、连接测试、DeepSeek Flash/Pro 预设、自动跟随 Chrome 界面语言、AI Markdown 渲染。
- 自动测试限制：本机 Chrome 151 的 headless 临时扩展会拦截 extension URL（`ERR_BLOCKED_BY_CLIENT`），不能可靠验证 Side Panel。因此 Side Panel、用户手势与扩展重载仍保留 GUI 手动验收；代码同时保持 Node 语法/Manifest 静态回归。

### 阶段 1 的进行状态

- 已实现：网页划词记录保存精确文本、前后 80 个字符和文本位置；刷新页面以及 SPA/异步正文稳定更新后会重新定位并恢复高亮、笔记与已保存单词。
- 已实现：从 Side Panel 保存笔记会把锚点一并写入，并立即通知原网页绘制笔记标记；阅读库可编辑、收藏、删除、打开原网页、导出 Markdown 或 JSON。
- 待验收：动态内容大幅改版时的重新定位提示；跨 iframe、受限页面与复杂 Shadow DOM 的降级提示。

### 词汇与朗读的进行状态

- 已实现：词形归并、跨网页词条合并、出现次数/上下文、掌握状态、到期复习、记住/重来操作与 JSON 导出；AI 或在线兜底词典的释义会写回已保存词条，词库页也可直接再次查询。
- 已实现：浏览器可用声音选择、语速、逐句长文本队列、当前朗读句高亮、暂停/继续、声音切换和跨阅读页断点续读；不再把正文截断为固定的 18,000 字。
- 待补：内置离线词典、词汇卡片正反面模式，以及不同浏览器声音的诊断。

### AI 网页工作流的进行状态

- 已实现：划词翻译、释义和解释的 Side Panel 对话；可在原文上下文中继续追问，最近十轮消息会随实际供应商协议一起发送，并以 Markdown 导出或清除。
- 已实现：对话按选区保存到本机 `chrome.storage.local`，不会上传到除用户配置的 AI 提供商之外的地方。
- 已实现：网页阅读器会按整篇正文按句子/词边界分块检索，并要求总结/问答以 `[S1]` 等来源编号标注依据；阅读器与 Side Panel 都会安全渲染常用 Markdown，阅读器中的来源编号可点击并跳回原文片段。
- 已实现：Side Panel 顶部可打开本机 AI 会话列表，恢复任一网页选区的对话并继续追问。

### 数据管理的进行状态

- 已实现：设置页可导出或恢复网页书架、标注、词汇和 AI 会话；默认不导出 API key，只有主动勾选才会包含。
- 恢复会先要求明确确认，并替换 LeafReader 自己的 IndexedDB 书架和扩展本地数据，不会触及网页或 Chrome 的其他数据。
- 已实现：本机诊断会显示扩展版本、网页/笔记/词汇/会话数量、可用浏览器声音、本地存储用量和 AI 配置状态，不上传阅读内容。

## 审计依据

此文档依据本机桌面 Leaf Reader 1.7.10 的公开安装资源和本地数据结构编写，未读取用户的阅读内容或 API Key。主要证据包括：

- `Info.plist`：PDF、EPUB、DOCX 文档类型。
- `Resources/ECDICT/ecdict.db`、`AIPrompts.json`、`speech-models-manifest.json` 和 `reader-web-*.js`。
- `reading-notes.sqlite`、`personal-vocabulary.sqlite3`、`word-records.sqlite3` 的 schema。
- 安装包中与 PDF embeddings、AI 会话导出、DOCX/EPUB 处理、本地 TTS 下载/诊断相关的公开字符串。

安装包字符串只能用于确认功能面，不应被当作桌面版内部实现的完整或稳定 API 文档。
