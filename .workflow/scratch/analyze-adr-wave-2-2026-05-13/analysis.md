# ADR Wave 2 Analysis — 6-Dimension Scoring

**Session**: ANL-adr-wave-2-2026-05-13
**Date**: 2026-05-13

## Scoring Summary

| Dimension | Score (1-5) | Confidence |
|-----------|-------------|------------|
| 1. 必要性 Necessity | 4.5 | high |
| 2. 完备性 Completeness | 4.0 | high |
| 3. 边界清晰度 Boundary Clarity | 4.5 | high |
| 4. 代码验证度 Code Verification | 4.5 | high |
| 5. 向后兼容性 Compatibility | 5.0 | high |
| 6. 可执行性 Executability | 4.5 | high |

**Overall**: 4.5/5.0 — ADR Wave 2 准备充分，4 个新 ADR 有清晰的代码证据支撑。

---

## Dimension 1: 必要性 (Necessity)

**Score: 4.5/5**

### 证据

Wave 1（ADR-001~004）覆盖了 Runtime Kernel 内部架构：Bridge、Authority、Projection、State Machine。
Wave 2 覆盖的是 **Skill 层** 的系统边界，与 Wave 1 正交：

| Wave 1 (Runtime Kernel) | Wave 2 (Skill Boundary) |
|-------------------------|-------------------------|
| Chat ↔ Runtime 通讯 | Skill Registry Authority |
| Context 所有权 | Official vs Custom 隔离 |
| 投影纯数据转换 | Capability Gate 准入控制 |
| 执行状态机 | Chat-first Skill 调用 |

### 理由
- Wave 1 未涉及任何 Skill 相关决策（Skill 层在 Wave 1 时尚未形成稳定架构）
- Skill Registry Authority、Official vs Custom Boundary、Capability Gate 都是**安全相关**的架构决策，需要宪法级记录
- 缺失 ADR 的风险：未来开发者可能不清楚 Registry 不做 policy、Custom 可以覆盖 Official、Gate 位置可以被移动

### 低分说明
- ADR-008 (Chat-first Skill Invocation) 的必要性稍低 — 当前的 chat-only 是现状而非约束，未来可能演进

---

## Dimension 2: 完备性 (Completeness)

**Score: 4.0/5**

### 覆盖情况

| Focus Area | ADR Coverage | Completeness |
|-----------|-------------|--------------|
| Skill Registry Authority | ✅ ADR-005 | 完备：constructor、discover、cache、resolve 各职责边界清晰 |
| Official vs Custom Boundary | ✅ ADR-006 | 完备：双目录、冲突规则、source 语义、tauri infra 保障 |
| Capability Gate Positioning | ✅ ADR-007 | 完备：gate 位置的选择 rationale、DEFAULT_ALLOWED_CAPABILITIES |
| Chat-first Skill Invocation | ✅ ADR-008 | 中等：当前是架构事实，但未约束未来演进路径 |
| Runtime vs SkillLoader Authority | ⏭️ ADR-005 提及 | 不需要独立 ADR，在 ADR-005 中提及 |
| Skill source semantics | ⏭️ ADR-005/ADR-006 提及 | 不需要独立 ADR |
| Deferred principles | 📋 context.md | 完整记录 |

### 缺失项
- 无。所有 P0 工作对应的架构决策都已覆盖。

---

## Dimension 3: 边界清晰度 (Boundary Clarity)

**Score: 4.5/5**

### 各 ADR 边界

**ADR-005 Skill Registry Authority:**
- 做：discover（读目录）+ cache（内存）+ resolve（查询）
- 不做：load markdown、match、execute、policy、目录监听
- 依赖：tauri plugin-fs（readDir / readTextFile）
- 不依赖：Pinia、RuntimeStore、skillBridge

**ADR-006 Official vs Custom Boundary:**
- Official：BaseDirectory.Resource（tauri 资源，只读）
- Custom：BaseDirectory.AppData（用户数据，可写）
- 冲突规则：Official 优先，Custom 被跳过 + warning
- 底层保障：tauri.conf.json resources + fs.scope.allow

**ADR-007 Capability Gate:**
- Gate 位置：skillBridge.ts（invocation 入口）
- Policy 来源：DEFAULT_ALLOWED_CAPABILITIES（System Layer 默认）
- 验证工具：CapabilityValidator
- 阻断方式：throw Error → catch → handleSendError → return null

**ADR-008 Chat-first Skill Invocation:**
- 入口：chat-send-controller.ts → sendMessage → tryExecuteSkill
- 执行路径：tryExecuteSkill → executeChatTask → runtimeBridge
- 返回语义：undefined(不是skill) / null(失败) / ChatMessage(成功)

