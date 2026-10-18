/**
 * Canvas 工作流类型定义
 *
 * 画布节点、边、工作流定义及执行状态。
 */
import type { MessageContent, RenderManifest } from '@/contracts/message-content'

export type WorkflowResourceKey = 'skills' | 'prompts' | 'knowledge' | 'tools'
export interface WorkflowDeliverySettings {
  session: { mode: 'none' | 'source' | 'workflow' }
  dingtalk: { enabled: boolean; instance_id: string; chat_id: string }
  email: { enabled: boolean; instance_id: string; to: string; subject: string }
  directory: { enabled: boolean; location: 'desktop' | 'service'; path: string; directory_ref: string; client_id: string; label?: string }
}
export interface WorkflowGeneratedFile {
  id: string; node_id: string; format: string; name: string
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  download_url?: string; digest?: string; size?: number; mime?: string
  error?: string; error_code?: string; created_at: string; updated_at: string
}
export interface WorkflowDelivery {
  id: string
  node_id: string
  kind: 'session' | 'dingtalk' | 'email' | 'directory'
  status: 'pending' | 'preparing' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'outcome_unknown'
  session_id?: string
  instance_id?: string
  chat_id?: string
  error?: string
  error_code?: string
  external_message_id?: string
  directory?: WorkflowDeliverySettings['directory']
  files?: Array<{ artifact_id: string; name: string; digest: string; path?: string }>
  parts?: Array<{ ordinal: number; status: string; attempts: number; external_message_id?: string; error?: string }>
  updated_at?: string
}
export interface WorkflowStepSettings {
  resources: Record<WorkflowResourceKey, { mode: 'inherit' | 'override' | 'none'; value: string[] }>
  memory: { retrieval: { mode: 'inherit' | 'related' | 'none'; query: string }; writeback: { mode: 'inherit' | 'suggest' | 'none' } }
  output: { kind: 'inherit' | 'text' | 'structured' | 'artifact'; fields: string; instructions: string; artifactKinds: string[] }
  input_selection: { kind: 'text' | 'structured' | 'artifact'; field: string }
  output_template: string
  output_field: string
  outputs: { formats: Array<'pdf' | 'md' | 'html'> }
  delivery: WorkflowDeliverySettings
}

/** 请求配置与实际命中分开；空数组不表示发生过执行。 */
export interface WorkflowStepReceipt {
  effective_resources?: Record<string, unknown>
  knowledge_hits?: unknown[]
  memory_hits?: unknown[]
  tool_calls?: unknown[]
  artifacts?: MessageContent['attachments']
  skill_receipts?: unknown[]
  output_error?: string
  retry_requires_review?: boolean
}

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
  revision?: string
}

/** 工作流执行状态 */
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'outcome_unknown'

/** 工作流节点执行结果 */
export interface WorkflowNodeRun {
  node_id: string
  type: string
  label?: string
  status: string
  output?: string
  error?: string
  provider_display_name?: string | null
  model_id?: string | null
  outcome_unknown?: boolean
  agent_role?: string
  branches?: Array<{ agent: string; task?: string; status: string; output?: string; error?: string; provider_display_name?: string; model_id?: string; outcome_unknown?: boolean }>
  handoff_agent?: string
  started_at?: string
  finished_at?: string
  resource_receipts?: Record<string, WorkflowStepReceipt>
}

/** 工作流执行结果 */
export interface WorkflowRun {
  generated_files?: WorkflowGeneratedFile[]
  deliveries?: WorkflowDelivery[]
  history_deleted?: boolean
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
  definition?: Workflow
  resource_snapshots?: Record<string, Record<string, unknown>>
  started_at: string
  finished_at?: string
}
