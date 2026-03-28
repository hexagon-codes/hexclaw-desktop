/**
 * useWechatQR — 微信扫码登录 SSE 流
 *
 * D14: 连接 POST /api/v1/channels/wechat/qr-stream SSE 端点，
 * 接收二维码和登录状态更新。
 */
import { ref, onUnmounted } from 'vue'
import { env } from '@/config/env'

type QRStatus = 'idle' | 'generating' | 'waiting' | 'scanning' | 'success' | 'error' | 'pending'

export function useWechatQR() {
  const status = ref<QRStatus>('idle')
  const message = ref('')
  const qrData = ref<string | null>(null)
  const nickname = ref<string | null>(null)
  const error = ref<string | null>(null)

  let eventSource: EventSource | null = null

  function startQRStream() {
    status.value = 'generating'
    message.value = '正在生成二维码...'
    error.value = null
    qrData.value = null

    // SSE via fetch + ReadableStream (POST not supported by EventSource)
    const url = `${env.apiBase}/api/v1/channels/wechat/qr-stream`
    fetch(url, { method: 'POST' })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          error.value = `HTTP ${resp.status}`
          status.value = 'error'
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let currentEvent = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6))
                handleEvent(currentEvent, data)
              } catch { /* ignore parse errors */ }
              currentEvent = ''
            }
          }
        }
      })
      .catch((e) => {
        error.value = e instanceof Error ? e.message : 'Connection failed'
        status.value = 'error'
      })
  }

  function handleEvent(event: string, data: Record<string, string>) {
    switch (event) {
      case 'status':
        status.value = (data.status as QRStatus) || 'waiting'
        message.value = data.message || ''
        break
      case 'qr':
        qrData.value = data.qr_data || data.content || null
        status.value = 'waiting'
        message.value = '请使用微信扫描二维码'
        break
      case 'result':
        nickname.value = data.nickname || null
        status.value = 'success'
        message.value = `已连接: ${data.nickname || '微信用户'}`
        break
      case 'error':
        error.value = data.message || 'Unknown error'
        status.value = 'error'
        break
    }
  }

  function stopQRStream() {
    eventSource?.close()
    eventSource = null
    status.value = 'idle'
  }

  onUnmounted(stopQRStream)

  return {
    status,
    message,
    qrData,
    nickname,
    error,
    startQRStream,
    stopQRStream,
  }
}
