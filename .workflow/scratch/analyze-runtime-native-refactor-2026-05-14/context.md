# Context: Runtime-native Refactor

**Date**: 2026-05-14
**Areas discussed**: skill 路由语义, Executor 命名, MODE:DIRECT 统一, execMode 收敛, SPE 兼容性

## Decisions

### Decision 1: M1 最小修复 — 只改路由不改实现
- **Context**: skillBridge.ts:133 使用 `type='chat'` 绕过 SkillTaskExecutor，导致语义与实际路由不匹配
- **Options**:
  1. 新增 SkillTaskExecutor 实现 ← 用户明确拒绝
  2. **修改路由 + ChatAgentExecutor 改名** ← 已采纳
  3. 保持现状（继续 type='chat' 兼容）
- **Chosen**: 方案 2 — 创建 `createContextAwareExecutor` 中 type='skill' → RuntimeLLMExecutor 的映射
- **Reason**: 最小改动（3 文件 ~5 行），不改执行流，验证简单
- **Rejected**: 方案 1 过度设计；方案 3 长期架构负债

### Decision 2: M4 统一 LLM Contract 推迟到 P1
- **Context**: MODE:DIRECT + sanitization 硬编码在 agentAdapter.ts:44-70
- **Chosen**: P1 — Wave 1 不改动此逻辑
- **Reason**: 当前不影响 SPE skill 执行，新增 archetype 类型时再处理

### Decision 3: M6 execMode 收敛推迟到 P1
- **Context**: execMode toggle 控制 RT vs WS 路径
- **Chosen**: P1 — Wave 1 不改此 toggle
- **Reason**: RT 路径当前作为 skill 专属路径而非通用 chat 路径

## Constraints

### Locked
1. **不新增 SkillTaskExecutor 实现** — M1 通过路由 + 改名修复，不新增 class
2. **不破坏 SPE 已验证路径** — summarize + bulletize UAT 是回归标准
3. **不改 WS 流式架构** — WS path 保持独立
4. **不引入 workflow/planner/multi-agent**

### Free
- ChatAgentExecutor 的新名称（建议 RuntimeLLMExecutor）
- createContextAwareExecutor 中 'skill' case 的实现方式（if-else fallthrough 或 switch case）
- skillBridge.ts 的 type 字段值（'skill' 确认）
- Wave 1 的 commit 粒度（1 个 commit 或 3 个分开）
- Wave 1 是否需要新 test 用例

### Deferred
- M3: 删除 createExecutor() 死代码（P2）
- M4: MODE:DIRECT/sanitization 提取到统一模块（P1）
- M5: Capability 检查统一（P2）
- M6: execMode toggle 收敛（P1）
- M8: 删除/重写 SkillTaskExecutor（P2）
- M10: WS Task 生命周期复用 runtimeBridge（P2）
- M7: RT/WS 共享端点处理（已接受）
- M9: 浏览器 dev 兼容（不适用）

## Code Context
- `src/services/agentAdapter.ts:87` — `ChatAgentExecutor` → `RuntimeLLMExecutor`（改名点）
- `src/services/taskExecutor.ts:171` — `createContextAwareExecutor` switch（路由加点）
- `src/services/skillBridge.ts:133` — `type: 'chat'` → `type: 'skill'`（语义修正）
- `src/services/taskExecutor.ts:103-132` — `SkillTaskExecutor` 桩（P2 清理）
- `src/services/agentAdapter.ts:44-70` — MODE:DIRECT 硬编码（P1 提取）
- `src/stores/chat-send-controller.ts:207` — execMode toggle（P1 收敛）
