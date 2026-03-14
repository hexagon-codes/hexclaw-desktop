import { ref } from 'vue'
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
    streaming.value = true
    content.value = ''
    error.value = null

    try {
      const stream = await apiSSE(url, body)
      reader = stream.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // 尝试解析 JSON，提取 content 字段
        try {
          const parsed = JSON.parse(value)
          const chunk = typeof parsed.content === 'string' ? parsed.content
            : typeof parsed.text === 'string' ? parsed.text
            : parsed.choices?.[0]?.delta?.content ?? value
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

  return {
    streaming,
    content,
    error,
    start,
    stop,
  }
}
