import { onBeforeUnmount, ref } from 'vue'
import { sidecarFetch } from '@/api/client'
import { backendRelativePath } from '@/services/backend-context'
import { releaseImagePreviewResource } from './useImagePreview'

// 持久消息保留稳定地址；受保护媒体经当前连接认证后才交给浏览器播放或预览。
export function useBackendMedia() {
  const urls = ref(new Map<string, string>())
  const pending = new Map<string, Promise<string>>()
  const controllers = new Map<string, AbortController>()
  const failed = new Set<string>()
  let disposed = false

  function managed(source: string): boolean {
    if (!/^https?:\/\//i.test(source)) return false
    return backendRelativePath(source)?.startsWith('/api/') ?? false
  }

  async function load(source: string): Promise<string> {
    if (!source || !managed(source)) return source
    const cached = urls.value.get(source)
    if (cached) return cached
    const existing = pending.get(source)
    if (existing) return existing
    const controller = new AbortController()
    controllers.set(source, controller)
    const task = (async () => {
      const response = await sidecarFetch(source, { signal: controller.signal })
      if (!response.ok) throw new Error(`Media fetch failed: HTTP ${response.status}`)
      const blob = await response.blob()
      if (disposed || controller.signal.aborted) throw new DOMException('Media released', 'AbortError')
      const url = URL.createObjectURL(blob)
      urls.value.set(source, url)
      failed.delete(source)
      return url
    })().finally(() => {
      pending.delete(source)
      controllers.delete(source)
    })
    pending.set(source, task)
    return task
  }

  function display(source: string): string {
    if (!source || !managed(source)) return source
    const cached = urls.value.get(source)
    if (cached) return cached
    if (!failed.has(source)) void load(source).catch(() => failed.add(source))
    return ''
  }

  function release(source: string) {
    controllers.get(source)?.abort()
    const url = urls.value.get(source)
    if (url) {
      releaseImagePreviewResource(url)
      URL.revokeObjectURL(url)
      urls.value.delete(source)
    }
    failed.delete(source)
  }

  function retain(sources: string[]) {
    const active = new Set(sources)
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
