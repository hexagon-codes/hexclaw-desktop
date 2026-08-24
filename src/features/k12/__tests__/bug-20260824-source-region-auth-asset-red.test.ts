import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import SourceIssueResolver from '../components/SourceIssueResolver.vue'

const { getAssetBlob } = vi.hoisted(() => ({
  getAssetBlob: vi.fn(),
}))

vi.mock('@/api/k12-asset-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/k12-asset-url')>()
  return {
    ...actual,
    k12GetAssetBlob: (...args: unknown[]) => getAssetBlob(...args),
  }
})

const wrappers: VueWrapper[] = []
const objectURL = 'blob:http://localhost/k12-source-region-photo'
let originalCreateObjectURL: typeof URL.createObjectURL | undefined
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined
let originalImage: typeof Image
let objectURLCount = 0

interface ImageDecodePlan {
  decode: () => Promise<void>
  width: number
  height: number
}

let imageDecodePlans: ImageDecodePlan[] = []

class ControlledImage {
  src = ''
  naturalWidth = 0
  naturalHeight = 0
  private readonly plan = imageDecodePlans.shift() ?? matchingImagePlan()

  async decode(): Promise<void> {
    await this.plan.decode()
    this.naturalWidth = this.plan.width
    this.naturalHeight = this.plan.height
  }
}

function matchingImagePlan(decode: () => Promise<void> = () => Promise.resolve()): ImageDecodePlan {
  return { decode, width: 430, height: 520 }
}

interface ResolverFixture {
  scope: 'problem' | 'group'
  displayLabel: string
  affectedLabels: string[]
  problemIds: string[]
  dependencyGroupId?: string
  skipLabel: string
}

const problemFixture: ResolverFixture = {
  scope: 'problem',
  displayLabel: '一. 1',
  affectedLabels: ['一. 1'],
  problemIds: ['problem-1'],
  skipLabel: '跳过这题',
}

const groupFixture: ResolverFixture = {
  scope: 'group',
  displayLabel: '第 3 题组',
  affectedLabels: ['三、1', '三、2'],
  problemIds: ['problem-3-1', 'problem-3-2'],
  dependencyGroupId: 'problem-group-3',
  skipLabel: '跳过第 3 题组',
}

async function renderResolver(
  fixture: ResolverFixture = problemFixture,
  options: { openRegion?: boolean } = {},
) {
  const wrapper = mount(SourceIssueResolver, {
    props: {
      agentId: 'mingming',
      scope: fixture.scope,
      displayLabel: fixture.displayLabel,
      affectedLabels: fixture.affectedLabels,
      problemIds: fixture.problemIds,
      dependencyGroupId: fixture.dependencyGroupId,
      structureVersion: 4,
      expectedInputRevision: 2,
      skipped: false,
      commandAvailable: true,
      skipLabel: fixture.skipLabel,
      pageAssetId: 'asset://mingming/photo.png',
      sourceWidth: 430,
      sourceHeight: 520,
      currentSourceRegion: { x: 18, y: 324, width: 394, height: 126 },
    } as never,
  })
  wrappers.push(wrapper)
  if (options.openRegion === false) return wrapper
  const opener = wrapper
    .findAll('button')
    .find((button) => button.text().replace(/\s+/g, ' ').trim() === '重新选择区域')
  expect(opener).toBeDefined()
  await opener!.trigger('click')
  await flushPromises()
  return wrapper
}

function buttonsByName(wrapper: VueWrapper, name: string) {
  return wrapper
    .findAll('button')
    .filter((candidate) => candidate.text().replace(/\s+/g, ' ').trim() === name)
}

function buttonByName(wrapper: VueWrapper, name: string) {
  const button = buttonsByName(wrapper, name)[0]
  expect(button).toBeDefined()
  return button!
}

