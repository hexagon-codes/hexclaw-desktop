# SPE Archetype v0.1

> Single-Pass Extraction — Runtime-stable skill template
> Freeze date: 2026-05-14

---

## 1. 概述

SPE（Single-Pass Extraction）Archetype 定义了 HexClaw Desktop 中一类特定 skill 的模板化实现方式。这类 skill 的特点是：**单遍提取，不对话，不核查，不使用外部工具。**

SPE Archetype 的成立条件：
- 两个独立 skill（summarize + bulletize）在同一 Runtime 上零改动运行
- 差异仅存在于 Format Layer，Runtime Layer 完全共享
- Behavior Engineering 方法（角色定义、约束、禁止令、[MODE: DIRECT] 后缀）可完整复用

---

## 2. SPE Template v0.1

### 模板结构

```markdown
# 角色

单遍提取引擎。提取关键事实。不对话。

---

# 格式 — 严格

{OUTPUT_FORMAT_INSTRUCTION}

# 规则（违反 = 失败）

- **{MAX_LINES} 行上限**
- **每行 ≤ {MAX_CHARS_PER_LINE} 字**（含前缀）
- **总输出 ≤ 120 字**
- 保留所有数字、日期、名称、机构
- 删除冗余词：的/了/已经/达到/突破/覆盖/超过
- 每行一个核心事实 + 一个细节
- 不要空行，前缀前后不要任何文字

# 禁止

免责声明 | 推理链 | 聊天 | 表情 | Markdown | 问候语 | {FORMAT_SPECIFIC_BANS}

---

# 示例

输入：
{EXAMPLE_INPUT}

输出：
\`\`\`
{EXAMPLE_OUTPUT}
\`\`\`
```

### 模板参数表

| 参数 | summarize | bulletize | 说明 |
|------|-----------|-----------|------|
| `OUTPUT_FORMAT_INSTRUCTION` | 每行必须用 `[要点N]` 开头 | 每行必须用 `•` 开头 | 格式定义 + 禁止其他格式 |
| `MAX_LINES` | 3 | 5 | 行数上限 |
| `MAX_CHARS_PER_LINE` | 45（含 6 字 `[要点1] `） | 50（含 2 字 `• `） | 每行最大字符数 |
| `FORMAT_SPECIFIC_BANS` | `【要点】` | `【要点】`、`[要点` | 格式特化禁止项 |
| `EXAMPLE_INPUT` | 特斯拉 Q1 交付 89.4 万... | 特斯拉 Q1 交付 89.4 万... | 示例输入 |
| `EXAMPLE_OUTPUT` | 3 行 [要点N] | 3 行 • | 示例输出 |

### 辅助机制

SPE skill 还需要以下辅助配置（位于 `skill.json`）：

```json
{
  "name": "{skill-name}",
  "display_name": "{Skill Name}",
  "version": "0.1.0",
  "description": "{description}",
  "capabilities": ["llm"],
  "entry": "SKILL.md"
}
```

关键约束：`capabilities` 必须只包含 `"llm"`。任何其他 capability 都会触发 Capability Gate 检查，需要额外的 Runtime 评估。

---

## 3. 验证证据

### 测试条件

- 输入：华为 HDC 2025 新闻稿（416 字）
- 后端：Go backend API（`http://localhost:16060/api/v1/chat`）
- 模型：mimo-v2.5
- 系统提示词：对应 SKILL.md
- 用户消息后缀：`[MODE: DIRECT]` + 格式指令

### 对比结果

| 维度 | summarize | bulletize | 结论 |
|------|-----------|-----------|------|
| 输出格式 | `[要点N]` 编号列表 | `•`/`-` 无序列表 | 不同 |
| 实际行数 | 3/3 | 5/5 | 符合各自上限 |
| 最大行长度 | 43 字 / 45 上限 | 28 字 / 50 上限 | 均未超限 |
| 总输出 | ~130 字 / 120 建议 | ~117 字 / 120 建议 | bulletize 更紧凑 |
| 实体保留 | 6/10 | 7/10 | 均 ≥5/10 |
| Chat 行为 | 无 | 无 | ✅ |
| Banned 内容 | 无 | 无 | ✅ |
| Format 入侵 | 无（`【要点】` 被禁止） | 无（`[要点N]` 被禁止） | ✅ |
| Runtime 修改 | 零 | 零 | **关键结论** |

### 行为工程复用验证

| 工程方法 | summarize | bulletize | 复用度 |
|----------|-----------|-----------|--------|
| 角色定义：单遍提取引擎 | 使用 | 使用 | 100% |
| 禁止：免责声明/推理链/聊天 | 使用 | 使用 | 100% |
| 规则：保留实体/删除冗余 | 使用 | 使用 | 100% |
| [MODE: DIRECT] user message 后缀 | 使用 | 使用 | 100% |
| 格式约束独立定制 | 使用 | 使用 | 格式参数化 |
| 示例驱动压缩风格 | 使用 | 使用 | 100% |

---

## 4. Runtime vs Behavior Layer 边界

### 属于 Runtime Layer（不可参数化）

