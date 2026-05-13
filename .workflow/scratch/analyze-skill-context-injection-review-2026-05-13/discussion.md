---
name: Skill Context Injection Review
description: 10-point review verifying Skill Context Injection implementation against Runtime Constitution
type: review
---

**Session**: ANL-skill-context-injection-review-2026-05-13
**Date**: 2026-05-13
**Type**: Architecture Review
**Scope**: standalone

## Decision: ✅ 允许 Commit

**Summary**: 实现完整符合 Runtime Constitution。没有红线违规，没有架构断裂。3 处 P2 改进建议。

---

## 10-Point Review Results

### Q1: loadSkillLayerForTask 是否只是注入外部已加载 SkillPackage？

**Status: ✅ 通过**

- `loadSkillLayerForTask(taskId, skillPkg)` 接收已在 skillBridge 中通过 `SkillLoader` 加载的 `SkillPackage`
- RuntimeStore 内部 **不调用** `skillLoader.loadSkill()`，不执行文件 IO
- 只调用 `loader.loadSkillLayer(ctx, skillPkg)` 做纯粹的数据注入

### Q2: Runtime 是否仍不负责 SkillRegistry / SkillLoader / 文件 IO？

**Status: ✅ 通过**

- `SkillRegistry` 不在 RuntimeStore 中导入
- RuntimeStore 虽有 `skillLoader` 实例（line 39），但仅被 `loadSkillForTask`/`reloadSkillForTask` 使用
- 新的 `loadSkillLayerForTask` **不使用** `this.skillLoader`
- 文件 IO 全部发生在 skillBridge（`new SkillLoader(baseDir).loadSkill()`）

### Q3: RuntimeStore 是否仍是唯一 Context mutation authority？

**Status: ✅ 通过**

- `loadSkillLayerForTask` 是 RuntimeStore 的方法
- `loader.loadSkillLayer(ctx, skillPkg)` 执行在 RuntimeStore 内部
- `revision.value++` 在方法内统一 bump
- `writeTimelineEvent` 在方法内触发
- skillBridge 没有任何直接操作 `RuntimeContext` 或 `ContextManager` 的代码

### Q4: skillBridge 是否没有直接 mutation RuntimeContext？

**Status: ✅ 通过**

- SkillBridge 只调用 RuntimeStore 方法：
  - `registerChatTask(task)` → runtimeBridge → RuntimeStore.registerContextForTask
  - `runtime.loadSkillLayerForTask(taskId, skillPkg)` → RuntimeStore 方法
- 没有任何直接对 `ctx.*` 或 `manager.*` 的访问

### Q5: agentAdapter 是否只是 prompt assembly？

**Status: ✅ 通过**

- `buildPromptInput` 只从 `RuntimeContext` 读取数据
- 没有导入 `SkillLoader`、`SkillRegistry` 或任何 store
- 没有文件 IO
- `executeWithContext` 只调用 `buildPromptInput` 和 `provider.execute`

### Q6: buildPromptInput 中 skill markdown 顺序是否正确？

**Status: ✅ 通过**

- `parts.push(skillLayer.markdown)` 在 `parts.push(constraints)` 之前
- 最终顺序: `skill.markdown + "\n\n" + constraints`
- user 输入独立在 `user` 字段，不混入 system

### Q7: 非 skill chat 路径是否完全不变？

**Status: ✅ 通过**

- 无 SkillLayer 时 `skillLayer?.markdown` 为 `undefined`
- `parts` 仅包含 constraints（或无内容）
- 输出与原始代码完全一致: `constraints.join('\n')` 或 `undefined`

### Q8: 是否没有新增 SkillTask / SkillExecutor / Workflow / Planner？

**Status: ✅ 通过**

- Task type 保持 `'chat'`（line 131: `type: 'chat'`）
- Executor 保持 `ChatAgentExecutor`
- 没有新文件创建（仅 3 个现有文件修改）
- 没有 Workflow / Planner / Node Graph / DAG

### Q9: 是否应该把 loadSkillLayerForTask 视为 Runtime API，还是放回已有流程？

**Status: ✅ 架构正确，保留当前分离**

- `loadSkillForTask(taskId, skillId)` — Runtime 内部路径，拥有完整 loading/capability lifecycle
- `loadSkillLayerForTask(taskId, skillPkg)` — 外部注入路径，接收已加载的 SkillPackage
- 两个路径满足不同调用方需求，合并会引入不必要的耦合（baseDir 选择、capability 重复校验）

### Q10: 是否需要补充测试？

**Status: ⚠️ P2 — 建议补充**

当前实现无测试覆盖。推荐补：
1. `buildPromptInput` 单元测试：验证 skill.markdown + constraints 拼接
2. `loadSkillLayerForTask` 单元测试：验证注入 + guard + timeline event + revision bump
3. `tryExecuteSkill` 集成测试：验证 Task 创建 + Context 注册 + SkillLayer 注入

---

## Constitution Compliance

| ADR | 关键约束 | 合规状态 |
|-----|---------|---------|
| ADR-001 | Chat 不导入 RuntimeStore | ✅ skillBridge 在 services 层，非 Chat 层 |
| ADR-001 | 跨域走 runtimeBridge | ✅ registerChatTask 经 runtimeBridge |
| ADR-002 | RuntimeStore 唯一 mutation authority | ✅ loadSkillLayerForTask 在 Store 内 mutation |
| ADR-002 | 每次 mutation bump revision | ✅ line 323 |
| ADR-005 | Registry 不导入 store | ✅ Registry 不受影响 |
| ADR-005 | Registry 不做 file IO | ✅ skilBridge 自己做 SkillLoader IO |
| ADR-007 | Capability Gate 在 invocation 入口 | ✅ skillBridge.checkSkillCapabilities 先于执行 |
| ADR-008 | three-return 语义不变 | ✅ 返回值未修改 |
| ADR-008 | 走 executeChatTask 路径 | ✅ 保持不变 |

## Red Lines Check

| 红线 | 状态 |
|------|------|
| DAG | ✅ 无 |
| Workflow Engine | ✅ 无 |
| Node Graph | ✅ 无 |
| BPMN | ✅ 无 |
| Visual Builder | ✅ 无 |
| Auto Agent Planner | ✅ 无 |
| Multi-Agent | ✅ 无 |

## Verdict

| 维度 | 结论 |
|------|------|
| Review verdict | ✅ Go |
| P0 issues | 0 |
| P1 issues | 0 |
| P2 issues | 3（缺少测试覆盖） |
| 允许 commit | ✅ 是 |
| 建议 tag | ✅ runtime-kernel-v0.7 |

## P2 改进建议

1. **测试覆盖**：补充 `buildPromptInput`、`loadSkillLayerForTask`、`tryExecuteSkill` 三种粒度的测试
2. **`loadSkillLayerForTask` guard 日志**：当前 `if ctx.skill loaded return` 静默跳过，未来如有重复调用意图不一致的情况，应考虑 warn log
3. **`registerChatTask` 在 skill 路径的语义确认**：当前 `registerChatTask` 产生 `task.created` timeline event，但 skill 路径的实际 "create" 时间点在 `tryExecuteSkill` 而非 chat-send-controller。需确认此 timeline event 语义是否准确（当前不阻塞，P2 记录）
