import { onBeforeUnmount, ref } from 'vue'
import { sidecarFetch } from '@/api/client'
import { backendRelativePath, backendScopeKey, assertBackendActive } from '@/services/backend-context'
import { env } from '@/config/env'
import { isTauri } from '@/utils/platform'
import { releaseImagePreviewResource } from './useImagePreview'

const GENERATED_MEDIA_PATH = '/api/v1/files/generated/'

// 消息中的生成文件是业务相对路径；拼接时保留开发代理或部署前缀。
export function backendMediaURL(source: string): string {
  // 生成器的内容寻址文件名是同一已登记资源，历史裸路径也进入认证读取和去重。
  if (/^\/?\d{6}\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(source)) {
    source = `${GENERATED_MEDIA_PATH}${source.replace(/^\//, '')}`
  }
  return source.startsWith(GENERATED_MEDIA_PATH)
    ? `${env.apiBase.replace(/\/+$/, '')}${source}`
    : source
}

export function isGeneratedMediaSource(source: string): boolean {
  const url = backendMediaURL(source)
  if (!/^https?:\/\//i.test(url)) return false
  try {
    return backendRelativePath(url)?.startsWith(GENERATED_MEDIA_PATH) ?? false
  } catch {
    return false
  }
}

// 持久消息保留稳定地址；受保护媒体经当前连接认证后才交给浏览器播放或预览。
export function useBackendMedia() {
  const urls = ref(new Map<string, string>())
  const pending = new Map<string, Promise<string>>()
  const controllers = new Map<string, AbortController>()
  const failed = new Set<string>()
  let disposed = false

  function managed(source: string): boolean {
    const url = backendMediaURL(source)
    if (!/^https?:\/\//i.test(url)) return false
    return backendRelativePath(url)?.startsWith('/api/') ?? false
  }

  async function load(source: string): Promise<string> {
    source = backendMediaURL(source)
    if (!source || !managed(source)) return source
    const cached = urls.value.get(source)
    if (cached) return cached
    const existing = pending.get(source)
    if (existing) return existing
    const controller = new AbortController()
    const scope = backendScopeKey()
    controllers.set(source, controller)
    const task = (async () => {
      if (isTauri() && isGeneratedMediaSource(source)) {
        const relative = backendRelativePath(backendMediaURL(source))!
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const root = convertFileSrc('asset', 'hexclaw-media')
        assertBackendActive(scope)
        const url = `${root}?path=${encodeURIComponent(relative)}&scope=${encodeURIComponent(scope)}`
        if (disposed || controller.signal.aborted) throw new DOMException('Media released', 'AbortError')
        urls.value.set(source, url)
        failed.delete(source)
        return url
      }
      const response = await sidecarFetch(backendMediaURL(source), { signal: controller.signal })
      if (!response.ok) throw new Error(`Media fetch failed: HTTP ${response.status}`)
      const blob = await response.blob()
      assertBackendActive(scope)
      if (disposed || controller.signal.aborted) throw new DOMException('Media released', 'AbortError')
      const url = URL.createObjectURL(blob)
      urls.value.set(source, url)
      failed.delete(source)
      return url
    })().catch((error: unknown) => {
      // 取消及旧请求的迟到失败不能污染当前资源；实际读取失败仍等待原有显式恢复。
      if (!disposed && !controller.signal.aborted && controllers.get(source) === controller
        && !(error instanceof DOMException && error.name === 'AbortError')) failed.add(source)
      throw error
    }).finally(() => {
      if (controllers.get(source) === controller) {
        pending.delete(source)
        controllers.delete(source)
      }
    })
    pending.set(source, task)
    return task
  }

  function display(source: string): string {
    source = backendMediaURL(source)
    if (!source || !managed(source)) return source
    const cached = urls.value.get(source)
    if (cached) return cached
    if (!failed.has(source)) void load(source).catch(() => undefined)
    return ''
  }

  function release(source: string) {
    source = backendMediaURL(source)
    const controller = controllers.get(source)
    // 先解除旧请求归属，同源资源立即重现时可创建新读取。
    pending.delete(source)
    controllers.delete(source)
    controller?.abort()
    const url = urls.value.get(source)
    if (url) {
      releaseImagePreviewResource(url)
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      urls.value.delete(source)
    }
    failed.delete(source)
  }

  function retain(sources: string[]) {
    const active = new Set(sources.map(backendMediaURL))
    for (const source of new Set([...urls.value.keys(), ...controllers.keys(), ...failed])) {
      if (!active.has(source)) release(source)
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    retain([])
  })
  return { display, load, retain }
}
