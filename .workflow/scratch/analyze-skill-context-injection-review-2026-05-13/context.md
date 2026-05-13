# Context: Skill Context Injection Review

**Date**: 2026-05-13

## Decisions

### Decision 1: 架构合规，允许 Commit
- **Context**: 全部 10 项审查点中 Q1-Q8 全部通过，Q9 架构正确，Q10 为 P2 建议
- **Options**:
  1. **允许 Commit** ✅ — 无红线违规，无 Constitution 违反
  2. 修复后再 Commit — 无 P0/P1 问题需阻塞
- **Chosen**: 允许 Commit
- **Reason**: 所有 Constitution-level 约束均被遵守，修改范围仅 3 文件 ~38 行，无架构断裂

### Decision 2: 建议 Tag runtime-kernel-v0.7
- **Context**: 之前的 tag `runtime-constitution-v0.9` 是 ADR 文档版本。此实现是运行时代码的实际变更
- **Options**:
  1. **建议 Tag** ✅ — runtime-kernel-v0.7 标记第一个 Official Skill 注入管道就绪
  2. 不 Tag — 等更多变更再 tag
- **Chosen**: 建议 Tag
- **Reason**: 这是 runtime kernel 中 Skill Context 注入的第一个完整实现，值得独立 tag 标记状态

## Constraints

### Locked
- L1: `loadSkillLayerForTask` 只注入外部 SkillPackage，不主动 load 文件
- L2: RuntimeStore 是 Context mutation 唯一 authority
- L3: buildPromptInput 保持纯 prompt assembly，无 IO/store/registry
- L4: Task type 保持 'chat'，不新增 SkillTask/SkillExecutor/Workflow/Planner
- L5: 非 skill chat 路径行为完全不变

### Free
- F1: SkillLoader baseDir 选择策略（当前使用 skillMeta.source 决定 BaseDirectory.Resource vs AppData）
- F2: `loadSkillLayerForTask` 命名（可改为 `injectSkillPackage` 等）

### Deferred
- D1: 测试覆盖（P2，建议补充单元测试 + 集成测试）
- D2: `loadSkillLayerForTask` guard 的 warn log（当重复调用意图不一致时）
- D3: Skill 路径 `registerChatTask` timeline 语义确认

## Code Context

### 修改文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/services/skillBridge.ts` | +25/-2 | 创建 Task、注册 Context、按 source 选择 BaseDir 加载 SKILL.md、注入 SkillLayer |
| `src/services/agentAdapter.ts` | +6/-4 | buildPromptInput 合并 skill.markdown 到 system prompt |
| `src/stores/runtime.ts` | +22/-0 | 新增 loadSkillLayerForTask(taskId, skillPkg) |

### 执行流

```
@summarize <text>
  → tryExecuteSkill
    → create Task { input: { text } }
    → registerChatTask(task)  ← 经 runtimeBridge
    → runtime.loadSkillLayerForTask(taskId, skillPkg)
      → loader.loadSkillLayer(ctx, skillPkg)  ← RuntimeStore 内
      → writeTimelineEvent + revision++
    → executeChatTask(taskId)
      → executor.executeWithContext(task, ctx)
        → buildPromptInput(ctx)
          → system = skill.markdown + constraints
          → user = "<text>"
```

### 关键验证命令

```bash
# TypeScript 编译检查
npx tsc --noEmit

# 验证 Runtime 不导入 Chat 类型
grep -r "from '@/types/chat'" src/services/runtime* src/stores/runtime.ts
# 应无输出

# 验证 Chat 不导入 RuntimeStore
grep -r "from '@/stores/runtime'" src/stores/chat*.ts
# 应无输出

# 验证 Registry 不导入 store
grep -r "from '@/stores" src/services/skillRegistry.ts
# 应无输出
```
