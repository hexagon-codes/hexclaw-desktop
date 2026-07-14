import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderGradedPhotoDataUrl, saveGradedPhoto } from '../graded-photo'

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
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textBaseline: '',
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/png;base64,R1JBREVE'),
  }
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (
    tag === 'canvas' ? canvas : nativeCreateElement(tag)
  )) as typeof document.createElement)

  class LoadedImage {
    naturalWidth = 1000
    naturalHeight = 2000
    width = 1000
    height = 2000
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: LoadedImage })
  return { ctx, canvas }
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: NativeImage })
})

describe('批改图片像素级导出', () => {
  it('把合法 bbox 的对错标记绘进原图 PNG，非法框不落笔', async () => {
    const { ctx, canvas } = installCanvas()
    const result = await renderGradedPhotoDataUrl('data:image/jpeg;base64,ORIGINAL', [
      { correct: true, bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
      { correct: false, bbox: { x: 0.9, y: 0.2, w: 0.2, h: 0.05 }, correctAnswer: '0.1' },
      // 超纲不是答错；即便坐标合法，也绝不能把红叉烧进原图像素。
      { correct: false, outOfScope: true, bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.05 } },
    ])

    expect(result).toBe('data:image/png;base64,R1JBREVE')
    expect(canvas.width).toBe(1000)
    expect(canvas.height).toBe(2000)
    expect(ctx.drawImage).toHaveBeenCalledOnce()
    expect(ctx.fillRect).toHaveBeenCalledOnce()
    expect(ctx.strokeRect).toHaveBeenCalledWith(100, 400, 200, 100)
    expect(ctx.fillText).toHaveBeenCalledWith('✓', expect.any(Number), expect.any(Number))
  })

  it('浏览器环境生成带日期文件名并触发真实下载动作', async () => {
    installCanvas()
    let clickedHref = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.href
    })
    const originalCreateObjectURL = URL.createObjectURL
    const createObjectURL = vi.fn(() => 'blob:http://localhost/graded-photo')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    const path = await saveGradedPhoto('data:image/jpeg;base64,ORIGINAL', [
      { correct: true, bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.05 } },
    ])
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: originalCreateObjectURL })
    expect(path).toMatch(/^作业批改_\d{4}-\d{2}-\d{2}_\d{4}\.png$/)
    expect(click).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(clickedHref).toBe('blob:http://localhost/graded-photo')
  })
})
