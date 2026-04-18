# Claude Code 扩展清单与制作指南

> 已安装的 MCP 服务器、常用 Skills、自定义 Commands 清单，以及 Command / Skill 的制作方法。

## 目录

- [一、已安装 MCP 服务器](#一已安装-mcp-服务器)
- [二、常用 Skills 分类清单](#二常用-skills-分类清单)
- [三、已创建的自定义命令](#三已创建的自定义命令)
- [四、Command 命令制作方法](#四command-命令制作方法)
- [五、Skill 制作方法](#五skill-制作方法)
  - [从社区市场学习优秀 Skill 设计](#从社区市场学习优秀-skill-设计)

---

## 一、已安装 MCP 服务器

MCP（Model Context Protocol）为 Claude Code 提供外部工具能力。当前已安装 4 个：

| MCP 服务器 | 包名 | 功能 | 常用场景 |
|------------|------|------|----------|
| **context7** | `@upstash/context7-mcp` | 实时查询库/框架官方文档 | 查 API 语法、版本迁移、配置方法，比训练数据更准 |
| **playwright** | `@playwright/mcp` | 浏览器自动化控制 | 页面截图、填表单、点击、E2E 测试、UI 验证 |
| **exa** | `exa-mcp-server` | AI 神经搜索引擎 | 代码搜索、公司调研、技术方案调研、深度研究 |
| **github** | `@modelcontextprotocol/server-github` | GitHub API 操作 | 查看/创建 PR、Issue、文件内容、代码搜索 |

### 各 MCP 工具速查

#### context7 — 文档查询

```
查一下 Gin 框架的中间件怎么写          # 自动调用 context7 查最新文档
GORM 的 Preload 和 Joins 区别是什么    # 比训练数据更准
Tailwind v4 的配置变更                  # 版本迁移场景
```

#### playwright — 浏览器控制

| 工具 | 功能 |
|------|------|
| `browser_navigate` | 打开 URL |
| `browser_snapshot` | 获取页面可访问性快照 |
| `browser_take_screenshot` | 页面截图 |
| `browser_click` | 点击元素 |
| `browser_fill_form` | 填写表单 |
| `browser_evaluate` | 执行 JS 代码 |
| `browser_network_requests` | 查看网络请求 |
| `browser_console_messages` | 查看控制台日志 |

#### exa — 神经搜索

```
用 exa 搜索 Go 语言的 circuit breaker 最佳实践
搜索 2026 年最新的 Kubernetes HPA 配置方案
```

#### github — GitHub 操作

| 工具 | 功能 |
|------|------|
| `get_pull_request` | 查看 PR 详情 |
| `create_pull_request` | 创建 PR |
| `list_issues` | 列出 Issue |
| `get_file_contents` | 查看远程文件 |
| `search_code` | 搜索代码 |
| `list_commits` | 查看提交历史 |

### MCP 管理命令

```bash
claude mcp list                    # 查看已安装的 MCP 及状态
claude mcp add <name> -- <cmd>     # 添加新 MCP
claude mcp remove <name>           # 删除 MCP
```

---

## 二、常用 Skills 分类清单

Skills 是预装的专业知识包，Claude 会根据上下文自动选用。当前共安装 200+ 个，按用途分类列出常用的：

### 代码审查与质量

| Skill | 功能 |
|-------|------|
| `requesting-code-review` | 完成任务后请求代码审查 |
| `receiving-code-review` | 收到审查反馈后的处理流程 |
| `systematic-debugging` | 系统化调试（科学方法排查） |
| `verification-before-completion` | 完成前必须跑验证命令 |
| `click-path-audit` | UI 交互路径全链路审计 |
| `security-review` | 安全审查清单 |
| `security-scan` | 扫描 `.claude/` 配置安全性 |
| `simplify` | 审查代码复用性和效率 |
| `santa-method` | 双 Agent 对抗验证 |

### Go 后端

| Skill | 功能 |
|-------|------|
| `golang-patterns` | Go 惯用模式和最佳实践 |
| `golang-testing` | Go 测试（表驱动、基准、模糊） |
| `api-design` | REST API 设计规范 |
| `database-migrations` | 数据库迁移最佳实践 |
| `postgres-patterns` | PostgreSQL 查询优化和设计 |
| `docker-patterns` | Docker/Compose 配置模式 |
| `deployment-patterns` | CI/CD 和部署工作流 |

### 前端

| Skill | 功能 |
|-------|------|
| `frontend-patterns` | React/Next.js 前端模式 |
| `coding-standards` | TS/JS/React 编码标准 |
| `e2e-testing` | Playwright E2E 测试 |
| `apple-design` | Apple HIG 设计规范（自建命令） |
| `liquid-glass-design` | iOS 26 Liquid Glass 设计 |

### 开发工作流

| Skill | 功能 |
|-------|------|
| `test-driven-development` | TDD 工作流 |
| `writing-plans` | 编写实现计划 |
| `executing-plans` | 执行实现计划 |
| `finishing-a-development-branch` | 分支完成后的集成决策 |
| `using-git-worktrees` | Git Worktree 隔离开发 |
| `dispatching-parallel-agents` | 并行 Agent 任务分发 |
| `brainstorming` | 创意探索（功能设计前） |
| `search-first` | 先搜索再编码 |
| `codebase-onboarding` | 新项目上手指南生成 |

### 研究与内容

| Skill | 功能 |
|-------|------|
| `deep-research` | 多源深度研究（带引用） |
| `exa-search` | Exa 神经搜索 |
| `documentation-lookup` | Context7 文档查询 |
| `defuddle` | 网页内容提取（去噪音） |
| `market-research` | 市场调研和竞品分析 |
| `article-writing` | 长文写作 |
| `content-engine` | 多平台内容创作 |

### GSD 项目管理（常用子集）

| Skill | 功能 |
|-------|------|
| `gsd-help` | 查看所有 GSD 命令 |
| `gsd-plan-phase` | 创建阶段计划 |
| `gsd-execute-phase` | 执行阶段计划 |
| `gsd-code-review` | 阶段代码审查 |
| `gsd-debug` | 系统化调试 |
| `gsd-fast` | 快速执行简单任务 |
| `gsd-progress` | 查看项目进度 |
| `gsd-resume-work` | 恢复上次工作 |
| `gsd-ship` | 创建 PR 准备合并 |

### 其他实用

| Skill | 功能 |
|-------|------|
| `prompt-optimizer` | 优化提示词 |
| `context-budget` | 审计上下文 token 消耗 |
| `continuous-learning` | 自动提取可复用模式 |
| `writing-skills` | 创建/编辑 Skill |
| `rules-distill` | 从 Skill 提取规则 |
| `claude-api` | Claude API 开发模式 |
| `mcp-server-patterns` | MCP 服务器开发模式 |

---

## 三、已创建的自定义命令

存放在 `~/.claude/commands/`（全局）：

| 命令 | 文件 | 功能 | 备注 |
|------|------|------|------|
| `/review-go` | `review-go.md` | Go 后端深度代码审查 | 入口，引用 `资深Go架构师代码审查.md` |
| `/review-fullstack` | `review-fullstack.md` | 全栈（前端+后端）深度代码审查 | 入口，引用 `全栈架构师代码审查.md` |
| `/apple-design` | `apple-design.md` | Apple HIG 设计规范驱动的 UI 开发/审查 | |
| `/test-dev` | `test-dev.md` | 测试环境全量回归测试 | |
| `/test-prod` | `test-prod.md` | 生产环境全量回归测试 | |
| `/资深Go架构师代码审查` | `资深Go架构师代码审查.md` | Go 架构师视角的审查 Pipeline | 规则本体，被 `/review-go` 引用 |
| `/全栈架构师代码审查` | `全栈架构师代码审查.md` | 全栈架构师视角的审查 Pipeline（含生态链扫描） | 规则本体，被 `/review-fullstack` 引用 |

---

## 四、Command 命令制作方法

### 基本概念

Command 是**提示词模板文件**，放在指定目录下即可注册为斜杠命令。

### 存放目录

| 路径 | 作用域 | 共享 |
|------|--------|------|
| `~/.claude/commands/` | 所有项目通用 | 仅自己 |
| `.claude/commands/` | 当前项目 | 团队（可提交到 Git） |

### 制作步骤

#### 1. 创建 `.md` 文件

文件名即命令名（去掉 `.md` 后缀）：

```bash
# 全局命令
~/.claude/commands/review-api.md    → /review-api

# 项目命令
.claude/commands/deploy-check.md    → /deploy-check
```

#### 2. 编写提示词内容

文件内容就是完整的提示词，`$ARGUMENTS` 是唯一支持的占位符：

```markdown
<!-- ~/.claude/commands/review-api.md -->
你是一位 API 安全审查专家。

对当前分支相对于 main 的全部 API 变更进行审查：

1. 路由是否有鉴权中间件
2. 请求参数是否有校验
3. 响应是否泄漏敏感字段
4. 是否有速率限制

重点关注：$ARGUMENTS
```

#### 3. 使用

```
/review-api                          # $ARGUMENTS 为空
/review-api 用户相关的接口            # $ARGUMENTS = "用户相关的接口"
```

### 最佳实践

```
✅ 角色设定放在开头（"你是一位..."）
✅ 用编号列出检查步骤，确保不遗漏
✅ 提供输出格式要求（表格/分级/模板）
✅ $ARGUMENTS 放在末尾，用于缩小范围
✅ 文件名用英文小写+连字符（跨平台兼容）

❌ 不要在命令中写配置/环境相关内容（放 CLAUDE.md）
❌ 不要写太短的命令（一句话没必要封装）
❌ 不要在命令中引用其他命令（不支持嵌套）
```

### 高级技巧：命令引用外部文件

命令可以指向一个更详细的提示词文件：

```markdown
<!-- ~/.claude/commands/review-go.md -->
请阅读 ~/.claude/commands/资深Go架构师代码审查.md，
按照其中的执行 Pipeline 对当前分支相对于 main 的全部变更进行深度审查。
$ARGUMENTS
```

这样 `/review-go` 是简短入口，详细规则放在另一个大文件里。

---

## 五、Skill 制作方法

### 基本概念

Skill 是比 Command 更强大的知识包，支持：
- 自动触发（根据上下文匹配）
- 限制可用工具
- 包含多个文件
- 带元数据（描述、触发条件）

### 存放目录

| 路径 | 作用域 |
|------|--------|
| `~/.claude/skills/` | 所有项目通用 |
| `.claude/skills/` | 当前项目 |

每个 Skill 是一个**子目录**，至少包含一个 `.md` 文件。

### 制作步骤

#### 1. 创建目录结构

```
~/.claude/skills/
└── my-review/              # Skill 名称
    └── skill.md             # 主文件（必须）
```

或者更简单的单文件形式：

```
~/.claude/skills/
└── my-review.md             # 单文件 Skill
```

#### 2. 编写 Skill 文件

```markdown
---
name: my-review
description: 针对 Go + React 全栈项目的代码审查，关注 context 传播和前后端契约
tools: [Read, Grep, Glob, Bash]
---

# 角色

你是一位全栈代码审查专家，精通 Go 后端和 React 前端。

# 审查规则

1. **后端 Go 专项**
   - context 是否在调用链中完整传播
   - error 是否被正确包装（%w）
   - goroutine 生命周期是否有泄漏风险

2. **前端 React 专项**
   - useEffect 是否有清理函数
   - 状态更新是否有竞态风险
   - API 错误是否有用户可见的反馈

3. **前后端契约**
   - 接口字段名和类型是否一致
   - 错误码和状态码是否对齐
   - 新增参数前端是否已适配

# 输出格式

按 Critical → High → Medium → Low 排序，每个问题包含：
- 文件和行号
- 问题描述
- 修复建议
```

#### 3. Frontmatter 字段说明

```yaml
---
name: my-skill              # Skill 名称（必须）
description: 一句话描述      # Claude 用来判断是否匹配当前任务（必须）
tools: [Read, Grep, Glob]   # 限制可用工具（可选，不写则全部可用）
---
```

**description 很重要**：Claude 根据 description 判断当前任务是否匹配这个 Skill。写得越精确，触发越准。

### Skill vs Command 对比

| 特性 | Command | Skill |
|------|---------|-------|
| 触发方式 | 手动 `/命令名` | 自动匹配 或 手动 |
| 文件格式 | 纯 Markdown | Frontmatter + Markdown |
| 工具限制 | 不支持 | 支持 `tools` 字段 |
| 参数传递 | `$ARGUMENTS` | 无（通过上下文） |
| 适合场景 | 重复性操作 | 专业领域知识 |
| 复杂度 | 低 | 中 |

### 选择建议

```
用 Command 当：
  - 你有一个固定的审查/生成/测试流程
  - 需要用 $ARGUMENTS 传参
  - 想要显式调用（/xxx）

用 Skill 当：
  - 你有一个专业领域的知识体系
  - 希望 Claude 自动识别并应用
  - 需要限制工具范围（如只读不改）
```

### 自定义 Agent（进阶）

在 `.claude/agents/` 目录下创建的是专用代理，比 Skill 更独立：

```markdown
---
name: security-reviewer
description: 审查代码安全漏洞
tools: [Read, Grep, Glob]
---

你是一个安全审查专家。只读代码不修改。
重点关注：SQL 注入、XSS、命令注入、敏感信息泄漏。
```

Agent 通过子代理机制调用，拥有独立上下文，不污染主会话。

### 从社区市场学习优秀 Skill 设计

自己从零写 Skill 容易闭门造车。建议先去社区市场看看优秀作品，吸收设计技巧后再写自己的。

#### Everything Claude Code（ECC）

最大的 Claude Code Skill 开源集合，当前已安装的 200+ Skill 大部分来自这里。

- **仓库**：`github.com/anthropics/courses` 及社区维护的 ECC 合集
- **安装**：用 `/configure-ecc` 交互式选择安装
- **学习要点**：
  - 看 `description` 怎么写——决定了 Claude 何时自动触发
  - 看 `tools` 限制——只读审查类 Skill 限制 `[Read, Grep, Glob]`
  - 看结构化输出要求——好的 Skill 都规定了输出格式
  - 看 trigger 条件描述——"Use when..." 的写法很讲究

```bash
# 查看已安装 Skill 的源码（最好的学习材料）
ls ~/.claude/skills/
cat ~/.claude/skills/systematic-debugging/skill.md
cat ~/.claude/skills/verification-before-completion/skill.md
cat ~/.claude/skills/golang-patterns/skill.md
```

#### OpenClaw 的 ClawHub 市场

OpenClaw 生态的 Skill/Agent 共享市场，侧重实战场景和多 Agent 协作。

- **定位**：偏向工程实战的 Skill 集合，有完整的审查、测试、部署流水线模板
- **学习要点**：
  - 看多 Skill 如何组合成工作流（如 discuss → plan → execute 链）
  - 看 Agent 定义如何限定角色边界
  - 看复杂审查 Pipeline 的分步设计（Step 0 → Step 5 的递进式检查）
  - 看如何用 frontmatter 元数据控制触发和工具范围

#### 从优秀 Skill 中提取设计模式

读了足够多的 Skill 后，你会发现这些共性模式：

| 设计模式 | 说明 | 示例 |
|----------|------|------|
| **角色设定** | 开头明确角色身份和专业领域 | "你是一位资深 Go 架构师" |
| **检查清单** | 用编号列出所有检查步骤，防遗漏 | Step 0 → Step 5 的审查 Pipeline |
| **输出模板** | 规定输出结构（表格/分级/Section） | "按 Critical → Low 排序" |
| **反例教学** | 用 ❌/✅ 对比说明正确做法 | "❌ 只追 happy path" |
| **历史教训** | 附带真实踩坑案例，防重蹈覆辙 | "sora_ch3 案例 2026-02-07" |
| **工具限制** | 审查类只给 Read/Grep，防止误改代码 | `tools: [Read, Grep, Glob]` |
| **递进深度** | 先高层扫描再逐行深入 | "Phase 1 Context → Phase 4 Summary" |
| **自检闭环** | 末尾加自检步骤，确认完成度 | "grep -c 残留反模式" |

#### 学习路线建议

```
1. 入门：读 3-5 个简单 Skill（golang-patterns / api-design / security-review）
   → 学会 frontmatter + 角色设定 + 检查清单

2. 进阶：读复杂 Pipeline Skill（systematic-debugging / click-path-audit）
   → 学会分步递进 + 反例教学 + 自检闭环

3. 实战：模仿写自己的 Skill，用 /writing-skills 辅助
   → 先抄结构，再填自己的领域知识

4. 优化：用 /skill-comply 检验 Skill 是否真的被遵守
   → 发现遵守率低的条目，改写 description 或拆分
```

---

*最后更新：2026 年 4 月*
