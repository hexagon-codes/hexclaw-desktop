import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'
import type { PracticeSetDTO } from '@/api/k12'

const h = vi.hoisted(() => ({
  listPracticeSets: vi.fn(),
  getAssetBlob: vi.fn(),
}))

vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12ListPracticeSets: (...args: unknown[]) => h.listPracticeSets(...args),
}))

vi.mock('@/api/k12-asset-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12-asset-url')>()),
  k12GetAssetBlob: (...args: unknown[]) => h.getAssetBlob(...args),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function completedPracticeSet(): PracticeSetDTO {
  return {
    record_id: 'practice-asset-auth',
    title: '小数乘法专项',
    source_kind: 'mixed',
    status: 'graded',
    status_label: '已批改',
    publishable: true,
    delivery_status: 'delivered',
    paper_no: 'P-2629-01',
    finalized_at: 1784300000,
    finalized_via: 'print',
    items: [
      {
        item_id: 'q1',
        question_markdown: '2.8×0.65=?',
        subject: '数学',
        added_via: 'weekly',
        verification_status: 'verified',
        verification_evidence: '独立验算',
        returned: true,
        return_ids: ['return-auth'],
        result_correct: false,
        result_evidence: 'system_verified',
      },
    ],
    return_assets: [
      {
        return_id: 'return-auth',
        asset_id: 'asset://k12-xiaoming/answer.png',
        item_ids: ['q1'],
        returned_at: 1784300100,
        regrade_job_id: 'grade-job-auth',
        regrade_status: 'completed',
        annotated_asset_id: 'asset://k12-xiaoming/annotated.png',
        result_markdown: '## 第 1 题\n\n**错因：** 小数点位置放错。',
      },
    ],
  }
}

function completedPracticeSetWithAssets(
  recordID: string,
  sourceAssetID: string,
  annotatedAssetID: string,
): PracticeSetDTO {
  const base = completedPracticeSet()
  return {
    ...base,
    record_id: recordID,
    return_assets: [
      {
        ...base.return_assets![0]!,
        return_id: `${recordID}-return`,
        asset_id: sourceAssetID,
        annotated_asset_id: annotatedAssetID,
      },
    ],
  }
}

function render() {
  return shallowMount(K12PracticeSetsPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: { plugins: [i18n()] },
  })
}

afterEach(() => {
  h.listPracticeSets.mockReset()
  h.getAssetBlob.mockReset()
  vi.restoreAllMocks()
})

