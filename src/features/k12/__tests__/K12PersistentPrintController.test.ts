import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'

const h = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('../persistent-print', () => ({
  preparePersistentPrint: (...args: unknown[]) => h.prepare(...args),
}))

const request = {
  agent: 'tutor-a',
  sourceKind: 'prep_card' as const,
  sourceRef: 'prep:1',
  title: '辅导要点',
  canonicalMarkdown: '# 辅导要点',
  browserPrint: vi.fn(),
}

describe('K12PersistentPrintController', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:exact-preview-pdf')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    h.prepare.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows the approved PDF preview and cannot confirm native printing before explicit click', async () => {
    const exactPdf = new Blob(['%PDF-exact'], { type: 'application/pdf' })
    const confirm = vi.fn().mockResolvedValue(true)
    h.prepare.mockResolvedValue({ status: 'preview', title: '冻结标题', pdf: exactPdf, confirm })
    const wrapper = mount(K12PersistentPrintController)

    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="k12-print-preview-pdf"]')?.getAttribute('src'))
      .toBe('blob:exact-preview-pdf')

    await document.body.querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!.click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(wrapper.emitted('result')).toEqual([[true]])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:exact-preview-pdf')
    wrapper.unmount()
  })

  it('closing preview creates no native print confirmation or durable dialog event', async () => {
    const confirm = vi.fn()
    h.prepare.mockResolvedValue({
      status: 'preview', title: '冻结标题',
      pdf: new Blob(['%PDF-exact'], { type: 'application/pdf' }), confirm,
    })
    const wrapper = mount(K12PersistentPrintController)
    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await document.body.querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')!.click()
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.emitted('result')).toBeUndefined()
    expect(document.body.querySelector('[data-testid="k12-print-preview"]')).toBeNull()
    wrapper.unmount()
  })

  it('already-completed idempotent job does not open a second preview', async () => {
    h.prepare.mockResolvedValue({ status: 'completed', printed: true })
    const wrapper = mount(K12PersistentPrintController)
    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await flushPromises()

    expect(wrapper.emitted('result')).toEqual([[true]])
    expect(document.body.querySelector('[data-testid="k12-print-preview"]')).toBeNull()
    wrapper.unmount()
  })
})
