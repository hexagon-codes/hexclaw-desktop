/**
 * Canvas 工作流类型定义
 *
 * 画布节点、边、工作流定义及执行状态。
 */

/** 画布节点 */
export interface CanvasNode {
  id: string
  type: 'agent' | 'tool' | 'condition' | 'output'
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

/** 工作流定义 */
export interface Workflow {
  id: string
  name: string
  description?: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  created_at: string
  updated_at: string
}

/** 工作流执行状态 */
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed'

/** 工作流执行结果 */
export interface WorkflowRun {
  id: string
  workflow_id: string
  status: WorkflowRunStatus
  output?: string
  error?: string
  started_at: string
  finished_at?: string
}
