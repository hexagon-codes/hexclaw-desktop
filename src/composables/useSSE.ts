import { ref, onUnmounted, getCurrentInstance } from 'vue'
import { apiSSE } from '@/api/client'

/** SSE 流式请求封装 */
export function useSSE() {
  const streaming = ref(false)
  const content = ref('')
  const error = ref<string | null>(null)

  let reader: ReadableStreamDefaultReader<string> | null = null

  /**
   * 发起 SSE 流式请求
   * @param url API 路径
   * @param body 请求体
   * @param onChunk 每个 chunk 的回调
   * @param onDone 流结束回调
   */
  async function start(
    url: string,
    body: Record<string, unknown>,
    onChunk?: (text: string) => void,
    onDone?: (fullContent: string) => void,
  ) {
    if (streaming.value) return
    streaming.value = true
    content.value = ''
    error.value = null

    try {
      const stream = await apiSSE(url, body)
      reader = stream.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        try {
          const parsed = JSON.parse(value)
          // 从已知字段提取增量；content/text 允许数字（如 {"content":123} → "123"）。
          // 未命中任何字段（心跳 / 元数据帧，如 {"event":"ping"}）则忽略该帧，
          // 不要把原始 JSON 串回灌进正文。
          let chunk: unknown
          if (parsed != null && typeof parsed === 'object') {
            if (parsed.content != null && typeof parsed.content !== 'object') chunk = parsed.content
            else if (parsed.text != null && typeof parsed.text !== 'object') chunk = parsed.text
            else chunk = parsed.choices?.[0]?.delta?.content
          } else {
            // JSON 解析出的标量（数字 / 字符串字面量），原样作为正文。
            chunk = parsed
          }
          if (chunk == null) continue
          const text = typeof chunk === 'string' ? chunk : String(chunk)
          content.value += text
          onChunk?.(text)
        } catch {
          content.value += value
          onChunk?.(value)
        }
      }

      onDone?.(content.value)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        error.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      streaming.value = false
      reader = null
    }
  }

  /** 停止流式读取 */
  function stop() {
    if (reader) {
      reader.cancel()
      reader = null
    }
    streaming.value = false
  }

  if (getCurrentInstance()) {
    onUnmounted(stop)
  }

  return {
    streaming,
    content,
    error,
    start,
    stop,
  }
}
