import { invoke } from '@tauri-apps/api/core'
import { DESKTOP_USER_ID } from '@/constants'
import { assertBackendActive, backendScopeKey } from '@/services/backend-context'
import { isTauri } from '@/utils/platform'
import { apiGet, apiPost } from './client'

export interface WorkflowDirectoryRef {
  client_id: string
  directory_ref: string
  label: string
}

export interface WorkflowDirectoryCatalog {
  client_id: string
  directories: WorkflowDirectoryRef[]
}

export interface WorkflowDirectoryFile {
  artifact_id: string
  name: string
  digest: string
  download_url: string
  mime: string
  size: number
}

export interface WorkflowDirectoryFileReceipt {
  artifact_id: string
  name: string
  digest: string
  path: string
}

export interface WorkflowPendingDirectoryDelivery {
  run_id: string
  delivery_id: string
  client_id: string
  directory_ref: string
  files: WorkflowDirectoryFile[]
}

export interface WorkflowDirectoryAck {
  client_id: string
  status: 'delivered' | 'failed'
  files: WorkflowDirectoryFileReceipt[]
  error_code?: string
  error?: string
}

export interface WorkflowDirectoryRunState {
  deliveries?: Array<{ id: string; status: string }>
}

export interface WorkflowDirectoryNativeError {
  code: string
  message: string
}

export async function pickWorkflowDirectory(): Promise<WorkflowDirectoryRef | null> {
  if (!isTauri()) throw new Error('Workflow directory selection requires the desktop application')
  return invoke<WorkflowDirectoryRef | null>('workflow_directory_pick')
}

export async function listWorkflowDirectories(): Promise<WorkflowDirectoryCatalog> {
  if (!isTauri()) return { client_id: '', directories: [] }
  return invoke<WorkflowDirectoryCatalog>('workflow_directory_list')
}

export async function saveWorkflowDirectory(
  delivery: WorkflowPendingDirectoryDelivery,
  scope = backendScopeKey(),
): Promise<WorkflowDirectoryFileReceipt[]> {
  assertBackendActive(scope)
  const files = await invoke<WorkflowDirectoryFileReceipt[]>('workflow_directory_save', {
    clientId: delivery.client_id,
    directoryRef: delivery.directory_ref,
    files: delivery.files,
    scope,
  })
  assertBackendActive(scope)
  return files
}

export function getPendingWorkflowDirectoryDeliveries(clientId: string, signal: AbortSignal) {
  return apiGet<{ deliveries: WorkflowPendingDirectoryDelivery[] }>(
    '/api/v1/canvas/deliveries/pending',
    { client_id: clientId, user_id: DESKTOP_USER_ID },
    { signal },
  )
}

export function getWorkflowDirectoryRunState(runId: string, signal: AbortSignal) {
  return apiGet<WorkflowDirectoryRunState>(
    `/api/v1/canvas/runs/${encodeURIComponent(runId)}`,
    { user_id: DESKTOP_USER_ID },
    { signal },
  )
}

/** 本机落盘回执可幂等确认；超时后先查询同一运行，不重新执行工作流。 */
export function acknowledgeWorkflowDirectoryDelivery(
  delivery: Pick<WorkflowPendingDirectoryDelivery, 'run_id' | 'delivery_id'>,
  receipt: WorkflowDirectoryAck,
  signal: AbortSignal,
) {
  return apiPost<WorkflowDirectoryRunState>(
    `/api/v1/canvas/runs/${encodeURIComponent(delivery.run_id)}/deliveries/${encodeURIComponent(delivery.delivery_id)}/ack?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
    receipt,
    { signal },
  )
}

export function workflowDirectoryNativeError(error: unknown): WorkflowDirectoryNativeError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error
    && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'workflow_backend_changed', message: 'Backend connection changed' }
  }
  return {
    code: 'workflow_directory_save_failed',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Workflow directory save failed',
  }
}
