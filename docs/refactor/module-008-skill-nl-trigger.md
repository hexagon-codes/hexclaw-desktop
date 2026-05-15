# Module 008: Skill NL Trigger (Limited Scope)

> 日期：2026-05-15
> Priority：P2（Module 007 完成后推进）
> Risk：中（涉及 Chat Send Controller 路由逻辑）
> Status：规划完成，待执行

---

## 1. Goal

让用户通过自然语言描述任务，系统自动匹配并触发对应的**官方 Skill**，而不需要显式使用 `@mention` 语法。

**限定范围**：仅官方 skill 且显式声明 triggers 的支持自然语言触发。外部/自定义 skill 保持 @mention 触发。

---

## 2. P0/P1 规则（设计约束）

| 规则 | 说明 |
|------|------|
| **External/custom skill 只能 @mention 触发** | 安全考虑，避免误触发 |
| **不支持自然语言自动触发（外部 skill）** | 外部 skill 不进入 NL trigger 匹配 |
| **不自动生成 triggers** | 不基于 description 推断 triggers |
| **不基于 description 推断 triggers** | 避免不准确的意图匹配 |
| **官方 skill 如需 NL trigger，必须显式声明 triggers** | 需单独评估 |
| **NL trigger 属于 Product UX 层能力** | 不进入 Runtime 核心 |

---

## 3. Background

### 当前状态

| 触发方式 | 支持范围 | 状态 |
|----------|----------|------|
| @mention (`@skill-name`) | 所有 skill | ✅ 已实现 |
| 斜杠命令 (`/command`) | 官方 commands | ✅ 已实现 |
| 自然语言触发 | 无 | ❌ 未实现 |

### 用户体验痛点

**当前**：用户必须记住 skill 名称和语法
```
@summarize 这段文字需要总结
@bulletize 把这些要点列出来
```

**目标**：用户用自然语言描述意图
```
帮我总结这段文字
把这些要点列出来
```

### 依赖关系

```
Module 007 (Skill Package Format) ✅
    ↓
Module 008 (Skill NL Trigger - Limited)
    ↓
未来的 Multi-skill Orchestration（P3，不做）
```

---

## 4. Scope

### In Scope（本模块交付）

| Phase | 内容 | 涉及文件 |
|-------|------|---------|
| Phase 1 | triggers 字段解析 + SkillRegistry 消费 | `skillRegistry.ts`, `skill.ts` (types) |
| Phase 2 | 意图识别模块（基于 triggers + 关键词匹配） | 新增 `intentMatcher.ts` |
| Phase 3 | Chat Send Controller 集成 | `chat-send-controller.ts` |
| Phase 4 | 置信度阈值 + fallback 机制 | `intentMatcher.ts`, `skillBridge.ts` |

### Out of Scope（明确不做）

| 排除项 | 原因 |
|--------|------|
| 外部/自定义 skill 的 NL trigger | 安全考虑，避免误触发 |
| 基于 description 自动生成 triggers | 不准确，需要人工审核 |
| 多 skill 编排 | 太早，P3 考虑 |
| NL trigger 进入 Runtime 核心 | 属于 Product UX 层能力 |
| Embedding trigger（向量匹配） | 过早优化，关键词匹配足够 |
| Trigger conflict resolution | 单 skill 触发即可 |

---

## 5. 触发方式分层

### Skill 类型与触发方式

| Skill 类型 | @mention | /command | NL Trigger | 说明 |
|------------|----------|----------|------------|------|
| **官方 Skill** (已声明 triggers) | ✅ | ❌ | ✅ | 需显式声明 triggers 字段 |
| **官方 Skill** (未声明 triggers) | ✅ | ❌ | ❌ | 保持原有行为 |
| **官方 Commands** | ❌ | ✅ | ❌ | 独立触发路径 |
| **外部/自定义 Skill** | ✅ | ❌ | ❌ | 安全考虑 |

### 触发优先级

