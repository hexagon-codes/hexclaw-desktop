# Chat-first Skill Flow 分析

> 分析日期：2026-05-13
> 上下文：Runtime Foundation 已稳定，进入 Product Runtime Integration Phase
> 基础：runtime-kernel-v0.7 / runtime-constitution-v0.8 / runtime-stabilization-p0 complete

---

## 目录

1. [架构总览](#1-架构总览)
2. [Skill Invocation Boundary](#2-skill-invocation-boundary)
3. [Intent vs Runtime Boundary](#3-intent-vs-runtime-boundary)
4. [Param Card 语义](#4-param-card-语义)
5. [Capability Integration Point](#5-capability-integration-point)
6. [Product Integration Risks](#6-product-integration-risks)
7. [最小 Execute Proposal](#7-最小-execute-proposal)
8. [Deferred Capabilities](#8-deferred-capabilities)

---

## 1. 架构总览

### 1.1 当前状态：Skill Infrastructure 已就位

| 层 | 组件 | 状态 |
|---|------|------|
| Data Model | `Skill` / `ClawHubSkill` / `SkillMeta` / `SkillPackage` | ✅ 已定义 |
| Discovery | `SkillRegistry` — 扫描 `skills/{id}/skill.json` | ✅ 已实现 |
| Loading | `SkillLoader` — 读取 skill.json + SKILL.md + references | ✅ 已实现 |
| Capability | `CapabilityValidator` — 3-stage rule chain (Phase 4) | ✅ 已实现 |
| Invocation UI | `ChatInput` + `MentionPopup` — `@skill` 选择 | ✅ 已实现 |
| Runtime Execute | `RuntimeStore.executeTask()` + `ContextAwareExecutor` | ✅ 已实现 |
| Skill Marketplace | `skills-marketplace.ts` — 18 mock skills | ✅ 测试用 |

### 1.2 关键缺口：中间链路缺失

```
用户输入 "@translate 你好" ──→  ???  ──→ Runtime Execute
                                  ↑
                    当前缺失的中间链路：
                    - Intent Recognition（识别 @skill 意图）
                    - Skill Match（将意图映射到具体 Skill）
                    - Param Extraction（提取参数）
                    - Skill Execute（调用 Runtime Execute）
                    - Result Translation（Skill Result → Chat Result）
```

### 1.3 核心设计原则

1. **Chat-first**：Skill 是 Chat 的增强，不是独立工作流引擎
2. **不走 DAG**：禁止 Workflow Engine / Node Graph / BPMN / Visual Builder
3. **Runtime Kernel 不变**：Skill Execute 复用现有的 `executeTask`，不新增 Runtime 概念
4. **Bridge 模式**：Chat ↔ Runtime 通过 `runtimeBridge` 交互，不直接 import RuntimeStore

---

## 2. Skill Invocation Boundary

### 2.1 调用方式：两种入口

```
方式 A：@mention 显式调用
  用户输入 "@skillName 参数" → 明确意图 → 直接 Route 到 Skill

方式 B：NL 隐式触发
  用户输入 "翻译你好" → Intent Recognition → 匹配 Skill trigger
```

### 2.2 @mention 方式（P0，立即实现）

**触发检测**：`ChatInput` 已支持 `@` 检测，`MentionPopup` 已过滤并展示 Skill 列表。

**当前缺口**：选中 skill 后只做了文本插入（`@skillName `），没有任何 invocation 逻辑。

**建议**：在 `chat-send-controller.ts` 的 `sendMessage()` 入口处，检测消息文本是否以 `@skillName` 开头：

```typescript
// sendMessage 入口处
const skillMatch = text.match(/^@(\S+)\s*(.*)/)
if (skillMatch) {
  const skillName = skillMatch[1]
  const skillInput = skillMatch[2]
  // → 走 Skill Invocation path，不走普通 chat
}
```

**边界规则**：
- `@mention` 必须出现在消息开头，中间出现的 `@` 不作为 skill 调用
- `@skillName` 后无参数时，视为缺少参数（走 Param Card 流程）
- `@skillName` 后跟参数时，直接执行

### 2.3 NL 隐式触发（P1，deferred）

**触发检测位置**：可以在 `chat-send-controller.ts` 中（Chat 层），也可以在 `RuntimeContext` 注入后（Runtime 层）。

**不建议进入 Runtime Kernel** 的理由：
- Trigger match 是纯文本操作，不需要 RuntimeContext
- Runtime Kernel 不应关心 "这条消息是否匹配某个 skill trigger"
- Chat 层是最自然的检测位置（已有消息文本）

**建议 deferred**，原因是：
- 当前没有真实 skill 需要 NL trigger
- @mention 已覆盖 P0 用例
- NL trigger 的误触率需要实际用户数据才能调优

### 2.4 Invocation Boundary 总结

| 维度 | 决策 | 原因 |
|------|------|------|
| @mention 检测位置 | `chat-send-controller.ts` sendMessage 入口 | 已有消息文本，不依赖 Runtime |
| NL trigger 检测位置 | Deferred | 无真实需求，误触不可控 |
| Skill Match 位置 | Deferred（或简单 Map lookup） | 当前 skill 量级小，Map 足够 |
| Execute 路由 | `runtimeBridge.executeChatTask()` | 复用现有 Runtime 执行链路 |
| Result 返回 | `TaskResult` → `buildAssistantMessage()` | 复用现有 Chat 消息展示 |

---

## 3. Intent vs Runtime Boundary

### 3.1 分界原则

```
Chat 层（Intent）                    Runtime 层（Execution）
─────────────────                    ────────────────────
@mention 检测                        Skill execute
Skill lookup                         Context 管理
Param extraction (简单)               Timeline 事件
Param Card 展示（复杂参数）           Memory 管理
Skill Result → Chat Message          Capability 验证
```

**Chat 层负责**：
- "用户想做什么"（Intent Recognition）
- "用哪个 skill"（Skill Match — 当前简单 Map，未来语义）
- "参数是什么"（Param Extraction — 简单 regex 或 Param Card）
- "结果怎么展示"（Result → ChatMessage）

**Runtime 层负责**：
- "怎么执行这个 skill"（Execution）
- "执行上下文管理"（RuntimeContext）
- "执行过程记录"（Timeline）
- "内存写入"（Memory）

### 3.2 不进入 Runtime 的 Intent 逻辑

以下**绝不能**进入 Runtime Kernel：

1. **@mention parsing** — 纯文本操作
2. **Skill trigger match** — 文本模式匹配
3. **Skill lookup** — Registry 查询
4. **Param extraction** — 参数解析
5. **Param Card display** — UI 层
6. **Result formatting** — ChatMessage 构建

### 3.3 必须进入 Runtime 的 Execution 逻辑

以下**必须**通过 `runtimeBridge.executeChatTask()` 进入 Runtime：

1. **Skill 实际执行** — `ContextAwareExecutor`
2. **Capability 验证** — `CapabilityValidator`
3. **RuntimeContext 管理** — Context 生命周期
4. **Timeline 事件** — 执行记录
5. **Memory 写入** — 持久化

### 3.4 Intent ↔ Runtime 数据流

```
Chat Layer                          Runtime Layer
──────────                          ────────────
sendMessage()
  ├─ @mention detect                skill.execute (via runtimeBridge)
  ├─ skill lookup                      ├─ CapabilityValidator.check()
  ├─ param extract                     ├─ ContextAwareExecutor.run()
  ├─ Param Card (if needed)            ├─ Timeline.write()
  └─ runtimeBridge.executeChatTask()   └─ Memory.write()
       │
       ▼
  TaskResult ←────────────────────── output
       │
       ▼
  buildAssistantMessage()
  → 展示 ChatMessage
```

---

## 4. Param Card 语义

### 4.1 需求分析

Param Card 是当用户 `@skillName` 但未提供足够参数时，Chat 层展示的参数收集卡片。

### 4.2 不是 Workflow Form

**重要区分**：
- Param Card = 参数收集（一次性），不是 multi-step form
- Param Card = 单次交互，不是 wizard/stepper
- Param Card = chat 内联卡片，不是独立页面

### 4.3 谁定义参数

方案对比：

| 方案 | 描述 | 评价 |
|------|------|------|
| A: skill.json 声明 params schema | skill.json 加 `params` 字段描述参数 | ✅ 明确，可验证 |
| B: SKILL.md 语义解析 | 从 markdown 提取参数 | ❌ 不精确，难维护 |
| C: Runtime 返回 missing params | 执行时发现缺参数再返回 | ❌ 浪费一次执行 |

**建议方案 A**：在 `skill.json` 中声明 `params` schema：

```json
{
  "name": "translate",
  "params": {
    "required": ["text"],
    "optional": ["source_lang", "target_lang"],
    "properties": {
      "text": { "type": "string", "label": "翻译文本" },
      "target_lang": { "type": "string", "label": "目标语言", "default": "中文" }
    }
  }
}
```

### 4.4 Param Card 交互流程

```
用户：@translate
  → Chat 检测到 @skillName 但无参数
  → 不提交消息（或提交但标记为 param-collection）
  → Chat 层展示 Param Card
  → 用户填写参数
  → 用户确认 → 发送实际执行请求

Param Card 不是 Runtime 概念：
  - 参数 schema 解析在 Chat 层
  - Card 渲染在 UI 层
  - Runtime 只收到完整的 execute 请求
```

### 4.5 参数提取优先级

```
1. 内联参数（消息文本中提取）：
   @translate 你好 → { text: "你好" }
   @translate 你好 target_lang=en → { text: "你好", target_lang: "en" }

2. Param Card（内联参数不足时）：

3. Skill default（参数未提供时使用 skill.json 定义的 default）
```

### 4.6 Param Card 不在 P0

Param Card 需要 UI 组件开发（Card 渲染、表单提交）。
P0 建议只做内联参数提取，参数不足时直接报错提示。
Param Card 作为 P1 deferred。

---

## 5. Capability Integration Point

### 5.1 现有基础设施

```typescript
// 已存在：
CapabilityValidator.validate(skillCaps, policy, registry)
// 返回：{ valid, unknownCaps, unauthorizedCaps, deniedCaps, effectiveCaps, warnings }

// 内置 skill.* capabilities：
skill.execute   → riskLevel: medium
skill.discover  → riskLevel: low
skill.load      → riskLevel: low

// 默认允许列表：
DEFAULT_ALLOWED_CAPABILITIES = ['llm', 'image_generation', 'filesystem.read']
```

### 5.2 集成点：Execute 之前

```
@skillName detected
  → Skill lookup → get SkillMeta.capabilities[]
  → CapabilityValidator.validate(skillCaps, policy, registry)
  → if !valid → 展示警告/拒绝执行
  → else → runtimeBridge.executeChatTask()
```

### 5.3 策略管理

- **System Policy** 由 `RuntimeContext` 的 System Layer 管理
- 当前 `DEFAULT_ALLOWED_CAPABILITIES` 位于 `capability.ts`
- 未来 Policy 可扩展为 per-skill / per-session / per-user 级别

### 5.4 不在 Chat 层做 Capability Check

**原因**：
- Capability registry 在 Runtime 侧
- Policy 判断可能依赖 RuntimeContext（如 session 级别的 override）
- Chat 层不应该 import CapabilityValidator

**建议**：Capability check 封装在 `runtimeBridge` 中（或新的 `skillBridge`），Chat 层只需调用 bridge 方法。

---

## 6. Product Integration Risks

### 6.1 风险矩阵

| 风险 | 等级 | 描述 | 缓解 |
|------|------|------|------|
| Skill Execute 成为隐形 Workflow Engine | 🔴 High | 用户希望 skill 能做 complex multi-step | 明确禁止 DAG，single-task linear execution |
| @mention 与 NL 冲突 | 🟡 Medium | 消息中普通 `@` 被误识别为 skill invocation | 仅消息开头 `@` 触发 |
| Skill 执行时间过长 | 🟡 Medium | Chat 期望快速响应 | 复用现有 timeout 机制 |
| Param Card 演化为 Form Builder | 🟡 Medium | 参数收集逐步扩展成可视化表单 | Param Card = 一次性，禁止 multi-step |
| Skill Result 格式不兼容 | 🟡 Medium | Skill 返回非 text 格式 | 当前 TaskResult 只有 `kind: 'text'` |
| Capability 绕过 | 🔴 High | Skill 声明高级 capability 但未授权 | CapabilityValidator 在 execute 前执行 |
| Skill 版本管理 | 🟢 Low | skill.json 版本升级 | 延后处理 |

### 6.2 绝对不做的红线

| 禁止项 | 理由 |
|--------|------|
| DAG / Workflow Engine | ADR-001，复杂度不可控 |
| Node Graph / Visual Builder | Product 定位不在此 |
| BPMN | 企业级太重 |
| Auto Agent Planner | 不可预测 |
| Multi-Agent | 超出 Chat-first scope |
| Skill Chain / Pipeline | 同 DAG |
| Param Card → Form Builder | UI 复杂度不可控 |
| NL trigger → semantic match | P0 不需要，误触不可控 |

### 6.3 边界防守原则

```
Skill 调用链路每增加一个"可以做复杂事情"的点，
就是一次红线入侵。必须保持：
  @skill → execute → result
  ↑ 没有中间层，没有编排，没有条件分支
```

---

## 7. 最小 Execute Proposal

### 7.1 实现方案

#### 新增文件：`src/services/skillBridge.ts`

```typescript
/**
 * skillBridge — Skill Execute 的 Chat-Runtime Bridge。
 *
 * 职责：
 * - @mention 检测（消息文本解析）
 * - Skill lookup（Registry 查询）
 * - Param extraction（简单内联提取）
 * - Capability check（委托 CapabilityValidator）
 * - Execute（委托 runtimeBridge.executeChatTask）
 * - Result → ChatMessage（委托 buildAssistantMessage）
 *
 * 不是：
 * - Workflow Engine
 * - DAG
 * - Skill Chain
 * - Intent Recognition Engine
 */
```

#### 修改文件：`src/stores/chat-send-controller.ts`

在 `sendMessage()` 入口处，检测 `@skillName` 并路由到 skill path：

```typescript
async function sendMessage(text: string, ...) {
  // ── Skill Invocation 检测 ──────────────────
  const skillInvocation = parseSkillInvocation(text)
  if (skillInvocation) {
    return executeSkillInvocation(skillInvocation, sessionId, ...)
  }
  
  // ── 原有 Chat 逻辑 ─────────────────────────
  // ...
}
```

### 7.2 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/skillBridge.ts` | **新增** | Skill invocation bridge |
| `src/stores/chat-send-controller.ts` | 修改 | 入口处加 skill invocation 检测 |
| `src/types/skill.ts` | 可选修改 | 加 `SkillParams` 类型支持 |
| `src/services/capabilityValidator.ts` | 不修改 | 已有足够 API |
| `src/services/runtimeBridge.ts` | 不修改 | 复用 `executeChatTask` |
| `src/components/chat/ChatInput.vue` | 不修改 | @mention UI 已就位 |
| `src/components/chat/MentionPopup.vue` | 不修改 | skill 展示已就位 |

### 7.3 数据流

```
ChatInput
  → @skillName 参数 发送
  → chat-send-controller.ts sendMessage()
    → skillBridge.parseSkillInvocation(text)
      → 检测 /^@(\S+)\s*(.*)/ match
      → 提取 skillName, skillInput
    → skillBridge.lookupSkill(skillName)
      → SkillRegistry.resolveSkill() / getAllSkills()
      → 按 name / display_name 匹配
    → skillBridge.extractParams(skillMeta, skillInput)
      → 简单 regex/parse（非 NLU）
      → 返回 params object
    → skillBridge.checkCapabilities(skillMeta)
      → CapabilityValidator.validate()
      → 不通过 → 返回 error message（不走 Runtime）
    → runtimeBridge.executeChatTask(taskId)
      → RuntimeStore.executeTask()
      → ContextAwareExecutor.execute()
      → TaskResult
    → buildAssistantMessage(result.content)
    → push message → display
```

### 7.4 代码量估算

| 模块 | 行数 | 说明 |
|------|------|------|
| `skillBridge.ts` | ~80-120 行 | 5 个纯函数 + 1 个主流程 |
| `chat-send-controller.ts` 修改 | ~15-20 行 | 入口检测 + 条件分支 |
| 测试 | ~50-80 行 | 边界 case |
| **合计** | **~150-200 行** | 最小实现 |

### 7.5 不做的事情（此 proposal 明确排除）

- ❌ NL trigger 检测
- ❌ 语义级 intent recognition
- ❌ Param Card UI
- ❌ Skill chain / pipeline
- ❌ 技能市场安装 / 卸载
- ❌ Skill 版本管理
- ❌ 执行进度展示
- ❌ Capability policy UI
- ❌ Official / Custom skill 管理页面
- ❌ 多轮参数收集

---

## 8. Deferred Capabilities

### 8.1 P1：NL Trigger

**内容**：用户输入 "翻译你好" 自动匹配 translate skill，不需要 `@translate`。

**原因 deferred**：
- 无真实数据支撑 trigger pattern 设计
- 误触风险：普通对话可能意外触发 skill
- @mention 方式已经覆盖 P0 用例

### 8.2 P1：Param Card UI

**内容**：当 `@skillName` 无参数时，展示一张参数收集卡片。

**原因 deferred**：
- 需要 UI 组件开发（Card 渲染、表单、确认）
- P0 只需要内联参数提取 + 缺参报错
- Param Card 是体验优化，不是功能缺失

### 8.3 P2：Semantic Skill Match

**内容**：基于语义的 skill 匹配（不只是按 name 精确匹配）。

**原因 deferred**：
- 当前 skill 数量少（18 mock），精确匹配足够
- 语义匹配需要 embedding 模型或 NLU 服务
- 架构上不应预先引入 AI 依赖

### 8.4 P2：Official vs Custom Skill 区分

**内容**：官方预装 skill vs 用户自定义 skill 的不同管理策略。

**原因 deferred**：
- 当前所有 skill 都是本地加载
- 没有用户自定义 skill 的创建流程
- 没有 ClawHub 市场的真实集成

### 8.5 P3：Skill 版本管理

**内容**：skill.json 的版本升级、兼容性检查、回滚。

**原因 deferred**：
- 没有 skill 更新机制
- 没有多版本共存需求
- 等 ClawHub 集成时再做

### 8.6 P3：Capability Policy UI

**内容**：用户界面管理 skill 的 capability 权限。

**原因 deferred**：
- 当前只有默认 policy
- 没有 per-skill 的 policy 覆盖需求
- 等用户需要精细权限控制时再做

### 8.7 永不做（Explicitly Not Doing）

| 能力 | 理由 |
|------|------|
| Skill Chain / Pipeline | 同 DAG，禁止 |
| Multi-Agent 编排 | 超出 Chat-first scope |
| Visual Skill Builder | 同 Visual Builder，禁止 |
| Auto Agent Planner | 不可预测，禁止 |
| NLU-as-a-Service | 目前不需要外部 NLU 服务 |

---

## 附录 A：决策记录

| ID | 决策 | 类型 | 依据 |
|----|------|------|------|
| D1 | @mention 检测在 Chat 层 sendMessage 入口 | Locked | 纯文本操作，不依赖 Runtime |
| D2 | Skill lookup 在 Chat 层 | Locked | Registry 查询是只读操作 |
| D3 | Capability check 在 Runtime 层（通过 bridge） | Locked | Validator 依赖 Runtime 侧的 Registry |
| D4 | Skill Execute 复用 runtimeBridge.executeChatTask | Locked | 避免 Runtime Kernel 变动 |
| D5 | Skill Result = TaskResult，不走 Result Surface | Locked | TaskResult 当前只有 text，Result Surface 无需求 |
| D6 | Param Card deferred 到 P1 | Free | P0 缺参直接报错 |
| D7 | NL trigger deferred 到 P1 | Free | 无真实数据，@mention 覆盖 P0 |
| D8 | 不新增 Runtime 概念（no SkillTask, no SkillExecutor） | Locked | 复用现有 Task + Executor |
| D9 | skillBridge.ts 新增 | Free | 独立职责，不污染 runtimeBridge |
| D10 | 禁止 DAG / Workflow / Node Graph / BPMN | Locked | 产品红线 |

## 附录 B：已读源文件

| 文件 | 内容 |
|------|------|
| `src/types/skill.ts` | Skill, ClawHubSkill, SkillStatusUpdateResult 接口 |
| `src/types/capability.ts` | CapabilityName, BUILTIN_CAPABILITIES (18 个), DEFAULT_ALLOWED_CAPABILITIES |
| `src/types/task.ts` | TaskResult (`kind: 'text'`), TaskOutput |
| `src/types/workspace.ts` | ResultKind (7 kinds), ResultItemProjection |
| `src/types/execution.ts` | ExecutionState, ExecutionStage |
| `src/types/timeline.ts` | 20 RuntimeEventType, MAX_TIMELINE_EVENTS |
| `src/types/context.ts` | ExecutionLayer 接口 |
| `src/services/skillRegistry.ts` | Skill 元数据发现与缓存 |
| `src/services/skillLoader.ts` | Skill 文件加载（meta + markdown + references） |
| `src/services/capabilityValidator.ts` | 3-stage Capability 验证规则链 |
| `src/services/runtimeBridge.ts` | Chat ↔ Runtime anti-coupling shim |
| `src/stores/runtime.ts` | RuntimeStore.executeTask() |
| `src/stores/chat-send-controller.ts` | Chat 发送控制器（WS path + RT path） |
| `src/components/chat/ChatInput.vue` | Chat 输入组件（@mention 检测） |
| `src/components/chat/MentionPopup.vue` | @mention 弹出菜单（agent + skill） |
| `src/config/skills-marketplace.ts` | 18 个 mock ClawHub skills |
