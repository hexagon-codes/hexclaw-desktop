import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12CreativeWorksPanel from '../views/K12CreativeWorksPanel.vue'
import type {
  CreativeWorkDTO,
  WorkFeedbackDTO,
  WorkFeedbackGenerationDTO,
  WorkType,
} from '@/api/k12'

/**
 * 作品当前合同回归（DD-040 / DD-042）：
 * - 一次保存就是一件新作品，不存在修改稿、版本线、归档或家长手写点评；
 * - 服务端 durable generation 是点评状态真相源；
 * - 首次失败重试复用 initial generation id，重新生成失败重试复用 command id；
 * - 作文可直接粘贴正文，美术走 ImageTask intake。
 */
const h = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  generate: vi.fn(),
  upload: vi.fn(),
  createImageTask: vi.fn(),
  getImageTask: vi.fn(),
  confirmImageTask: vi.fn(),
  retryImageTask: vi.fn(),
  cancelImageTask: vi.fn(),
  deleteWork: vi.fn(),
  sendWork: vi.fn(),
  getDeliveryBatch: vi.fn(),
  queryDeliveryBatch: vi.fn(),
  retryDeliveryBatch: vi.fn(),
  clipboard: vi.fn(),
  exportDocument: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  getAssetBlob: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://')
      ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}`
      : '',
  k12CancelImageTask: (...args: unknown[]) => h.cancelImageTask(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirmImageTask(...args),
  k12CreateCreativeWork: (...args: unknown[]) => h.create(...args),
  k12CreateImageTask: (...args: unknown[]) => h.createImageTask(...args),
  k12DeleteCreativeWork: (...args: unknown[]) => h.deleteWork(...args),
  k12GenerateWorkFeedback: (...args: unknown[]) => h.generate(...args),
  k12GetDeliveryBatch: (...args: unknown[]) => h.getDeliveryBatch(...args),
  k12GetImageTask: (...args: unknown[]) => h.getImageTask(...args),
  k12ListCreativeWorks: (...args: unknown[]) => h.list(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.queryDeliveryBatch(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.retryDeliveryBatch(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retryImageTask(...args),
  k12SendCreativeWork: (...args: unknown[]) => h.sendWork(...args),
  k12UploadAsset: (...args: unknown[]) => h.upload(...args),
}))

vi.mock('@/api/desktop', () => ({
  setClipboard: (...args: unknown[]) => h.clipboard(...args),
}))

vi.mock('@/api/k12-asset-url', () => ({
  k12GetAssetBlob: (...args: unknown[]) => h.getAssetBlob(...args),
}))

vi.mock('../export', () => ({
  exportArchiveDocument: (...args: unknown[]) => h.exportDocument(...args),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: h.toastSuccess, error: h.toastError }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function feedback(type: WorkType = 'writing', suffix = '1'): WorkFeedbackDTO {
  return {
    feedback_id: `feedback-${suffix}`,
    feedback_type: type,
    evidence_refs: [`source:${suffix}`],
    visible_evidence: [`可见证据 ${suffix}`],
    affirmation: `先这样肯定 ${suffix}`,
    parent_guidance: `家长可以这样问 ${suffix}`,
    next_step: `下一次只试一个点 ${suffix}`,
    projection_markdown: [
      `## 可见证据 ${suffix}`,
      `## 先这样肯定 ${suffix}`,
      `## 家长可以这样问 ${suffix}`,
      `## 下一次只试一个点 ${suffix}`,
    ].join('\n\n'),
    source_snapshot: {
      source: 'ai',
      method_ref: `creative-feedback@${suffix}`,
      capability: 'creative_work_feedback',
    },
  }
}

function generation(
  status: WorkFeedbackGenerationDTO['status'],
  type: WorkType = 'writing',
  suffix = '1',
): WorkFeedbackGenerationDTO {
  return {
    generation_id: `generation-${suffix}`,
    status,
    ...(status === 'succeeded' ? { feedback: feedback(type, suffix) } : {}),
    ...(status === 'failed' ? { failure_message: '点评生成失败' } : {}),
  }
}

function work(overrides: Partial<CreativeWorkDTO> = {}): CreativeWorkDTO {
  return {
    work_id: 'work-1',
    work_type: 'writing',
    display_name: '语文写作',
    content_markdown: '柳枝像绿色的丝带。',
    row_version: 1,
    initial_feedback: generation('succeeded'),
    created_at: 1,
    latest_generation_at: 1,
    ...overrides,
  }
}

function render(agentId = 'agent-1') {
  return mount(K12CreativeWorksPanel, {
    attachTo: document.body,
    props: { agentId },
    global: {
      plugins: [i18n()],
      stubs: { Teleport: true },
    },
  })
}

