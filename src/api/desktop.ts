/**
 * 写入剪贴板（使用浏览器 API，无需后端支持）
 *
 * 优先 navigator.clipboard.writeText，回退到 document.execCommand('copy')。
 */
export async function setClipboard(content: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content)
    return
  }
  // Fallback for environments without Clipboard API (e.g., non-HTTPS)
  const textarea = document.createElement('textarea')
  textarea.value = content
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