function expectUnavailableRegionEditor(wrapper: VueWrapper): void {
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('[data-source-region-editor]').exists()).toBe(false)
  expect(wrapper.find('[data-source-region-selection]').exists()).toBe(false)
  expect(wrapper.findAll('[data-source-region-handle]')).toHaveLength(0)
  expect(buttonsByName(wrapper, '使用此区域重新读取')).toHaveLength(0)
  expect(buttonsByName(wrapper, '取消')).toHaveLength(1)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('BUG-20260824 · 题源区域原图认证读取', () => {
  beforeEach(() => {
    getAssetBlob.mockReset()
    originalCreateObjectURL = URL.createObjectURL
    originalRevokeObjectURL = URL.revokeObjectURL
    originalImage = globalThis.Image
    objectURLCount = 0
    imageDecodePlans = [matchingImagePlan()]
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        objectURLCount += 1
        return objectURLCount === 1 ? objectURL : `${objectURL}-${objectURLCount}`
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      value: ControlledImage,
    })
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    })
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      value: originalImage,
    })
  })

  it.each([problemFixture, groupFixture])(
    '$scope resolver 恢复标题、并行状态、原因、可访问名称和四个 ghost 动作',
    async (fixture) => {
      const wrapper = await renderResolver(fixture, { openRegion: false })
      const resolver = wrapper.get('[data-source-issue-resolver]')

      expect(resolver.element.tagName).toBe('SECTION')
      expect(resolver.attributes('aria-label')).toBe(`${fixture.displayLabel}来源处理`)

      const header = resolver.get('.source-resolver__head')
      expect(header.get('b').text().replace(/\s+/g, ' ').trim()).toBe(
        `${fixture.displayLabel} · 需要你确认`,
      )
      expect(header.get('span').text().replace(/\s+/g, ' ').trim()).toBe('其他题继续处理')

      const reason = resolver.get('[data-source-issue-reason]')
      expect(reason.element.tagName).toBe('P')
      expect(reason.text().trim().length).toBeGreaterThan(0)

      const actions = resolver.get('[data-source-actions]')
      const actionButtons = actions.findAll('button')
      expect(actionButtons.map((button) => button.text().replace(/\s+/g, ' ').trim())).toEqual([
        '纠正识别',
        '重新选择区域',
        '重新拍摄',
        fixture.skipLabel,
      ])
      expect(actionButtons).toHaveLength(4)
      for (const button of actionButtons) {
        expect(button.classes()).toEqual(expect.arrayContaining(['hc-btn', 'hc-btn-ghost']))
      }
    },
  )

  it('经认证客户端读取 PageAsset，并且只把 Blob object URL 交给 img', async () => {
    const blob = new Blob(['protected image'], { type: 'image/png' })
    getAssetBlob.mockResolvedValue(blob)

    const wrapper = await renderResolver()
    const panel = wrapper.get('[data-source-panel="region"]')
    const editor = panel.get('[data-source-region-editor]')
    const selection = editor.get('[data-source-region-selection]')
    const selectionElement = selection.element as HTMLElement

    expect(editor.attributes()).toMatchObject({
      'data-page-asset-id': 'asset://mingming/photo.png',
      'data-source-width': '430',
      'data-source-height': '520',
      'data-current-region': JSON.stringify({ x: 18, y: 324, width: 394, height: 126 }),
    })
    expect(editor.get('img').attributes()).toMatchObject({
      src: objectURL,
      alt: '当前作业原图',
      draggable: 'false',
    })
    expect(selection.attributes()).toMatchObject({
      role: 'group',
      tabindex: '0',
      'aria-label': '一. 1题源区域；方向键移动，Shift 加方向键调整大小',
      'data-source-region': JSON.stringify({ x: 18, y: 324, width: 394, height: 126 }),
    })
    expect(Number.parseFloat(selectionElement.style.left)).toBeCloseTo((18 / 430) * 100, 5)
    expect(Number.parseFloat(selectionElement.style.top)).toBeCloseTo((324 / 520) * 100, 5)
    expect(Number.parseFloat(selectionElement.style.width)).toBeCloseTo((394 / 430) * 100, 5)
    expect(Number.parseFloat(selectionElement.style.height)).toBeCloseTo((126 / 520) * 100, 5)
    expect(
      editor
        .findAll('[data-source-region-handle]')
        .map((handle) => [handle.attributes('data-handle'), handle.attributes('aria-hidden')]),
    ).toEqual([
      ['nw', 'true'],
      ['ne', 'true'],
      ['sw', 'true'],
      ['se', 'true'],
    ])

    const panelActions = panel.get('.source-resolver__actions').findAll('button')
    expect(panelActions.map((button) => button.text().replace(/\s+/g, ' ').trim())).toEqual([
      '取消',
      '使用此区域重新读取',
    ])
    expect(panelActions[0]?.classes()).toContain('hc-btn-ghost')
    expect(panelActions[1]?.classes()).toContain('hc-btn-primary')
    expect(getAssetBlob).toHaveBeenCalledWith(
      'mingming',
      'asset://mingming/photo.png',
      expect.any(AbortSignal),
    )
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob)
    expect(buttonByName(wrapper, '使用此区域重新读取').element.disabled).toBe(false)
  })

  it.each(['null', 'request-error', 'decode-failed', 'dimension-mismatch', 'zero-byte'] as const)(
    '%s 时图片相关 DOM 和区域提交 exact-set 为 0，只保留一个取消动作',
    async (failure) => {
      if (failure === 'request-error') {
        getAssetBlob.mockRejectedValue(new Error('authenticated asset read failed'))
      } else {
        imageDecodePlans = [
          failure === 'decode-failed'
            ? matchingImagePlan(() => Promise.reject(new Error('decode failed')))
            : failure === 'dimension-mismatch'
              ? { ...matchingImagePlan(), width: 431 }
              : matchingImagePlan(),
        ]
        getAssetBlob.mockResolvedValue(
          failure === 'null'
            ? null
            : failure === 'zero-byte'
              ? new Blob([], { type: 'image/png' })
              : new Blob(['protected image'], { type: 'image/png' }),
        )
      }

      const wrapper = await renderResolver()

      expectUnavailableRegionEditor(wrapper)
      expect(getAssetBlob).toHaveBeenCalledWith(
        'mingming',
        'asset://mingming/photo.png',
        expect.any(AbortSignal),
      )
    },
  )

  it('图片仍在解码时不渲染选区也不允许提交，解码完成后才发布当前身份', async () => {
    const pendingDecode = deferred<void>()
    imageDecodePlans = [matchingImagePlan(() => pendingDecode.promise)]
    getAssetBlob.mockResolvedValue(new Blob(['protected image'], { type: 'image/png' }))

    const wrapper = await renderResolver()

    expectUnavailableRegionEditor(wrapper)

    pendingDecode.resolve(undefined)
    await flushPromises()

    expect(wrapper.get('img').attributes('src')).toBe(objectURL)
    expect(wrapper.find('[data-source-region-selection]').exists()).toBe(true)
    expect(buttonByName(wrapper, '使用此区域重新读取').element.disabled).toBe(false)
  })

  it('切换题源动作后立即撤销当前 object URL', async () => {
    getAssetBlob.mockResolvedValue(new Blob(['protected image'], { type: 'image/png' }))
    const wrapper = await renderResolver()

    await buttonByName(wrapper, '纠正识别').trigger('click')

    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectURL)
    expect(wrapper.find('[data-source-region-editor]').exists()).toBe(false)
  })

  it('解码未完成时卸载会中止读取并撤销临时 object URL', async () => {
    const pendingDecode = deferred<void>()
    imageDecodePlans = [matchingImagePlan(() => pendingDecode.promise)]
    getAssetBlob.mockResolvedValue(new Blob(['protected image'], { type: 'image/png' }))
    const wrapper = await renderResolver()
    const signal = getAssetBlob.mock.calls[0]?.[2] as AbortSignal

    wrapper.unmount()

    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectURL)
  })

  it('旧身份解码完成不能回填，新身份完成解码前仍不可提交', async () => {
    const firstDecode = deferred<void>()
    const secondDecode = deferred<void>()
    imageDecodePlans = [
      matchingImagePlan(() => firstDecode.promise),
      matchingImagePlan(() => secondDecode.promise),
    ]
    getAssetBlob.mockResolvedValue(new Blob(['protected image'], { type: 'image/png' }))
    const wrapper = await renderResolver()
    const firstSignal = getAssetBlob.mock.calls[0]?.[2] as AbortSignal

    await wrapper.setProps({ pageAssetId: 'asset://mingming/photo-next.png' })
    await flushPromises()

    expect(firstSignal.aborted).toBe(true)
    expect(getAssetBlob).toHaveBeenNthCalledWith(
      2,
      'mingming',
      'asset://mingming/photo-next.png',
      expect.any(AbortSignal),
    )
    firstDecode.resolve(undefined)
    await flushPromises()
    expectUnavailableRegionEditor(wrapper)

    const secondSignal = getAssetBlob.mock.calls[1]?.[2] as AbortSignal
    expect(secondSignal.aborted).toBe(false)
    secondDecode.resolve(undefined)
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe(`${objectURL}-2`)
    expect(buttonByName(wrapper, '使用此区域重新读取').element.disabled).toBe(false)
  })
})
