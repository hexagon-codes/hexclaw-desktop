# ADR Wave 2 Analysis — Discussion Timeline

**Session**: ANL-adr-wave-2-2026-05-13
**Date**: 2026-05-13
**Type**: Architecture Analysis

## Round 1: Context Loading

Loaded:
- ADR-001 (Chat-Runtime Bridge) — frozen baseline
- ADR-002 (Runtime Authority Ownership) — frozen baseline
- ADR-003 (Projection Purity) — frozen baseline
- ADR-004 (Execution State Machine) — frozen baseline
- ADR README — v0.8 Constitution Baseline

Loaded system state:
- `skillRegistry.ts` — 双 BaseDirectory + source 标记
- `skillBridge.ts` — capability gate + `tryExecuteSkill` 主入口
- `skillLoader.ts` — load + parse，source: 'custom'
- `runtimeBridge.ts` — Chat ↔ Runtime 唯一 touchpoint
- `runtimeServices.ts` — CapabilityRegistry / CapabilityValidator 服务定位器
- `capability.ts` — DEFAULT_ALLOWED_CAPABILITIES
- `chat-send-controller.ts` — sendMessage 中 skill invocation + runtime/WS 双路径
- `context.ts` — SkillMeta.source 联合类型

## Round 2: Focus Area Mapping

### 1. Skill Registry Authority
Current: SkillRegistry 是模块级单例，职责 = discover + cache + resolve。
不做：load markdown、match skill、execute、目录监听。
构造器注入两个 BaseDirectory，由 skillBridge 的 getRegistry() lazy init。

Architecture question: Registry 的 authority 边界是否需要宪法级保护？
→ 结论：是。Registry 是 Skill 元数据层的单一权威来源。
→ ADR-005

### 2. Official vs Custom Boundary
Current: 两棵独立目录树，Official (Resource) 优先于 Custom (AppData)，冲突保留 Official 跳过 Custom 并 console.warn。tauri infrastructure（resources + fs scope）提供底层只读保障。

Architecture question: 双目录 + 冲突规则是安全策略还是实现选择？
→ 结论：安全策略。Custom 不可覆盖 Official 是 trust 模型的核心。
→ ADR-006（但部分实现细节如 console.warn 级别不需要 ADR）

### 3. Capability Gate Positioning
Current: skillBridge 侧的 checkSkillCapabilities() 使用 DEFAULT_ALLOWED_CAPABILITIES 做 pre-check，验证失败 throw Error。

Architecture question: Gate 位置在 skillBridge 而非 Registry/Loader/Runtime 是否正确？
→ 结论：正确。Gate 在 invocation 入口（skillBridge），靠近调用方，阻断及时。
Registry 只提供数据，Loader 只加载，都不做 policy。
→ ADR-007

### 4. Chat-first Skill Invocation
Current: 唯一 Skill 执行入口是 chat @mention，路径为 `tryExecuteSkill → executeChatTask`。
chat-send-controller.ts 中 sendMessage 先 tryExecuteSkill，非 skill 则 fallthrough 到正常 chat。

Architecture question: Skill invocation 绑定 Chat 上下文是架构约束还是实现现状？
→ 结论：当前是架构事实。Skill 的执行上下文 = Chat，走 runtimeBridge。
未来可以有其他入口（如 context-triggered），但当前应记录这个决策。
→ ADR-008（标记为 accepted 但非 frozen）

### 5. Runtime vs SkillLoader Authority
Current: SkillLoader 只负责 load + parse skill.json / SKILL.md / references，不做 registry/policy/official。
Runtime 不直接接触 Skill（通过 skillBridge 间接接触）。

Architecture question: 这个分离是否需要 ADR？
→ 结论：不需要。SkillLoader 的职责边界已在文件头注释中明确，
属于 implementation detail，非架构级决策。在 ADR-005 中提及即可。

### 6. Skill source semantics
Current: source: 'official' | 'custom' 由 Registry/Loader 自动填充，非 skill.json 字段。
Official skills 的 source='official'（Registry 填充），Custom skills 的 source='custom'（Registry 或 Loader 填充）。

Architecture question: 联合类型 vs boolean 设计是否需要 ADR？
→ 结论：不需要独立 ADR。这是 SkillMeta 类型设计的实现细节。
在 ADR-005 或 ADR-006 中作为 reference 提及即可。

### 7. Deferred Principles
有哪些原则明确不进入 Wave 2：
- **Prompt 保护**：Official Skill 的 prompt 保护机制（如 SKILL.md 只读）
- **Category 过滤**：按 category 分类/过滤 skill
- **Entitlement**：细粒度用户权限控制
- **更新机制**：Skill 热更新/版本管理
- **Directory watch**：目录监听（当前是 eager load + discover 后不再重扫）
- **Remote skill**：远程/marketplace skill
- **Composition**：Skill 组合/编排（7 条 red lines 已禁止 DAG/Workflow Engine 等）

## Current Understanding

ADR Wave 1（frozen baseline）覆盖了 Runtime Kernel 的核心架构：
- Bridge 模式（Chat ↔ Runtime）
- Authority 模型（RuntimeStore 唯一突变点）
- Projection 纯度（纯函数层）
- State Machine（执行状态机）

ADR Wave 2 需要覆盖新的系统边界：
- Skill 元数据层（Registry Authority）
- Skill 安全隔离（Official vs Custom）
- Skill 执行控制（Capability Gate）
- Skill 调用入口（Chat-first Invocation）

## Reassessment

CLI 验证建议：
- npx tsc --noEmit 确认所有文件编译通过
- git log 确认所有 P0 工作已提交