async function openOnlyDetail(wrapper: ReturnType<typeof render>) {
  await wrapper.get('[data-testid="cw-detail-toggle"]').trigger('click')
  await flushPromises()
}

describe('K12CreativeWorksPanel current contract', () => {
  beforeEach(() => {
    h.list.mockReset().mockResolvedValue({ items: [] })
    h.create.mockReset().mockResolvedValue({
      work_id: 'work-new',
      created: true,
      initial_feedback_generation_id: 'generation-new',
    })
    h.generate.mockReset()
    h.upload.mockReset()
    h.createImageTask.mockReset()
    h.getImageTask.mockReset()
    h.confirmImageTask.mockReset()
    h.retryImageTask.mockReset()
    h.cancelImageTask.mockReset()
    h.deleteWork.mockReset()
    h.sendWork.mockReset()
    h.getDeliveryBatch.mockReset()
    h.queryDeliveryBatch.mockReset()
    h.retryDeliveryBatch.mockReset()
    h.clipboard.mockReset().mockResolvedValue(undefined)
    h.exportDocument.mockReset().mockResolvedValue(undefined)
    h.toastSuccess.mockReset()
    h.toastError.mockReset()
    h.getAssetBlob.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('projects durable reviewed/failed/pending states and filters the current list locally', async () => {
    h.list.mockResolvedValue({
      items: [
        work(),
        work({
          work_id: 'work-art',
          work_type: 'art',
          display_name: '美术作品',
          content_markdown: undefined,
          source_asset_id: 'asset://agent-1/art.png',
          initial_feedback: generation('failed', 'art', 'art'),
        }),
        work({
          work_id: 'work-pending',
          row_version: 2,
          initial_feedback: generation('running', 'writing', 'pending'),
        }),
      ],
    })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.findAll('.k12cw__card')).toHaveLength(3)
    expect(wrapper.get('[data-testid="cw-kpis"]').text()).toContain('3')
    expect(wrapper.get('[data-testid="cw-kpis"]').text()).toContain('1')
    expect(
      wrapper.find('.k12cw__card[data-review-state="pending"] button')?.attributes('disabled'),
    ).toBeDefined()

    await wrapper.findAll('.k12cw__filter button')[2]!.trigger('click')
    expect(wrapper.findAll('.k12cw__card')).toHaveLength(1)
    expect(wrapper.get('.k12cw__card').attributes('data-work-id')).toBe('work-art')
    expect(wrapper.get('[data-testid="cw-thumb"]').attributes('src')).toMatch(/^blob:/)
    wrapper.unmount()
  })

  it('BUG-20260726-020 refreshes a pending initial review until the durable feedback is visible', async () => {
    vi.useFakeTimers()
    const pending = work({
      initial_feedback: generation('running', 'art', 'real-art'),
      work_type: 'art',
      display_name: '彩虹和小猫',
      content_markdown: undefined,
    })
    const reviewed = work({
      initial_feedback: generation('succeeded', 'art', 'real-art'),
      work_type: 'art',
      display_name: '彩虹和小猫',
      content_markdown: undefined,
    })
    h.list.mockResolvedValueOnce({ items: [pending] }).mockResolvedValue({ items: [reviewed] })

    const wrapper = render()
    await flushPromises()
    expect(wrapper.get('.k12cw__card').attributes('data-review-state')).toBe('pending')

    await vi.advanceTimersByTimeAsync(1_500)
    await flushPromises()

    expect(h.list).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.k12cw__card').attributes('data-review-state')).toBe('reviewed')
    expect(wrapper.get('[data-testid="cw-detail-toggle"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('BUG-20260726-022 projects persisted generation/creation time in the card footer', async () => {
    h.list.mockResolvedValue({
      items: [
        work({
          work_id: 'work-reviewed-time',
          created_at: 1_785_536_418,
          latest_generation_at: 1_785_575_743,
        } as Partial<CreativeWorkDTO>),
        work({
          work_id: 'work-pending-time',
          initial_feedback: generation('running', 'writing', 'pending-time'),
          created_at: 1_785_622_938,
          latest_generation_at: undefined,
        } as Partial<CreativeWorkDTO>),
        work({
          work_id: 'work-failed-time',
          initial_feedback: generation('failed', 'writing', 'failed-time'),
          created_at: 1_785_709_458,
          latest_generation_at: undefined,
        } as Partial<CreativeWorkDTO>),
      ],
    })

    const wrapper = render()
    await flushPromises()
    const cards = wrapper.findAll('.k12cw__card')

    expect(cards).toHaveLength(3)
    expect(cards[0]!.get('[data-testid="cw-card-time"]').attributes('datetime')).toBe(
      new Date(1_785_575_743_000).toISOString(),
    )
    expect(cards[0]!.get('[data-testid="cw-card-time"]').attributes('data-time-source')).toBe(
      'latest_generation_at',
    )
    expect(cards[1]!.get('[data-testid="cw-card-time"]').attributes('datetime')).toBe(
      new Date(1_785_622_938_000).toISOString(),
    )
    expect(cards[2]!.get('[data-testid="cw-card-time"]').attributes('datetime')).toBe(
      new Date(1_785_709_458_000).toISOString(),
    )
    expect(cards[1]!.get('[data-testid="cw-card-time"]').attributes('data-time-source')).toBe(
      'created_at',
    )
    expect(cards[2]!.get('[data-testid="cw-card-time"]').attributes('data-time-source')).toBe(
      'created_at',
    )
    expect(cards.every((card) => card.get('.k12cw__foot').find('button').exists())).toBe(true)
    wrapper.unmount()
  })

  it('BUG-20260723-012 opens the immutable artwork preview by keyboard and restores focus on Escape', async () => {
    h.list.mockResolvedValue({
      items: [
        work({
          work_type: 'art',
          display_name: '彩虹和小猫',
          content_markdown: undefined,
          source_asset_id: 'asset://agent-1/frozen-art.png',
          initial_feedback: generation('succeeded', 'art', 'preview'),
        }),
      ],
    })
    const wrapper = render()
    await flushPromises()

    const thumbnail = wrapper.get('[data-testid="cw-thumb"]')
    ;(thumbnail.element as HTMLElement).focus()
    await thumbnail.trigger('keydown', { key: 'Enter', keyCode: 13 })
    await flushPromises()

    expect(wrapper.get('[data-testid="cw-image-preview"]').attributes('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(wrapper.get('[data-testid="cw-image-preview"]').element)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-testid="cw-image-preview"]').exists()).toBe(false)
    expect(document.activeElement).toBe(thumbnail.element)
    wrapper.unmount()
  })

  it('renders the approved structured detail and exact current action set', async () => {
    h.list.mockResolvedValue({ items: [work()] })
    const wrapper = render()
    await flushPromises()
    await openOnlyDetail(wrapper)

    expect(wrapper.get('[data-testid="cw-work-content"]').text()).toContain('柳枝像绿色的丝带')
    const feedbackBlock = wrapper.get('[data-testid="cw-latest-feedback"]')
    expect(feedbackBlock.text()).toContain('可见证据 1')
    expect(feedbackBlock.text()).toContain('先这样肯定 1')
    expect(feedbackBlock.text()).toContain('家长可以这样问 1')
    expect(feedbackBlock.text()).toContain('下一次只试一个点 1')
    expect(
      wrapper
        .get('[data-testid="cw-action-bar"]')
        .findAll('button')
        .map((button) => button.attributes('data-testid')),
    ).toEqual(['cw-copy', 'cw-send', 'cw-export-pdf', 'cw-feedback-regenerate', 'cw-delete'])
    expect(wrapper.get('[data-testid="cw-delete"]').classes()).toContain('hc-btn-danger-ghost')
    expect(wrapper.find('[data-testid="cw-revision-submit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cw-archive"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('首发成功写回批次身份，关闭并重开详情后恢复同一 delivered 批次', async () => {
    h.list.mockResolvedValue({ items: [work()] })
    h.sendWork.mockResolvedValue({ batch_id: 'batch-1', status: 'delivered' })
    h.getDeliveryBatch.mockResolvedValue({ batch_id: 'batch-1', status: 'delivered' })
    const wrapper = render()
    await flushPromises()
    await openOnlyDetail(wrapper)

    await wrapper.get('[data-testid="cw-send"]').trigger('click')
    await flushPromises()
    expect(h.sendWork).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="cw-send"]').text()).toBe('发送成功')
    expect(wrapper.get('[data-testid="cw-send"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="cw-detail-close"]').trigger('click')
    await flushPromises()
    await openOnlyDetail(wrapper)

    expect(h.getDeliveryBatch).toHaveBeenCalledTimes(1)
    expect(h.getDeliveryBatch).toHaveBeenCalledWith('agent-1', 'batch-1')
    expect(wrapper.get('[data-testid="cw-send"]').text()).toBe('发送成功')
    expect(wrapper.get('[data-testid="cw-send"]').attributes('disabled')).toBeDefined()
    expect(h.sendWork).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('retries a failed initial review with the server-owned initial generation id', async () => {
    const failed = work({
      initial_feedback: generation('failed', 'writing', 'initial'),
    })
    h.list.mockResolvedValue({ items: [failed] })
    h.generate.mockResolvedValue(
      work({ initial_feedback: generation('succeeded', 'writing', 'initial') }),
    )
    const wrapper = render()
    await flushPromises()
    await openOnlyDetail(wrapper)

    await wrapper.get('[data-testid="cw-initial-review-retry"]').trigger('click')
    await flushPromises()

    expect(h.generate).toHaveBeenCalledWith(
      'agent-1',
      'work-1',
      'generation-initial',
      expect.any(AbortSignal),
    )
    expect(wrapper.find('[data-testid="cw-latest-feedback"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps the existing feedback visible and reuses one command id after regeneration failure', async () => {
    h.list.mockResolvedValue({ items: [work()] })
    h.generate.mockRejectedValueOnce(new Error('上游暂不可用')).mockResolvedValueOnce(
      work({
        latest_feedback: generation('succeeded', 'writing', 'replacement'),
        row_version: 2,
      }),
    )
    const wrapper = render()
    await flushPromises()
    await openOnlyDetail(wrapper)

    await wrapper.get('[data-testid="cw-feedback-regenerate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="cw-latest-feedback"]').text()).toContain('先这样肯定 1')
    expect(wrapper.get('[data-testid="cw-feedback-regenerate-error"]').text()).toContain('重新生成')
    const firstCommand = h.generate.mock.calls[0]![2]

    await wrapper.get('[data-testid="cw-feedback-regenerate"]').trigger('click')
    await flushPromises()
    expect(h.generate.mock.calls[1]![2]).toBe(firstCommand)
    expect(wrapper.get('[data-testid="cw-latest-feedback"]').text()).toContain(
      '先这样肯定 replacement',
    )
    wrapper.unmount()
  })

  it('creates a text-only writing as one new work with command metadata', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="cw-add-open"]').trigger('click')
    await wrapper.get('[data-testid="cw-add-draft"]').setValue('春天来了。')
    await wrapper.get('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()

    expect(h.create).toHaveBeenCalledWith({
      agent: 'agent-1',
      work_type: 'writing',
      content_markdown: '春天来了。',
      command_id: expect.any(String),
    })
    expect(h.createImageTask).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('BUG-20260723-004 keeps the approved minimal writing/art add-work field sets', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-testid="cw-add-open"]').trigger('click')

    const modal = wrapper.get('[data-testid="cw-add-modal"]')
    expect(modal.find('[data-testid="cw-add-photo-input"]').exists()).toBe(true)
    expect(modal.find('[data-testid="cw-add-draft"]').exists()).toBe(true)
    expect(modal.find('[data-testid="cw-add-title"]').exists()).toBe(false)
    expect(modal.find('[data-testid="cw-add-task"]').exists()).toBe(false)
    expect(modal.find('[data-testid="cw-add-intent"]').exists()).toBe(false)

    await modal.get('[data-testid="cw-add-type-art"]').trigger('click')
    await flushPromises()
    const artModal = wrapper.get('[data-testid="cw-add-modal"]')
    expect(artModal.find('[data-testid="cw-add-photo-input"]').exists()).toBe(true)
    expect(artModal.find('[data-testid="cw-add-draft"]').exists()).toBe(false)
    expect(artModal.get('[data-testid="cw-add-title"]').attributes('placeholder')).toBe(
      '选填，如作品已有名称可填写',
    )
    expect(artModal.find('[data-testid="cw-add-task"]').exists()).toBe(false)
    expect(artModal.find('[data-testid="cw-add-intent"]').exists()).toBe(false)
    expect(artModal.get('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('isolates late list responses when switching tutoring agents', async () => {
    let resolveOld!: (value: { items: CreativeWorkDTO[] }) => void
    let resolveNew!: (value: { items: CreativeWorkDTO[] }) => void
    h.list
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNew = resolve
        }),
      )

    const wrapper = render('agent-old')
    await wrapper.setProps({ agentId: 'agent-new' })
    resolveNew({
      items: [work({ work_id: 'new-work', display_name: '新辅导对象作品' })],
    })
    await flushPromises()
    resolveOld({
      items: [work({ work_id: 'old-work', display_name: '旧辅导对象作品' })],
    })
    await flushPromises()

    expect(wrapper.text()).toContain('新辅导对象作品')
    expect(wrapper.text()).not.toContain('旧辅导对象作品')
    wrapper.unmount()
  })

  it('shows a retryable load failure without fabricating an empty archive', async () => {
    h.list.mockRejectedValueOnce(new Error('列表加载失败')).mockResolvedValueOnce({
      items: [work()],
    })
    const wrapper = render()
    await flushPromises()
    expect(wrapper.get('[data-testid="cw-error"]').text()).toContain('列表加载失败')
    expect(wrapper.find('[data-testid="cw-empty"]').exists()).toBe(false)

    await wrapper.get('[data-testid="cw-load-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="cw-error"]').exists()).toBe(false)
    expect(wrapper.findAll('.k12cw__card')).toHaveLength(1)
    wrapper.unmount()
  })
})
