<div align="center">

[English](README.en.md) | **中文**

<img src=".github/assets/logo.png" alt="HexClaw Logo" width="160">

# HexClaw Desktop (河蟹桌面客户端)

**企业级安全的个人 AI Agent 一体化桌面客户端**

[![CI](https://github.com/hexagon-codes/hexclaw-desktop/workflows/CI/badge.svg)](https://github.com/hexagon-codes/hexclaw-desktop/actions)
[![Release](https://img.shields.io/github/v/release/hexagon-codes/hexclaw-desktop?include_prereleases)](https://github.com/hexagon-codes/hexclaw-desktop/releases)
[![License](https://img.shields.io/github/license/hexagon-codes/hexclaw-desktop)](https://github.com/hexagon-codes/hexclaw-desktop/blob/main/LICENSE)
[![Downloads](https://img.shields.io/github/downloads/hexagon-codes/hexclaw-desktop/total)](https://github.com/hexagon-codes/hexclaw-desktop/releases)
[![Stars](https://img.shields.io/github/stars/hexagon-codes/hexclaw-desktop?style=social)](https://github.com/hexagon-codes/hexclaw-desktop)

**Built with**

[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go&logoColor=white)](https://go.dev)

**Powered by**

<a href="https://github.com/hexagon-codes/hexagon"><img src="https://img.shields.io/badge/🔷_Hexagon-Agent_Engine-4A90D9?style=for-the-badge" alt="Hexagon"></a>
<a href="https://github.com/hexagon-codes/hexclaw"><img src="https://img.shields.io/badge/🦀_HexClaw-Backend-F74C00?style=for-the-badge" alt="HexClaw"></a>

[**🌐 官网 hexclaw.net**](https://hexclaw.net) · [📖 在线文档](https://hexclaw.net/zh/docs/) · [⬇️ 下载](https://github.com/hexagon-codes/hexclaw-desktop/releases)

macOS / Windows / Linux 原生运行 · Sidecar 架构本地部署 · 零云端依赖 · 数据完全私有

</div>

---

<!-- TODO: 添加应用截图
<p align="center">
  <img src="docs/screenshots/chat.png" alt="聊天界面" width="800" />
</p>
-->

## 功能特性

| 功能 | 说明 |
|------|------|
| **AI 对话** | 多模型支持: OpenAI / DeepSeek / Anthropic / Gemini / Qwen / Ollama，流式输出，Markdown 渲染，代码高亮 |
| **Agent 编排** | 自定义 Agent 角色/目标/背景，多 Agent 协作，Agent 会议模式，角色模板库 |
| **Skill 系统** | 技能市场 + 自定义技能，Tool 注册与权限管理 |
| **工作流画布** | 可视化拖拽编排 Agent 工作流，DAG 图执行引擎 |
| **MCP 协议** | Model Context Protocol 工具集成，外部工具即插即用 |
| **知识库 (RAG)** | 文档上传/解析/向量检索，支持 PDF / Markdown / TXT 等格式 |
| **记忆系统** | 长期记忆 + 短期记忆 + 语义搜索，跨会话记忆持久化 |
| **定时任务** | Cron 调度，周期性执行 Agent 任务 |
| **安全网关** | Prompt 注入检测 / PII 过滤 / 内容过滤 / RBAC 权限控制 |
| **团队协作** | *(规划中)* 多用户工作空间，共享 Agent 和会话 |
| **IM 通道** | 飞书 / 钉钉 / 企微 / 微信 / Slack / Discord / Telegram，通过 IM 远程与 AI 对话 |
| **深度研究** | 4 阶段自主调研（搜索→分析→综合→报告），基于 Hexagon Plan-and-Execute 引擎 |
| **文档解析** | 聊天中直接上传 PDF / Word / Excel / CSV，自动提取文本作为上下文 |
| **Webhook 通知** | 企微 / 飞书 / 钉钉机器人 Webhook 推送，任务完成自动通知 |
| **ClawHub 技能市场** | 浏览、搜索、安装 OpenClaw 社区 Skill，按分类筛选（编程/研究/写作/数据/自动化） |
| **首次引导** | 3 步 Welcome 向导（选 Provider → 选模型 → 测试连接），零配置门槛 |
| **实时日志** | WebSocket 流式日志，Agent 执行链路全程追踪 |
| **多语言** | 中文 / English，vue-i18n 国际化 |
| **系统托盘** | 最小化到托盘，托盘菜单快捷操作 |
| **全局快捷键** | `⌘+Shift+H` 随时唤起 Quick Chat 窗口 |
| **自动更新** | Tauri Updater，应用内一键升级 |

## 生态链

```
toolkit → ai-core → hexagon → hexclaw → hexclaw-desktop
                                       → hexclaw-ui
                                       → hexagon-ui
```

| 项目 | 定位 | 语言 |
|------|------|------|
| [toolkit](https://github.com/hexagon-codes/toolkit) | 通用工具箱 — 基础设施库 (日志/配置/HTTP/并发/错误链) | Go |
| [ai-core](https://github.com/hexagon-codes/ai-core) | AI 能力底座 — LLM Provider/Embedding/向量/记忆 | Go |
| [hexagon](https://github.com/hexagon-codes/hexagon) | 全能 AI Agent 框架 — ReAct/Plan-and-Execute/Tool 调度 | Go |
| [hexclaw](https://github.com/hexagon-codes/hexclaw) | 河蟹后端 — Sidecar 服务 (RESTful API/RAG/Cron/安全网关) | Go |
| **hexclaw-desktop** | **河蟹桌面客户端 (本仓库)** | **Rust + Vue 3** |
| [hexclaw-ui](https://github.com/hexagon-codes/hexclaw-ui) | 河蟹 Web 端 — Web 客户端 (同时作为桌面端 UI 渲染层复用) | Vue 3 |
| [hexagon-ui](https://github.com/hexagon-codes/hexagon-ui) | Agent 观测台 — 可观测性面板 (链路追踪/推理回放/性能分析) | Vue 3 |

## 架构

```
HexClaw.app
┌───────────────────────────────────────────────────────────────────┐
│  Tauri Shell (Rust)                                               │
│  窗口管理 · 系统托盘 · 原生菜单 · 全局快捷键 · 单实例 · 自动更新  │
│  API 代理 (CORS bypass) · Sidecar 进程管理                        │
├───────────────────────────────────────────────────────────────────┤
│  Vue 3 前端 (WebView)                                             │
│  ┌────────┬────────┬────────┬────────┬────────┬────────┬───────┐ │
│  │Dashboard│  Chat  │ Agents │ Skills │ Canvas │ 知识库  │  MCP  │ │
│  ├────────┼────────┼────────┼────────┼────────┼────────┼───────┤ │
│  │  记忆   │  日志  │  任务  │ IM通道 │  设置  │  关于   │ Quick │ │
│  └───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───────┘ │
│      │  Pinia Store    │  Vue Router      │  Tauri invoke (IPC)   │
├──────┴─────────────────┴──────────────────┴───────────────────────┤
│  Tauri Commands (Rust → Go)                                       │
│  check_engine_health · proxy_api_request · get_sidecar_status     │
├───────────────────────────────────────────────────────────────────┤
│  HTTP / WebSocket  ←→  localhost:16060                            │
├───────────────────────────────────────────────────────────────────┤
│  hexclaw serve (Go Sidecar)                                       │
│  Agent 引擎 · LLM 路由 · RAG · MCP · CORS · 安全网关 · Cron      │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Hexagon Framework  ←  ai-core (LLM/Tool/Memory)          │   │
│  │                     ←  toolkit (Log/Config/HTTP/Concurrency)│   │
│  └────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

设计模式与 **Docker Desktop 管理 Docker Engine** 一致 — Tauri 壳管理 Go Sidecar 进程。
前后端通过 **Tauri IPC 代理**通信（解决 WebView CORS 限制），完全解耦。

> Go Sidecar 默认监听 `localhost:16060`，可通过 hexclaw 配置文件修改端口。

## 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 桌面框架 | Tauri | v2 |
| 前端框架 | Vue 3 (Composition API) | 3.5+ |
| 语言 | TypeScript | 5.9+ |
| 状态管理 | Pinia | 3.x |
| UI 组件库 | 自研设计系统 (Apple-Inspired) | - |
| 样式 | Tailwind CSS | 4.x |
| 路由 | Vue Router | 5.x |
| 国际化 | vue-i18n | 11.x |
| 图标 | Lucide Vue | - |
| Markdown | markdown-it + Shiki (代码高亮) | - |
| 文档解析 | pdfjs-dist + mammoth + xlsx | - |
| 数据存储 | SQLite (tauri-plugin-sql) + Tauri Store | - |
| HTTP 客户端 | ofetch (前端) / reqwest (Rust 代理) | - |
| 构建工具 | Vite | 7.x |
| 测试 | Vitest + @vue/test-utils | - |
| Lint | ESLint + oxlint + Prettier | - |
| 后端 Sidecar | hexclaw serve (Go) | Go 1.23+ |
| Agent 框架 | Hexagon | - |
| Rust 层 | Tauri Shell + 插件生态 | Rust 2021 edition |

## 安装

### Homebrew (macOS)

```bash
brew tap hexagon-codes/tap
brew install --cask hexclaw
```

### GitHub Releases

前往 [Releases](https://github.com/hexagon-codes/hexclaw-desktop/releases) 下载对应平台安装包：

| 平台 | 格式 |
|------|------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | `.msi` / `.exe` (NSIS) |
| Linux | `.deb` / `.AppImage` |

> 首次打开 macOS 版本可能需要在 **系统设置 → 隐私与安全性** 中允许运行。

详细使用说明请参阅 [使用指南](docs/guide.md)（[English Guide](docs/guide.en.md)）。

## 开发

### 前置要求

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 20.19 或 >= 22.12 | JavaScript 运行时 |
| pnpm | >= 9 | 包管理器 |
| Rust | stable (2021 edition) | Tauri 编译 |
| Go | >= 1.23 | Sidecar 编译 |

### 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/hexagon-codes/hexclaw-desktop.git
cd hexclaw-desktop

# 2. 安装依赖
make install
# 等价于: pnpm install && cd src-tauri && cargo fetch

# 3. 编译 Go sidecar (首次需要，需要同级目录存在 hexclaw 仓库)
make sidecar

# 4. 启动开发模式
make dev
```

> **注意**: `make sidecar` 需要在 `hexclaw-desktop` 同级目录下克隆 [hexclaw](https://github.com/hexagon-codes/hexclaw) 仓库：
> ```
> work/
> ├── hexclaw/           # Go 后端仓库
> └── hexclaw-desktop/   # 本仓库
> ```

### Make 命令

| 命令 | 说明 |
|------|------|
| `make dev` | 开发模式 (Vite HMR + Tauri 窗口) |
| `make build` | 构建生产版本 |
| `make build-web` | 仅构建前端 |
| `make sidecar` | 编译 Go sidecar (当前平台) |
| `make sidecar-all` | 交叉编译所有平台 sidecar |
| `make lint` | 代码检查 (oxlint + ESLint) |
| `make format` | 代码格式化 (Prettier) |
| `make type-check` | TypeScript 类型检查 |
| `make test` | 运行单元测试 |
| `make clean` | 清理构建产物 |
| `make install` | 安装所有依赖 |

### 项目结构

```
hexclaw-desktop/
├── src/                          # Vue 3 前端源码
│   ├── api/                      # API 客户端 (Tauri IPC + HTTP fallback)
│   │   ├── client.ts             # HTTP/WS/IPC 基础客户端
│   │   ├── chat.ts               # 聊天 API
│   │   ├── agents.ts             # Agent 管理 API
│   │   ├── skills.ts             # Skill API
│   │   ├── canvas.ts             # 工作流画布 API
│   │   ├── mcp.ts                # MCP 协议 API
│   │   ├── knowledge.ts          # 知识库 API
│   │   ├── memory.ts             # 记忆系统 API
│   │   ├── tasks.ts              # 定时任务 API
│   │   ├── im-channels.ts       # IM 通道 API (飞书/钉钉/企微等)
│   │   ├── webhook.ts            # Webhook 通知 API
│   │   ├── logs.ts               # 日志 API
│   │   ├── settings.ts           # 设置 API
│   │   └── system.ts             # 系统信息 API
│   ├── components/               # 组件
│   │   ├── chat/                 # 聊天组件
│   │   │   ├── ResearchProgress.vue  # 深度研究进度面板
│   │   ├── agent/                # Agent 组件
│   │   ├── canvas/               # 画布组件
│   │   ├── common/               # 通用组件 (CommandPalette/ContextMenu/Toast 等)
│   │   ├── layout/               # 布局组件 (AppLayout/Sidebar/TitleBar)
│   │   └── logs/                 # 日志组件
│   ├── views/                    # 页面视图
│   │   ├── DashboardView.vue     # 仪表板 (首页)
│   │   ├── ChatView.vue          # AI 对话
│   │   ├── AgentsView.vue        # Agent 管理
│   │   ├── SkillsView.vue        # Skill 市场
│   │   ├── CanvasView.vue        # 工作流画布
│   │   ├── McpView.vue           # MCP 管理
│   │   ├── KnowledgeView.vue     # 知识库
│   │   ├── MemoryView.vue        # 记忆管理
│   │   ├── TasksView.vue         # 定时任务
│   │   ├── LogsView.vue          # 日志查看
│   │   ├── IMChannelsView.vue    # IM 通道管理
│   │   ├── TeamView.vue          # 团队协作 (规划中)
│   │   ├── SettingsView.vue      # 设置
│   │   ├── AboutView.vue         # 关于 (独立窗口)
│   │   ├── QuickChatView.vue     # 快捷聊天 (独立窗口)
│   │   └── WelcomeView.vue       # 欢迎页
│   ├── stores/                   # Pinia 状态管理
│   ├── composables/              # 组合式函数
│   ├── i18n/                     # 国际化资源
│   ├── router/                   # 路由配置
│   ├── types/                    # TypeScript 类型定义
│   ├── utils/                    # 工具函数
│   │   ├── file-parser.ts        # 文档解析器 (PDF/Word/Excel/CSV)
│   ├── config/                   # 前端配置 (env.ts 等)
│   └── assets/                   # 静态资源 (Logo/图标)
├── src-tauri/                    # Tauri (Rust) 层
│   ├── src/
│   │   ├── main.rs               # 入口
│   │   ├── lib.rs                # 应用初始化 & 插件注册
│   │   ├── commands.rs           # Tauri IPC 命令 (健康检查/API 代理)
│   │   ├── sidecar.rs            # Go Sidecar 进程管理
│   │   ├── tray.rs               # 系统托盘
│   │   ├── menu.rs               # macOS 原生菜单
│   │   └── window.rs             # 窗口管理 & 全局快捷键
│   ├── binaries/                 # Go sidecar 二进制 (编译生成)
│   ├── icons/                    # 应用图标
│   ├── capabilities/             # Tauri v2 权限配置
│   ├── tauri.conf.json           # Tauri 配置
│   ├── build.rs                  # Rust 构建脚本
│   └── Cargo.toml                # Rust 依赖
├── docs/                         # 文档
│   └── guide.md                  # 使用指南
├── Casks/                        # Homebrew Cask 定义
├── .github/                      # GitHub CI/CD
├── Makefile                      # 开发命令
├── vite.config.ts                # Vite 配置
├── vitest.config.ts              # Vitest 测试配置
├── eslint.config.ts              # ESLint 配置
├── tsconfig.json                 # TypeScript 配置
├── package.json                  # Node 依赖
├── LICENSE                       # Apache 2.0 许可证
└── README.md
```

## 构建

### 生产构建

```bash
# 完整构建 (前端 + Tauri 打包)
make build

# 输出位置:
#   macOS: src-tauri/target/release/bundle/macos/HexClaw.app
#   DMG:   src-tauri/target/release/bundle/dmg/HexClaw_*.dmg
```

### 指定目标平台构建

```bash
# macOS Intel
npx @tauri-apps/cli build --target x86_64-apple-darwin

# macOS Apple Silicon
npx @tauri-apps/cli build --target aarch64-apple-darwin
```

### Sidecar 交叉编译

```bash
# 编译所有平台
make sidecar-all

# 或单独编译指定平台
make sidecar-darwin-arm64    # macOS Apple Silicon
make sidecar-darwin-amd64    # macOS Intel
make sidecar-linux-amd64     # Linux x86_64
make sidecar-windows-amd64   # Windows x86_64
```

Sidecar 二进制输出到 `src-tauri/binaries/` 目录，Tauri 打包时会自动内嵌。

## 测试

```bash
# 运行单元测试
pnpm test:unit

# 或使用 Make
make test
```

测试文件规范：
- 测试文件与源码同目录，命名为 `*.test.ts` 或 `*.spec.ts`
- Store 测试放在 `src/stores/__tests__/` 目录
- 使用 Vitest + @vue/test-utils

## 常见问题

### macOS 提示"无法打开，因为无法验证开发者"

在 **系统设置 → 隐私与安全性** 中找到 HexClaw，点击"仍要打开"。或在终端执行：

```bash
xattr -cr /Applications/HexClaw.app
```

### 侧边栏显示 "Engine stopped" 但后端已启动

1. 确认 hexclaw 进程在运行: `ps aux | grep hexclaw`
2. 确认端口监听正常: `curl http://localhost:16060/health`
3. 如果 curl 成功但前端仍显示 stopped，检查是否是旧版本应用（重新 `make build` 并安装最新版本）

### `make sidecar` 编译失败

1. 确认 Go >= 1.23 已安装: `go version`
2. 确认 `hexclaw` 仓库在同级目录: `ls ../hexclaw/cmd/hexclaw`
3. 确认 Rust 工具链已安装 (用于检测平台 triple): `rustc -vV`

### `make dev` 启动后白屏

Sidecar 可能未编译或端口冲突。检查：
1. 确认已执行 `make sidecar`
2. 确认 `16060` 端口未被占用: `lsof -i :16060`

### hexclaw 后端启动失败

1. 查看错误日志: `~/.hexclaw/hexclaw.log`
2. 直接运行 sidecar 查看输出: `./src-tauri/binaries/hexclaw-$(rustc -vV | grep host | awk '{print $2}') serve --desktop`
3. 即使未配置 LLM API Key，hexclaw 也应该能正常启动（LLM 功能降级，基础 API 仍可用）

## 贡献指南

### 工作流程

1. Fork 本仓库
2. 创建功能分支: `git checkout -b feat/your-feature`
3. 提交更改: `git commit -m "feat: 添加新功能"`
4. 推送分支: `git push origin feat/your-feature`
5. 创建 Pull Request

### 代码规范

- **格式化**: `make format` (Prettier)
- **检查**: `make lint` (ESLint + oxlint)
- **类型检查**: `make type-check` (vue-tsc)

### Commit Message 格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 添加新功能
fix: 修复问题
docs: 文档更新
style: 代码格式调整
refactor: 重构
test: 测试相关
chore: 构建/工具链
```

## 在线资源

- 🌐 官网: [hexclaw.net](https://hexclaw.net)
- 📖 中文文档: [hexclaw.net/zh/docs](https://hexclaw.net/zh/docs/)
- 📖 English Docs: [hexclaw.net/en/docs](https://hexclaw.net/en/docs/)
- 🐙 GitHub: [hexagon-codes/hexclaw-desktop](https://github.com/hexagon-codes/hexclaw-desktop)

## 联系我们

- GitHub Issues: [hexclaw-desktop/issues](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- 河蟹 AI: ai@hexclaw.net
- 河蟹支持: support@hexclaw.net

## License

[Apache License 2.0](LICENSE)
