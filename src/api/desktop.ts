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

/** 扩展名 → MIME（Tauri 拖拽只给路径，无 MIME，需据扩展名推断供 vision/上传分类）。 */
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function mimeFromName(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

/**
 * 读取本地文件为 File 对象。
 *
 * Tauri 原生拖拽（onDragDropEvent）只提供文件路径，而会话框附件需要 File（含字节，
 * 供 useChatSend 经 FileReader 转 base64）。通过后端 read_file_as_base64 命令读字节后封装。
 */
export async function readLocalFileAsFile(path: string): Promise<File> {
  const { invoke } = await import('@tauri-apps/api/core')
  const res = await invoke<{ base64: string; name: string; mime?: string }>('read_file_as_base64', { path })
  const bin = atob(res.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const name = res.name || path.split(/[/\\]/).pop() || 'file'
  return new File([bytes], name, { type: res.mime || mimeFromName(name) })
}
