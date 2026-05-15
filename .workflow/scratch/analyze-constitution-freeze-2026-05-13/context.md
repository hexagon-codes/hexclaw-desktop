# Context: Runtime Constitution Freeze Review

**Date**: 2026-05-13
**Session**: ANL-constitution-freeze-2026-05-13
**Areas discussed**: ADR quality review, constitution stability scoring, freeze conditions

## Decisions

### Decision 1: Constitution Freeze Scope
- **Context**: 4 个 ADR 中哪些可以冻结为 v0.8 Constitution baseline
- **Options considered**:
  1. All 4 freeze as-is — 但 ADR-001 API 表会过时
  2. Conditional freeze — 3 个 freeze + ADR-001 deferred
  3. No freeze — 继续 Wave 2 后再考虑
- **Chosen**: Conditional freeze（Option 2）
- **Reason**: ADR-002/003/004 原则稳定，经过代码验证。ADR-001 需先分离原则层和 impl detail

### Decision 2: ADR-001 修订方向
- **Context**: ADR-001 的 API 函数表不适合放在 Constitution 层
- **Options considered**: 1. 保留并持续更新 2. 删除表格保留原则 3. 移到附录
- **Chosen**: 删除 API 函数表，保留原则描述
- **Reason**: Constitution 层应该只放原则，API 函数表会频繁过时

### Decision 3: Freeze 语义
- **Context**: Constitution freeze 的含义需要明确
- **Options considered**: 1. 不可修改 2. 新 ADR supersede 3. 可改写
- **Chosen**: 新 ADR supersede 制度
- **Reason**: 架构需要演进空间，但不允许静默修改已冻结的 ADR

## Constraints

### Locked

1. **ADR-002/003/004 在完成 minor revision 后 freeze 为 Constitution baseline**
   - ADR-002: 去除具体 composable 名称 → 泛化 "Composable 层返回 patch"
   - ADR-003: 补充 `import type` 不影响纯度的说明
   - ADR-004: 移除"当前仅 chat type" temporal caveat

2. **ADR-001 不加入第一版 Constitution**
   - 需要先做原则/impl 分离
   - 分离后的原则部分可加入 Constitution
   - 分离后的 API 表部分作为 implementation note

3. **Constitution ADR 的修改规则**
   - 冻结后不得原地修改
   - 变更必须通过新的 ADR supersede
   - 旧 ADR 标记 superseded 并指向新 ADR

### Free

1. **Minor wording fixes**（来自 ambiguity list，实施者自行决定优先级）：
   - ADR-001: "或"表述统一、Chat 类型范围明确、"协调者/数据拥有者"补充
   - ADR-002: revision 机制补充说明、"绕过"边界明确、纯持久化范围明确
   - ADR-003: "投射不充分"标准明确、WorkspaceStore 反例处理
   - ADR-004: Decision 与 Constraints 中 Executor 表述统一

2. **Line-number drift protection**：在代码中添加 `// [ADR-NNN]` 标记，使 References 可 grep 定位而非依赖行号。实施者判断是否需要。

### Deferred

1. **ADR-003 ESLint rule** — 创建 `no-store-import-in-projector` 规则。优先级：低。在 workspace UI 开始消费投影时实施。
2. **ADR-002 revision bump Proxy** — 用 Proxy 封装 ContextManager 自动化 revision bump。优先级：低。在出现 revision 漏 bump 的 bug 时实施。
3. **CI import check for ADR-001** — 在 CI 中添加 `grep` 命令检查 bridge 是否被绕过。优先级：低。在团队扩张时实施。
4. **PR template update** — 在 PR template 中添加 ADR compliance check。优先级：低。

## Revision Summary

| ADR | 必须修改（冻结合并） | 建议修改（wording） |
|-----|---------------------|-------------------|
| 001 | 删除 API 函数表，分离原则/impl | "或"统一、"协调者"补充、类型范围明确 |
| 002 | composable 名称 → 泛化 | revision 说明、"绕过"边界、纯持久化范围 |
| 003 | 补充 `import type` 说明 | "投射不充分"标准、WorkspaceStore 反例 |
| 004 | 移除 "仅 chat type" caveat | Decision/Constraints 统一 Executor 表述 |

## Execution Order

```
Step 1: 对 4 个 ADR 各自做 targeted revision (3 个 must-fix + ADR-001 restructure)
Step 2: Freeze ADR-002/003/004 为 v0.8 Constitution baseline
Step 3: ADR-001 原则部分加入 Constitution (与 Step 2 异步)
```

## Code Context

审查基于以下文件的全文阅读：
- `docs/adr/001-chat-runtime-bridge.md`
- `docs/adr/002-runtime-authority-ownership.md`
- `docs/adr/003-projection-purity.md`
- `docs/adr/004-execution-state-machine.md`
- `docs/adr/README.md`
- `docs/adr/template.md`
