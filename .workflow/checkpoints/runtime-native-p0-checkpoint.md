# Checkpoint: Runtime-native P0 Freeze

**Date**: 2026-05-14
**Phase**: `runtime-native-refactor-p0`
**Status**: `paused`

---

## 已完成

| 里程碑 | Tag | 说明 |
|--------|-----|------|
| Runtime Constitution v0.9 | `runtime-constitution-v0.9` | 9 条 ADR（001-009），Constitution 定型 |
| SPE Archetype v0.1 | `spe-archetype-v0.1` | Skill 模板体系冻结：Role/Format/Rules/Bans/Example + 6 参数 |
| summarize alpha | `summarize-skill-alpha` | 首个 SPE 技能，[要点N] 格式验证通过 |
| bulletize alpha | `bulletize-skill-alpha` | 第二个 SPE 技能，[•] 格式变体验证通过 |
| Desktop Runtime Path | `desktop-runtime-skill-path-p0` | systemPrompt transport、request_id 缓存规避、providerAdapter 去重 |
| Runtime-native P0 | —（自 `desktop-runtime-skill-path-p0` 后未提交） | ChatAgentExecutor → RuntimeLLMExecutor、type='skill' 路由修复 |
| Runtime Error Boundary | `runtime-error-boundary-v0.1` | BridgeError 类型 + executeTask 重抛 |
| Capability Gate | `capability-gate-p0` | skillBridge 预检 + DEFAULT_ALLOWED_CAPABILITIES |
| Official Skill Boundary | `official-skill-boundary-p0` | 双 BaseDirectory + SkillMeta.source |
| Chat-first Skill Flow | `chat-first-skill-flow-p0` | @mention 检测 + tryExecuteSkill 三值语义 |
| ADR Wave 2 | `runtime-constitution-v0.9` | ADR-005~008 |
| Skill Execution Mode Fix | `skill-context-injection-p0` | commands.rs system_prompt + MODE:DIRECT |

## 未完成

| 项 | 优先级 | 说明 |
|----|--------|------|
| MODE:DIRECT formalization | P1 | 从 agentAdapter.ts 提取为正式模块（ISS-20260514-002） |
| execMode convergence | P1 | RT 路径稳定后移除 toggle（ISS-20260514-004） |
| createExecutor() 死代码删除 | P2 | 仅 createContextAwareExecutor 在使用（ISS-20260514-001） |
| SkillTaskExecutor 桩清理 | P2 | 死代码遗留（ISS-20260514-005） |
| Capability check dedup | P2 | skillBridge + runtimeServices 两处（ISS-20260514-003） |
| WS Task lifecycle 复用 | P2 | runtimeBridge 路径对齐（ISS-20260514-006） |
| UAT （Tauri 环境） | 阻塞 | @summarize / @bulletize / normal chat 端到端验证 |

## 当前 Tags

```
desktop-runtime-skill-path-p0   ← 最新
bulletize-skill-alpha
skill-context-injection-p0
spe-archetype-v0.1
summarize-skill-alpha
runtime-constitution-v0.9
official-skill-boundary-p0
capability-gate-p0
chat-first-skill-flow-p0
runtime-stabilization-p0-complete
runtime-error-boundary-v0.1
runtime-constitution-v0.8
runtime-kernel-v0.7
workspace-surface-v0.4
...
```

## 当前未提交文件

### 核心代码（P0 — 建议提交为 runtime-native-p0）

| 文件 | 改动 |
|------|------|
| `src/services/agentAdapter.ts` | class rename + isSkill systemPrompt + MODE:DIRECT 注入 |
| `src/services/taskExecutor.ts` | case 'skill' 路由 + import 更新 |
| `src/services/skillBridge.ts` | type: 'chat' → 'skill' |

### 工作流元数据

| 文件 | 说明 |
|------|------|
| `.workflow/state.json` | 最新 artifacts + key_decisions + deferred |
| `docs/1.md` | 分析需求文档更新 |

### Tauri 构建产物

| 文件 | 说明 |
|------|------|
| `src-tauri/Cargo.lock` | 依赖锁定 |
| `src-tauri/Cargo.toml` | Cargo 配置 |
| `src-tauri/gen/schemas/*.json` | 自动生成 schema |

### Untracked

| 文件 | 说明 |
|------|------|
| `.workflow/.scratchpad/` | 临时笔记 |
| `.workflow/uat-*` | 各种 UAT 脚本 |
| `src-tauri/gen/schemas/windows-schema.json` | 自动生成 schema |
| `src-tauri/skills/` | 手动放置的 skill 资源 |

## 恢复推荐

### 入口路径

```
1. 提交 P0 核心改动 → tag runtime-native-p0
2. Tauri UAT：@summarize、@bulletize、normal chat
3. 进入 P1：MODE:DIRECT formalization 或 execMode convergence
```

### 命令序列

```bash
# 提交 P0（当前 pending 的核心代码）
git add src/services/agentAdapter.ts src/services/taskExecutor.ts src/services/skillBridge.ts
git commit -m "refactor: rename ChatAgentExecutor to RuntimeLLMExecutor + skill type routing"
git tag runtime-native-p0

# 或全量提交 workspace（含 schema 等）
git add -A
git commit -m "chore: workspace surface v0.5 + runtime-native-p0"
```

### 后续优先顺序

1. **P1 MODE:DIRECT formalization** — 从 agentAdapter.ts 提取独立模块，清理 prompt 注入
2. **Tauri UAT** — 确认 SPE skill 在真实 Tauri 环境下端到端工作
3. **P1 execMode convergence** — `craft|auto|runtime` toggle 移除，锁定 Runtime 路径
4. **P2 cleanup** — 死代码删除、桩清理
