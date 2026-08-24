import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

import SourceIssueResolver from '../components/SourceIssueResolver.vue'
import sourceIssueResolverSource from '../components/SourceIssueResolver.vue?raw'

const { getAssetBlob } = vi.hoisted(() => ({ getAssetBlob: vi.fn() }))

vi.mock('@/api/k12-asset-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/k12-asset-url')>()
  return {
    ...actual,
    k12GetAssetBlob: (...args: unknown[]) => getAssetBlob(...args),
  }
})

const CURRENT_REGION = { x: 40, y: 30, width: 200, height: 120 }
const wrappers: VueWrapper[] = []
const sourceObjectURL = 'blob:http://localhost/source-issue-page-current'
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalImage = globalThis.Image

class SourceIssueImage {
  src = ''
  naturalWidth = 400
  naturalHeight = 300

  async decode(): Promise<void> {}
}

function renderResolver() {
  const wrapper = mount(SourceIssueResolver, {
    attachTo: document.body,
    props: {
      scope: 'group',
      displayLabel: '第 3 题组',
      affectedLabels: ['三、1', '三、2'],
      problemIds: ['problem-3-1', 'problem-3-2'],
      dependencyGroupId: 'group-3',
      structureVersion: 4,
      expectedInputRevision: 2,
      skipped: false,
      commandAvailable: true,
      disabled: false,
      skipLabel: '跳过第 3 题组',
      agentId: 'mingming',
      pageAssetId: 'asset://mingming/page-current.png',
      sourceWidth: 400,
      sourceHeight: 300,
      currentSourceRegion: CURRENT_REGION,
    } as never,
  })
  wrappers.push(wrapper)
  return wrapper
}

function buttonByName(wrapper: VueWrapper, name: string) {
  const button = wrapper
    .findAll('button')
    .find(
      (candidate) =>
        candidate.text().replace(/\s+/g, ' ').trim() === name &&
        !candidate.element.closest('[hidden]') &&
        !candidate.element.closest('[style*="display: none"]'),
    )
  expect(button, `missing button: ${name}`).toBeDefined()
  return button!
}

function panelOpen(wrapper: VueWrapper, name: 'region' | 'retake') {
  const panel = wrapper.find(`[data-source-panel="${name}"]`)
  if (!panel.exists()) return false
  if (panel.attributes('hidden') !== undefined) return false
  return !/display:\s*none/.test(panel.attributes('style') ?? '')
}

function draftRegion(wrapper: VueWrapper) {
  const encoded = wrapper.get('[data-source-region-selection]').attributes('data-source-region')
  expect(encoded).toBeTruthy()
  return JSON.parse(encoded!) as typeof CURRENT_REGION
}

beforeEach(() => {
  getAssetBlob.mockReset()
  getAssetBlob.mockResolvedValue(new Blob(['source image'], { type: 'image/png' }))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => sourceObjectURL),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: SourceIssueImage,
  })
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  document.body.innerHTML = ''
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