describe('BUG-20260824 · 练习集受保护图片认证读取', () => {
  it('回传缩略图与复批标注图只使用认证 Blob/ObjectURL，读取失败不保留空图片操作', async () => {
    const answerBlob = new Blob(['answer'], { type: 'image/png' })
    const annotatedBlob = new Blob(['annotated'], { type: 'image/png' })
    const objectURLs = new Map<Blob, string>([
      [answerBlob, 'blob:practice-answer'],
      [annotatedBlob, 'blob:practice-annotated'],
    ])
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(
        (source) =>
          (source instanceof Blob ? objectURLs.get(source) : undefined) ?? 'blob:unexpected',
      )
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    h.listPracticeSets.mockResolvedValue({ items: [completedPracticeSet()] })
    h.getAssetBlob.mockImplementation((_agent: string, assetID: string) =>
      Promise.resolve(
        assetID.endsWith('/answer.png')
          ? answerBlob
          : assetID.endsWith('/annotated.png')
            ? annotatedBlob
            : null,
      ),
    )

    const loaded = render()
    await flushPromises()
    await loaded.get('[data-testid="ps-regrade-result-open"]').trigger('click')
    await flushPromises()

    expect
      .soft(
        h.getAssetBlob.mock.calls.some(
          ([agent, assetID]) =>
            agent === 'k12-xiaoming' && assetID === 'asset://k12-xiaoming/answer.png',
        ),
      )
      .toBe(true)
    expect
      .soft(
        h.getAssetBlob.mock.calls.some(
          ([agent, assetID]) =>
            agent === 'k12-xiaoming' && assetID === 'asset://k12-xiaoming/annotated.png',
        ),
      )
      .toBe(true)
    expect.soft(loaded.get('.k12ps__return-thumb').attributes('src')).toBe('blob:practice-answer')
    expect
      .soft(loaded.get('[data-testid="ps-regrade-annotated"]').attributes('src'))
      .toBe('blob:practice-annotated')
    expect
      .soft(
        loaded
          .findAll('img')
          .map((image) => image.attributes('src') ?? '')
          .some((src) => src.includes('/api/k12/assets/')),
      )
      .toBe(false)
    loaded.unmount()
    expect.soft(revokeObjectURL).toHaveBeenCalledWith('blob:practice-answer')
    expect.soft(revokeObjectURL).toHaveBeenCalledWith('blob:practice-annotated')

    const objectURLCountBeforeFailure = createObjectURL.mock.calls.length
    h.getAssetBlob
      .mockReset()
      .mockImplementation((_agent: string, assetID: string) =>
        Promise.resolve(
          assetID.endsWith('/answer.png') ? null : new Blob([], { type: 'image/png' }),
        ),
      )
    const unavailable = render()
    await flushPromises()
    await unavailable.get('[data-testid="ps-regrade-result-open"]').trigger('click')
    await flushPromises()

    expect.soft(unavailable.find('.k12ps__return-thumb').exists()).toBe(false)
    expect.soft(unavailable.find('[data-testid="ps-regrade-annotated"]').exists()).toBe(false)
    expect.soft(unavailable.find('[data-testid="ps-regrade-result-modal"]').exists()).toBe(true)
    expect.soft(unavailable.find('[data-testid="ps-regrade-markdown"]').exists()).toBe(true)
    expect.soft(createObjectURL).toHaveBeenCalledTimes(objectURLCountBeforeFailure)
    unavailable.unmount()
  })

  it('身份变化与卸载会中止各自仍在读取的受保护图片', async () => {
    h.listPracticeSets.mockResolvedValue({ items: [completedPracticeSet()] })
    h.getAssetBlob.mockImplementation(() => new Promise<Blob | null>(() => undefined))

    const wrapper = render()
    await flushPromises()
    const firstIdentitySignals = h.getAssetBlob.mock.calls
      .filter(([agent]) => agent === 'k12-xiaoming')
      .map((call) => call[2] as AbortSignal)
    expect(firstIdentitySignals).toHaveLength(2)
    expect(firstIdentitySignals.every((signal) => !signal.aborted)).toBe(true)

    await wrapper.setProps({ agentId: 'k12-xiaohong' })
    await flushPromises()
    const nextIdentitySignals = h.getAssetBlob.mock.calls
      .filter(([agent]) => agent === 'k12-xiaohong')
      .map((call) => call[2] as AbortSignal)
    expect(firstIdentitySignals.every((signal) => signal.aborted)).toBe(true)
    expect(nextIdentitySignals).toHaveLength(2)
    expect(nextIdentitySignals.every((signal) => !signal.aborted)).toBe(true)

    wrapper.unmount()
    expect(nextIdentitySignals.every((signal) => signal.aborted)).toBe(true)
  })

  it('同 Agent 记录与资产身份变化会释放旧 URL、中止旧请求并拒绝晚到旧图', async () => {
    const oldSourceID = 'asset://k12-xiaoming/answer-old.png'
    const oldAnnotatedID = 'asset://k12-xiaoming/annotated-old.png'
    const nextSourceID = 'asset://k12-xiaoming/answer-next.png'
    const nextAnnotatedID = 'asset://k12-xiaoming/annotated-next.png'
    const oldSourceBlob = new Blob(['old-source'], { type: 'image/png' })
    const lateOldAnnotatedBlob = new Blob(['late-old-annotated'], { type: 'image/png' })
    const nextSourceBlob = new Blob(['next-source'], { type: 'image/png' })
    let resolveOldAnnotated!: (blob: Blob | null) => void
    const oldAnnotatedPending = new Promise<Blob | null>((resolve) => {
      resolveOldAnnotated = resolve
    })
    let oldAnnotatedSignal: AbortSignal | undefined
    const createdObjectSources: unknown[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      createdObjectSources.push(blob)
      if (blob === oldSourceBlob) return 'blob:practice-old-source'
      if (blob === lateOldAnnotatedBlob) return 'blob:practice-late-old-annotated'
      if (blob === nextSourceBlob) return 'blob:practice-next-source'
      return 'blob:practice-unexpected'
    })
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    h.listPracticeSets
      .mockResolvedValueOnce({
        items: [completedPracticeSetWithAssets('practice-old-assets', oldSourceID, oldAnnotatedID)],
      })
      .mockResolvedValueOnce({
        items: [
          completedPracticeSetWithAssets('practice-next-assets', nextSourceID, nextAnnotatedID),
        ],
      })
    h.getAssetBlob.mockImplementation((_agent: string, assetID: string, signal?: AbortSignal) => {
      if (assetID === oldSourceID) return Promise.resolve(oldSourceBlob)
      if (assetID === oldAnnotatedID) {
        oldAnnotatedSignal = signal
        return oldAnnotatedPending
      }
      if (assetID === nextSourceID) return Promise.resolve(nextSourceBlob)
      return Promise.resolve(null)
    })

    const wrapper = render()
    await flushPromises()
    expect
      .soft(wrapper.get('.k12ps__return-thumb').attributes('src'))
      .toBe('blob:practice-old-source')
    expect.soft(oldAnnotatedSignal?.aborted).toBe(false)

    await (wrapper.vm as unknown as { load: () => Promise<void> }).load()
    await flushPromises()

    expect.soft(oldAnnotatedSignal?.aborted).toBe(true)
    expect.soft(revokeObjectURL).toHaveBeenCalledWith('blob:practice-old-source')
    expect
      .soft(wrapper.get('.k12ps__return-thumb').attributes('src'))
      .toBe('blob:practice-next-source')

    resolveOldAnnotated(lateOldAnnotatedBlob)
    await flushPromises()

    expect.soft(createdObjectSources).not.toContain(lateOldAnnotatedBlob)
    expect
      .soft(
        wrapper
          .findAll('img')
          .map((image) => image.attributes('src') ?? '')
          .filter((src) => src.includes('old')),
      )
      .toEqual([])
    wrapper.unmount()
    expect.soft(revokeObjectURL).toHaveBeenCalledWith('blob:practice-next-source')
  })
})
