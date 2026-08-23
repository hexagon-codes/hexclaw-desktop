import { isTauri } from '@/utils/platform'
import { saveBlobInApp } from '@/utils/download'
import type { BBox, PhotoJobItemStatus } from '@/api/k12'
import { PHOTO_PROCESS_ISSUE_COLOR, projectPhotoAssessmentStatus } from './photo-assessment-status'

export interface GradedPhotoMark {
  /** 必须直接来自图片结果 item.status；不得由 verdict/badge/布尔值重推。 */
  status: PhotoJobItemStatus
  bbox?: BBox | null
  correctAnswer?: string
}

const EDGE_EPS = 0.005
const MAX_OVERLAY_ANSWER_LENGTH = 40

function cleanAnswerMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\boxed\{([^{}]+)\}/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/(?:\*\*|__|~~|`)/g, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function acceptBriefAnswer(value: string): string {
  const answer = cleanAnswerMarkdown(value)
    .replace(/^[\s:：\-—]+/, '')
    .replace(/[。；;]+$/, '')
    .trim()
  return answer && Array.from(answer).length <= MAX_OVERLAY_ANSWER_LENGTH ? answer : ''
}

/**
 * 从后端返回的 solution Markdown 中提取适合写在原图上的短答案。
 *
 * 批改图只承载“订正结果”，不能把完整推导过程烧进学生原图；找不到明确
 * 「答案」标签时，仅兼容历史接口返回的单行短答案。
 */
export function extractBriefFinalAnswer(solution?: string | null): string {
  const source = solution?.replace(/\r\n?/g, '\n').trim() ?? ''
  if (!source) return ''

  const lines = source.split('\n')

  // Markdown 的「答案」章节：只取该章节第一行非空正文。
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i]!.match(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/)
    if (!heading) continue
    const title = cleanAnswerMarkdown(heading[1]!)
    const inline = title.match(/^(?:最终)?答案\s*[:：]\s*(.+)$/)
    if (inline) return acceptBriefAnswer(inline[1]!)
    if (!/^(?:最终)?答案$/.test(title)) continue
    for (let j = i + 1; j < lines.length && !/^\s{0,3}#{1,6}\s+/.test(lines[j]!); j += 1) {
      if (!lines[j]!.trim()) continue
      return acceptBriefAnswer(lines[j]!)
    }
    return ''
  }

  // 行内显式答案，兼容「答案：」「最终答案是」「答：」等常见模型输出。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = cleanAnswerMarkdown(lines[i]!)
    const explicit =
      line.match(/^(?:最终)?答案\s*(?:[:：]|为|是)\s*(.+)$/) ?? line.match(/^答\s*[:：]\s*(.+)$/)
    if (explicit) return acceptBriefAnswer(explicit[1]!)
  }

  const boxed = source.match(/\\boxed\{([^{}]+)\}/)
  if (boxed) return acceptBriefAnswer(boxed[1]!)

  // 旧接口会直接返回「11.4」或「解：x=14」；只放行单行短值，Markdown
  // 章节、多段推导和长句一律留在界面文字区，不写入图片。
  const nonEmpty = lines.filter((line) => line.trim())
  if (nonEmpty.length !== 1 || /^\s{0,3}#/.test(nonEmpty[0]!)) return ''
  const legacy = cleanAnswerMarkdown(nonEmpty[0]!).replace(/^解\s*[:：]\s*/, '')
  return acceptBriefAnswer(legacy)
}

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
export async function renderGradedPhotoBlob(
  imageSrc: string,
  marks: GradedPhotoMark[],
): Promise<Blob> {
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
    const projection = projectPhotoAssessmentStatus(mark.status)
    if (!projection.overlayVisible || !isValidGradingBBox(mark.bbox)) continue
    const b = mark.bbox
    const x = b.x * canvas.width
    const y = b.y * canvas.height
    const w = b.w * canvas.width
    const h = b.h * canvas.height
    const strokeColor =
      projection.tone === 'correct'
        ? '#24a866'
        : projection.tone === 'wrong'
          ? '#e44848'
          : projection.tone === 'process'
            ? PHOTO_PROCESS_ISSUE_COLOR
            : '#d3912d'
    const radius = Math.min(
      42,
      Math.max(18, Math.round(Math.min(canvas.width, canvas.height) / 45)),
    )
    const cx = Math.min(canvas.width - radius - 1, Math.max(radius + 1, x + w))
    const cy = Math.min(canvas.height - radius - 1, Math.max(radius + 1, y + h * 0.4))

    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (projection.tone !== 'correct' && projection.tone !== 'wrong') {
      ctx.font = `900 ${Math.round(radius * 1.8)}px ui-rounded, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = lineWidth + 4
      ctx.strokeText(projection.symbol, cx, cy)
      ctx.fillStyle = strokeColor
      ctx.fillText(projection.symbol, cx, cy)
      ctx.restore()
      continue
    }
    const drawSegment = (x0: number, y0: number, x1: number, y1: number) => {
      for (const [color, width] of [
        ['#ffffff', lineWidth + 4],
        [strokeColor, lineWidth],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.strokeStyle = color
        ctx.lineWidth = width
        ctx.stroke()
      }
    }
    if (projection.tone === 'correct') {
      drawSegment(cx - radius * 0.75, cy, cx - radius * 0.25, cy + radius * 0.5)
      drawSegment(cx - radius * 0.25, cy + radius * 0.5, cx + radius, cy - radius * 0.67)
    } else {
      drawSegment(cx - radius * 0.67, cy - radius * 0.67, cx + radius * 0.67, cy + radius * 0.67)
      drawSegment(cx + radius * 0.67, cy - radius * 0.67, cx - radius * 0.67, cy + radius * 0.67)
    }
    ctx.restore()
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('failed to encode graded image'))
    }, 'image/png')
  })
}

function gradedPhotoFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `作业批改_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.png`
}

/** 桌面端走原生保存对话框；浏览器/dev 走 download 链接，供真实 E2E 验证。 */
export async function saveGradedPhoto(
  imageSrc: string,
  marks: GradedPhotoMark[],
): Promise<string | null> {
  const blob = await renderGradedPhotoBlob(imageSrc, marks)
  const filename = gradedPhotoFilename()
  if (isTauri()) return await saveBlobInApp(blob, filename)

  // 大图 data: URL 在 Chrome 中可能不触发 download，反而把当前 SPA 导航走。
  // Blob URL 是浏览器原生下载通道，Playwright/真实用户都能得到稳定文件事件。
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  return filename
}
