/**
 * 应用内下载（Tauri 原生 Save 对话框 + Rust 写盘），而不是把链接丢给系统浏览器。
 *
 * 背景：Tauri WKWebView 里 `<a download>` / blob URL 不可靠，且全局点击拦截会把
 * http(s) 链接交给 `shell.open` → 系统浏览器。下载类动作必须走原生 Save 对话框，
 * 由 Rust 侧 `save_file_from_url`（http/s）/ `save_bytes_to_path`（data:）写盘，
 * 获得"本应用下载"的体验。
 */

import { open as shellOpen } from '@tauri-apps/plugin-shell'

/**
 * 弹原生 Save 对话框让用户选路径，再由 Rust 写盘。返回保存路径；用户取消返回 null。
 * http(s) → save_file_from_url（流式，不进 JS 内存）；data: → save_bytes_to_path。
 */
export async function downloadInApp(src: string, filename: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')

  const chosen = await save({ defaultPath: filename })
  if (!chosen) return null // 用户取消

  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma < 0) throw new Error('invalid data URL')
    await invoke<number>('save_bytes_to_path', { base64Data: src.slice(comma + 1), path: chosen })
  } else if (src.startsWith('http')) {
    await invoke<number>('save_file_from_url', { url: src, path: chosen })
  } else {
    throw new Error(`unsupported src: ${src.slice(0, 32)}`)
  }
  return chosen
}

export interface OpenDocumentDeps {
  /** 本会话缓存的原始 File（重载后失效 → null）。 */
  file: File | null
  /** true=下载（落本地磁盘），false=预览（系统默认应用打开）。 */
  download: boolean
  /** 保存对话框默认文件名。 */
  filename: string
  uploadPreview: (file: File) => Promise<{ token: string }>
  previewUrl: (token: string, dl: boolean) => string
  toast: { info: (m: string) => void; error: (m: string) => void; success?: (m: string) => void }
  expiredMsg: string
  failedMsg: string
  /** 下载成功提示，入参为保存路径。 */
  savedMsg: (path: string) => string
  // 以下可注入，便于测试 / 非 Tauri 回退
  saveInApp?: (src: string, filename: string) => Promise<string | null>
  shell?: (url: string) => Promise<void>
  windowOpen?: (url: string) => void
}

/**
 * 预览或下载会话内文档。预览走系统默认应用（shell.open），
 * 下载走应用内 Save 对话框（downloadInApp）——绝不把下载丢给系统浏览器。
 */
export async function openOrDownloadDocument(deps: OpenDocumentDeps): Promise<void> {
  if (!deps.file) {
    deps.toast.info(deps.expiredMsg)
    return
  }
  const saveInApp = deps.saveInApp ?? downloadInApp
  const shell = deps.shell ?? shellOpen
  const winOpen = deps.windowOpen ?? ((u: string) => { window.open(u, '_blank') })

  try {
    const { token } = await deps.uploadPreview(deps.file)
    if (deps.download) {
      // 应用内下载：原生 Save 对话框 + Rust 写盘，绝不把下载丢给系统浏览器（BUG-20260626）
      const chosen = await saveInApp(deps.previewUrl(token, false), deps.filename)
      if (chosen) deps.toast.success?.(deps.savedMsg(chosen))
    } else {
      // 预览：系统默认应用打开（非 Tauri/dev 回退 window.open）
      const url = deps.previewUrl(token, false)
      try {
        await shell(url)
      } catch {
        winOpen(url)
      }
    }
  } catch {
    deps.toast.error(deps.failedMsg)
  }
}
