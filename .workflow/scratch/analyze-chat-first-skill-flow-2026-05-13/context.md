# Chat-first Skill Flow — Context

## Locked Decisions

| ID | 决策 | 依据 |
|----|------|------|
| D1 | @mention 检测在 Chat 层 sendMessage 入口 | 纯文本操作，不依赖 Runtime |
| D2 | Skill lookup 在 Chat 层（Registry 只读查询） | 无需 RuntimeContext |
| D3 | Capability check 在 Runtime 层（通过 bridge） | Validator 依赖 Runtime 侧的 Registry |
| D4 | Skill Execute 复用 `runtimeBridge.executeChatTask` | 避免 Runtime Kernel 变动 |
| D5 | Skill Result = TaskResult（kind: 'text'），不走 Result Surface | TaskResult 当前只有 text |
| D8 | 不新增 Runtime 概念（no SkillTask, no SkillExecutor） | 复用现有 Task + Executor |
| D10 | 禁止 DAG / Workflow / Node Graph / BPMN | 产品红线 |

## Free Decisions

| ID | 决策 | 依据 |
|----|------|------|
| D6 | Param Card → P1 | P0 缺参直接报错 |
| D7 | NL trigger → P1 | 无真实数据，@mention 覆盖 P0 |
| D9 | `skillBridge.ts` 新增文件 | 独立职责，不污染 runtimeBridge |

## Deferred Items

| 能力 | 目标 | 条件 |
|------|------|------|
| NL trigger (P1) | 用户输入自然语言自动匹配 skill | 有真实 user feedback 数据 |
| Param Card UI (P1) | @skill 缺参时展示参数收集卡片 | 需要 UI 组件开发 |
| Semantic skill match (P2) | 基于语义匹配，非 name 精确匹配 | skill 数量 > 50 |
| Official vs Custom skill (P2) | 区分预装 skill 和用户自定义 skill | 有自定义 skill 创建流程 |
| Skill version management (P3) | 版本升级、兼容性、回滚 | ClawHub 集成 |
| Capability policy UI (P3) | UI 管理 per-skill 权限 | 有 per-skill policy 需求 |

## Next Steps

1. 实现最小 Execute proposal：
   - 新增 `src/services/skillBridge.ts` (~80-120 行)
   - 修改 `chat-send-controller.ts` (@mention 检测 + 路由，~15-20 行)
   - 仅支持 @mention + 内联参数 + TaskResult text 返回
2. P1 再考虑 Param Card UI 和 NL trigger
