# Claude Code 实战经验

> 这套经验来自[河蟹 AI](https://github.com/hexagon-codes/hexclaw-desktop)及其生态仓库的开发实践，记录如何用 Claude Code 完成设计、实现、验证与协作，并提供可复用的命令和模板。
>
> 适合分享给团队新人快速上手，也适合有经验的开发者查阅最佳实践。

---

## 目录结构

```
claude-code-practices/
│
├── README.md                                       ← 你在这里
│
├── 实战手册/                                       # 4 份主干文档（先读）
│   ├── claude使用手册.md                            # 快捷键/斜杠命令/CLAUDE.md/Memory/Hooks
│   ├── claude提示词大全.md                          # 验证驱动 / 划定范围 / 结构化提示词 / 反模式
│   ├── claude扩展清单与制作指南.md                   # MCP / Skill / Command 清单与制作方法
│   └── claude设计驱动·测试闭环·多Agent协作.md        # 核心工作流（14 节）
│
├── command/                                         # 可直接复制到 ~/.claude/commands/ 的命令模板
│   ├── review-go.md                                 # /review-go 入口 → 规则本体
│   ├── 资深Go架构师代码审查.md                       # Go 后端深度审查 Pipeline
│   ├── review-fullstack.md                          # /review-fullstack 入口
│   ├── 全栈架构师代码审查.md                         # 全栈审查（含前后端契约、生态链扫描）
│   ├── apple-design.md                              # /apple-design — Apple HIG 设计评审
│   ├── test-dev.md                                  # /test-dev — 测试环境回归
│   └── adr-new.md                                   # /adr-new — 架构决策记录生成器
│
├── data/                                           # 命令运行时引用的数据模板（非 slash 命令）
│   └── api-test-cases.md                            # /test-dev 引用的 API 测试用例模板
│
├── hooks/                                           # Claude Code Hook 样本脚本
│   ├── README.md                                    # 事件类型 + settings.json 配置示例
│   ├── sensitive-file-block.sh                      # PreToolUse: 拦截 git commit 敏感文件
│   ├── post-edit-quality.sh                         # PostToolUse: 改完文件跑 lint/typecheck
│   └── pre-stop-verify.sh                           # Stop: 未提交变更触发测试的样本
│
├── templates/                                       # 初始化项目时一次性复制的配置模板
│   ├── USER-CLAUDE.md.template                      # ~/.claude/CLAUDE.md 全局偏好
│   └── CLAUDE.md.template                           # 项目级 CLAUDE.md
│
└── skill/
    └── devtestops/                                  # DevTestOps 流程 Skill（完整 pipeline）
        ├── SKILL.md                                 # 装到 ~/.claude/skills/devtestops/ 后自动触发
        └── references/
            ├── checklist.md                         # 提测准入基线
            ├── specialized-tests.md                 # 8 类专项测试触发规则
            └── test-levels.md                       # 变更类型 → 测试级别映射
```

---

## 快速开始（5 步）

### Step 1：读文档（30 分钟上手）

| 顺序 | 文档 | 你会学到 | 时间 |
|:----:|------|----------|:----:|
| 1 | [使用手册](./实战手册/claude使用手册.md) | 快捷键、斜杠命令、CLAUDE.md、Memory、Hooks | 10 min |
| 2 | [提示词大全](./实战手册/claude提示词大全.md) | 验证驱动、划定范围、结构化提示词、反模式 | 10 min |
| 3 | [扩展清单](./实战手册/claude扩展清单与制作指南.md) | 已装的 MCP/Skill 清单、怎么自己做 | 5 min |
| 4 | [设计驱动·测试闭环·多 Agent 协作](./实战手册/claude设计驱动·测试闭环·多Agent协作.md) | 核心工作流（先看开篇和第 14 节） | 5 min |

### Step 2：装命令和数据（5 分钟生效）

```bash
# 全局安装（所有项目共用）
mkdir -p ~/.claude/commands ~/.claude/data
cp docs/claude-code-practices/command/*.md ~/.claude/commands/
cp docs/claude-code-practices/data/*.md    ~/.claude/data/

# 或只装到当前项目
mkdir -p .claude/commands .claude/data
cp docs/claude-code-practices/command/*.md .claude/commands/
cp docs/claude-code-practices/data/*.md    .claude/data/
```

装完就能用：`/review-go`、`/review-fullstack`、`/apple-design`、`/test-dev`、`/adr-new`。

`data/` 下的 `api-test-cases.md` 是 `/test-dev` 运行时读的数据模板——按你项目实际接口补充用例。

### Step 3：装 DevTestOps Skill（按任务选择验证）

```bash
mkdir -p ~/.claude/skills
cp -r docs/claude-code-practices/skill/devtestops ~/.claude/skills/
```

安装后可按实际任务和项目已有测试要求选用 Skill，结合受影响行为与证据缺口选择验证方法；纯文档、注释等不涉及逻辑变化的任务不属于该 Skill 的运行场景。复制 Skill 不代表每次改动都自动执行测试。

### Step 4：装 Hooks（挡住事故）

Hook 示例依赖 Bash、`jq` 和对应项目的检查工具。复制脚本后还需在 `settings.json` 中绑定事件；按项目要求核对用途与执行范围，脚本复制本身不会启用 Hook。

```bash
# 复制脚本
mkdir -p ~/.claude/hooks
cp docs/claude-code-practices/hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh

# 合并 settings.json — 见 hooks/README.md
```

三个 Hook 样本：
- **sensitive-file-block** — 拦截 `git commit` 敏感文件
- **post-edit-quality** — 改完代码自动跑 lint/typecheck
- **pre-stop-verify** — 有未提交变更时执行识别到的项目测试命令，失败阻止收尾

`pre-stop-verify` 样本按工作区是否有改动触发，不会区分纯文档与业务变更，也不会自动选择受影响用例。仅在项目确实要求这种收尾门禁时绑定；按任务选择验证的项目不应直接启用该全量样本。Hooks 的启用不扩大任务或测试授权。

### Step 5：建立 CLAUDE.md

```bash
# 全局偏好
cp docs/claude-code-practices/templates/USER-CLAUDE.md.template ~/.claude/CLAUDE.md

# 项目偏好（到项目根目录）
cp docs/claude-code-practices/templates/CLAUDE.md.template /path/to/your/project/CLAUDE.md
```

按模板里的 `{{占位符}}` 填你项目的实际值。项目模板会继承全局偏好，只需要写项目特有的覆盖项。

---

## 核心理念（一分钟版本）

- **设计驱动**：先明确问题、范围和验收；复杂功能比较方案并记录必要 ADR，局部修复采用有证据的最小改动
- **验证闭环**：结论必须对应实际证据。业务改动按行为选择测试或真实链路；纯文档核对内容、链接与示例，不把搜索或构建成功当成功能验收
- **多 Agent 协作**：Claude 写代码 / Codex 审代码 / 人类决策。交叉审查消除单模型盲区
- **工作流 > 工具**：按任务确定设计、验证与协作的必要程度，模型升级不代替结果核对

> 术语定位：这套做法在业内被称为 **Agentic Engineering**——和 Karpathy 提的 Vibe coding（凭感觉让 AI 写、能跑就行）对照，强调人类编排 agent、设置质量门禁、验证输出，把 AI 生成代码纳入工程闭环。说到底：AI 可以写代码，不能替你承担工程责任。

> 模型升级时，按实际受影响任务评估提示词与验证方法；已有证据不足或出现行为变化时再补相关验证，不默认重跑所有项目检查。

完整叙事参见公众号文章 [《河蟹 AI 背后的 Claude Code SOP：设计驱动 × 测试闭环 × 多 Agent 协作》](https://mp.weixin.qq.com/s/1rza-Ye3NF89KNAJp_PttA)。

---

## 进阶文档

- [设计驱动·测试闭环·多Agent协作](./实战手册/claude设计驱动·测试闭环·多Agent协作.md) — 14 节工作流全文
- [DevTestOps Skill 详解](./skill/devtestops/SKILL.md) — 7 阶段交付 + 8 类专项测试
- [Hooks 工作原理](./hooks/README.md) — Claude Code 5 种事件类型和 settings.json 绑定

## 反馈

- Issue：[hexclaw-desktop issues](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- 如果这套 SOP 帮到了你，欢迎 star 一下 HexClaw 主仓库——这也是持续迭代这套 SOP 的地方
