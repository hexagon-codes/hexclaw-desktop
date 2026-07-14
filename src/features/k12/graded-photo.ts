import { isTauri } from '@/utils/platform'
import { downloadInApp } from '@/utils/download'
import type { BBox } from '@/api/k12'

export interface GradedPhotoMark {
  correct: boolean
  /** 超出当前学段不是答错：不得把红叉写进导出的原图。 */
  outOfScope?: boolean
  bbox?: BBox | null
  correctAnswer?: string
}

const EDGE_EPS = 0.005

export function isValidGradingBBox(b?: BBox | null): b is BBox {
  if (!b) return false
  const vals = [b.x, b.y, b.w, b.h]
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return false
  if (b.w <= 0 || b.h <= 0) return false
  if (b.x < 0 || b.y < 0 || b.x > 1 || b.y > 1) return false
  return b.x + b.w <= 1 + EDGE_EPS && b.y + b.h <= 1 + EDGE_EPS
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('failed to load homework image'))
    image.src = src
  })
}

/**
 * 把批改标记真正绘入原图像素，生成可保存的 PNG。
 * 只绘制通过几何诚实门的 bbox；缺框题继续留在界面文字批改，不冒险错位落叉。
 */
export async function renderGradedPhotoDataUrl(imageSrc: string, marks: GradedPhotoMark[]): Promise<string> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  if (!canvas.width || !canvas.height) throw new Error('invalid homework image size')

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas is unavailable')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  const lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.004))
  for (const mark of marks) {
    if (mark.outOfScope || !isValidGradingBBox(mark.bbox)) continue
    const b = mark.bbox
    const x = b.x * canvas.width
    const y = b.y * canvas.height
    const w = b.w * canvas.width
    const h = b.h * canvas.height
    const color = mark.correct ? '#24a866' : '#e44848'

    ctx.save()
    ctx.lineWidth = lineWidth
    ctx.strokeStyle = color
    ctx.fillStyle = mark.correct ? 'rgba(36,168,102,0.10)' : 'rgba(228,72,72,0.10)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)

    const fontSize = Math.max(28, Math.min(72, Math.round(Math.max(h * 0.72, lineWidth * 7))))
    ctx.font = `800 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = color
    ctx.fillText(mark.correct ? '✓' : '✗', x + lineWidth * 1.5, y + lineWidth)

    if (!mark.correct && mark.correctAnswer?.trim()) {
      const answer = mark.correctAnswer.trim().replace(/\s+/g, ' ').slice(0, 48)
      const answerSize = Math.max(20, Math.min(42, Math.round(fontSize * 0.52)))
      ctx.font = `700 ${answerSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
      const answerY = Math.min(canvas.height - answerSize - lineWidth, y + h + lineWidth * 2)
      ctx.fillText(`订正：${answer}`, x, answerY, Math.max(w * 2.5, canvas.width - x - lineWidth))
    }
    ctx.restore()
  }
  return canvas.toDataURL('image/png')
}

function gradedPhotoFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `作业批改_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.png`
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('invalid graded image data')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  const mime = /^data:([^;,]+)/.exec(meta)?.[1] || 'application/octet-stream'
  const binary = meta.includes(';base64') ? atob(payload) : decodeURIComponent(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** 桌面端走原生保存对话框；浏览器/dev 走 download 链接，供真实 E2E 验证。 */
export async function saveGradedPhoto(imageSrc: string, marks: GradedPhotoMark[]): Promise<string | null> {
  const dataUrl = await renderGradedPhotoDataUrl(imageSrc, marks)
  const filename = gradedPhotoFilename()
  if (isTauri()) return await downloadInApp(dataUrl, filename)

  // 大图 data: URL 在 Chrome 中可能不触发 download，反而把当前 SPA 导航走。
  // Blob URL 是浏览器原生下载通道，Playwright/真实用户都能得到稳定文件事件。
  const objectUrl = URL.createObjectURL(dataUrlToBlob(dataUrl))
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  return filename
}
