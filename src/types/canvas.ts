/**
 * Canvas 工作流类型定义
 *
 * 画布节点、边、工作流定义及执行状态。
 */
import type { MessageContent, RenderManifest } from '@/contracts/message-content'


/** 画布节点 */
export interface CanvasNode {
  id: string
  // input=触发/起点(注入运行输入)·agent=模型·parallel=并行扇出(多角色并发)·tool=工具/Skill·condition=条件·output=输出
  type: 'input' | 'agent' | 'parallel' | 'tool' | 'condition' | 'output'
  label: string
  x: number
  y: number
  config?: Record<string, unknown>
}

/** 画布边 */
export interface CanvasEdge {
  id: string
  from: string
  to: string
  label?: string
}

/** condition 节点运算符（与后端 workflow_condition.go 对齐）。 */
export type ConditionOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'regex'
  | 'empty'
  | 'not_empty'

export const CONDITION_OPERATORS: ConditionOperator[] = [
  'eq', 'ne', 'contains', 'not_contains', 'gt', 'lt', 'gte', 'lte', 'regex', 'empty', 'not_empty',
]

/** condition 节点单条规则：命中则激活 target 出边分支。 */
export interface ConditionRule {
  op: ConditionOperator
  value?: string
  /** 命中时激活的下游 nodeID（必须是本 condition 节点的一条出边 target）。 */
  target: string
}

/**
 * condition 节点配置（对应后端 node.Data）。按序求值 conditions，首个命中的规则激活其
 * target 分支；未命中激活 default；未选中的分支下游整枝跳过。
 */
export interface ConditionNodeConfig {
  /** 取值来源：'input'=运行输入 · '<nodeID>'=该节点输出 · 空=上游合并输出。 */
  source?: string
  conditions: ConditionRule[]
  /** 可选：无规则命中时激活的下游 nodeID。 */
  default?: string
}

/** 工作流定义 */
export interface Workflow {
  id: string
  name: string
  description?: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** Versioned scenario metadata. K12 definitions freeze immutable owner/version here. */
  data?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** 工作流执行状态 */
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 工作流节点执行结果 */
export interface WorkflowNodeRun {
  node_id: string
  type: string
  label?: string
  status: string
  output?: string
  error?: string
  agent_role?: string
  handoff_agent?: string
  started_at?: string
  finished_at?: string
}

/** 工作流执行结果 */
export interface WorkflowRun {
  id: string
  workflow_id: string
  status: WorkflowRunStatus
  input?: string
  output?: string
  message_content?: MessageContent
  render_manifest?: RenderManifest
  error?: string
  node_results?: WorkflowNodeRun[]
  /** Durable trigger/owner evidence; optional for generic legacy runs. */
  agent_id?: string
  learner_id?: string
  workflow_version?: string
  object_id?: string
  trigger_key?: string
  prior_run_id?: string
  retry_safe?: boolean
  started_at: string
  finished_at?: string
}
