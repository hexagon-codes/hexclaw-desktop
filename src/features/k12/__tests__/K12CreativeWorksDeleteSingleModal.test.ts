import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12CreativeWorksPanel from '../views/K12CreativeWorksPanel.vue'
import type { CreativeWorkDTO } from '@/api/k12'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  deleteWork: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12AssetURL: vi.fn(() => ''),
  k12CancelImageTask: vi.fn(),
  k12ConfirmImageTask: vi.fn(),
  k12CreateCreativeWork: vi.fn(),
  k12CreateImageTask: vi.fn(),
  k12DeleteCreativeWork: (...args: unknown[]) => h.deleteWork(...args),
  k12GenerateWorkFeedback: vi.fn(),
  k12GetDeliveryBatch: vi.fn(),
  k12GetImageTask: vi.fn(),
  k12ListCreativeWorks: (...args: unknown[]) => h.list(...args),
  k12QueryDeliveryBatch: vi.fn(),
  k12RetryDeliveryBatch: vi.fn(),
  k12RetryImageTask: vi.fn(),
  k12SendCreativeWork: vi.fn(),
  k12UploadAsset: vi.fn(),
}))

vi.mock('@/api/desktop', () => ({
  setClipboard: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function readyWork(): CreativeWorkDTO {
  return {
    work_id: 'work-1',
    work_type: 'writing',
    display_name: '语文写作',
    content_markdown: '柳枝像绿色的丝带。',
    row_version: 7,
    initial_feedback: {
      generation_id: 'generation-1',
      status: 'succeeded',
      feedback: {
        feedback_id: 'feedback-1',
        feedback_type: 'writing',
        evidence_refs: ['content:1'],
        visible_evidence: ['写到了柳枝随风摆动'],
        affirmation: '画面具体。',
        parent_guidance: '可以问孩子柳枝怎样变化。',
        next_step: '补充一个变化细节。',
        source_snapshot: {
          source: 'ai',
          method_ref: 'writing-feedback@1',
          capability: 'writing_feedback',
        },
      },
    },
  }
}

function render() {
  return mount(K12CreativeWorksPanel, {
    attachTo: document.body,
    props: { agentId: 'agent-1' },
    global: {
      plugins: [i18n()],
      stubs: { Teleport: true },
    },
  })
}

async function openDetail(wrapper: ReturnType<typeof render>) {
  await wrapper.get('[data-testid="cw-detail-toggle"]').trigger('click')
  await flushPromises()
}

describe('K12CreativeWorksPanel single-modal destructive delete', () => {
  beforeEach(() => {
    h.list.mockReset().mockResolvedValue({ items: [readyWork()] })
    h.deleteWork.mockReset().mockResolvedValue({
      work_id: 'work-1',
      deleted: true,
      row_version: 8,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('replaces the detail with one standard dialog and restores scroll/focus on cancel', async () => {
    const wrapper = render()
    await flushPromises()
    await openDetail(wrapper)

    const detailBody = wrapper.get<HTMLElement>('.k12cw-detail-modal__body')
    detailBody.element.scrollTop = 137
    const deleteButton = wrapper.get<HTMLButtonElement>('[data-testid="cw-delete"]')
    expect(deleteButton.classes()).toContain('hc-btn-danger-ghost')
    deleteButton.element.focus()
    await deleteButton.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="cw-detail-modal"]').exists()).toBe(false)
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true)
    expect(wrapper.findAll('[aria-modal="true"]')).toHaveLength(1)
    expect(wrapper.find('.hc-dialog').classes()).not.toContain('k12cw-detail-modal')

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '取消')!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    const restoredBody = wrapper.get<HTMLElement>('.k12cw-detail-modal__body')
    expect(restoredBody.element.scrollTop).toBe(137)
    expect(document.activeElement).toBe(
      wrapper.get<HTMLButtonElement>('[data-testid="cw-delete"]').element,
    )
    wrapper.unmount()
  })

  it('restores the same retryable detail when the delete request fails', async () => {
    vi.useFakeTimers()
    h.deleteWork.mockRejectedValueOnce(new Error('删除失败'))
    const wrapper = render()
    await flushPromises()
    await openDetail(wrapper)
    const detailBody = wrapper.get<HTMLElement>('.k12cw-detail-modal__body')
    detailBody.element.scrollTop = 81
    await wrapper.get('[data-testid="cw-delete"]').trigger('click')
    await vi.advanceTimersByTimeAsync(5_000)
    await wrapper.get('.hc-dialog__btn--danger').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cw-detail-modal"]').exists()).toBe(true)
    expect(wrapper.get<HTMLElement>('.k12cw-detail-modal__body').element.scrollTop).toBe(81)
    expect(wrapper.findAll('[data-testid="cw-detail-toggle"]')).toHaveLength(1)
    expect(document.activeElement).toBe(
      wrapper.get<HTMLButtonElement>('[data-testid="cw-delete"]').element,
    )
    wrapper.unmount()
  })
})
