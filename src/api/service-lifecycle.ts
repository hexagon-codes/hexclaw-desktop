import { api } from './client'
import { assertBackendActive } from '@/services/backend-context'

const RESTART_OBSERVATION_TIMEOUT_MS = 120000
const HEALTH_REQUEST_TIMEOUT_MS = 3000
const HEALTH_OBSERVATION_INTERVAL_MS = 1000

interface ServiceHealth {
  status: 'healthy' | 'unhealthy'
  process_instance_id: string
  restart_supported: boolean
}

function assertOperationActive(scope: string, signal: AbortSignal) {
  assertBackendActive(scope)
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
}

function parseHealth(value: unknown): ServiceHealth | null {
  if (!value || typeof value !== 'object') return null
  const health = value as Partial<ServiceHealth>
  if (
    !['healthy', 'unhealthy'].includes(health.status ?? '')
    || typeof health.process_instance_id !== 'string'
    || !health.process_instance_id
    || typeof health.restart_supported !== 'boolean'
  ) return null
  return health as ServiceHealth
}

async function serviceRequest(
  path: string,
  scope: string,
  signal: AbortSignal,
  timeout: number,
  body?: { expected_process_instance_id: string; request_id: string },
) {
  assertOperationActive(scope, signal)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  // ofetch 在收到外部 signal 时不创建 timeout，需同时保留取消与单次请求时限。
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeout))
  try {
    return await api.raw<unknown>(path, {
      method: body ? 'POST' : 'GET',
      body,
      headers: { 'x-hexclaw-connection-scope': scope },
      signal: controller.signal,
      retry: 0,
      ignoreResponseError: true,
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function waitForObservation(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 云端重启只提交一次；结果不确定时继续观察代际，不重新发送。 */
export async function restartRemoteService(scope: string, signal: AbortSignal): Promise<boolean | null> {
  let before: Awaited<ReturnType<typeof serviceRequest>>
  try {
    before = await serviceRequest('/health', scope, signal, HEALTH_REQUEST_TIMEOUT_MS)
  } catch {
    assertOperationActive(scope, signal)
    return null
  }
  assertOperationActive(scope, signal)
  const initialHealth = parseHealth(before._data)
  if (![200, 503].includes(before.status) || !initialHealth?.restart_supported) {
    throw new Error('Managed service restart is not available')
  }

  const requestId = globalThis.crypto.randomUUID()
  try {
    const response = await serviceRequest('/api/v1/service/restart', scope, signal, 10000, {
      expected_process_instance_id: initialHealth.process_instance_id,
      request_id: requestId,
    })
    assertOperationActive(scope, signal)
    if (response.status >= 400 && response.status < 500) return false
    // 受理回执及中断都不能证明进程重启，后续只以健康接口确认。
  } catch {
    assertOperationActive(scope, signal)
  }

  const deadline = Date.now() + RESTART_OBSERVATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    assertOperationActive(scope, signal)
    try {
      const response = await serviceRequest('/health', scope, signal,
        Math.min(HEALTH_REQUEST_TIMEOUT_MS, deadline - Date.now()))
      assertOperationActive(scope, signal)
      const health = parseHealth(response._data)
      if (response.status === 200 && health?.status === 'healthy'
        && health.process_instance_id !== initialHealth.process_instance_id) return true
    } catch {
      assertOperationActive(scope, signal)
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await waitForObservation(signal, Math.min(HEALTH_OBSERVATION_INTERVAL_MS, remaining))
  }
  return null
}
