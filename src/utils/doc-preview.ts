/**
 * 文档原文件注册表（会话内有效）。
 *
 * 文档卡片只在 metadata 里存 {name,mime,size,id}，不存原文件（避免持久化膨胀）。
 * 发送时把原 File 登记在此；点击卡片预览/下载时再上传给 sidecar 暂存并以 http://localhost
 * 提供（WKWebView iframe 渲染不了 PDF、又无 fs 插件，只能走 sidecar + shell open）。
 * 重载后注册表清空，预览/下载优雅失效（卡片仍展示）。
 */
const files = new Map<string, File>()

/** 登记原文件。 */
export function registerDocPreview(id: string, file: File): void {
  files.set(id, file)
}

/** 取原文件；无（未登记 / 重载后）返回 undefined。 */
export function getDocPreviewFile(id: string | undefined): File | undefined {
  return id ? files.get(id) : undefined
}
