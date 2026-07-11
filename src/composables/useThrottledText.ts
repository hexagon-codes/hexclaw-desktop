/**
 * useThrottledText —— 高频文本源的节流镜像(BUG-20260710 P1 · 流式渲染成本)。
 *
 * 背景:流式回复每个 chunk 都把整条内容喂 MarkdownRenderer 全量重 parse,
 * 单条流 O(n²)——长回复时 WKWebView 主线程被持续占满(打字/滚动卡)。
 * 本 composable 把「每 chunk 一次」降为「至多每 interval 一次 + 尾帧必刷」:
 * markdown 解析频率从 ~15次/s 降到 ~3次/s,内容最终一致(trailing flush)。
 */
import { ref, watch, onScopeDispose, type Ref } from 'vue'

export function useThrottledText(source: () => string, intervalMs = 300): Ref<string> {
  const mirror = ref(source())
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (v: string) => {
    mirror.value = v
    last = Date.now()
    if (timer) { clearTimeout(timer); timer = null }
  }

  watch(source, (v) => {
    const now = Date.now()
    if (now - last >= intervalMs || v === '') {
      // 到点立即刷;清空(流结束/切会话)也立即刷,不留残影
      flush(v)
      return
    }
    // 未到点:排尾帧,保证最后一段内容不丢(trailing)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => flush(source()), intervalMs - (now - last))
  })

  onScopeDispose(() => { if (timer) clearTimeout(timer) })
  return mirror
}
