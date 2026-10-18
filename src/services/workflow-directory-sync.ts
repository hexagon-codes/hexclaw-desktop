import { watch } from 'vue'
import {
  acknowledgeWorkflowDirectoryDelivery,
  getPendingWorkflowDirectoryDeliveries,
  getWorkflowDirectoryRunState,
  listWorkflowDirectories,
  saveWorkflowDirectory,
  workflowDirectoryNativeError,
  type WorkflowDirectoryAck,
  type WorkflowPendingDirectoryDelivery,
} from '@/api/workflow-directories'
import {
  assertBackendActive,
  backendContext,
  backendScopeKey,
  registerBackendDraftFlush,
} from '@/services/backend-context'
import { isTauri } from '@/utils/platform'
import { logger } from '@/utils/logger'

const POLL_DELAY_MS = 10_000

interface PreparedReceipt {
  delivery: WorkflowPendingDirectoryDelivery
  receipt: WorkflowDirectoryAck
}

/** 当前桌面只接收分配给本机已选目录的任务；离线不会伪造落盘成功。 */
export function startWorkflowDirectorySync(): () => void {
  if (!isTauri()) return () => {}
  let disposed = false
  let stopScope = () => {}

  const stopWatch = watch(
    () => backendScopeKey(backendContext.value),
    (scope) => {
      stopScope()
      if (!scope || disposed) return
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const prepared = new Map<string, PreparedReceipt>()
      const completed = new Set<string>()
      const keyOf = (delivery: WorkflowPendingDirectoryDelivery) => `${delivery.run_id}:${delivery.delivery_id}`
      const active = () => {
        if (controller.signal.aborted || disposed) throw new DOMException('The operation was aborted', 'AbortError')
        assertBackendActive(scope)
      }
      stopScope = () => {
        controller.abort()
        if (timer !== undefined) clearTimeout(timer)
      }

      const confirm = async (key: string, item: PreparedReceipt, reconcile: boolean) => {
        active()
        if (reconcile) {
          const run = await getWorkflowDirectoryRunState(item.delivery.run_id, controller.signal)
          active()
          const status = run.deliveries?.find((delivery) => delivery.id === item.delivery.delivery_id)?.status
          if (status === item.receipt.status || status === 'delivered') {
            prepared.delete(key)
            completed.add(key)
            return
          }
          // 只有服务明确仍待保存时，才重放同一份幂等回执。
          if (status !== 'pending') return
        }
        await acknowledgeWorkflowDirectoryDelivery(item.delivery, item.receipt, controller.signal)
        active()
        prepared.delete(key)
        completed.add(key)
      }

      const poll = async () => {
        try {
          active()
          const catalog = await listWorkflowDirectories()
          active()
          if (!catalog.client_id || !catalog.directories.length) return
          for (const [key, item] of prepared) {
            try { await confirm(key, item, true) }
            catch (error) {
              active()
              logger.debug('Workflow directory receipt reconciliation is pending', workflowDirectoryNativeError(error).code)
            }
          }
          active()
          const response = await getPendingWorkflowDirectoryDeliveries(catalog.client_id, controller.signal)
          active()
          const directories = new Set(catalog.directories.map((directory) => directory.directory_ref))
          for (const delivery of response.deliveries ?? []) {
            active()
            const key = keyOf(delivery)
            if (prepared.has(key) || completed.has(key) || delivery.client_id !== catalog.client_id
              || !directories.has(delivery.directory_ref)) continue
            let receipt: WorkflowDirectoryAck
            try {
              const files = await saveWorkflowDirectory(delivery, scope)
              active()
              receipt = { client_id: catalog.client_id, status: 'delivered', files }
            } catch (error) {
              active()
              const failure = workflowDirectoryNativeError(error)
              if (failure.code === 'workflow_backend_changed' || failure.code === 'workflow_network_unavailable') continue
              receipt = {
                client_id: catalog.client_id,
                status: 'failed',
                files: [],
                error_code: failure.code,
                error: failure.message,
              }
            }
            active()
            const item = { delivery, receipt }
            prepared.set(key, item)
            try { await confirm(key, item, false) }
            catch (error) {
              active()
              logger.debug('Workflow directory acknowledgement is pending', workflowDirectoryNativeError(error).code)
            }
          }
        } catch (error) {
          if (!controller.signal.aborted && !disposed) {
            logger.debug('Workflow directory sync is waiting for the active backend', workflowDirectoryNativeError(error).code)
          }
        } finally {
          if (!controller.signal.aborted && !disposed) timer = setTimeout(() => void poll(), POLL_DELAY_MS)
        }
      }
      void poll()
    },
    { immediate: true },
  )
  const stop = () => {
    disposed = true
    stopScope()
    stopWatch()
  }
  const unregisterFlush = registerBackendDraftFlush(stop)
  return () => { unregisterFlush(); stop() }
}