```
1. 斜杠命令 (/command)     → 最高优先级，直接执行
2. @mention (@skill-name)  → 高优先级，直接执行
3. 自然语言 (NL trigger)   → 低优先级，需要置信度验证
4. 普通聊天                → 默认行为
```

---

## 6. Implementation Details

### Phase 1: triggers 字段解析

**skill.json 扩展**：
```json
{
  "name": "summarize",
  "display_name": "文本摘要",
  "triggers": ["总结", "摘要", "summarize", "要点"],
  "trigger_config": {
    "language": ["zh", "en"],
    "confidence_threshold": 0.7
  }
}
```

**类型定义**：
```typescript
interface SkillPackageMeta {
  // ... 现有字段
  triggers?: string[]
  trigger_config?: {
    language?: string[]
    confidence_threshold?: number
  }
}
```

### Phase 2: 意图识别模块

**新增 `src/services/intentMatcher.ts`**：

```typescript
interface IntentMatch {
  skillId: string
  confidence: number
  matchedTrigger: string
  source: 'official' | 'custom' | 'external'
}

function matchIntent(
  input: string,
  skills: SkillMeta[]
): IntentMatch | null {
  // 1. 过滤：只匹配官方 skill
  const officialSkills = skills.filter(s => s.source === 'official')
  
  // 2. 匹配：基于 triggers 字段
  for (const skill of officialSkills) {
    if (!skill.triggers) continue
    
    for (const trigger of skill.triggers) {
      if (input.includes(trigger)) {
        return {
          skillId: skill.skillId,
          confidence: calculateConfidence(input, trigger),
          matchedTrigger: trigger,
          source: skill.source
        }
      }
    }
  }
  
  return null
}
```

### Phase 3: Chat Send Controller 集成

**修改 `src/stores/chat-send-controller.ts`**：

```typescript
async function handleSend(message: string) {
  // 1. 检查斜杠命令
  if (message.startsWith('/')) {
    return handleSlashCommand(message)
  }
  
  // 2. 检查 @mention
  const mentionMatch = message.match(/^@(\w+)\s+(.*)/)
  if (mentionMatch) {
    return handleMention(mentionMatch[1], mentionMatch[2])
  }
  
  // 3. 检查自然语言触发
  const intentMatch = matchIntent(message, skillRegistry.getAll())
  if (intentMatch && intentMatch.confidence >= 0.7) {
    return handleSkillInvocation(intentMatch.skillId, message)
  }
  
  // 4. 普通聊天
  return handleNormalChat(message)
}
```

### Phase 4: 置信度阈值 + Fallback

**置信度计算**：
```typescript
function calculateConfidence(input: string, trigger: string): number {
  // 精确匹配
  if (input === trigger) return 1.0
  
  // 包含匹配
  if (input.includes(trigger)) {
    // 位置权重：开头 > 中间 > 结尾
    const position = input.indexOf(trigger) / input.length
    return 0.7 + (1 - position) * 0.3
  }
  
  return 0
}
```

**Fallback 机制**：
- confidence >= 0.7 → 直接触发 skill
- 0.4 <= confidence < 0.7 → 提示用户确认："你是不是想用 {skillName}？"
- confidence < 0.4 → 普通聊天

---

## 7. Exit Criteria

### 功能验收

| # | 标准 | 验证方式 |
|---|------|----------|
| 1 | 官方 skill 且声明 triggers 的支持 NL 触发 | 输入"帮我总结这段话" → 触发 summarize |
| 2 | @mention 语法保持向后兼容 | 输入"@summarize 文本" → 仍正常工作 |
| 3 | 普通 chat 不受误触发影响 | 输入"今天天气怎么样" → 普通 chat |
| 4 | 外部 skill 不支持 NL 触发 | 外部 skill 只能 @mention 触发 |
| 5 | 斜杠命令优先级最高 | 输入"/command" → 直接执行，不走 NL |

### UAT 测试用例