describe('BUG-20260803-022 · SourceIssueResolver approved source input journeys', () => {
  it('PROG-026D keeps current source facts immutable while keyboard edits a bounded draft and confirms source pixels', async () => {
    const wrapper = renderResolver()
    const opener = buttonByName(wrapper, '重新选择区域')

    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()

    const panel = wrapper.get('[data-source-panel="region"]')
    expect(panel.text()).toContain('将仅重新读取第 3 题组，原图不会被修改。')
    expect(panel.find('[role="dialog"]').exists()).toBe(false)
    expect(panel.get('img').attributes()).toMatchObject({
      src: sourceObjectURL,
      alt: '当前作业原图',
    })
    const editor = panel.get('[data-source-region-editor]')
    expect(editor.attributes('data-page-asset-id')).toBe('asset://mingming/page-current.png')
    expect(editor.attributes('data-source-width')).toBe('400')
    expect(editor.attributes('data-source-height')).toBe('300')
    expect(JSON.parse(editor.attributes('data-current-region')!)).toEqual(CURRENT_REGION)
    expect(panel.findAll('[data-source-region-handle]')).toHaveLength(4)

    const selection = panel.get('[data-source-region-selection]')
    expect(document.activeElement).toBe(selection.element)
    expect(draftRegion(wrapper)).toEqual(CURRENT_REGION)

    await selection.trigger('keydown', { key: 'ArrowRight' })
    await selection.trigger('keydown', { key: 'ArrowDown', shiftKey: true })

    const draft = { x: 41, y: 30, width: 200, height: 121 }
    expect(draftRegion(wrapper)).toEqual(draft)
    expect(JSON.parse(editor.attributes('data-current-region')!)).toEqual(CURRENT_REGION)

    await buttonByName(wrapper, '使用此区域重新读取').trigger('click')

    expect(wrapper.emitted('intent')).toEqual([
      [
        {
          action: 'reselect_region',
          problem_ids: ['problem-3-1', 'problem-3-2'],
          dependency_group_id: 'group-3',
          structure_version: 4,
          expected_input_revision: 2,
          payload: {
            page_asset_id: 'asset://mingming/page-current.png',
            region: draft,
          },
        },
      ],
    ])
    // A local click is not a commit: current facts and the open draft remain until
    // the parent applies a validated server snapshot or reports a failure.
    expect(JSON.parse(editor.attributes('data-current-region')!)).toEqual(CURRENT_REGION)
    expect(draftRegion(wrapper)).toEqual(draft)
  })

  it('PROG-026D discards a region draft on cancel, Escape, and action switch with zero command and restores focus', async () => {
    const wrapper = renderResolver()
    const opener = buttonByName(wrapper, '重新选择区域')

    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()
    await wrapper.get('[data-source-region-selection]').trigger('keydown', { key: 'ArrowRight' })
    expect(draftRegion(wrapper).x).toBe(41)
    await buttonByName(wrapper, '取消').trigger('click')

    expect(panelOpen(wrapper, 'region')).toBe(false)
    expect(wrapper.emitted('intent')).toBeUndefined()
    expect(document.activeElement).toBe(opener.element)

    await opener.trigger('click')
    await flushPromises()
    expect(draftRegion(wrapper)).toEqual(CURRENT_REGION)
    await wrapper.get('[data-source-region-selection]').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('[data-source-region-selection]').trigger('keydown', { key: 'Escape' })

    expect(panelOpen(wrapper, 'region')).toBe(false)
    expect(wrapper.emitted('intent')).toBeUndefined()
    expect(document.activeElement).toBe(opener.element)

    await opener.trigger('click')
    await flushPromises()
    await wrapper.get('[data-source-region-selection]').trigger('keydown', { key: 'ArrowLeft' })
    await buttonByName(wrapper, '重新拍摄').trigger('click')

    expect(panelOpen(wrapper, 'region')).toBe(false)
    expect(panelOpen(wrapper, 'retake')).toBe(true)
    expect(wrapper.emitted('intent')).toBeUndefined()

    await opener.trigger('click')
    await flushPromises()
    expect(draftRegion(wrapper)).toEqual(CURRENT_REGION)
  })

  it('PROG-026D retains the open draft and synchronously locks the whole resolver while pending', async () => {
    const wrapper = renderResolver()
    await buttonByName(wrapper, '重新选择区域').trigger('click')
    await flushPromises()
    await wrapper.get('[data-source-region-selection]').trigger('keydown', { key: 'ArrowRight' })

    await wrapper.setProps({ disabled: true })

    expect(wrapper.get('[data-source-issue-resolver]').attributes('aria-busy')).toBe('true')
    expect(panelOpen(wrapper, 'region')).toBe(true)
    expect(draftRegion(wrapper).x).toBe(41)
    const controls = wrapper.findAll<HTMLButtonElement | HTMLInputElement>('button, input')
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.every((control) => control.element.disabled)).toBe(true)
  })

  it('PROG-026E uses one hidden image-only system picker; cancel is inert and selection emits one upload intent without app preview', async () => {
    const wrapper = renderResolver()
    await buttonByName(wrapper, '重新拍摄').trigger('click')
    await nextTick()

    const panel = wrapper.get('[data-source-panel="retake"]')
    expect(panel.get('p').element.textContent?.trim()).toBe(
      '使用新照片重新处理第 3 题组？新照片会保存为新的识别版本，原照片仍保留用于核对。',
    )
    expect(panel.text()).toContain('使用新照片重新处理第 3 题组？')
    expect(panel.text()).toContain('新照片会保存为新的识别版本，原照片仍保留用于核对。')
    expect(panel.find('img').exists(), 'retake must not add an app-side preview').toBe(false)
    expect(panel.find('[role="dialog"]').exists()).toBe(false)

    const picker = panel.get<HTMLInputElement>('input[type="file"]')
    expect(picker.attributes('accept')).toBe('image/*')
    expect(picker.attributes('capture'), 'retake must not request a camera').toBeUndefined()
    expect(picker.attributes('hidden')).toBeDefined()

    let nativePickerClicks = 0
    picker.element.addEventListener('click', () => nativePickerClicks++)
    await buttonByName(wrapper, '使用新照片').trigger('click')
    expect(nativePickerClicks).toBe(1)

    Object.defineProperty(picker.element, 'files', { configurable: true, value: [] })
    await picker.trigger('change')
    expect(wrapper.emitted('retakeFile')).toBeUndefined()
    expect(wrapper.emitted('intent')).toBeUndefined()

    const file = new File(['new-page'], 'new-page.png', { type: 'image/png' })
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] })
    await picker.trigger('change')

    expect(wrapper.emitted('retakeFile')).toEqual([
      [
        {
          action: 'retake',
          file,
          problem_ids: ['problem-3-1', 'problem-3-2'],
          dependency_group_id: 'group-3',
          structure_version: 4,
          expected_input_revision: 2,
        },
      ],
    ])
    expect(wrapper.emitted('intent')).toBeUndefined()
  })

  it('PROG-026D/E owns the frozen prototype card box instead of inheriting a progress-slot column', () => {
    const cardRule = sourceIssueResolverSource.match(/\.source-resolver\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(cardRule).toContain('display: block;')
    expect(cardRule).toContain('margin-top: 10px;')
    expect(cardRule).toContain('padding: 12px;')
    expect(cardRule).toContain('border: 0.5px solid var(--hc-border);')
    expect(cardRule).toContain('border-radius: 11px;')
    expect(cardRule).toContain('line-height: 1.6;')
  })
})
