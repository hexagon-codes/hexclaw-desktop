# Claude Code 使用技巧手册

## 目录

- [一、自动执行 / 跳过确认](#一自动执行--跳过确认)
- [二、核心工作流](#二核心工作流)
- [三、CLAUDE.md 项目记忆](#三claudemd-项目记忆)
- [四、实用快捷键](#四实用快捷键)
- [五、常用斜杠命令](#五常用斜杠命令)
- [六、上下文管理](#六上下文管理)
- [七、Hooks 自动化](#七hooks-自动化)
- [八、子代理与并行 Agent](#八子代理与并行-agent)
- [九、实用提示词技巧](#九实用提示词技巧)
- [十、PR 自动审查](#十pr-自动审查)
- [十一、MCP 扩展](#十一mcp-扩展)
- [十二、自定义命令（Custom Commands）](#十二自定义命令custom-commands)
- [十三、IDE 集成](#十三ide-集成)
- [十四、Memory 记忆系统](#十四memory-记忆系统)
- [十五、批量/无头模式](#十五批量无头模式)
- [十六、权限层级优先级](#十六权限层级优先级)

---

## 一、自动执行 / 跳过确认

### 临时方案：Shift+Tab 切换模式

在 Claude Code 界面反复按 **Shift+Tab** 循环切换三种模式：

| 模式 | 说明 |
|------|------|
| `normal-mode` | 默认，每步需确认 |
| `auto-accept edit on` | 自动接受编辑，无需确认 |
| `plan mode on` | 仅规划，不执行 |

> 遇到"Do you want to make this edit?"弹窗时，选第 2 项 **"Yes, allow all edits during this session (shift+tab)"** 即可当次会话全部自动接受。

### 永久方案：配置文件白名单（最可靠）

编辑 `~/.claude/settings.json`：

```json
{
  "permissions": {
    "defaultMode": "auto",
    "allow": [
      "Edit",
      "MultiEdit",
      "Read",
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)"
    ],
    "deny": [
      "Bash(rm -rf *)"
    ]
  }
}
```

白名单里的工具**完全不会弹确认**，`deny` 中的危险操作永远被拦截。

### 彻底跳过（仅限隔离环境）

```bash
# 启动时加参数（临时）
claude --dangerously-skip-permissions

# 或写入配置（永久）
# "defaultMode": "bypassPermissions"
```

> ⚠️ `bypassPermissions` 仅建议在 Docker 容器 / 虚拟机等隔离环境中使用。

---

## 二、核心工作流

### Plan Mode：先规划再执行

按 **Shift+Tab** 切到 Plan Mode，让 Claude 以架构师视角先分析代码库、列出所有受影响的文件和依赖，再切回执行模式。直接开干往往走弯路，先规划能省很多重构时间。

示例提示词：
```
Act as a Senior Architect. Before proposing implementation:
1. Analyze existing codebase in /src/
2. Identify all files affected by this change
3. List integration points and dependencies
4. Present as a numbered implementation plan
```

### 给 Claude 一个验证闭环

在 `CLAUDE.md` 里写上测试命令、构建命令、lint 命令。当 Claude 能运行构建、看到报错、然后自己修复，就形成了自我迭代的反馈循环——不再靠"看起来对"，而是靠真正跑通。

```markdown
## 验证命令
- 测试: pytest tests/
- 构建: npm run build
- Lint: npm run lint
```

---

## 三、CLAUDE.md 项目记忆

在项目根目录创建 `CLAUDE.md`，Claude 每次启动都会自动加载，是跨会话的"长期记忆"。

### 快速生成

```bash
claude /init    # 自动分析代码库，生成 CLAUDE.md 初稿
```

### 5 层层级（从高到低优先级）

| 层级 | 路径 | 用途 | 共享 |
|------|------|------|------|
| 托管策略 | 系统级目录（macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`） | 企业强制规则 | 全组织 |
| 用户级 | `~/.claude/CLAUDE.md` | 个人全局偏好（如"默认用中文回答"） | 仅自己 |
| 项目级 | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享规范，提交到 Git | 团队 |
| 本地级 | `./CLAUDE.local.md`（加入 `.gitignore`） | 个人的测试 URL、环境变量等 | 仅自己 |
| 子目录级 | 子目录中的 `CLAUDE.md` | 访问该目录时才懒加载 | 团队 |

### 大型项目拆分规则

当规则超过 200 行时，拆分到 `.claude/rules/` 目录：

```
.claude/
├── CLAUDE.md           # 核心规则（200 行以内）
└── rules/
    ├── testing.md      # 测试规范
    ├── security.md     # 安全约束
    └── api-design.md   # API 设计规范
```

### 示例

```markdown
## 技术栈
- Go 1.25+ / Gin / GORM / PostgreSQL

## 常用命令
- 测试：go test ./... -v
- 构建：make all

## 约定
- 所有新功能必须附带单元测试
- 禁止使用 GORM AutoMigrate，手动写 SQL 放 sql/ 目录
- 默认用中文回答

## 禁止事项
- 不得直接操作 main 分支
- 不得在业务代码中直接读取环境变量（走 constant 包）
```

### 编写原则

对 CLAUDE.md 里的每一行，问自己：**"删掉这条会导致 Claude 犯错吗？"** 如果不会，就删掉它。

> **注意**：CLAUDE.md 是建议性的，Claude 约 80% 情况会遵守。必须执行的规则应改用 Hooks（见下文）。

---

## 四、实用快捷键

| 快捷键 | 功能 |
|--------|------|
| `Shift+Tab` | 切换 normal / auto-accept / plan 模式 |
| `Esc` | 中断当前任务（不丢失上下文，可立即重定向） |
| `Esc+Esc` 或 `/rewind` | 打开检查点菜单，回滚代码+对话 |
| `Option+T` / `Alt+T` | 开关扩展思考（Extended Thinking） |
| `!命令` | 直接运行 shell 命令，结果进上下文 |
| `@文件名` | 引用文件直接加入上下文（免搜索） |
| 行尾 `\` | 多行输入续行，按 Enter 不发送 |

---

## 五、常用斜杠命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空上下文，开始新任务 |
| `/compact` | 压缩当前对话，节省 token |
| `/compact [指令]` | 带指令压缩（如 `/compact 保留数据库相关上下文`） |
| `/context` | 查看当前上下文内容和 token 用量 |
| `/cost` | 查看当前会话的 token 用量和费用 |
| `/model` | 切换模型（Opus / Sonnet / Haiku） |
| `/fast` | 切换快速模式（同模型加速输出，非降级模型） |
| `/rewind` | 回滚到某个检查点 |
| `/resume` | 恢复上次会话 |
| `/continue` | 继续最近一次对话 |
| `/review` | 代码审查 |
| `/doctor` | 诊断环境和配置问题 |
| `/memory` | 查看/编辑记忆文件 |
| `/install-github-app` | 安装 GitHub App，自动审查 PR |

---

## 六、上下文管理

- **频繁 `/clear`**：每次开始新任务都清一次，避免旧对话占用 token，也防止 Claude 被历史信息误导。
- **用 `@文件名`**：直接引用文件进上下文，Claude 无需先搜索，节省步骤和 token。
- **用 `!命令`** 代替让 Claude 去执行命令：更快，输出直接进上下文。
- **大任务用 Subagent**：把重型任务分给子 Agent，不污染主上下文窗口。
- **图片/截图输入**：直接拖拽图片到对话框，或用 `@screenshot.png` 引用。Claude 是多模态的，可以看懂 UI 截图、错误截图、架构图。
- **Skills 按需加载**：把专项知识写成 `.claude/skills/` 下的 markdown 文件，只在需要时加载，保持上下文精简。

---

## 七、Hooks 自动化

Hooks 是确定性的，100% 执行（不像 CLAUDE.md）。适合"每次都必须发生"的事情。

在 `.claude/settings.json` 中配置：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "command": "prettier --write $FILE" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "command": "python3 validate_command.py \"$TOOL_INPUT\"", "timeout": 5000 }
        ]
      }
    ]
  }
}
```

---

## 八、子代理与并行 Agent

### 子代理（Subagent）

Claude 会自动派遣子代理处理复杂调研任务，保持主上下文干净。你也可以显式要求：

```
帮我并行调研以下 3 个问题：
1. 项目中所有定时任务的实现方式
2. auth 中间件的完整调用链
3. 最近 20 次提交涉及的模块分布
```

### 自定义代理

在 `.claude/agents/` 目录下创建专用代理：

```markdown
---
name: security-reviewer
description: 审查代码安全漏洞
tools: [Read, Grep, Glob]
---

你是一个安全审查专家。只读代码不修改。
重点关注：SQL 注入、XSS、命令注入、敏感信息泄漏。
```

### 并行多实例

用 Git Worktree 开多个独立工作区，各跑一个 Claude 实例：

```bash
git worktree add ../feature-a
git worktree add ../feature-b
# 在每个 worktree 里启动独立的 Claude Code 实例
```

---

## 九、实用提示词技巧

| 场景 | 提示词 |
|------|--------|
| 让 Claude 质疑方案 | `"仔细审查这些改动，在我通过你的测试之前，别提交 PR。"` |
| 强制验证而非假设 | `"请证明这有效"` |
| 推倒重来用最优解 | `"鉴于你现在所掌握的一切信息，放弃这个方案，实施更优雅的解决方案。"` |
| 让 Claude 帮你 code review | `"主分支和你的分支之间存在差异，并对每一个决定提出质疑"` |
| 先访谈再执行 | `"首先提供一个最基本的规格说明，然后使用 AskUserQuestion 工具对我进行面试，之后创建一个新的会话来执行。"` |


---

## 十、PR 自动审查

```bash
# 在 Claude Code 中运行
/install-github-app
```

安装后，Claude 会自动审查你提交的 PR，在 AI 工具使用越来越多、PR 量增大时特别实用。

---

## 十一、MCP 扩展

MCP（Model Context Protocol）可以为 Claude Code 添加外部工具能力。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/your-project"],
      "permissions": {
        "allow": ["read_file", "list_directory"],
        "deny": ["write_file", "delete_file"]
      }
    }
  }
}
```

> 常用 MCP：文件系统、浏览器控制、数据库查询、GitHub、Slack 等。

---

## 十二、自定义命令（Custom Commands）

在 `.claude/commands/` 目录下创建 `.md` 文件，即可注册为斜杠命令。

### 目录层级

| 路径 | 作用域 | 共享 |
|------|--------|------|
| `~/.claude/commands/` | 所有项目通用 | 仅自己 |
| `.claude/commands/` | 当前项目 | 团队（提交到 Git） |

### 创建命令

```markdown
<!-- .claude/commands/review-go.md -->
请对当前分支相对于 main 的全部 Go 变更进行深度审查。

重点关注：
1. context 传播是否完整
2. 错误处理是否有遗漏
3. 并发安全性

$ARGUMENTS
```

### 使用

```
/review-go                    # 无参数执行
/review-go 只看 relay/ 目录    # $ARGUMENTS 被替换为参数
```

> 命令本质是提示词模板，`$ARGUMENTS` 是唯一支持的占位符。

---

## 十三、IDE 集成

Claude Code 可以在多种环境中使用：

| 环境 | 说明 |
|------|------|
| CLI（终端） | `claude` 命令，功能最全 |
| VS Code 扩展 | 编辑器内嵌，选中代码直接交互 |
| JetBrains 插件 | IntelliJ / GoLand / WebStorm 等 |
| 桌面端 App | macOS / Windows 原生应用 |
| Web 端 | claude.ai/code |

> 所有环境共享同一套配置（`~/.claude/`、CLAUDE.md、Memory）。

---

## 十四、Memory 记忆系统

Claude Code 有双重记忆机制，让经验跨会话传承。

### CLAUDE.md（你写的指令）

- 每次会话自动加载，详见第三节
- 团队共享的规范和约束

### Auto Memory（Claude 自己保存的笔记）

- 存储在 `~/.claude/projects/<project>/memory/`
- `MEMORY.md` 为索引文件，开头 200 行自动加载
- 其余话题文件按需加载

### 常用操作

```
记住：这个项目的测试统一放在 test/ 目录下       # 让 Claude 记住偏好
忘掉之前关于测试目录的记忆                       # 让 Claude 忘记
/memory                                          # 查看/编辑记忆文件
```

---

## 十五、批量/无头模式

适合 CI/CD 集成、脚本批处理、自动化流水线。

```bash
# 单次执行，不进入交互
claude -p "给 utils.go 里所有公开函数加上 godoc 注释"

# 管道输入
git diff | claude -p "review 这个 diff"

# 指定输出格式
claude -p "列出所有 TODO 注释" --output-format json

# 限制工具权限
claude -p "分析代码质量" --allowedTools Read,Grep,Glob

# 恢复之前的会话
claude --resume    # 恢复上次会话
claude --continue  # 继续最近一次对话
```

---

## 十六、权限层级优先级

```
Managed settings（企业管理，不可覆盖）
    ↓
CLI 参数（--allowedTools, --permission-mode）
    ↓
项目配置（.claude/settings.json）
    ↓
用户全局配置（~/.claude/settings.json）
```

某一层级的 `deny` 规则，无法被更低层级的 `allow` 覆盖。

---

*最后更新：2026 年 4 月*
