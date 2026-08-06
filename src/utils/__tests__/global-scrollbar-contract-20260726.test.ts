import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installScrollReveal } from '../scroll-reveal'

function defineScroller(
  height: number,
  scrollHeight: number,
  top = 0,
): HTMLDivElement {
  const element = document.createElement('div')
  element.style.overflowY = 'auto'
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, value: 0, writable: true },
  })
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      right: 400,
      bottom: top + height,
      left: 0,
      width: 400,
      height,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(element)
  return element
}

function allFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...allFiles(path))
      continue
    }
    if (/\.(?:css|vue)$/.test(entry.name)) files.push(path)
  }
  return files
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('single global fixed scrollbar controller 2026-07-26', () => {
  it('全应用只安装一个视觉层，长短内容容器的 thumb 均固定 168px', () => {
    const disposeFirst = installScrollReveal(document)
    const disposeSecond = installScrollReveal(document)
    const first = defineScroller(400, 2_000)
    const second = defineScroller(400, 20_000, 410)

    first.dispatchEvent(new Event('scroll'))
    const layer = document.querySelector('.hc-global-scrollbar-layer')
    expect(layer).not.toBeNull()
    expect(document.querySelectorAll('.hc-global-scrollbar-layer')).toHaveLength(1)
    const thumb = layer!.querySelector<HTMLElement>(
      '.hc-global-scrollbar--vertical .hc-global-scrollbar__thumb',
    )
    expect(thumb?.style.height).toBe('168px')

    second.dispatchEvent(new Event('scroll'))
    expect(thumb?.style.height).toBe('168px')

    disposeSecond()
    disposeFirst()
  })

  it('容器可用轨道不足 168px 时才缩短 thumb', () => {
    const dispose = installScrollReveal(document)
    const shortTrack = defineScroller(96, 1_000)

    shortTrack.dispatchEvent(new Event('scroll'))

    const thumb = document.querySelector<HTMLElement>(
      '.hc-global-scrollbar--vertical .hc-global-scrollbar__thumb',
    )
    expect(thumb?.style.height).toBe('96px')
    dispose()
  })

  it('thumb 位置按真实 scroll progress 映射，而不是按内容比例改变长度', () => {
    const dispose = installScrollReveal(document)
    const scroller = defineScroller(400, 2_000)

    scroller.scrollTop = 800
    scroller.dispatchEvent(new Event('scroll'))

    const thumb = document.querySelector<HTMLElement>(
      '.hc-global-scrollbar--vertical .hc-global-scrollbar__thumb',
    )
    expect(thumb?.style.height).toBe('168px')
    expect(thumb?.style.transform).toBe('translateY(116px)')

    scroller.scrollTop = 1_600
    scroller.dispatchEvent(new Event('scroll'))
    expect(thumb?.style.height).toBe('168px')
    expect(thumb?.style.transform).toBe('translateY(232px)')
    dispose()
  })

  it('滚动条样式与控制器只能存在于全局实现，组件不得局部覆写', () => {
    const srcRoot = resolve(process.cwd(), 'src')
    const globalCss = resolve(srcRoot, 'assets/styles/global.css')
    const localOverrides = allFiles(srcRoot)
      .filter((file) => file !== globalCss)
      .filter((file) => /::-webkit-scrollbar/.test(readFileSync(file, 'utf8')))

    const globalSource = readFileSync(globalCss, 'utf8')
    const controllerSource = readFileSync(
      resolve(srcRoot, 'utils/scroll-reveal.ts'),
      'utf8',
    )

    expect(localOverrides).toEqual([])
    expect(globalSource).toContain('.hc-global-scrollbar-layer')
    expect(globalSource).toMatch(
      /\.hc-global-scrollbar--vertical[\s\S]*height:\s*168px/,
    )
    expect(controllerSource).toContain('FIXED_THUMB_PX = 168')
    expect(controllerSource).not.toContain('scrollHeight /')
  })

  it('DD-043：全局滚动条禁止标准 scrollbar-width / scrollbar-color 属性，保留 ::-webkit-scrollbar 透明规则', () => {
    const srcRoot = resolve(process.cwd(), 'src')
    const globalCss = resolve(srcRoot, 'assets/styles/global.css')
    const globalSource = readFileSync(globalCss, 'utf8')

    const standardProps =
      /scrollbar-width\s*:|scrollbar-color\s*:/g
    expect(globalSource.match(standardProps) ?? []).toEqual([])
    expect(globalSource).toMatch(
      /::-webkit-scrollbar-thumb:window-inactive[\s\S]*background\s*:\s*transparent/,
    )
    expect(globalSource).toMatch(
      /::-webkit-scrollbar-thumb[\s\S]*background\s*:\s*transparent/,
    )
  })
})
