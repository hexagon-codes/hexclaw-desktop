import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractBriefFinalAnswer, renderGradedPhotoDataUrl, saveGradedPhoto } from '../graded-photo'

const NativeImage = globalThis.Image
const nativeCreateElement = document.createElement.bind(document)

function installCanvas() {
  const ctx = {
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/png;base64,R1JBREVE'),
  }
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? canvas : nativeCreateElement(tag)) as typeof document.createElement)

  class LoadedImage {
    naturalWidth = 1000
    naturalHeight = 2000
    width = 1000
    height = 2000
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    writable: true,
    value: LoadedImage,
  })
  return { ctx, canvas }
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    writable: true,
    value: NativeImage,
  })
})

describe('批改图片像素级导出', () => {
  it('从 Markdown 解题过程中只提取答案章节的简短最终答案', () => {
    expect(extractBriefFinalAnswer('## 解答\n先算 4÷2=2。\n\n## 答案\n**8**')).toBe('8')
    expect(extractBriefFinalAnswer('计算过程略\n\n答案：225千克')).toBe('225千克')
  })

  it('没有明确最终答案时不把整段解题 Markdown 当成订正文案', () => {
    expect(
      extractBriefFinalAnswer(
        '## 解答\n第一步先列式。\n\n第二步计算后再检查，这里是一段完整的过程说明。',
      ),
    ).toBe('')
  })

  it('把合法 bbox 的对错标记绘进原图 PNG，非法框不落笔', async () => {
    const { ctx, canvas } = installCanvas()
    const result = await renderGradedPhotoDataUrl('data:image/jpeg;base64,ORIGINAL', [
      { status: 'correct', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
      { status: 'wrong', bbox: { x: 0.9, y: 0.2, w: 0.2, h: 0.05 }, correctAnswer: '0.1' },
      // 超纲不是答错；即便坐标合法，也绝不能把红叉烧进原图像素。
      { status: 'out_of_scope', bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.05 } },
    ])

    expect(result).toBe('data:image/png;base64,R1JBREVE')
    expect(canvas.width).toBe(1000)
    expect(canvas.height).toBe(2000)
    expect(ctx.drawImage).toHaveBeenCalledOnce()
    expect(ctx.fillRect).not.toHaveBeenCalled()
    expect(ctx.strokeRect).not.toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
    expect(ctx.beginPath).toHaveBeenCalledTimes(4) // white underlay + green stroke, two ✓ segments
    expect(ctx.stroke).toHaveBeenCalledTimes(4)
    expect(ctx.moveTo).toHaveBeenCalledWith(expect.any(Number), expect.any(Number))
  })

  it('过程问题从同一 item.status 绘制紫色 ⚠，不落红叉', async () => {
    const { ctx } = installCanvas()
    await renderGradedPhotoDataUrl('data:image/jpeg;base64,ORIGINAL', [
      {
        status: 'correct_with_process_issue',
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
      },
    ])

    expect(ctx.fillText).toHaveBeenCalledWith('⚠', expect.any(Number), expect.any(Number))
    expect(ctx.fillStyle).toBe('#A56BD6')
    expect(ctx.moveTo).not.toHaveBeenCalled()
  })

  it('浏览器环境生成带日期文件名并触发真实下载动作', async () => {
    installCanvas()
    let clickedHref = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedHref = this.href
    })
    const originalCreateObjectURL = URL.createObjectURL
    const createObjectURL = vi.fn(() => 'blob:http://localhost/graded-photo')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    })
    const path = await saveGradedPhoto('data:image/jpeg;base64,ORIGINAL', [
      { status: 'correct', bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
    ])
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    })
    expect(path).toMatch(/^作业批改_\d{4}-\d{2}-\d{2}_\d{4}\.png$/)
    expect(click).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(clickedHref).toBe('blob:http://localhost/graded-photo')
  })

  it('像素绘制前再清洗订正文案，长解题过程不会烧进图片', async () => {
    const { ctx } = installCanvas()
    await renderGradedPhotoDataUrl('data:image/jpeg;base64,ORIGINAL', [
      {
        status: 'wrong',
        bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
        correctAnswer: '## 解答\n第一步先列式。\n\n第二步计算后再检查，这里是一段完整的过程说明。',
      },
    ])

    expect(ctx.stroke).toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
  })
})