| 组件 | 职责 | 是否修改 |
|------|------|---------|
| `commands.rs` | Tauri IPC → Go backend | 不修改 |
| `agentAdapter.ts` | `buildPromptInput` 拼接 SKILL.md | 不修改 |
| `providerAdapter.ts` | systemPrompt 去重 | 不修改 |
| `backendLLMClient.ts` | 发送请求 | 不修改 |
| Go backend | 语义缓存、LLM 调用 | 不修改 |
| Capability Gate | `capabilities: ["llm"]` 检查 | 不修改 |
| Skill Registry | `source` 解析、文件查找 | 不修改 |
| `skill.json` | `name`/`display_name`/`description` | 新 skill 的元数据文件 |

### 属于 Skill Behavior Layer（可通过模板参数化）

| 组件 | 职责 | 修改方式 |
|------|------|---------|
| `SKILL.md` | 角色定义 + 格式 + 规则 + 禁止 + 示例 | 模板参数填充 |
| 输出格式 | `[要点N]` / `•` / 其他 | `OUTPUT_FORMAT` 参数 |
| 行数上限 | 3 / 5 / etc. | `MAX_LINES` 参数 |
| 每行字数 | 45 / 50 / etc. | `MAX_CHARS_PER_LINE` 参数 |
| 格式禁止 | 防止格式漂移 | `FORMAT_SPECIFIC_BANS` 参数 |

### 边界图

```
┌─────────────────────────────────────┐
│         Runtime Layer               │
│  (commands.rs / adapter / backend)  │  ← 不修改
│       Capability Gate               │
└─────────────────────────────────────┘
                   │
                   ▼  skill.json + SKILL.md
┌─────────────────────────────────────┐
│      Skill Behavior Layer           │
│  (Role / Format / Rules / Bans)     │  ← 模板参数化
│       summarize / bulletize         │
└─────────────────────────────────────┘
```

---

## 5. 适用范围

### SPE Archetype 适用

- **Single-pass extraction**（单遍提取）— 对输入文本做一次提取，无多轮交互
- **纯文本输出** — 输出仅为格式化的文本列表/摘要
- **不对话**（no chat）
- **不核实事实**（no fact-checking）
- **只使用 LLM** — `capabilities: ["llm"]`
- **不包含以下行为**：no workflow、no tool use、no validator、no multi-agent

### SPE Archetype 不适用（需 Runtime 评估）

以下类型的 skill **不能**直接使用 SPE 模板。必须重新做 Runtime 评估：

| Skill 类型 | 原因 | 需要评估的组件 |
|-----------|------|---------------|
| Workflow 类 | 多步骤执行 | Capability Gate、executor |
| Tool Use 类 | 需要外部工具调用 | Tool Registry、permissions |
| Validator 类 | 需要验证/纠错循环 | Repair Loop、error handling |
| Multi-Agent 类 | 需要多模型协作 | Agent coordination、state |
| Browser 类 | 需要网络访问 | Browser capability、CSP |
| Filesystem 类 | 需要文件写权限 | FS capability、scope |
| Generation 类 | 需要内容生成而非提取 | 不同 behavior pattern |
| Rewrite 类 | 需要修改原文而非提取 | 不同 behavior pattern |

---

## 6. 边界条款

> **超出 SPE 定义范围的 skill 必须重新做完整的 Runtime 评估。**
> 评估内容包括：Capability Gate 适配、permission 扩展、executor 逻辑变更、
> systemPrompt transport 影响、以及现有 skill 的回归测试。

### 判定方法

判断一个 skill 是否属于 SPE 范围：

```
IF skill 满足全部以下条件:
  ✅ 输入 → 输出（无多轮交互）
  ✅ 仅文本处理（无外部工具）
  ✅ 只读（不修改源数据）
  ✅ 不对话
  = SPE 范围，可直接使用模板

ELSE:
  ⚠️ 超出 SPE，必须评估 Runtime 影响
```

### 协议

- SPE 模板仅限 **single-pass extraction** 类 skill
- 任何超出此范围的 skill 必须提 Issue 评估对 Runtime 的影响
- 评估通过后方可新增对应的 Archetype 模板
- SPE Archetype 本身只增不改（新增参数，不影响已有 skill）

---

## 7. 标记建议

建议在以下节点创建 git tag：

| Tag | 含义 | 节点 |
|-----|------|------|
| `spe-archetype-v0.1` | SPE Archetype 冻结 | 当前 commit |
| `summarize-skill-alpha` | 首个 skill 就绪 | 已存在 |
| `bulletize-skill-alpha` | 第二个 skill 就绪 | 当前 commit |

`spe-archetype-v0.1` 作为 SPE 模板的正式冻结标记。后续 SPE 类 skill 均引用此标记作为基线。

---

## 附录 A: 文件路径参考

| 文件 | 路径 |
|------|------|
| summarize SKILL.md | `skills/builtin/summarize/SKILL.md` |
| summarize skill.json | `skills/builtin/summarize/skill.json` |
| bulletize SKILL.md | `skills/builtin/bulletize/SKILL.md` |
| bulletize skill.json | `skills/builtin/bulletize/skill.json` |
| 本文件 | `docs/skill-archetypes/spe-v0.1.md` |

## 附录 B: 变更历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-05-14 | v0.1 | 初始冻结。基于 summarize + bulletize 验证。 |
