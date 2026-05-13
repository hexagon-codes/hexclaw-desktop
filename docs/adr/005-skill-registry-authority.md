# ADR-005: Skill Registry Authority

**Status**: frozen baseline
**Date**: 2026-05-13

## Context

Skill 元数据管理需要一个明确的权威来源。在 Capability Gate 和 Official vs Custom 隔离引入之前，SkillMeta 的发现、缓存和查询分散在多个模块中。随着系统演进，以下问题需要架构级约束：

1. **职责膨胀风险**：Registry 如果被扩展为执行层、policy 层或加载层，将违反单一职责原则
2. **安全边界**：Registry 决定了哪些 Skill 可见、可被 resolve。如果 Registry 可写，将破坏 Custom 不可覆盖 Official 的保证
3. **调用方依赖**：skillBridge、MentionPopup 等多个调用方依赖 Registry 的查询接口。Registry 的 authority 模型变化会影响所有消费方

需要一个宪法级边界保护 Registry 的职责范围。

## Decision

**SkillRegistry 是 Skill 元数据层的唯一权威来源，职责严格限定为 discover + cache + resolve。**

### 做（In Scope）

| 职责 | 方法 | 说明 |
|------|------|------|
| **discover** | `discoverFromDir(baseDir, source)` | 扫描 skills/ 目录，读取 skill.json。readDir + readTextFile，无网络/远程操作 |
| **cache** | `Map<string, SkillMeta>` | 全量缓存，一次性加载。lazy init（首次查询触发） |
| **resolve** | `resolveSkill(id)` / `getAllSkills()` | 只读查询接口，不修改数据 |

### 不做（Out of Scope）

- ❌ **load markdown** — 那是 SkillLoader 的职责（`skillLoader.ts:62-134`）
- ❌ **match skill** — 语义匹配/模糊匹配不在 Registry 中
- ❌ **execute** — Registry 不调用任何执行逻辑
- ❌ **policy** — Registry 不做 capability check / entitlement / access control
- ❌ **watch directory** — 当前无目录监听，一次性加载
- ❌ **remote / marketplace** — Registry 只扫描本地文件系统

## Constraints

- Registry 不得导入 `@/stores/runtime`、`@/stores/*` 或 `Pinia`
- Registry 方法必须是 read-only（不修改传入的参数，不写入全局状态）
- `discoverFromDir` 不抛出异常抛出（目录不存在时静默返回空 Map）
- 禁止在 Registry 中添加 policy/entitlement/access control 逻辑
- Registry 实例化使用模块级单例（`skillBridge.ts:21-26`），但构造器接受参数以支持测试

## Rejected Alternatives

| Alternative | Reason for Rejection |
|-------------|---------------------|
| Registry + Policy 混合 | 职责耦合，政策变化需要修改 Registry，违反单一职责 |
| Registry 直接 load markdown | 与 SkillLoader 职责重叠，Registry 注入应由 Loader 处理 |
| 多 Registry 实例 | 需要协调机制，单例已满足需求 |
| Registry 管理执行（execute） | Registry 不应了解执行上下文，执行是 Runtime 的职责 |
| Registry 监听目录变更 | 增加复杂度和平台依赖，当前无热更新需求 |

## Consequences

- ✅ **单一权威来源**：所有 SkillMeta 查询走同一个 Registry，数据一致
- ✅ **零 skillBridge 变更**：`new SkillRegistry()` 无参调用继续工作（双参数均有默认值）
- ✅ **可测试性**：构造器接受 BaseDirectory 参数，可注入测试目录
- ✅ **职责边界清晰**：新增代码审查可直接引用 ADR-005 判断职责归属
- ⚠️ **膨胀风险**：Registry 可能随时间被添加"小功能"而逐渐膨胀，需要定期审查职责边界
- ⚠️ **无编译期保护**：职责边界依赖代码审查和 ADR 约束，无法编译期强制

## Compliance

代码审查时检查：

```bash
# 验证 Registry 不导入 store
grep -r "from '@/stores" src/services/skillRegistry.ts || echo "✅ Registry 无 store 导入"

# 验证 Registry 方法保持 read-only
grep -n "\.set\|\.delete\|\.clear" src/services/skillRegistry.ts | grep -v "this.cache.set" | grep -v "test" || echo "✅ Registry 无意外 mutation"
```

新增 Registry 功能时判断：
- 是否改变了 discover/cache/resolve 三个职责之一？→ 修改 ADR-005
- 是否增加了第四个职责？→ 拒绝，或创建新 ADR supersede

## References

- `src/services/skillRegistry.ts:21-146` — `class SkillRegistry` 完整实现
- `src/services/skillRegistry.ts:27-33` — 双 BaseDirectory 构造器
- `src/services/skillRegistry.ts:69-113` — `discoverFromDir`（readDir + readTextFile，无网络）
- `src/services/skillRegistry.ts:120-135` — `discoverSkills`（先扫 Official 再扫 Custom）
- `src/services/skillRegistry.ts:46-54` — `resolveSkill` / `getAllSkills` 查询接口
- `src/services/skillBridge.ts:21-26` — 模块级单例 `getRegistry()`

## Cross-References

- ADR-002: Runtime Authority Ownership（Registry 的 authority 模型继承 RuntimeStore 作为唯一 mutation 源的概念）
- ADR-006: Official vs Custom Boundary（Registry 使用双 BaseDirectory 实现隔离）
