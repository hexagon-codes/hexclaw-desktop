import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import K12PersistentPrintController from '../components/K12PersistentPrintController.vue'

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  previewGetDocument: vi.fn(),
  previewRender: vi.fn(),
}))
vi.mock('../persistent-print', () => ({
  preparePersistentPrint: (...args: unknown[]) => h.prepare(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => h.previewGetDocument(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}))

const request = {
  agent: 'tutor-a',
  sourceKind: 'tutoring_tips' as const,
  sourceRef: 'tutoring-tips:1',
  title: '辅导要点',
  canonicalMarkdown: '# 辅导要点',
  browserPrint: vi.fn(),
}

describe('K12PersistentPrintController', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    )
    h.prepare.mockReset()
    h.previewRender.mockReset().mockResolvedValue(undefined)
    h.previewGetDocument.mockReset().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 595 * scale,
            height: 842 * scale,
          }),
          render: () => ({ promise: h.previewRender(), cancel: vi.fn() }),
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    })
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows the approved PDF preview and cannot confirm native printing before explicit click', async () => {
    const exactPdf = new Blob(['%PDF-exact'], { type: 'application/pdf' })
    const confirm = vi.fn().mockResolvedValue(true)
    h.prepare.mockResolvedValue({ status: 'preview', title: '冻结标题', pdf: exactPdf, confirm })
    const wrapper = mount(K12PersistentPrintController)

    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    })
    expect(document.body.querySelector('iframe')).toBeNull()
    expect(document.body.querySelectorAll('[data-testid="k12-print-preview-page"]')).toHaveLength(1)

    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(wrapper.emitted('result')).toEqual([[true]])
    wrapper.unmount()
  })

  it('closing preview creates no native print confirmation or durable dialog event', async () => {
    const confirm = vi.fn()
    h.prepare.mockResolvedValue({
      status: 'preview',
      title: '冻结标题',
      pdf: new Blob(['%PDF-exact'], { type: 'application/pdf' }),
      confirm,
    })
    const wrapper = mount(K12PersistentPrintController)
    await (wrapper.vm as unknown as { open: (req: typeof request) => Promise<void> }).open(request)
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    })
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')!
      .click()
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

  it.each(['printed', 'rejected'] as const)(
    '旧确认%s在新命令开始后到达，不发布旧结果或释放新命令锁',
    async (outcome) => {
      let resolveOld!: (printed: boolean) => void
      let rejectOld!: (cause: Error) => void
      let resolveNew!: (printed: boolean) => void
      const oldConfirmation = new Promise<boolean>((resolve, reject) => {
        resolveOld = resolve
        rejectOld = reject
      })
      const newConfirmation = new Promise<boolean>((resolve) => { resolveNew = resolve })
      const confirmNew = vi.fn(() => newConfirmation)
      const preparedA = {
        status: 'preview', title: 'A', pdf: new Blob(['%PDF-a']), confirm: () => oldConfirmation,
      }
      const preparedB = {
        status: 'preview', title: 'B', pdf: new Blob(['%PDF-b']), confirm: confirmNew,
      }
      h.prepare.mockResolvedValueOnce(preparedA).mockResolvedValueOnce(preparedB)
      const wrapper = mount(K12PersistentPrintController, {
        global: { stubs: { K12PrintPreviewModal: true } },
      })
      const vm = wrapper.vm as unknown as {
        open(req: typeof request): Promise<void>
        close(force: boolean): void
        confirm(): Promise<void>
        state: { preparation: unknown }
      }
      try {
        await vm.open(request)
        const oldOperation = vm.confirm()
        vm.close(true)
        await vm.open({ ...request, agent: 'tutor-b', sourceRef: 'tutoring-tips:2' })
        const newOperation = vm.confirm()
        if (outcome === 'printed') resolveOld(true)
        else rejectOld(new Error('old confirmation failed'))
        await oldOperation

        expect(vm.state.preparation).toEqual(preparedB)
        expect(wrapper.emitted('result')).toBeUndefined()
        expect(wrapper.emitted('error')).toBeUndefined()
        await vm.confirm()
        expect(confirmNew).toHaveBeenCalledOnce()

        resolveNew(true)
        await newOperation
        expect(wrapper.emitted('result')).toEqual([[true]])
        expect(wrapper.emitted('error')).toBeUndefined()
      } finally {
        wrapper.unmount()
      }
    },
  )
})
