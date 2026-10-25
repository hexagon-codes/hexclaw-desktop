import DOMPurify from 'dompurify'

const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
]
const FORBID_ATTR = ['onerror', 'onload', 'onclick', 'onmouseover', 'onsubmit', 'srcset']

function looksLikeHtmlDocument(content: string): boolean {
  return /<!doctype|<html|<head|<body/i.test(content)
}

export function isCompleteHtmlDocument(content: string): boolean {
  return /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*<\/html>\s*$/i.test(content)
}

export function htmlDocumentTitle(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html')
  return (document.title || document.querySelector('h1')?.textContent || '').trim().slice(0, 160)
}

export function attachPreviewStyleNonce(content: string): string {
  const nonce = document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce
  if (!nonce) return content
  const preview = new DOMParser().parseFromString(content, 'text/html')
  // srcdoc 继承主窗口的样式策略；只接续样式许可，不将 nonce 写回原始成果。
  preview.querySelectorAll('style').forEach(style => { style.setAttribute('nonce', nonce) })
  return `<!doctype html>\n${preview.documentElement.outerHTML}`
}

export function sanitizeArtifactHtml(content: string, title = 'Artifact Preview'): string {
  if (looksLikeHtmlDocument(content)) {
    return attachPreviewStyleNonce(DOMPurify.sanitize(content, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS,
      FORBID_ATTR,
    }))
  }

  const safeBody = DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS,
    FORBID_ATTR,
  })

  return attachPreviewStyleNonce(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${DOMPurify.sanitize(title)}</title>
    <style>
      body { margin: 0; padding: 16px; font-family: ui-sans-serif, system-ui, sans-serif; background: #fff; color: #111827; }
    </style>
  </head>
  <body>${safeBody}</body>
</html>`)
}

export function openSanitizedArtifact(content: string, title: string) {
  const doc = sanitizeArtifactHtml(content, title)
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    URL.revokeObjectURL(url)
    return false
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}
