# HexClaw Desktop 使用指南

## 目录

- [安装与首次启动](#安装与首次启动)
- [界面概览](#界面概览)
- [AI 对话](#ai-对话)
- [Agent 管理](#agent-管理)
- [Skill 系统](#skill-系统)
- [工作流画布](#工作流画布)
- [MCP 工具集成](#mcp-工具集成)
- [知识库](#知识库)
- [记忆系统](#记忆系统)
- [定时任务](#定时任务)
- [团队协作](#团队协作)
- [设置与配置](#设置与配置)
- [快捷键](#快捷键)
- [系统托盘](#系统托盘)
- [故障排查](#故障排查)

---

## 安装与首次启动

### 系统要求

| 平台 | 最低版本 |
|------|---------|
| macOS | 11.0 (Big Sur) 及以上 |
| Windows | 10 (1809) 及以上 |
| Linux | Ubuntu 20.04 / Fedora 36 及以上 |

### 安装方式

**macOS (Homebrew)**

```bash
brew tap everyday-items/tap
brew install --cask hexclaw
```

**macOS / Windows / Linux (手动下载)**

1. 前往 [GitHub Releases](https://github.com/everyday-items/hexclaw-desktop/releases) 页面
2. 下载对应平台安装包：
   - macOS: `.dmg` 文件，双击打开后拖入 Applications
   - Windows: `.msi` 或 `.exe` 安装程序
   - Linux: `.deb` (Debian/Ubuntu) 或 `.AppImage`
3. 启动 HexClaw

### 首次启动

1. **启动应用** — 双击 HexClaw 图标
2. **等待引擎就绪** — 侧边栏底部状态指示灯从红色变为绿色 (Engine running)
3. **配置 LLM** — 进入 **设置 → LLM 配置**，选择 Provider 并填入 API Key
4. **开始对话** — 切换到聊天页面，发送第一条消息

> **提示**: 即使未配置 LLM API Key，HexClaw 引擎也能正常启动。此时可以浏览界面、管理 Agent 和 Skill，但 AI 对话功能将不可用。

### macOS 安全提示

首次打开可能弹出"无法验证开发者"提示。解决方法：

- **方法 A**: 系统设置 → 隐私与安全性 → 找到 HexClaw → 点击"仍要打开"
- **方法 B**: 终端执行 `xattr -cr /Applications/HexClaw.app`

---

## 界面概览

HexClaw 采用经典的三栏布局：

```
┌──────────────────────────────────────────────────────┐
│  标题栏 (HexClaw Logo + 窗口控制)                     │
├──────┬───────────────────────────────────────────────┤
│      │                                               │
│ 侧边栏│              主内容区                         │
│      │                                               │
│ 导航  │  (聊天/Agent/设置等页面内容)                   │
│      │                                               │
│      │                                               │
│ ───  │                                               │
│ 状态  │                                               │
│ 设置  │                                               │
└──────┴───────────────────────────────────────────────┘
```

### 侧边栏导航

| 图标 | 页面 | 说明 |
|------|------|------|
| Dashboard | 仪表板 | 系统概览和快速入口 |
| Chat | 对话 | AI 多轮对话 |
| Agents | Agent | Agent 角色管理 |
| Tasks | 任务 | 定时任务管理 |
| Skills | 技能 | 技能市场与管理 |
| Knowledge | 知识库 | RAG 知识管理 |
| Memory | 记忆 | 长期记忆管理 |
| MCP | MCP | 外部工具集成 |
| Logs | 日志 | 实时运行日志 |
| Canvas | 画布 | 工作流编排 |
| Team | 团队 | 多人协作 |
| Settings | 设置 | 应用配置 |

### 引擎状态指示

侧边栏底部显示 HexClaw Engine 运行状态：

- **绿灯 + "Engine running"** — 后端服务正常运行，所有功能可用
- **红灯 + "Engine stopped"** — 后端服务未就绪，AI 功能不可用

---

## AI 对话

### 基本用法

1. 点击侧边栏 **Chat** 进入对话页面
2. 在底部输入框输入消息，按 `Enter` 发送
3. AI 回复支持 Markdown 渲染和代码高亮
4. 使用 `Shift+Enter` 换行输入多行内容

### 会话管理

- **新建会话**: 点击聊天页左侧 "+" 按钮
- **切换会话**: 在会话列表中点击历史会话
- **搜索会话**: 使用搜索功能查找历史对话内容
- **导出会话**: 支持导出聊天记录

### 模型选择

支持以下 LLM Provider：

| Provider | 模型示例 |
|----------|---------|
| OpenAI | gpt-4o, gpt-4o-mini |
| DeepSeek | deepseek-chat, deepseek-coder |
| Anthropic | claude-sonnet-4-20250514 |
| Google Gemini | gemini-2.0-flash |
| 通义千问 | qwen-max, qwen-plus |
| 豆包 (Ark) | doubao-pro |
| Ollama | llama3, mistral (本地模型) |

在 **设置 → LLM 配置** 中选择 Provider、填入 API Key 和模型名称。

### Quick Chat 快捷聊天

按 `⌘+Shift+H` (macOS) 或 `Ctrl+Shift+H` (Windows/Linux) 可在任意位置唤起快捷聊天窗口，无需切换到主界面即可快速提问。

---

## Agent 管理

### 创建 Agent

1. 进入 **Agents** 页面
2. 点击 "新建 Agent"
3. 填写：
   - **名称** — Agent 的显示名称
   - **目标** — Agent 的工作目标描述
   - **背景故事** — 角色的背景设定和行为规则
4. 保存即可使用

### Agent 角色模板

内置多种预设角色：

| 角色 | 用途 |
|------|------|
| Assistant | 通用助手 |
| Researcher | 信息调研 |
| Writer | 文案写作 |
| Coder | 代码开发 |
| Translator | 翻译 |
| Analyst | 数据分析 |

### 多 Agent 协作

支持多个 Agent 在同一会话中协作，可以通过 Agent 会议模式让多个角色交叉讨论。

---

## Skill 系统

Skill 是 Agent 可调用的外部工具能力。

### 内置 Skill

| Skill | 说明 | 默认状态 |
|-------|------|---------|
| Search | 网络搜索 | 开启 |
| Weather | 天气查询 | 开启 |
| Translate | 翻译 | 开启 |
| Summary | 文本摘要 | 开启 |
| Browser | 网页浏览 | 开启 |
| Code | 代码执行 | **关闭** (高风险) |
| Shell | 命令执行 | **关闭** (高风险) |

### 技能市场

浏览和安装社区贡献的第三方 Skill，支持一键安装/卸载。

---

## 工作流画布

可视化编排 Agent 工作流：

1. 进入 **Canvas** 页面
2. 从左侧面板拖入节点（Agent / Tool / 条件判断等）
3. 连线建立执行流程
4. 点击"运行"执行整个工作流

支持 DAG（有向无环图）执行引擎，自动并行处理无依赖的节点。

---

## MCP 工具集成

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 是标准化的 AI 工具集成协议。

### 添加 MCP Server

1. 进入 **MCP** 页面
2. 点击 "添加服务器"
3. 配置连接方式：
   - **stdio** — 本地进程通信
   - **SSE** — Server-Sent Events
   - **Streamable HTTP** — HTTP 流式传输
4. 连接成功后，该服务器提供的工具会自动注册到 Agent 可用工具列表

### 在设置中配置

在 **设置 → MCP** 中可以配置默认协议和自动重连行为。

---

## 知识库

基于 RAG (Retrieval-Augmented Generation) 的知识管理：

### 上传文档

1. 进入 **知识库** 页面
2. 点击 "上传文档"
3. 支持格式: PDF / Markdown / TXT / DOCX
4. 文档自动解析、分块、向量化

### 使用知识库

在对话中，Agent 会自动检索知识库中的相关内容作为上下文，提供更准确的回答。

---

## 记忆系统

HexClaw 支持跨会话的长期记忆：

- **短期记忆** — 当前会话的上下文 (最多 50 轮，超过后自动摘要)
- **长期记忆** — 跨会话持久化的知识和偏好
- **语义搜索** — 基于向量相似度检索相关记忆

在 **Memory** 页面可以查看、搜索和管理已存储的记忆。

---

## 定时任务

使用 Cron 表达式定期执行 Agent 任务：

1. 进入 **Tasks** 页面
2. 点击 "新建任务"
3. 配置：
   - **名称** — 任务描述
   - **Cron 表达式** — 如 `0 9 * * *` (每天 9:00)
   - **Prompt** — 要执行的 Agent 指令
4. 任务会按计划自动执行，结果通知到系统通知

---

## 团队协作

**Team** 页面提供多用户协作功能：

- 创建和管理工作空间
- 邀请团队成员
- 共享 Agent 配置和会话记录
- 统一管理团队的 LLM 用量和配额

---

## 设置与配置

### LLM 配置

| 选项 | 说明 |
|------|------|
| Provider | LLM 服务商 |
| Model | 模型名称 |
| API Key | 服务商 API 密钥 |
| Base URL | 自定义 API 端点 (可选) |
| Temperature | 生成随机性 (0-2) |
| Max Tokens | 最大输出 Token 数 |

### 安全配置

| 选项 | 说明 |
|------|------|
| 安全网关 | 启用/关闭请求安全检查 |
| 注入检测 | Prompt 注入防护 |
| PII 过滤 | 个人敏感信息自动脱敏 |
| 内容过滤 | 有害内容拦截 |
| 单次 Token 限制 | 每次请求最大 Token |
| 速率限制 | 每分钟最大请求数 |

### 外观设置

- **主题模式**: 浅色 / 深色 / 跟随系统
- 切换后即时生效

### 通知设置

- 系统通知开关
- 声音提醒
- Agent 任务完成通知
- 心跳检测通知

### 运行引擎 (Runtime Engine)

查看后端引擎运行状态，包括：

| 组件 | 说明 |
|------|------|
| HexClaw Engine | Go 后端服务 (端口 16060) |
| Hexagon Agent Engine | AI Agent 核心引擎 |
| ai-core | LLM 能力底座 |

每个组件显示运行状态（绿灯/红灯）、版本号和关键信息。点击刷新按钮可手动刷新状态。

---

## 快捷键

### 全局快捷键

| 快捷键 | 操作 |
|--------|------|
| `⌘+Shift+H` | 唤起 Quick Chat 窗口 |

### 应用内快捷键

| 快捷键 | 操作 |
|--------|------|
| `⌘+1` | 切换到对话页 |
| `⌘+2` | 切换到 Agent 页 |
| `⌘+3` | 切换到任务页 |
| `⌘+N` | 新建对话 |
| `⌘+,` | 打开设置 |
| `⌘+K` | 打开命令面板 |

> Windows/Linux 用户将 `⌘` 替换为 `Ctrl`。

### 命令面板

按 `⌘+K` 打开命令面板，支持模糊搜索快速执行操作：

- 切换页面
- 新建对话/Agent
- 切换主题
- 打开设置

---

## 系统托盘

关闭主窗口时，HexClaw 不会退出而是最小化到系统托盘：

- **左键单击托盘图标** — 显示/隐藏主窗口
- **右键菜单**:
  - 显示主窗口
  - 新建对话
  - 快捷聊天
  - 设置
  - 退出

---

## 故障排查

### 引擎状态红灯 (Engine stopped)

**原因**: HexClaw 后端 Sidecar 进程未启动或不健康。

**排查步骤**:

```bash
# 1. 检查进程是否在运行
ps aux | grep hexclaw

# 2. 检查端口监听
lsof -i :16060

# 3. 手动测试健康检查
curl http://localhost:16060/health
# 应返回: {"status":"healthy"}
```

**常见原因**:
- 端口 16060 被其他进程占用
- hexclaw 二进制文件不存在或损坏
- 权限问题（macOS 安全策略拦截）

### 对话无响应

1. 确认引擎状态为绿灯 (Engine running)
2. 确认已在设置中配置 LLM API Key
3. 检查网络连接（需要访问 LLM Provider API）
4. 查看日志页面获取详细错误信息

### 应用崩溃

查看系统日志：
- macOS: `Console.app` → 搜索 "HexClaw"
- 或直接从终端启动查看日志：

```bash
# macOS
/Applications/HexClaw.app/Contents/MacOS/hexclaw-desktop

# 查看 sidecar 日志
~/.hexclaw/hexclaw.log
```

### 重置应用数据

如需完全重置：

```bash
# 删除应用数据
rm -rf ~/.hexclaw

# 删除应用配置 (Tauri Store)
rm -rf ~/Library/Application\ Support/com.everyday-items.hexclaw
```

> **警告**: 此操作会清除所有对话记录、Agent 配置和记忆数据，不可恢复。

---

## HexClaw Desktop vs OpenClaw 功能对比

[OpenClaw](https://github.com/openclaw/openclaw) 是一个本地优先的个人 AI 助手平台，以超广泛的消息平台接入和本地网关架构著称。HexClaw Desktop 则定位为企业级安全 AI Agent 桌面客户端，强调安全防护和 Agent 编排能力。以下是两者的详细对比：

### 产品定位

| 维度 | HexClaw Desktop | OpenClaw |
|------|----------------|----------|
| 定位 | 企业级安全 AI Agent 桌面客户端 | 本地优先的个人 AI 助手 |
| 目标用户 | 企业用户 / 团队 / 开发者 | 个人用户 / 极客 |
| 核心理念 | 安全 + Agent 编排 + 可视化 | Local + Fast + Always-on |
| 开源协议 | Apache-2.0 | MIT |

### 架构与技术栈

| 维度 | HexClaw Desktop | OpenClaw |
|------|----------------|----------|
| 客户端技术 | Tauri v2 + Vue 3 + TypeScript | Node.js >= 22 + TypeScript |
| 后端引擎 | Go (HexClaw Engine + Hexagon Agent) | Node.js (Gateway + WebSocket) |
| 安装方式 | 原生桌面安装包 (.dmg/.msi/.deb) | `npm install -g openclaw` |
| 运行形态 | 独立桌面应用 (Sidecar 后端) | CLI + 后台守护进程 |
| 数据存储 | SQLite + Qdrant (向量) | 本地文件系统 |
| 通信方式 | Tauri IPC + REST API | WebSocket 控制面 (`ws://127.0.0.1:18789`) |

### LLM Provider 支持

| Provider | HexClaw Desktop | OpenClaw |
|----------|----------------|----------|
| OpenAI | ✅ | ✅ |
| Anthropic (Claude) | ✅ | ✅ |
| DeepSeek | ✅ | ✅ (通过 OpenAI 兼容) |
| Google Gemini | ✅ | ✅ |
| 通义千问 (Qwen) | ✅ | - |
| 豆包 (Ark) | ✅ | - |
| Ollama (本地模型) | ✅ | ✅ |
| 自定义/第三方中转 | ✅ | ✅ (OpenAI 兼容) |
| 多 Provider 管理 | ✅ (OpenCat 标准) | ✅ |
| 聊天区模型切换 | ✅ | ✅ |

### 核心功能对比

| 功能 | HexClaw Desktop | OpenClaw |
|------|----------------|----------|
| AI 多轮对话 | ✅ | ✅ |
| 流式输出 (SSE) | ✅ | ✅ |
| 会话管理 (新建/删除/搜索) | ✅ | ✅ |
| 对话导出 | ✅ | - |
| Agent 角色系统 | ✅ (自定义角色 + 预设模板) | ✅ (多 Agent 路由) |
| 多 Agent 协作 | ✅ (Agent 会议模式) | ✅ (Session 工具协调) |
| 工作流画布 (Canvas) | ✅ (DAG 可视化编排) | ✅ (A2UI 可视化工作区) |
| Skill/技能系统 | ✅ (内置 + 市场) | ✅ (Bundled + Managed + ClawHub) |
| MCP 工具集成 | ✅ (stdio/SSE/HTTP) | - |
| 知识库 (RAG) | ✅ (PDF/MD/TXT/DOCX) | - |
| 长期记忆 | ✅ (语义检索) | ✅ (Context/Memory) |
| 定时任务 (Cron) | ✅ | ✅ (Scheduler) |
| 团队协作 | ✅ | - |
| Token/成本追踪 | - | ✅ |

### 安全特性

| 安全能力 | HexClaw Desktop | OpenClaw |
|---------|----------------|----------|
| 安全网关 | ✅ | - |
| Prompt 注入检测 | ✅ | - |
| PII 自动脱敏 | ✅ | - |
| 内容过滤 | ✅ | - |
| API Key 加密存储 | ✅ (AES-GCM / Tauri Store) | ✅ (本地配置文件) |
| 速率限制 | ✅ | - |
| DM 配对审批 | - | ✅ |

### 消息平台与接入方式

| 接入渠道 | HexClaw Desktop | OpenClaw |
|---------|----------------|----------|
| 桌面原生界面 | ✅ | - |
| Quick Chat 快捷窗口 | ✅ | - |
| 系统托盘 | ✅ | ✅ (菜单栏 App) |
| WhatsApp / Telegram / Slack | - | ✅ |
| Discord / Signal / iMessage | - | ✅ |
| 飞书 / LINE / Teams | - | ✅ |
| WebChat 网页端 | - | ✅ |
| 语音交互 | - | ✅ (唤醒词 + TTS) |

### 部署与运维

| 维度 | HexClaw Desktop | OpenClaw |
|------|----------------|----------|
| 安装方式 | Homebrew / DMG / MSI | npm / Docker / Nix |
| 远程访问 | - | ✅ (SSH / Tailscale) |
| 多设备同步 | - | ✅ (macOS + iOS + Android 节点) |
| 自动更新 | ✅ (Tauri Updater) | ✅ (stable/beta/dev 通道) |
| 浏览器控制 | - | ✅ (Chrome DevTools Protocol) |

### 选择建议

**选择 HexClaw Desktop，如果你需要：**
- 企业级安全防护 (注入检测、PII 过滤、内容审查)
- 可视化 Agent 工作流编排 (DAG Canvas)
- RAG 知识库和语义记忆
- 国内 LLM 原生支持 (通义千问、豆包)
- 团队协作和集中管理
- 精美的原生桌面体验

**选择 OpenClaw，如果你需要：**
- 跨 20+ 消息平台统一管理 AI 助手
- 本地网关 + 远程访问 (Tailscale)
- 语音交互和唤醒词
- 多设备节点协同 (Mac + iPhone + Android)
- 浏览器自动化操作
- 轻量 CLI 驱动，不需要 GUI

### 互补而非替代

HexClaw Desktop 和 OpenClaw 面向不同场景，可以互补使用：

- **OpenClaw** 擅长"连接一切"——统一各消息平台的 AI 交互入口，适合个人用户把所有聊天工具整合到一个 AI 助手
- **HexClaw Desktop** 擅长"安全与编排"——提供企业级安全防护、可视化工作流和知识管理，适合需要精细化控制和团队协作的场景

两者都遵循 **本地优先** 原则，数据不上传第三方服务器，用户完全掌控隐私。

---

## 更多帮助

- **GitHub Issues**: [提交 Bug 或功能建议](https://github.com/everyday-items/hexclaw-desktop/issues)
- **GitHub Discussions**: [社区讨论](https://github.com/everyday-items/hexclaw-desktop/discussions)
- **关于页面**: 系统菜单 → HexClaw → 关于 HexClaw
