# Claude Code 实战经验

> 业余时间 × 一个人 × 6 核心仓库 × 68 万行代码，做出[河蟹 AI](https://github.com/hexagon-codes/hexclaw-desktop) 的副产品。整套"怎么用 Claude Code 做出一个能跑的产品"的工作流，沉淀在这里。
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
│   └── pre-stop-verify.sh                           # Stop: 收尾前必须跑过测试
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

### Step 3：装 DevTestOps Skill（让测试流程自动触发）

```bash
mkdir -p ~/.claude/skills
cp -r docs/claude-code-practices/skill/devtestops ~/.claude/skills/
```

装完之后，跑任何改动时 Claude 会自动按变更类型触发对应级别的测试检查，不用每次提醒。

### Step 4：装 Hooks（挡住事故）

```bash
# 复制脚本
mkdir -p ~/.claude/hooks
cp docs/claude-code-practices/hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh

# 合并 settings.json — 见 hooks/README.md
```

三个开箱即用的 hook：
- **sensitive-file-block** — 拦截 `git commit` 敏感文件
- **post-edit-quality** — 改完代码自动跑 lint/typecheck
- **pre-stop-verify** — 收尾前必须跑过测试

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

- **设计驱动**：编码前先走完整设计阶段（Plan 模式 → 方案对比 → ADR），不做"一句话 + 秒出代码"
- **测试闭环**：不接受 "should pass" / "probably OK"。测试跑过、grep 扫过残留才算完成
- **多 Agent 协作**：Claude 写代码 / Codex 审代码 / 人类决策。交叉审查消除单模型盲区
- **工作流 > 工具**：模型升级只抬每一步的上限，不让"要不要做设计 / 跑测试 / 交叉审查"这些问题失效

> 术语定位：这套做法在业内被称为 **Agentic Engineering**——和 Karpathy 提的 Vibe coding（凭感觉让 AI 写、能跑就行）对照，强调人类编排 agent、设置质量门禁、验证输出，把 AI 生成代码纳入工程闭环。说到底：AI 可以写代码，不能替你承担工程责任。

> 关于 Opus 4.7：主干 SOP 不用推倒重来，但提示词、评审门禁、测试 harness 需要随模型升级重新跑一遍回归。这些是工作流判断，跟模型能力无关；但旧的验证门槛在更强的模型上可能需要重新标定。

完整叙事参见公众号文章 [《河蟹 AI 背后的 Claude Code SOP：设计驱动 × 测试闭环 × 多 Agent 协作》](https://mp.weixin.qq.com/s/1rza-Ye3NF89KNAJp_PttA)。

---

## 进阶文档

- [设计驱动·测试闭环·多Agent协作](./实战手册/claude设计驱动·测试闭环·多Agent协作.md) — 14 节工作流全文
- [DevTestOps Skill 详解](./skill/devtestops/SKILL.md) — 7 阶段交付 + 8 类专项测试
- [Hooks 工作原理](./hooks/README.md) — Claude Code 5 种事件类型和 settings.json 绑定

## 反馈

- Issue：[hexclaw-desktop issues](https://github.com/hexagon-codes/hexclaw-desktop/issues)
- 如果这套 SOP 帮到了你，欢迎 star 一下 HexClaw 主仓库——这也是持续迭代这套 SOP 的地方
