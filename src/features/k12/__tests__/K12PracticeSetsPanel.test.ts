import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'
import type { PracticeSetDTO, PracticeItemDTO } from '@/api/k12'

// 练习集面板（§3.8 购物车两段 · §4.13 呈现物）：待打印篮（学科分组+阻断沉底+移除）+ 打印历史（paper_no+三态）。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  finalizeSpy: vi.fn(),
  deliveryGetSpy: vi.fn(),
  deliveryRetrySpy: vi.fn(),
  deliveryQuerySpy: vi.fn(),
  removeSpy: vi.fn(),
  advanceSpy: vi.fn(),
  cancelSpy: vi.fn(),
  paperSpy: vi.fn(),
  preparePrintSpy: vi.fn(),
  getPrintJobSpy: vi.fn(),
  printJobPaperSpy: vi.fn(),
  commitPrintSpy: vi.fn(),
  printEventSpy: vi.fn(),
  retryPrintSpy: vi.fn(),
  printSpy: vi.fn(),
  renderPdfSpy: vi.fn(),
  uploadSpy: vi.fn(),
  submitSpy: vi.fn(),
  gradeSpy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  previewGetDocument: vi.fn(),
  previewRender: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListPracticeSets: (agent: string, status?: string) => h.listSpy(agent, status),
  k12FinalizePracticeSet: (a: string, id: string, via: string, target?: string) =>
    h.finalizeSpy(a, id, via, target),
  k12GetDeliveryBatch: (...args: unknown[]) => h.deliveryGetSpy(...args),
  k12RetryDeliveryBatch: (...args: unknown[]) => h.deliveryRetrySpy(...args),
  k12QueryDeliveryBatch: (...args: unknown[]) => h.deliveryQuerySpy(...args),
  k12RemoveFromBasket: (a: string, id: string, itemId: string) => h.removeSpy(a, id, itemId),
  k12AdvancePracticeSet: (a: string, id: string, step: string) => h.advanceSpy(a, id, step),
  k12CancelPracticeSet: (a: string, id: string) => h.cancelSpy(a, id),
  k12GetPracticePaper: (a: string, id: string, kind: string) => h.paperSpy(a, id, kind),
  k12PreparePracticePrintJob: (...args: unknown[]) => h.preparePrintSpy(...args),
  k12GetPracticePrintJob: (...args: unknown[]) => h.getPrintJobSpy(...args),
  k12GetPracticePrintJobPaper: (...args: unknown[]) => h.printJobPaperSpy(...args),
  k12CommitPracticePrintReceipt: (...args: unknown[]) => h.commitPrintSpy(...args),
  k12RecordPracticePrintEvent: (...args: unknown[]) => h.printEventSpy(...args),
  k12RetryPracticePrintJob: (...args: unknown[]) => h.retryPrintSpy(...args),
  k12UploadAsset: (a: string, file: File) => h.uploadSpy(a, file),
  k12SubmitPracticeSet: (a: string, id: string, req: unknown) => h.submitSpy(a, id, req),
  k12GradePracticeSet: (
    a: string,
    id: string,
    results: Array<{ item_id: string; correct: boolean }>,
  ) => h.gradeSpy(a, id, results),
  k12AssetURL: (agent: string, assetId: string) => `/asset/${agent}/${encodeURIComponent(assetId)}`,
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    success: h.toastSuccess,
    error: h.toastError,
    info: h.toastInfo,
    warning: h.toastWarning,
  }),
}))
vi.mock('../export', () => ({
  printPracticePaper: (markdown: string, title: string) => h.printSpy(markdown, title),
  printPracticePaperWithReceipt: (pdf: Blob) => h.printSpy(pdf),
  renderPracticePaperPdf: (markdown: string, title: string) => h.renderPdfSpy(markdown, title),
  savePracticePaperPdf: vi.fn().mockResolvedValue(true),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => h.previewGetDocument(...args),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function item(
  id: string,
  q: string,
  subject: string,
  status: PracticeItemDTO['verification_status'],
  via = 'weekly',
): PracticeItemDTO {
  return {
    item_id: id,
    question_markdown: q,
    subject,
    added_via: via as PracticeItemDTO['added_via'],
    verification_status: status,
    verification_evidence: status === 'verified' ? '独立验算' : undefined,
    blocked_reason: status !== 'verified' ? '验证器未达质量门' : undefined,
  }
}

function basket(items: PracticeItemDTO[]): PracticeSetDTO {
  return {
    record_id: 'basket1',
    title: '待打印篮',
    source_kind: 'mixed',
    status: 'draft',
    status_label: '草稿',
    publishable: false,
    delivery_status: 'not_sent',
    items,
    return_assets: [],
  }
}

function historySet(over: Partial<PracticeSetDTO> = {}): PracticeSetDTO {
  return {
    record_id: 'hist1',
    title: '小数乘法专项 · 07/12',
    source_kind: 'mixed',
    status: 'graded',
    status_label: '已批改',
    publishable: true,
    delivery_status: 'delivered',
    paper_no: 'P-2629-01',
    finalized_at: 1784300000,
    finalized_via: 'print',
    items: [item('q9', '2.8×0.65=?', '数学', 'verified')],
    return_assets: [],
    ...over,
  }
}

function render() {
  return mount(K12PracticeSetsPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: { plugins: [i18n()] },
  })
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  )
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
  h.listSpy.mockReset()
  h.finalizeSpy.mockReset().mockResolvedValue({
    set: historySet({ status: 'assigned', status_label: '待完成' }),
    skipped_blocked_count: 2,
  })
  h.deliveryGetSpy.mockReset()
  h.deliveryRetrySpy.mockReset()
  h.deliveryQuerySpy.mockReset()
  h.removeSpy.mockReset().mockResolvedValue(basket([]))
  h.advanceSpy.mockReset().mockResolvedValue(historySet())
  h.cancelSpy
    .mockReset()
    .mockResolvedValue(historySet({ status: 'cancelled', status_label: '已取消' }))
  h.paperSpy.mockReset().mockResolvedValue({
    kind: 'question',
    title: '小数乘法专项 · 07/12',
    paper_no: 'P-2629-01',
    markdown: '# 小数乘法专项\n\n1. 2.8×0.65=?',
    preview: false,
  })
  h.preparePrintSpy.mockReset().mockResolvedValue({
    print_job: {
      print_job_id: 'print-1',
      practice_set_id: 'basket1',
      status: 'preparing',
      paper_no: 'P-2629-02',
      source_digest: 'sha256:source',
      attempt_count: 1,
    },
    replayed: false,
  })
  h.getPrintJobSpy.mockReset().mockResolvedValue({
    print_job: { print_job_id: 'print-1', status: 'dialog_open' },
  })
  h.printJobPaperSpy.mockReset().mockResolvedValue({
    print_job_id: 'print-1',
    kind: 'question',
    title: '待打印篮',
    paper_no: 'P-2629-02',
    source_digest: 'sha256:source',
    artifact_id: 'qsheet-1',
    markdown: '# 待打印篮\n\n1. 2.8×0.65=?',
  })
  h.printEventSpy
    .mockReset()
    .mockImplementation((_agent: string, _job: string, event: { status: string }) =>
      Promise.resolve({ print_job: { print_job_id: 'print-1', status: event.status } }),
    )
  h.commitPrintSpy.mockReset().mockResolvedValue({
    print_job: {
      print_job_id: 'print-1',
      status: 'printed',
      native_job_id: 'native-1',
      native_receipt_id: 'receipt-1',
      printer_snapshot: { adapter: 'appkit' },
    },
  })
  h.retryPrintSpy.mockReset().mockResolvedValue({
    print_job: { print_job_id: 'print-1', status: 'preparing', attempt_count: 2 },
  })
  h.printSpy.mockReset().mockResolvedValue({
    status: 'printed',
    native_job_id: 'native-1',
    native_receipt_id: 'receipt-1',
    printer_snapshot: { adapter: 'appkit' },
  })
  h.renderPdfSpy.mockReset().mockResolvedValue(new Blob(['%PDF-1.7'], { type: 'application/pdf' }))
  h.uploadSpy
    .mockReset()
    .mockResolvedValue({ asset_id: 'asset://k12-xiaoming/return.png', size: 3 })
  h.submitSpy
    .mockReset()
    .mockResolvedValue(historySet({ status: 'submitted', status_label: '已回传' }))
  h.gradeSpy.mockReset().mockResolvedValue(historySet())
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
  h.toastInfo.mockReset()
  h.toastWarning.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('K12PracticeSetsPanel · 购物车两段（§3.8/§4.13）', () => {
  it('空篮 + 空历史 → 双空态', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-basket-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-history-empty"]').exists()).toBe(true)
  })

  it('练习集列表加载失败 → 页面内保留重试入口', async () => {
    h.listSpy.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-error"]').text()).toContain('网络中断')
    await w.find('[data-testid="ps-load-retry"]').trigger('click')
    await flushPromises()
    expect(h.listSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="ps-error"]').exists()).toBe(false)
  })

  it('篮内按学科分组（§4.13 顺序），阻断题沉底成组且降透明', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        basket([
          item('c1', '默写：梅须逊雪', '语文', 'verified'),
          item('m1', '2.8×0.65=?', '数学', 'verified'),
          item('s1', '闭合电路判断', '科学', 'needs_review'),
        ]),
      ],
    })
    const w = render()
    await flushPromises()
    const groups = w.findAll('.k12ps__group').map((g) => g.text())
    // 数学在语文前（§4.13 卷面顺序），阻断组沉底
    expect(groups[0]).toBe('数学')
    expect(groups[1]).toBe('语文')
    expect(w.find('[data-testid="ps-blocked-group"]').exists()).toBe(true)
    expect(w.find('.k12ps__item--blocked').exists()).toBe(true)
    // verified 题连续编号，阻断题无号
    const seqs = w.findAll('.k12ps__seq').map((s) => s.text())
    expect(seqs).toEqual(['1', '2', '–'])
  })

  it('篮内逐题可移除（购物车对称操作）', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('m1', '2.8×0.65=?', '数学', 'verified')])] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-remove-item"]').trigger('click')
    await flushPromises()
    expect(h.removeSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'm1')
  })

  it('先预览再确认系统打印；取消不固化，成功由同一持久 PrintJob receipt 原子固化', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        basket([
          item('m1', '题', '数学', 'verified'),
          item('s1', '阻断题', '科学', 'needs_review'),
        ]),
      ],
    })
    h.preparePrintSpy
      .mockResolvedValueOnce({
        print_job: { print_job_id: 'print-1', status: 'preparing', attempt_count: 1 },
        replayed: false,
      })
      .mockResolvedValueOnce({
        print_job: { print_job_id: 'print-1', status: 'cancelled', attempt_count: 1 },
        replayed: true,
      })
    h.printSpy
      .mockResolvedValueOnce({
        status: 'cancelled',
        native_job_id: 'native-cancelled',
        printer_snapshot: { adapter: 'appkit' },
      })
      .mockResolvedValueOnce({
        status: 'printed',
        native_job_id: 'native-1',
        native_receipt_id: 'receipt-1',
        printer_snapshot: { adapter: 'appkit' },
      })
    const exactPreviewPdf = new Blob(['%PDF-exact-preview'], { type: 'application/pdf' })
    h.renderPdfSpy.mockResolvedValue(exactPreviewPdf)
    const w = render()
    await flushPromises()
    expect(w.text()).toContain('1 道阻断题打印时跳过')

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.preparePrintSpy).toHaveBeenCalledWith(
      'k12-xiaoming',
      'basket1',
      expect.stringMatching(/^desktop-print:/),
      'question',
    )
    expect(h.printJobPaperSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1', 'question')
    expect(h.renderPdfSpy).toHaveBeenCalledWith('# 待打印篮\n\n1. 2.8×0.65=?', '待打印篮')
    expect(document.body.querySelector('[data-testid="k12-print-preview"]')).not.toBeNull()
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.printEventSpy).not.toHaveBeenCalled()
    expect(h.finalizeSpy).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    })
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()
    expect(h.printSpy).toHaveBeenCalledWith(exactPreviewPdf)
    expect(h.renderPdfSpy).toHaveBeenCalledTimes(1)
    expect(h.printEventSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1', {
      status: 'cancelled',
      native_job_id: 'native-cancelled',
      printer_snapshot: { adapter: 'appkit' },
    })

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.retryPrintSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1')
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-testid="k12-print-preview-ready"]')).not.toBeNull()
    })
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()
    expect(h.printSpy).toHaveBeenLastCalledWith(exactPreviewPdf)
    expect(h.commitPrintSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1', {
      native_job_id: 'native-1',
      native_receipt_id: 'receipt-1',
      printer_snapshot: { adapter: 'appkit' },
    })
    expect(h.finalizeSpy).not.toHaveBeenCalled()
  })

  it('原生适配器中断必须记 outcome_unknown，禁止把结果未知当失败后盲目重试', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified')])],
    })
    h.printSpy.mockResolvedValueOnce({
      status: 'outcome_unknown',
      native_job_id: 'native-unknown',
      printer_snapshot: { adapter: 'appkit' },
      failure_kind: 'native_result_unavailable',
      failure_detail: 'native channel closed',
    })
    const w = render()
    await flushPromises()

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    expect(h.printEventSpy).not.toHaveBeenCalled()
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()

    expect(h.printEventSpy.mock.calls.map((call) => call[2])).toEqual([
      { status: 'dialog_open' },
      {
        status: 'outcome_unknown',
        native_job_id: 'native-unknown',
        failure_kind: 'native_result_unavailable',
        failure_detail: 'native channel closed',
      },
    ])
    expect(h.retryPrintSpy).not.toHaveBeenCalled()
    expect(h.finalizeSpy).not.toHaveBeenCalled()
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(h.toastError).toHaveBeenCalledWith('native channel closed')
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')!
      .click()
    await flushPromises()
  })

  it('篮子打印的确定性 native 故障记 failed，允许同一 PrintJob 后续受控重试', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified')])],
    })
    h.printSpy.mockResolvedValueOnce({
      status: 'failed',
      native_job_id: 'native-failed',
      printer_snapshot: { adapter: 'appkit' },
      failure_kind: 'pdf_media_box_invalid',
      failure_detail: '打印 PDF 页面尺寸无效',
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()

    expect(h.printEventSpy).toHaveBeenLastCalledWith('k12-xiaoming', 'print-1', {
      status: 'failed',
      native_job_id: 'native-failed',
      failure_kind: 'pdf_media_box_invalid',
      failure_detail: '打印 PDF 页面尺寸无效',
    })
    expect(h.commitPrintSpy).not.toHaveBeenCalled()
    expect(h.toastError).toHaveBeenCalledWith('打印 PDF 页面尺寸无效')
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')!
      .click()
    await flushPromises()
  })

  it('篮子打印在 commit 响应丢失时查询同一 receipt 收敛，不再次调用原生打印', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified')])],
    })
    h.commitPrintSpy.mockRejectedValueOnce(new Error('response lost'))
    h.getPrintJobSpy.mockResolvedValueOnce({
      print_job: {
        print_job_id: 'print-1',
        status: 'printed',
        native_job_id: 'native-1',
        native_receipt_id: 'receipt-1',
        printer_snapshot: { adapter: 'appkit' },
      },
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()

    expect(h.printSpy).toHaveBeenCalledTimes(1)
    expect(h.commitPrintSpy).toHaveBeenCalledTimes(1)
    expect(h.getPrintJobSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1')
    expect(h.toastSuccess).toHaveBeenCalled()
  })

  it('篮子 dialog_open 响应丢失时先查询收敛，再且仅再调用一次原生打印', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified')])],
    })
    h.printEventSpy.mockRejectedValueOnce(new Error('dialog response lost'))
    h.getPrintJobSpy.mockResolvedValueOnce({
      print_job: { print_job_id: 'print-1', status: 'dialog_open' },
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()
    await document.body
      .querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!
      .click()
    await flushPromises()

    expect(h.printEventSpy).toHaveBeenCalledTimes(1)
    expect(h.getPrintJobSpy).toHaveBeenCalledWith('k12-xiaoming', 'print-1')
    expect(h.printSpy).toHaveBeenCalledTimes(1)
    expect(h.commitPrintSpy).toHaveBeenCalledTimes(1)
  })

  it('PDF 渲染失败不进入系统打印，且释放页面操作锁', async () => {
    h.listSpy.mockResolvedValue({
      items: [basket([item('m1', '题', '数学', 'verified')])],
    })
    h.renderPdfSpy.mockRejectedValueOnce(new Error('PDF 渲染失败'))
    const w = render()
    await flushPromises()

    await w.find('[data-testid="ps-finalize-print"]').trigger('click')
    await flushPromises()

    expect(document.body.querySelector('[data-testid="k12-print-preview"]')).toBeNull()
    expect(h.printSpy).not.toHaveBeenCalled()
    expect(h.printEventSpy).not.toHaveBeenCalled()
    expect(h.toastError).toHaveBeenCalledWith('PDF 渲染失败')
    expect(w.find('[data-testid="ps-finalize-print"]').attributes('disabled')).toBeUndefined()
  })

  it('发送练习集不传目标；unknown 只查原批次并仅在原按钮投影状态', async () => {
    vi.useFakeTimers()
    h.listSpy.mockResolvedValue({ items: [basket([item('m1', '题', '数学', 'verified')])] })
    const receipt = {
      delivery_id: 'delivery-1',
      batch_id: 'batch-1',
      batch_ordinal: 0,
      agent_name: 'k12-xiaoming',
      object_kind: 'practice_set',
      object_id: 'basket1',
      binding_id: 'binding-1',
      target: { platform: 'dingtalk', chat_id: 'chat-1' },
      status: 'outcome_unknown',
      dedupe_key: 'child-1',
      payload_digest: 'sha256:payload',
      payload_json: '{}',
      render_manifest_json: '{}',
      attempt: 1,
      created_at: 1,
      updated_at: 1,
    }
    h.finalizeSpy.mockResolvedValue({
      set: historySet({
        status: 'assigned',
        status_label: '待完成',
        delivery_status: 'pending',
        delivery_batch_id: 'batch-1',
      }),
      skipped_blocked_count: 0,
      delivery_batch: {
        batch_id: 'batch-1',
        agent_name: 'k12-xiaoming',
        object_kind: 'practice_set',
        object_id: 'basket1',
        dedupe_key: 'batch-1',
        content_digest: 'sha256:content',
        status: 'outcome_unknown',
        receipts: [receipt],
        created_at: 1,
        updated_at: 1,
      },
    })
    h.deliveryQuerySpy.mockResolvedValue({
      batch_id: 'batch-1',
      agent_name: 'k12-xiaoming',
      object_kind: 'practice_set',
      object_id: 'basket1',
      dedupe_key: 'batch-1',
      content_digest: 'sha256:content',
      status: 'delivered',
      receipts: [{ ...receipt, status: 'delivered' }],
      created_at: 1,
      updated_at: 2,
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-finalize-send"]').trigger('click')
    await flushPromises()

    expect(h.finalizeSpy).toHaveBeenCalledWith('k12-xiaoming', 'basket1', 'send', undefined)
    expect(w.find('[data-testid="ps-finalize-send"]').text()).toBe('发送中…')
    expect(w.text()).not.toMatch(/选择.*(钉钉|飞书|接收人|发送目标)/)
    await vi.runOnlyPendingTimersAsync()
    await flushPromises()
    expect(h.deliveryQuerySpy).toHaveBeenCalledWith('k12-xiaoming', 'batch-1')
    expect(w.find('[data-testid="ps-finalize-send"]').text()).toBe('发送成功')
    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(h.toastInfo).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('全阻断篮 → 固化禁用并提示', async () => {
    h.listSpy.mockResolvedValue({ items: [basket([item('s1', '阻断', '科学', 'needs_review')])] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-finalize-print"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('还没有已验证的题')
  })

  it('打印历史：paper_no 徽标 + 三态呈现（graded→已批改）+ finalized_at 倒序', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        historySet({ record_id: 'old', title: '旧卷', finalized_at: 100, paper_no: 'P-2628-01' }),
        historySet({
          record_id: 'new',
          title: '新卷',
          finalized_at: 200,
          paper_no: 'P-2629-02',
          status: 'assigned',
          status_label: '待完成',
        }),
      ],
    })
    const w = render()
    await flushPromises()
    const cards = w.findAll('.k12ps__hcard')
    expect(cards[0]!.text()).toContain('新卷') // 倒序：新在前
    expect(cards[0]!.text()).toContain('P-2629-02')
    expect(cards[0]!.text()).toContain('待完成') // assigned → 三态「待完成」
    expect(cards[1]!.text()).toContain('已批改') // graded → 三态「已批改」
    // 界面不展示六态时间轴（§3.8）
    expect(w.find('.practice-timeline').exists()).toBe(false)
  })

  it('assigned 回传必须先选照片和照片覆盖题；空输入不调用 submit', async () => {
    h.listSpy.mockResolvedValue({
      items: [historySet({ status: 'assigned', status_label: '待完成' })],
    })
    const w = render()
    await flushPromises()
    await w
      .findAll('.k12ps__btn')
      .find((b) => b.text() === '回传作答')!
      .trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="ps-return-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-return-confirm"]').attributes('disabled')).toBeDefined()
    expect(h.submitSpy).not.toHaveBeenCalled()

    const file = new File(['png'], 'answer.png', { type: 'image/png' })
    const input = w.find('[data-testid="ps-return-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q9"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(h.uploadSpy).toHaveBeenCalledWith('k12-xiaoming', file)
    expect(h.submitSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', {
      return_id: expect.any(String),
      item_ids: ['q9'],
      asset_id: 'asset://k12-xiaoming/return.png',
    })
  })

  it('DD-028：两批照片逐次追加并显示覆盖题号，第二批不覆盖第一批', async () => {
    const q1 = { ...item('q1', '第 1 题', '数学', 'verified'), paper_seq: 1 }
    const q2 = { ...item('q2', '第 2 题', '数学', 'verified'), paper_seq: 2 }
    const initial = historySet({ status: 'assigned', status_label: '待完成', items: [q1, q2] })
    const firstReturn = {
      return_id: 'return-1',
      asset_id: 'asset://k12-xiaoming/one.png',
      item_ids: ['q1'],
      returned_at: 1784300100,
    }
    const secondReturn = {
      return_id: 'return-2',
      asset_id: 'asset://k12-xiaoming/two.png',
      item_ids: ['q2'],
      returned_at: 1784300200,
    }
    h.listSpy.mockResolvedValue({ items: [initial] })
    h.submitSpy
      .mockResolvedValueOnce(
        historySet({
          status: 'submitted',
          status_label: '已回传',
          items: [{ ...q1, returned: true, return_ids: ['return-1'] }, q2],
          return_assets: [firstReturn],
        }),
      )
      .mockResolvedValueOnce(
        historySet({
          status: 'submitted',
          status_label: '已回传',
          items: [
            { ...q1, returned: true, return_ids: ['return-1'] },
            { ...q2, returned: true, return_ids: ['return-2'] },
          ],
          return_assets: [firstReturn, secondReturn],
        }),
      )

    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-return-open"]').trigger('click')
    let input = w.find('[data-testid="ps-return-file"]')
    const firstFile = new File(['one'], 'one.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [firstFile] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q1"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(w.findAll('[data-testid="ps-return-asset"]')).toHaveLength(1)
    expect(w.find('[data-testid="ps-return-asset"]').text()).toContain('照片 1')
    expect(w.find('[data-testid="ps-return-asset"]').text()).toContain('第 1 题')
    expect(w.find('[data-testid="ps-return-open"]').text()).toContain('继续上传')

    await w.find('[data-testid="ps-return-open"]').trigger('click')
    input = w.find('[data-testid="ps-return-file"]')
    const secondFile = new File(['two'], 'two.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [secondFile] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q2"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    const batches = w.findAll('[data-testid="ps-return-asset"]')
    expect(batches).toHaveLength(2)
    expect(batches[0]!.text()).toContain('照片 1')
    expect(batches[0]!.text()).toContain('第 1 题')
    expect(batches[1]!.text()).toContain('照片 2')
    expect(batches[1]!.text()).toContain('第 2 题')
  })

  it('DD-028：提交结果未知后原地重试复用同一 return_id 和已上传 asset，不重复上传', async () => {
    h.listSpy.mockResolvedValue({
      items: [historySet({ status: 'assigned', status_label: '待完成' })],
    })
    h.submitSpy.mockRejectedValueOnce(new Error('网络中断，结果未知')).mockResolvedValueOnce(
      historySet({
        status: 'submitted',
        status_label: '已回传',
        items: [
          {
            ...item('q9', '2.8×0.65=?', '数学', 'verified'),
            returned: true,
            return_ids: ['return-replay'],
          },
        ],
        return_assets: [
          {
            return_id: 'return-replay',
            asset_id: 'asset://k12-xiaoming/return.png',
            item_ids: ['q9'],
            returned_at: 1784300100,
          },
        ],
      }),
    )
    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-return-open"]').trigger('click')
    const file = new File(['png'], 'answer.png', { type: 'image/png' })
    const input = w.find('[data-testid="ps-return-file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await w.find('[data-testid="ps-return-item-q9"]').setValue(true)
    await w.find('[data-testid="ps-return-confirm"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="ps-return-error"]').text()).toContain('结果未知')
    const firstReq = h.submitSpy.mock.calls[0]![2] as { return_id: string }
    await w.find('[data-testid="ps-return-retry"]').trigger('click')
    await flushPromises()

    expect(h.uploadSpy).toHaveBeenCalledTimes(1)
    expect(h.submitSpy).toHaveBeenCalledTimes(2)
    expect((h.submitSpy.mock.calls[1]![2] as { return_id: string }).return_id).toBe(
      firstReq.return_id,
    )
  })

  it('无回传照片时只保留“手动记结果”兜底，且空结果不调用 grade', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        historySet({
          status: 'assigned',
          status_label: '待完成',
          items: [item('q9', '2.8×0.65=?', '数学', 'verified')],
          return_assets: [],
        }),
      ],
    })
    const w = render()
    await flushPromises()
    expect(w.findAll('button').some((button) => button.text() === '复批')).toBe(false)
    await w.find('[data-testid="ps-manual-grade-open"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="ps-grade-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="ps-grade-modal"]').text()).toContain('手动记结果')
    expect(w.find('[data-testid="ps-grade-confirm"]').attributes('disabled')).toBeDefined()
    expect(h.gradeSpy).not.toHaveBeenCalled()

    await w.find('[data-testid="ps-grade-correct-q9"]').setValue(true)
    await w.find('[data-testid="ps-grade-confirm"]').trigger('click')
    await flushPromises()
    expect(h.gradeSpy).toHaveBeenCalledWith('k12-xiaoming', 'hist1', [
      { item_id: 'q9', correct: true },
    ])
  })

  it('回传照片自动复批中显示原位进度，并轮询到可查看结果', async () => {
    vi.useFakeTimers()
    const queued = historySet({
      status: 'submitted',
      status_label: '已回传',
      items: [
        {
          ...item('q9', '2.8×0.65=?', '数学', 'verified'),
          returned: true,
          return_ids: ['return-auto'],
        },
      ],
      return_assets: [
        {
          return_id: 'return-auto',
          asset_id: 'asset://k12-xiaoming/answer.png',
          item_ids: ['q9'],
          returned_at: 1784300100,
          regrade_job_id: 'grade-job-1',
          regrade_status: 'queued',
        },
      ],
    })
    const completed = historySet({
      items: [
        {
          ...queued.items[0]!,
          result_correct: false,
          result_evidence: 'system_verified',
        },
      ],
      return_assets: [
        {
          ...queued.return_assets[0]!,
          regrade_status: 'completed',
          annotated_asset_id: 'asset://k12-xiaoming/annotated.png',
          result_markdown: '## 第 1 题\n\n孩子把小数点位置放错了。',
        },
      ],
    })
    h.listSpy.mockResolvedValueOnce({ items: [queued] }).mockResolvedValue({ items: [completed] })

    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-regrade-status"]').text()).toContain('正在自动复批')
    expect(w.find('[data-testid="ps-regrade-result-open"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(1_500)
    await flushPromises()
    expect(h.listSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="ps-regrade-result-open"]').exists()).toBe(true)
    w.unmount()
  })

  it('自动复批结果以批注原图和家长讲题说明为同一结果面', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        historySet({
          items: [
            {
              ...item('q9', '2.8×0.65=?', '数学', 'verified'),
              returned: true,
              return_ids: ['return-result'],
              result_correct: false,
              result_evidence: 'system_verified',
            },
          ],
          return_assets: [
            {
              return_id: 'return-result',
              asset_id: 'asset://k12-xiaoming/answer.png',
              item_ids: ['q9'],
              returned_at: 1784300100,
              regrade_job_id: 'grade-job-result',
              regrade_status: 'completed',
              annotated_asset_id: 'asset://k12-xiaoming/annotated.png',
              result_markdown:
                '## 第 1 题\n\n**错因：** 小数点位置放错。\n\n**家长这样讲：** 先估算。',
            },
          ],
        }),
      ],
    })

    const w = render()
    await flushPromises()
    await w.find('[data-testid="ps-regrade-result-open"]').trigger('click')
    await flushPromises()

    const modal = w.find('[data-testid="ps-regrade-result-modal"]')
    expect(modal.exists()).toBe(true)
    expect(modal.find('[data-testid="ps-regrade-annotated"]').attributes('src')).toContain(
      encodeURIComponent('asset://k12-xiaoming/annotated.png'),
    )
    expect(modal.find('[data-testid="ps-regrade-markdown"]').text()).toContain('家长这样讲')
    expect(modal.text()).toContain('1 题继续复习')
  })

  it('只有真实不确定项进入最小人工核对，其余系统结论不再询问家长', async () => {
    const q1 = {
      ...item('q1', '第 1 题', '数学', 'verified'),
      paper_seq: 1,
      returned: true,
      return_ids: ['return-review'],
      result_correct: true,
      result_evidence: 'system_verified' as const,
    }
    const q2 = {
      ...item('q2', '第 2 题', '数学', 'verified'),
      paper_seq: 2,
      returned: true,
      return_ids: ['return-review'],
    }
    h.listSpy.mockResolvedValue({
      items: [
        historySet({
          status: 'submitted',
          status_label: '已回传',
          items: [q1, q2],
          return_assets: [
            {
              return_id: 'return-review',
              asset_id: 'asset://k12-xiaoming/answer.png',
              item_ids: ['q1', 'q2'],
              returned_at: 1784300100,
              regrade_job_id: 'grade-job-review',
              regrade_status: 'needs_review',
              unresolved_item_ids: ['q2'],
            },
          ],
        }),
      ],
    })

    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="ps-regrade-review"]').text()).toContain('仅 1 题需要核对')
    await w.find('[data-testid="ps-regrade-manual"]').trigger('click')
    await flushPromises()

    const modal = w.find('[data-testid="ps-grade-modal"]')
    expect(modal.text()).toContain('第 2 题')
    expect(modal.text()).not.toContain('第 1 题')
    expect(modal.find('[data-testid="ps-grade-correct-q2"]').exists()).toBe(true)
    expect(modal.find('[data-testid="ps-grade-correct-q1"]').exists()).toBe(false)
  })
})
