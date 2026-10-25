import { onBeforeUnmount, watch, type Ref } from 'vue'
import { getAssetBlob } from '@/api/assets'
import { assertBackendActive, backendScopeKey } from '@/services/backend-context'
import { releaseImagePreviewResource } from './useImagePreview'
import { logger } from '@/utils/logger'

export const K12_MARKDOWN_IMAGE_ATTRIBUTE = 'data-k12-asset-source'

function assetImageAgent(source: string): string | undefined {
  // 只接管既有内容寻址资产；原生 asset 协议的自然本地路径仍走原图片处理。
  return /^asset:\/\/([^/?#]+)\/[a-f0-9]{64}\.[a-z0-9]+$/.exec(source)?.[1]
}

export function isK12MarkdownImageSource(source: string): boolean {
  return assetImageAgent(source) !== undefined
}

interface AssetImageEntry {
  scope: string
  controller: AbortController
  url?: string
}

// 清洗后的节点只接收既有认证接口取得的对象 URL，不改写规范正文或全局 URI 规则。
export function useK12MarkdownImages(
  root: Ref<HTMLElement | null>,
  rendered: Readonly<Ref<string>>,
) {
  const entries = new Map<string, AssetImageEntry>()
  let disposed = false

  function current(source: string, entry: AssetImageEntry): boolean {
    return !disposed && !entry.controller.signal.aborted
      && entries.get(source) === entry && entry.scope === backendScopeKey()
  }

  function release(source: string, entry: AssetImageEntry) {
    entry.controller.abort()
    if (entry.url) {
      for (const image of root.value?.querySelectorAll<HTMLImageElement>(
        `img[${K12_MARKDOWN_IMAGE_ATTRIBUTE}]`,
      ) ?? []) {
        if (image.getAttribute(K12_MARKDOWN_IMAGE_ATTRIBUTE) === source
          && image.getAttribute('src') === entry.url) image.removeAttribute('src')
      }
      releaseImagePreviewResource(entry.url)
      URL.revokeObjectURL(entry.url)
    }
    entries.delete(source)
  }

  function apply(source: string, entry: AssetImageEntry) {
    if (!entry.url || !current(source, entry)) return
    try {
      assertBackendActive(entry.scope)
    } catch {
      return
    }
    for (const image of root.value?.querySelectorAll<HTMLImageElement>(
      `img[${K12_MARKDOWN_IMAGE_ATTRIBUTE}]`,
    ) ?? []) {
      if (image.getAttribute(K12_MARKDOWN_IMAGE_ATTRIBUTE) === source) image.src = entry.url
    }
  }

  async function load(source: string, agent: string, entry: AssetImageEntry) {
    try {
      const blob = await getAssetBlob(agent, source, entry.controller.signal)
      if (!blob || !current(source, entry)) return
      assertBackendActive(entry.scope)
      entry.url = URL.createObjectURL(blob)
      apply(source, entry)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      logger.warn('K12 Markdown image could not be loaded', error)
    }
  }

  function synchronize() {
    const sources = new Map<string, string>()
    for (const image of root.value?.querySelectorAll<HTMLImageElement>(
      `img[${K12_MARKDOWN_IMAGE_ATTRIBUTE}]`,
    ) ?? []) {
      const source = image.getAttribute(K12_MARKDOWN_IMAGE_ATTRIBUTE) ?? ''
      const agent = assetImageAgent(source)
      if (agent) sources.set(source, agent)
    }
    const scope = backendScopeKey()
    for (const [source, entry] of entries) {
      if (!sources.has(source) || entry.scope !== scope) release(source, entry)
    }
    for (const [source, agent] of sources) {
      const existing = entries.get(source)
      if (existing) {
        apply(source, existing)
        continue
      }
      const entry = { scope, controller: new AbortController() }
      entries.set(source, entry)
      void load(source, agent, entry)
    }
  }

  // v-html 已替换节点后再接线；同资产复用字节，移除或连接切换立即失效旧读取。
  watch([root, rendered, () => backendScopeKey()], synchronize, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => {
    disposed = true
    for (const [source, entry] of entries) release(source, entry)
  })
}
