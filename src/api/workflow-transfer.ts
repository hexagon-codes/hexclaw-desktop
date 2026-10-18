import { apiGet, apiPost, sidecarFetch } from './client'
import { env } from '@/config/env'
import { assertBackendActive, backendScopeKey } from '@/services/backend-context'
import { isTauri } from '@/utils/platform'
import { saveBlobInApp } from '@/utils/download'
import type { Workflow } from '@/types'

export interface WorkflowTransferIssue {
  severity: 'error' | 'warning'
  code: string
  node_id?: string
  path?: string
  message: string
}

export type WorkflowImportFormat = 'hexclaw-json' | 'coze-yaml' | 'coze-zip' | 'unknown'

export interface WorkflowImportPreview {
  format: WorkflowImportFormat
  schema_version: string
  workflow: Workflow | null
  issues: WorkflowTransferIssue[]
  can_import: boolean
}

export interface WorkflowDefinitionDocument {
  format: 'hexclaw-workflow'
  schema_version: '1.0.0'
  workflow: Workflow
  issues: WorkflowTransferIssue[]
}

export type WorkflowExportDefinition = Pick<Workflow, 'name' | 'nodes' | 'edges' | 'description' | 'data'> & { id?: string }

export interface WorkflowDownloadResult {
  saved: boolean
  issues: WorkflowTransferIssue[]
}

const WORKFLOW_PATH = '/api/v1/canvas/workflows'

function transferError(payload: unknown, status: number, fallback: string, fallbackCode?: string): Error {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  const detail = data?.error ?? data?.message
  const issues = Array.isArray(data?.issues) ? data.issues as WorkflowTransferIssue[] : undefined
  const error = new Error(typeof detail === 'string' && detail
    ? detail
    : issues?.filter(issue => issue.severity === 'error').map(issue => issue.message).join('\n') || fallback)
  // 原始诊断与逐节点问题供排查使用，界面按稳定错误码翻译。
  return Object.assign(error, {
    status,
    code: typeof data?.code === 'string' ? data.code : issues?.find(issue => issue.severity === 'error')?.code ?? fallbackCode,
    data: payload,
    issues,
  })
}

function isImportPreview(value: unknown): value is WorkflowImportPreview {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<WorkflowImportPreview>
  const workflow = result.workflow
  return typeof result.format === 'string'
    && typeof result.schema_version === 'string'
    && typeof result.can_import === 'boolean'
    && Array.isArray(result.issues)
    && (workflow === null || (typeof workflow === 'object' && workflow !== null
      && typeof workflow.name === 'string' && Array.isArray(workflow.nodes) && Array.isArray(workflow.edges)))
}

async function uploadWorkflowDefinition(
  file: File,
  preview: boolean,
  signal?: AbortSignal,
): Promise<WorkflowImportPreview> {
  const scope = backendScopeKey()
  const form = new FormData()
  form.append('file', file)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), env.timeout)
  try {
    const response = await sidecarFetch(
      `${env.apiBase}${WORKFLOW_PATH}/import${preview ? '/preview' : ''}`,
      { method: 'POST', body: form, signal: controller.signal },
    )
    assertBackendActive(scope)
    const payload: unknown = await response.json().catch(() => null)
    assertBackendActive(scope)
    // 兼容性阻断保留完整预检原因，避免 HTTP 错误归一化丢掉逐节点问题。
    if ((response.status === (preview ? 200 : 201) || response.status === 422)
      && isImportPreview(payload)) {
      return payload
    }
    throw transferError(payload, response.status,
      response.ok ? 'Invalid workflow import response' : `Workflow import failed (${response.status})`,
      response.ok ? 'WORKFLOW_IMPORT_INVALID_RESPONSE' : undefined)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** 预检不创建工作流；关闭或换文件时可中止在途请求。 */
export function previewWorkflowImport(file: File, signal?: AbortSignal): Promise<WorkflowImportPreview> {
  return uploadWorkflowDefinition(file, true, signal)
}

/** 提交同一原始文件，由服务端重新解析后创建新的副本。 */
export function importWorkflowDefinition(file: File): Promise<WorkflowImportPreview> {
  return uploadWorkflowDefinition(file, false)
}

/** 已保存定义的导出，与编辑器草稿导出共享服务端脱敏合同。 */
export function getWorkflowDefinitionExport(id: string): Promise<WorkflowDefinitionDocument> {
  return apiGet<WorkflowDefinitionDocument>(`${WORKFLOW_PATH}/${encodeURIComponent(id)}/export`)
}

export function exportWorkflowDefinition(workflow: WorkflowExportDefinition): Promise<WorkflowDefinitionDocument> {
  // 草稿导出只传定义；保存时间、revision等运行环境事实不属于导出请求。
  const { id, name, description, nodes, edges, data } = workflow
  return apiPost<WorkflowDefinitionDocument>(`${WORKFLOW_PATH}/export`, { workflow: { id, name, description, nodes, edges, data } })
}

function exportFileName(name: string): string {
  const leaf = Array.from(name.trim())
    .map(character => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? '-' : character)
    .join('')
  return `${leaf || 'workflow'}.hexclaw.json`
}

/** 原生端沿共享 Save grant 落盘；浏览器端触发标准文件下载。 */
export async function downloadWorkflowDefinition(workflow: WorkflowExportDefinition): Promise<WorkflowDownloadResult> {
  const document = await exportWorkflowDefinition(workflow)
  const issues = document.issues ?? []
  if (document.format !== 'hexclaw-workflow' || document.schema_version !== '1.0.0' || !document.workflow) {
    throw transferError(document, 200, 'Invalid workflow export response', 'WORKFLOW_EXPORT_INVALID_RESPONSE')
  }
  if (issues.some(issue => issue.severity === 'error')) {
    throw transferError(document, 422, 'Invalid workflow export definition')
  }
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' })
  const filename = exportFileName(workflow.name)
  if (isTauri()) return { saved: Boolean(await saveBlobInApp(blob, filename)), issues }

  const url = URL.createObjectURL(blob)
  const link = globalThis.document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  globalThis.document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return { saved: true, issues }
}
