# VaultPilot

VaultPilot 是一个面向 Obsidian 的知识库 Agent 插件，用于在本地 vault 中进行自然语言问答、笔记检索、来源检查、相关笔记推荐和连续对话辅助。

这个项目的定位不是重新做一个 Obsidian，而是在 Obsidian 已有的文件、链接、命令和侧边栏能力之上，构建一个可解释、可扩展、适合学习 Agent 工程的插件。

## 核心能力

- 在 Obsidian 右侧边栏打开 Agent 对话视图。
- 检索当前 vault 中的 Markdown 笔记。
- 基于检索到的来源回答问题，并展示来源。
- 读取当前笔记并解释内容。
- 为当前笔记推荐相关 `[[wikilinks]]`。
- 支持中文、英文以及中英混合查询的基础分词。
- 支持本地检索模式，无需 API key。
- 支持 OpenAI-compatible Chat Completions 接口，可配置 DeepSeek、OpenRouter、LM Studio、本地网关等兼容服务。
- 支持工具调用模式，让模型按需读取当前笔记、搜索笔记、检查文件夹、分类文件、读写记忆。
- 支持流式输出和过程面板，展示 Agent 的处理状态与工具调用结果。
- 支持分层 Memory 系统，包括长期档案记忆、会话线程摘要、滑动窗口和跨线程回忆。

## 为什么做这个项目

VaultPilot 的目标是把 Obsidian vault 变成一个可交互的个人知识 Agent：

- Obsidian 负责笔记、文件、链接和本地工作流。
- VaultPilot 负责理解问题、调用工具、检索证据、组织上下文和生成回答。
- Memory 系统负责保存用户偏好、项目事实、历史决策和会话摘要。

它更像一个学习型 Agent 工程项目：既能作为可用插件运行，又能清楚展示 RAG、tool calling、context management、memory、evaluation 等 Agent 系统关键模块。

## 当前架构概览

主要模块：

- `src/main.ts`：插件入口，初始化设置、索引、工具、MemoryStore、ThreadStore 和 Obsidian 命令。
- `src/ui/view.ts`：右侧 Agent 视图，负责用户输入、流式输出、过程面板、当前线程和上下文拼接。
- `src/agent/`：Agent Runner、工具注册、工具执行和 tool calling 类型。
- `src/rag/`：笔记分词、索引、查询改写、检索、评估相关逻辑。
- `src/memory/`：长期记忆、会话线程、上下文路由和 memory 单元测试。
- `src/services/`：对 vault 笔记与检索服务的封装。
- `docs/`：体验升级计划、Agent 学习日志、Memory 系统设计文档等。

## Memory 系统

VaultPilot 已实现基础的工程化 Memory 系统：

- 长期记忆：`VaultPilot/Memory.md`
  - `Preferences`
  - `Environment`
  - `Project Facts`
  - `Confirmed Decisions`
  - `Archived`
- 会话线程：`VaultPilot/Threads/<thread-id>/`
  - `metadata.json`
  - `transcript.jsonl`
  - `summary.md`
- 短期上下文：UI 内存中的 sliding window。
- 跨线程回忆：按关键词、标题命中和更新时间检索历史 thread summary。
- 记忆工具：
  - `read_profile`
  - `remember_profile`
  - `update_profile`
  - `forget_profile`
  - `read_thread_summary`
  - `search_threads`

详细设计见：

```text
docs/memory-system-design.md
```

## Agent 工具

当前工具能力包括：

- `get_current_note`：读取当前激活的 Markdown 笔记。
- `search_notes`：根据模型生成的查询检索 vault 笔记。
- `read_note`：按 vault 相对路径读取笔记。
- `inspect_folder`：基于索引检查文件夹结构和文件摘要。
- `classify_folder_files`：按语义类别统计和分类文件夹中的 Markdown 文件。
- `suggest_links`：为当前笔记推荐相关笔记链接。
- `read_profile` / `remember_profile` / `update_profile` / `forget_profile`：读写长期记忆。
- `read_thread_summary` / `search_threads`：读取当前线程摘要或搜索历史线程。

## 本地开发安装

1. 将本目录克隆或复制到 Obsidian vault 的插件目录：

   ```text
   YourVault/.obsidian/plugins/vaultpilot
   ```

2. 安装依赖：

   ```bash
   npm install
   ```

3. 构建插件：

   ```bash
   npm run build
   ```

4. 在 Obsidian 中打开社区插件，并启用 `VaultPilot`。

5. 打开命令面板，运行：

   ```text
   Open agent
   ```

## 常用命令

Obsidian 命令：

- `Open agent`：打开 VaultPilot 侧边栏。
- `Suggest links for current note`：为当前笔记推荐链接。
- `Rebuild index`：重建索引。
- `Clear index cache`：清除索引缓存。
- `Open memory`：打开长期记忆文件。
- `Open current thread summary`：打开当前会话线程摘要。
- `Start new thread`：下一次提问开启新线程，避免上下文串线。
- `Start Ollama`：尝试启动本地 Ollama。
- `Check Ollama status`：检查 Ollama 服务状态。

开发命令：

```bash
npm run build
npm run dev
npm run lint
npm test
```

## 设置说明

VaultPilot 支持多种运行方式：

- 本地检索模式：不需要 API key，使用本地索引生成基于来源的回答。
- OpenAI-compatible 模式：将检索到的笔记片段和上下文发送给兼容 Chat Completions 的模型服务。
- 本地/远程 embedding 配置：用于笔记 RAG 索引；注意当前 Memory 系统本身没有使用向量库。

默认 Chat Completions endpoint：

```text
https://api.openai.com/v1/chat/completions
```

兼容服务可以包括 DeepSeek、OpenRouter、LM Studio 或暴露相同请求格式的本地网关。

## 测试与验证

当前项目包含针对 Memory 系统的轻量测试：

```bash
npm test
```

覆盖内容包括：

- 长期记忆分区写入。
- 精确去重。
- 相似记忆更新。
- 按 query 更新。
- 归档遗忘。
- 记住/忘记指令解析。
- 新话题不注入旧上下文。
- 追问、纠正、历史回忆的上下文路由。

构建与 lint：

```bash
npm run build
npm run lint
```

## 当前状态

VaultPilot 已经从基础 MVP 演进为一个具备 RAG、tool calling、流式输出、过程面板和基础 Memory 系统的 Obsidian Agent 插件。

仍可继续优化的方向：

- 更强的检索 rerank 和 relevance gate。
- 面向失败样例的 RAG regression eval。
- 更精细的 token-aware context budget。
- LLM-based memory consolidation。
- 更完整的隐私删除和多用户隔离机制。
- 更成熟的 UI polish 和交互体验。