| 输入 | 预期行为 | 优先级 |
|------|----------|--------|
| "帮我总结这段话" | 触发 summarize skill | P0 |
| "把这段变成要点" | 触发 bulletize skill | P0 |
| "@summarize 文本" | 显式触发，仍正常工作 | P0 |
| "今天天气怎么样" | 普通 chat，无 skill 触发 | P0 |
| "/help" | 执行 help 命令 | P0 |
| "分析这个数据" | 普通 chat（无对应 triggers） | P1 |
| 外部 skill 的自然语言描述 | 普通 chat，不触发 | P1 |

### 回归测试

- [ ] 所有现有 @mention 调用仍正常
- [ ] 所有 /command 调用仍正常
- [ ] 普通聊天不受影响
- [ ] SkillResultCard 仍正常渲染

---

## 8. Risk Assessment

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 误触发（普通聊天被识别为 skill） | 中 | 高 | 置信度阈值 + 显式 @mention 优先 |
| 中文 trigger 歧义 | 中 | 中 | trigger 优先级 + 最长匹配 |
| 与现有 @mention 路径冲突 | 低 | 高 | @mention 作为最高优先级，绕过 NL 匹配 |
| 性能影响（每次输入都做意图匹配） | 低 | 低 | 关键词匹配，非 LLM 调用 |
| 外部 skill 误触发 | 低 | 高 | 外部 skill 不进入 NL 匹配 |

---

## 9. Time Estimate

| Phase | 内容 | 时间 |
|-------|------|------|
| Phase 1 | triggers 解析 + SkillRegistry 消费 | 1-2 小时 |
| Phase 2 | intentMatcher 模块 | 2-3 小时 |
| Phase 3 | Chat Send Controller 集成 | 1-2 小时 |
| Phase 4 | 置信度阈值 + fallback | 1-2 小时 |
| UAT 验证 | 真实环境测试 | 1 小时 |
| **总计** | | **6-10 小时** |

---

## 10. 依赖检查

| 依赖项 | 状态 | 说明 |
|--------|------|------|
| Module 007 (Skill Package Format) | ✅ 完成 | 提供 layers + triggers 机制 |
| skill.json triggers 字段 | ✅ 已定义 | 可选字段，官方 skill 需显式声明 |
| RuntimeLLMExecutor | ✅ 已完成 | 统一的 LLM 执行路径 |
| SkillRegistry | ✅ 已完成 | skill 发现与解析 |
| SkillBridge | ✅ 已完成 | skill 调用桥接层 |

**无硬阻塞依赖**，可直接开始。

---

## 11. 与现有流程的集成

### Plan→Execute→Review 循环

| 阶段 | 本 Module 的活动 |
|------|------------------|
| **Plan** | 本文档（已完成） |
| **Execute** | Phase 1-4 实现 |
| **Review** | 代码审查（重点关注路由逻辑） |
| **Test** | UAT 测试（重点：误触发检测） |
| **Verify** | Exit Criteria 验证 |

### TDD 适用性

| 适合 TDD | 不适合 TDD |
|----------|------------|
| intentMatcher 匹配逻辑 | Chat Send Controller 集成 |
| 置信度计算 | UI 交互反馈 |
| triggers 字段解析 | Fallback 用户体验 |

---

## 12. 后续演进

### Module 009 (P3，未来考虑)

- 多 skill 编排（一个意图触发多个 skill）
- Trigger conflict resolution（多 skill 匹配时的决策）
- 基于用户历史的 trigger 学习

### 不做的事

- Embedding trigger（向量匹配）— 过早优化
- 外部 skill NL trigger — 安全风险
- Runtime 核心集成 — 属于 UX 层

---

## 13. 参考文档

- `docs/system/MODULE_STATUS.md` — 当前模块状态
- `docs/system/PROJECT_CONSTITUTION.md` — 项目总宪法
- `docs/refactor/module-007-skill-package-format.md` — Module 007 规划
- `docs/refactor/runtime-native-roadmap.md` — 二次开发路线图
