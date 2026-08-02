/**
 * 应用内下载（Tauri 原生 Save 对话框 + Rust 写盘），而不是把链接丢给系统浏览器。
 *
 * 背景：Tauri WKWebView 里 `<a download>` / blob URL 不可靠，且全局点击拦截会把
 * http(s) 链接交给 `shell.open` → 系统浏览器。下载类动作必须走原生 Save 对话框，
 * 由 Rust 侧 opaque grant 流式写盘，
 * 获得"本应用下载"的体验。
 */

import { open as shellOpen } from '@tauri-apps/plugin-shell'

/**
 * 弹原生 Save 对话框让用户选路径，再由 Rust 写盘。返回保存路径；用户取消返回 null。
 * http(s) 资源全程由 Rust 流式落盘；不接受内嵌二进制 data URL。
 */
export async function downloadInApp(src: string, filename: string): Promise<string | null> {
  const { downloadIntoGrant, pickSaveFileGrant } = await import('@/api/native-files')
  const grant = await pickSaveFileGrant(filename, 'save_download')
  if (!grant) return null // 用户取消

  if (!src.startsWith('http')) {
    throw new Error(`unsupported src: ${src.slice(0, 32)}`)
  }
  await downloadIntoGrant(grant, src)
  return grant.name
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
