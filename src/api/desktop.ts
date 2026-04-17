/**
 * 写入剪贴板
 *
 * Tauri 桌面端优先使用后端 /api/v1/desktop/clipboard 写入系统剪贴板，
 * 回退到 navigator.clipboard.writeText，最终回退到 execCommand('copy')。
 */
export async function setClipboard(content: string): Promise<void> {
  // Tauri 桌面端：通过后端 API 写入系统剪贴板（绕过 WebView 限制）
  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('proxy_api_request', {
        method: 'POST',
        path: '/api/v1/desktop/clipboard',
        body: JSON.stringify({ content }),
      })
      return
    } catch {
      // Tauri invoke 失败，回退到浏览器 API
    }
  }
  // 浏览器环境
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content)
    return
  }
  // 最终回退
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
