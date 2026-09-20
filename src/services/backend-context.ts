import { shallowRef } from 'vue'
import { isTauri } from '@/utils/platform'
import { env } from '@/config/env'
import type { ChatMode } from '@/types/chat'

export interface BackendContext {
  connectionId: string
  backendId: string
  configRevision: number
  activationGeneration: number
  kind: 'local' | 'remote'
  apiBase: string
  wsBase: string
  hasToken: boolean
}

export const backendContext = shallowRef<BackendContext | null>(null)
export const backendPanelOpen = shallowRef(false)

// 兼容内部占位地址和当前后端的绝对资产 URL，返回由原生层追加部署前缀的业务路径。
export function backendRelativePath(raw: string): string | null {
  const url = new URL(raw, env.apiBase)
  if (url.username || url.password || url.hash) return null
  for (const root of [backendContext.value?.apiBase, env.apiBase]) {
    if (!root) continue
    const base = new URL(root)
    const prefix = base.pathname.replace(/\/+$/, '')
    if (url.origin !== base.origin) continue
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue
    return `${url.pathname.slice(prefix.length) || '/'}${url.search}`
  }
  return null
}
let reloadPending = false
const beforeReload = new Set<() => void | Promise<void>>()

export function backendScopeKey(context = backendContext.value): string {
  return context ? JSON.stringify([context.connectionId, context.backendId, context.configRevision, context.activationGeneration]) : ''
}

export function backendStorageKey(key: string): string {
  const context = backendContext.value
  if (!context?.backendId) return key
  return `hexclaw:backend:${encodeURIComponent(context.connectionId)}:${encodeURIComponent(context.backendId)}:${key}`
}

export function registerBackendDraftFlush(flush: () => void | Promise<void>): () => void {
  beforeReload.add(flush)
  return () => beforeReload.delete(flush)
}

export async function flushBackendDrafts(): Promise<void> {
  await Promise.all([...beforeReload].map((flush) => flush()))
}

// 切换后重建页面运行域，已进入原生层的操作继续使用原快照。
export async function initializeBackendContext(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  backendContext.value = await invoke<BackendContext>('get_backend_context')
  let bootstrapping = true
  await listen<BackendContext>('backend-connection-changed', (event) => {
    if (bootstrapping) { backendContext.value = event.payload; return }
    if (backendScopeKey(event.payload) === backendScopeKey() || reloadPending) return
    reloadPending = true
    void Promise.allSettled([...beforeReload].map((flush) => flush())).then(() => {
      if (event.payload.connectionId !== backendContext.value?.connectionId || event.payload.backendId !== backendContext.value?.backendId) {
        // 目标服务自行恢复自己的最近会话，不能把来源服务的孩子或任务参数带过去。
        const url = new URL(window.location.href)
        url.search = ''
        url.hash = ''
        window.history.replaceState(null, '', url)
      }
      window.location.reload()
    })
  })
  // 首次本机启动等待已认证的数据身份，避免先建立无归属缓存。
  for (let attempt = 0; !backendContext.value?.backendId && attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    backendContext.value = await invoke<BackendContext>('get_backend_context')
  }
  bootstrapping = false
}

export function assertBackendActive(scope: string): void {
  if (reloadPending || scope !== backendScopeKey()) throw new DOMException('Backend connection changed', 'AbortError')
}

function legacyLocalValue(key: string): string | null {
  const context = backendContext.value
  if (context?.kind !== 'local' || !context.backendId) return null
  const binding = 'hexclaw:legacy-local-backend-id'
  const owner = localStorage.getItem(binding)
  if (owner && owner !== context.backendId) return null
  if (!owner) localStorage.setItem(binding, context.backendId)
  return localStorage.getItem(key)
}

export const backendLocalStorage = {
  getItem(key: string): string | null {
    const scoped = backendStorageKey(key)
    const value = localStorage.getItem(scoped)
    if (value !== null || scoped === key) return value
    const legacy = legacyLocalValue(key)
    if (legacy !== null) localStorage.setItem(scoped, legacy)
    return legacy
  },
  setItem(key: string, value: string): void { localStorage.setItem(backendStorageKey(key), value) },
  removeItem(key: string): void { localStorage.removeItem(backendStorageKey(key)) },
}

export interface ModelSettingsReturn {
  path: string
  sessionId: string | null
  agentRole: string
  chatMode: ChatMode
}

const modelSettingsReturnKey = 'model-settings-return'

// 配置支路只记录原入口；正文和附件仍由 Composer 持久化，按同一服务身份恢复。
export function saveModelSettingsReturn(context: ModelSettingsReturn): void {
  backendLocalStorage.setItem(modelSettingsReturnKey, JSON.stringify(context))
}

export function readModelSettingsReturn(): ModelSettingsReturn | null {
  try {
    const raw = backendLocalStorage.getItem(modelSettingsReturnKey)
    if (!raw) return null
    const value = JSON.parse(raw) as ModelSettingsReturn
    if (typeof value.path !== 'string' || !value.path.startsWith('/chat')
      || typeof value.agentRole !== 'string'
      || (value.sessionId !== null && typeof value.sessionId !== 'string')
      || !['chat', 'agent', 'research'].includes(value.chatMode)) return null
    return value
  } catch { return null }
}

export function clearModelSettingsReturn(): void {
  backendLocalStorage.removeItem(modelSettingsReturnKey)
}