### 模糊地带
- ADR-005 和 ADR-006 的边界有重叠：Registry 使用双 BaseDirectory 实现了 Boundary，但 Boundary 的"冲突时保留 Official"是安全策略，在 ADR-006 中记录更好
- ADR-007 的未来 supersede 路径未定义（entitlement 系统可能取代 DEFAULT_ALLOWED_CAPABILITIES）

---

## Dimension 4: 代码验证度 (Code Verification)

**Score: 4.5/5**

### 验证结果

| ADR | Code Anchor | Verified |
|-----|-------------|----------|
| ADR-005 | `skillRegistry.ts:27-33` constructor 双 BaseDirectory | ✅ |
| ADR-005 | `skillRegistry.ts:69-113` discoverFromDir 不涉及 policy | ✅ |
| ADR-005 | `skillRegistry.ts:46-54` resolveSkill/getAllSkills 查询接口 | ✅ |
| ADR-006 | `skillRegistry.ts:120-135` discoverSkills 先 Official 后 Custom | ✅ |
| ADR-006 | `skillRegistry.ts:130-133` 冲突 continue + console.warn | ✅ |
| ADR-006 | `context.ts:32` source: 'official' \| 'custom' | ✅ |
| ADR-007 | `skillBridge.ts:38-46` checkSkillCapabilities | ✅ |
| ADR-007 | `skillBridge.ts:115-118` capability pre-check | ✅ |
| ADR-007 | `capability.ts:47-51` DEFAULT_ALLOWED_CAPABILITIES | ✅ |
| ADR-008 | `chat-send-controller.ts:156-163` tryExecuteSkill 调用 | ✅ |
| ADR-008 | `skillBridge.ts:91-133` tryExecuteSkill 完整实现 | ✅ |

### 编译通过
- `npx tsc --noEmit` — ✅ 零错误

---

## Dimension 5: 向后兼容性 (Compatibility)

**Score: 5.0/5**

### 分析

| 变更 | 兼容性 | 说明 |
|------|--------|------|
| ADR-005: Registry Authority | ✅ 兼容 | `new SkillRegistry()` 无参调用继续工作（双参数均有默认值） |
| ADR-006: Official vs Custom | ✅ 兼容 | 新增目录，不影响已有 Custom skill 路径 |
| ADR-007: Capability Gate | ✅ 兼容 | pre-check 失败 throw Error，不影响非 skill 路径 |
| ADR-008: Chat-first Invocation | ✅ 兼容 | 在 sendMessage 中先 tryExecuteSkill，非 skill 继续 fallthrough |

### 风险
- 无 breaking change 风险。所有变更都是新增约束或新增目录扫描。

---

## Dimension 6: 可执行性 (Executability)

**Score: 4.5/5**

### 写入成本

| ADR | 篇幅 | 复杂度 | 写入耗时估计 |
|-----|------|--------|-------------|
| ADR-005 Skill Registry Authority | ~80 行 | 低 | 15min |
| ADR-006 Official vs Custom Boundary | ~100 行 | 低 | 20min |
| ADR-007 Capability Gate | ~80 行 | 低 | 15min |
| ADR-008 Chat-first Skill Invocation | ~60 行 | 低 | 10min |

### 依赖关系
- ADR-005 → 无（但引用 ADR-002 Authority 概念）
- ADR-006 → ADR-005（Registry 使用双 BaseDirectory）
- ADR-007 → ADR-005（Gate 查询 Registry 获取 capabilities）
- ADR-008 → ADR-001 + ADR-007（通过 runtimeBridge 执行 + capability pre-check）

### 写入顺序
1. ADR-005（基础：Registry Authority）
2. ADR-006（安全：Official vs Custom）
3. ADR-007（执行控制：Capability Gate）
4. ADR-008（入口：Chat-first Invocation）

### 风险
- ADR-008 可能被 future work supersede（如果 Skill 获得非 chat 入口）
- ADR-007 可能被 entitlement 系统 supersede

---

## Confidence Summary

| Factor | Weight | Score | Weighted |
|--------|--------|-------|----------|
| 代码证据完整性 | 30% | 4.5 | 1.35 |
| 架构理解深度 | 25% | 4.5 | 1.13 |
| 边界分析质量 | 20% | 4.5 | 0.90 |
| 兼容性验证 | 15% | 5.0 | 0.75 |
| 可执行性 | 10% | 4.5 | 0.45 |
| **Overall** | 100% | **4.58** | **4.58** |

**Recommendation**: ✅ Go — ADR Wave 2 准备充分，4 个 ADR 可立即写入。
