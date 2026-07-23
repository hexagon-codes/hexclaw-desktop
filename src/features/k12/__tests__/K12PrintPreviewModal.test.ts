import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import K12PrintPreviewModal from '../components/K12PrintPreviewModal.vue'

const h = vi.hoisted(() => ({
  getDocument: vi.fn(),
  loadingDestroy: vi.fn(),
  documentDestroy: vi.fn(),
  render: vi.fn(),
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => h.getDocument(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}))

function pdfDocument(pageCount = 2) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 595 * scale,
        height: 842 * scale,
      }),
      render: () => {
        const promise = h.render()
        return { promise, cancel: vi.fn() }
      },
    })),
    destroy: h.documentDestroy,
  }
}

function resolvedLoadingTask(pageCount = 2) {
  return {
    promise: Promise.resolve(pdfDocument(pageCount)),
    destroy: h.loadingDestroy,
  }
}

describe('K12PrintPreviewModal', () => {
  beforeEach(() => {
    h.getDocument.mockReset().mockReturnValue(resolvedLoadingTask())
    h.loadingDestroy.mockReset()
    h.documentDestroy.mockReset()
    h.render.mockReset().mockResolvedValue(undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the frozen PDF Blob with PDF.js canvases and enables print only after every page is ready', async () => {
    let resolveDocument!: (value: ReturnType<typeof pdfDocument>) => void
    h.getDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        resolveDocument = resolve
      }),
      destroy: h.loadingDestroy,
    })
    const exactPdf = new Blob(['%PDF-frozen'], { type: 'application/pdf' })
    const wrapper = mount(K12PrintPreviewModal, {
      props: {
        open: true,
        title: '本周错题卷',
        pdf: exactPdf,
      },
    })

    const dialog = document.body.querySelector<HTMLElement>('[data-testid="k12-print-preview"]')!
    const print = dialog.querySelector<HTMLButtonElement>(
      '[data-testid="k12-print-preview-print"]',
    )!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.querySelector('iframe')).toBeNull()
    expect(dialog.querySelector('[data-testid="k12-print-preview-loading"]')).not.toBeNull()
    expect(print.disabled).toBe(true)
    await vi.waitFor(() => {
      expect(h.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.any(Uint8Array),
          isEvalSupported: false,
          useSystemFonts: true,
        }),
      )
    })

    print.click()
    expect(wrapper.emitted('print')).toBeUndefined()

    resolveDocument(pdfDocument(2))
    await flushPromises()

    expect(dialog.querySelectorAll('[data-testid="k12-print-preview-page"]')).toHaveLength(2)
    expect(dialog.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    expect(print.disabled).toBe(false)

    print.click()
    expect(wrapper.emitted('print')).toHaveLength(1)
    wrapper.unmount()
  })

  it('shows a retryable error without enabling print and retries the same Blob', async () => {
    const exactPdf = new Blob(['%PDF-frozen'], { type: 'application/pdf' })
    h.getDocument
      .mockImplementationOnce(() => ({
        promise: Promise.reject(new Error('PDF 解码失败')),
        destroy: h.loadingDestroy,
      }))
      .mockReturnValueOnce(resolvedLoadingTask(1))

    const wrapper = mount(K12PrintPreviewModal, {
      props: { open: true, title: '本周错题卷', pdf: exactPdf },
    })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-error"]')).not.toBeNull()
    })

    const dialog = document.body.querySelector<HTMLElement>('[data-testid="k12-print-preview"]')!
    const print = dialog.querySelector<HTMLButtonElement>(
      '[data-testid="k12-print-preview-print"]',
    )!
    expect(dialog.querySelector('[data-testid="k12-print-preview-error"]')?.textContent).toContain(
      'PDF 解码失败',
    )
    expect(print.disabled).toBe(true)
    expect(wrapper.emitted('print')).toBeUndefined()

    dialog.querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-retry"]')!.click()
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll('[data-testid="k12-print-preview-page"]')).toHaveLength(
        1,
      )
    })

    expect(h.getDocument).toHaveBeenCalledTimes(2)
    expect(dialog.querySelectorAll('[data-testid="k12-print-preview-page"]')).toHaveLength(1)
    expect(print.disabled).toBe(false)
    wrapper.unmount()
  })

  it('closes without printing and releases the PDF.js session', async () => {
    const wrapper = mount(K12PrintPreviewModal, {
      props: {
        open: true,
        title: '本周错题卷',
        pdf: new Blob(['%PDF-frozen'], { type: 'application/pdf' }),
      },
    })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    })

    document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')!
      .click()
    await flushPromises()

    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('print')).toBeUndefined()
    wrapper.unmount()
    expect(h.documentDestroy).toHaveBeenCalled()
  })
})
