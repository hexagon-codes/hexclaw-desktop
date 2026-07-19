import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12CreativeWorksPanel from '../views/K12CreativeWorksPanel.vue'
import type { CreativeWorkDTO } from '@/api/k12'

// 作品面板（PRD §3.10）：直连 /creative-works*，只点评不打分不代写（INV-011）。
// 验证：列表/类型过滤、点评走 feedback、修改稿走 revision、版本时间线渲染、
// 添加作品弹窗（原型 5326-5361）、KPI/点评规则（原型 2570-2586）、点评联动出口（好句入积累/错处入错题）。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  createSpy: vi.fn(),
  feedbackSpy: vi.fn(),
  generateFeedbackSpy: vi.fn(),
  revisionSpy: vi.fn(),
  archiveSpy: vi.fn(),
  accumSpy: vi.fn(),
  recordMistakeSpy: vi.fn(),
  uploadSpy: vi.fn(),
  createOCRSpy: vi.fn(),
  retryOCRSpy: vi.fn(),
  confirmOCRSpy: vi.fn(),
  sendSpy: vi.fn(),
  cardDoneSpy: vi.fn(),
  printSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListCreativeWorks: (agent: string, type?: string) => h.listSpy(agent, type),
  k12CreateCreativeWork: (req: unknown) => h.createSpy(req),
  k12AttachWorkFeedback: (a: string, id: string, fb: string) => h.feedbackSpy(a, id, fb),
  k12GenerateWorkFeedback: (a: string, id: string, signal?: AbortSignal) =>
    h.generateFeedbackSpy(a, id, signal),
  k12SubmitWorkRevision: (
    a: string,
    id: string,
    c?: string,
    asset?: string,
    ocr?: { jobId: string; version: number; digest: string },
  ) => ocr === undefined
    ? (asset === undefined ? h.revisionSpy(a, id, c) : h.revisionSpy(a, id, c, asset))
    : h.revisionSpy(a, id, c, asset, ocr),
  k12ArchiveCreativeWork: (a: string, id: string) => h.archiveSpy(a, id),
  k12AddAccumulation: (req: unknown) => h.accumSpy(req),
  k12RecordMistake: (req: unknown) => h.recordMistakeSpy(req),
  k12UploadAsset: (a: string, f: File, p?: (n: number) => void, signal?: AbortSignal) =>
    h.uploadSpy(a, f, p, signal),
  k12CreateCreativeWorkOCR: (req: unknown) => h.createOCRSpy(req),
  k12RetryCreativeWorkOCR: (agent: string, jobId: string) => h.retryOCRSpy(agent, jobId),
  k12ConfirmCreativeWorkOCR: (agent: string, jobId: string, content: string) =>
    h.confirmOCRSpy(agent, jobId, content),
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://') ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}` : '',
  k12SendWorkFeedback: (a: string, id: string, kind?: string) => h.sendSpy(a, id, kind),
  k12MarkPracticeCardDone: (a: string, id: string) => h.cardDoneSpy(a, id),
}))
vi.mock('../export', () => ({
  printPracticePaper: (...args: unknown[]) => h.printSpy(...args),
  savePracticePaperPdf: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function work(over: Partial<CreativeWorkDTO> = {}): CreativeWorkDTO {
  return {
    record_id: 'w1', work_type: 'writing', title: '《春天的校园》', task: '写景',
    status: 'draft', status_label: '待点评',
    versions: [{ version_id: 'v1', content_markdown: '柳枝像绿色的丝带' }],
    ...over,
  }
}

function render() {
  return mount(K12CreativeWorksPanel, {
    props: { agentId: 'k12-xiaoming' },
    global: { plugins: [i18n()] },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function pickPhoto(w: ReturnType<typeof render>, file: File) {
  const input = w.find('[data-testid="cw-add-photo-input"]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
  await input.trigger('change')
}

beforeEach(() => {
  h.listSpy.mockReset()
  h.createSpy.mockReset().mockResolvedValue({ record_id: 'w-new', created: true })
  h.feedbackSpy.mockReset().mockResolvedValue(work({ status: 'feedback_ready', status_label: '已点评' }))
  h.generateFeedbackSpy.mockReset().mockResolvedValue(
    work({ status: 'feedback_ready', status_label: '已点评' }),
  )
  h.revisionSpy.mockReset().mockResolvedValue(work({ status: 'revised', status_label: '已修改' }))
  h.archiveSpy.mockReset().mockResolvedValue({ ok: true })
  h.accumSpy.mockReset().mockResolvedValue({ record_id: 'a1', created: true })
  h.recordMistakeSpy.mockReset().mockResolvedValue({ record_created: true, record_id: 'm1' })
  h.uploadSpy.mockReset().mockResolvedValue({ asset_id: 'asset://k12-xiaoming/abc.png', size: 3 })
  h.createOCRSpy.mockReset().mockResolvedValue({
    job_id: 'ocr-1', request_id: 'request-1', source_asset_id: 'asset://k12-xiaoming/abc.png',
    source_digest: 'asset-digest', status: 'awaiting_confirmation', ocr_raw: 'OCR 原稿',
    attempt_count: 1, created_at: 100, updated_at: 101,
  })
  h.retryOCRSpy.mockReset().mockResolvedValue({
    job_id: 'ocr-1', request_id: 'request-1', source_asset_id: 'asset://k12-xiaoming/abc.png',
    source_digest: 'asset-digest', status: 'awaiting_confirmation', ocr_raw: '重试 OCR 原稿',
    attempt_count: 2, created_at: 100, updated_at: 102,
  })
  h.confirmOCRSpy.mockReset().mockResolvedValue({
    job_id: 'ocr-1', request_id: 'request-1', source_asset_id: 'asset://k12-xiaoming/abc.png',
    source_digest: 'asset-digest', status: 'confirmed', ocr_raw: 'OCR 原稿',
    confirmed_content: '家长修正稿', confirmed_version: 1, confirmed_digest: 'confirmed-digest',
    confirmed_at: 103, attempt_count: 1, created_at: 100, updated_at: 103,
  })
  h.sendSpy.mockReset().mockResolvedValue({ ok: true, target: '钉钉 · 妈妈' })
  h.cardDoneSpy.mockReset().mockResolvedValue(work())
  h.printSpy.mockReset().mockResolvedValue(true)
})

describe('K12CreativeWorksPanel · 作品', () => {
  it('空 → 空态文案', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-empty"]').exists()).toBe(true)
  })

  it('列表加载失败显示可见错误和原地重试，重试成功后恢复作品', async () => {
    h.listSpy
      .mockRejectedValueOnce(new Error('作品服务暂不可用'))
      .mockResolvedValueOnce({ items: [work()] })
    const w = render()
    await flushPromises()

    expect(w.find('[data-testid="cw-error"]').text()).toContain('作品服务暂不可用')
    await w.find('[data-testid="cw-load-retry"]').trigger('click')
    await flushPromises()

    expect(h.listSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="cw-error"]').exists()).toBe(false)
    expect(w.text()).toContain('《春天的校园》')
  })

  it('按 agentId 隔离拉取', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    render()
    await flushPromises()
    expect(h.listSpy).toHaveBeenCalledWith('k12-xiaoming', undefined)
  })

  it('切换孩子时作品列表最后一次请求获胜，旧孩子晚到结果不得覆盖新孩子', async () => {
    const oldList = deferred<{ items: CreativeWorkDTO[] }>()
    const newList = deferred<{ items: CreativeWorkDTO[] }>()
    h.listSpy.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise)
    const w = render()
    await w.setProps({ agentId: 'k12-xiaohong' })
    newList.resolve({ items: [work({ title: '小红的新作品' })] })
    await flushPromises()
    oldList.resolve({ items: [work({ title: '小明的旧作品' })] })
    await flushPromises()

    expect(w.text()).toContain('小红的新作品')
    expect(w.text()).not.toContain('小明的旧作品')
  })

  it('渲染作品 + 版本时间线', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-list"]').exists()).toBe(true)
    expect(w.text()).toContain('《春天的校园》')
    expect(w.text()).toContain('v1')
    expect(w.text()).toContain('柳枝像绿色的丝带')
  })

  it('版本正文和点评用 Markdown 渲染，并显示 feedback_source / feedback_skill', async () => {
    h.listSpy.mockResolvedValue({ items: [work({
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [{
        version_id: 'v1',
        content_markdown: '**春天**的校园',
        feedback: '建议补充 `声音` 细节',
        feedback_source: 'ai',
        feedback_skill: 'writing-feedback@1.0.0/embedded',
      }],
    })] })
    const w = render()
    await flushPromises()

    expect(w.find('[data-testid="cw-version-content"] strong').text()).toBe('春天')
    expect(w.find('[data-testid="cw-version-feedback"] code').text()).toBe('声音')
    const provenance = w.find('[data-testid="cw-feedback-provenance"]')
    expect(provenance.text()).toContain('AI 生成')
    expect(provenance.text()).toContain('writing-feedback@1.0.0/embedded')
  })

  it('结构化点评作为 canonical UI 投影，展示观察、限制、建议和允许动作', async () => {
    h.listSpy.mockResolvedValue({ items: [work({
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [{
        version_id: 'v1',
        feedback: '旧兼容投影不应成为唯一事实源',
        structured_feedback: {
          feedback_id: 'feedback-1',
          version_id: 'v1',
          feedback_type: 'writing',
          evidence_refs: ['content-ref:sha256:abc#full'],
          observations: [{ dimension: 'expression', evidence: '使用了“绿色的丝带”这个可见比喻。' }],
          source_snapshot: {
            source: 'ai',
            method_ref: 'writing-feedback@1.0.0/embedded',
            capability: 'evidence_based_feedback',
          },
          limitations: '仅依据家长确认后的本版原文。',
          suggestions: ['由孩子补充一个听觉细节。'],
          allowed_actions: ['send', 'collect', 'record_language_issue'],
          projection_markdown: '### 观察\n\n使用了“绿色的丝带”这个可见比喻。',
        },
      }],
    })] })
    const w = render()
    await flushPromises()

    const feedback = w.get('[data-testid="cw-structured-feedback"]')
    expect(feedback.text()).toContain('使用了“绿色的丝带”这个可见比喻。')
    expect(feedback.text()).toContain('仅依据家长确认后的本版原文。')
    expect(feedback.text()).toContain('由孩子补充一个听觉细节。')
    expect(feedback.text()).toContain('发送')
    expect(feedback.text()).toContain('收藏')
    expect(feedback.text()).toContain('记录语言问题')
    expect(feedback.text()).toContain('writing-feedback@1.0.0/embedded')
  })

  it('待点评 → 写点评走 feedback（非空才启用）', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()
    const submit = w.find('[data-testid="cw-feedback-submit"]')
    expect(submit.attributes('disabled')).toBeDefined() // 空输入禁用
    await w.find('[data-testid="cw-feedback-input"]').setValue('比喻好，可加感官细节')
    await submit.trigger('click')
    await flushPromises()
    expect(h.feedbackSpy).toHaveBeenCalledWith('k12-xiaoming', 'w1', '比喻好，可加感官细节')
  })

  it('已点评 → 提交修改稿走 revision', async () => {
    h.listSpy.mockResolvedValue({ items: [work({ status: 'feedback_ready', status_label: '已点评' })] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-revision-input"]').setValue('柳枝像绿色的丝带，风一吹沙沙响')
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    await flushPromises()
    expect(h.revisionSpy).toHaveBeenCalledWith('k12-xiaoming', 'w1', '柳枝像绿色的丝带，风一吹沙沙响')
  })

  it('修改稿可只上传照片；快速改选时中止 A 且只提交最后成功的 B asset_id', async () => {
    h.listSpy.mockResolvedValue({
      items: [work({ work_type: 'art', status: 'feedback_ready', status_label: '已点评' })],
    })
    const a = deferred<{ asset_id: string; size: number }>()
    const b = deferred<{ asset_id: string; size: number }>()
    h.uploadSpy.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const w = render()
    await flushPromises()
    const input = w.find('[data-testid="cw-revision-photo-input"]')

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['a'], 'revision-a.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['b'], 'revision-b.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    b.resolve({ asset_id: 'asset://k12-xiaoming/revision-b.png', size: 3 })
    await flushPromises()
    a.resolve({ asset_id: 'asset://k12-xiaoming/revision-a.png', size: 3 })
    await flushPromises()
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    await flushPromises()

    expect((h.uploadSpy.mock.calls[0]![3] as AbortSignal | undefined)?.aborted).toBe(true)
    expect(h.revisionSpy).toHaveBeenCalledWith(
      'k12-xiaoming',
      'w1',
      undefined,
      'asset://k12-xiaoming/revision-b.png',
    )
  })

  it('修改稿照片 A 成功后改选 B，B 失败不得沿用 A 提交', async () => {
    h.listSpy.mockResolvedValue({
      items: [work({ work_type: 'art', status: 'feedback_ready', status_label: '已点评' })],
    })
    h.uploadSpy
      .mockResolvedValueOnce({ asset_id: 'asset://k12-xiaoming/revision-a.png', size: 3 })
      .mockRejectedValueOnce(new Error('B 上传失败'))
    const w = render()
    await flushPromises()
    const input = w.find('[data-testid="cw-revision-photo-input"]')

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['a'], 'revision-a.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['b'], 'revision-b.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()

    expect(w.find('[data-testid="cw-revision-photo-error"]').text()).toContain('B 上传失败')
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    expect(h.revisionSpy).not.toHaveBeenCalled()
  })

  it('作文修改稿照片也必须完成 OCR 校对确认，并把确认版本证据提交给 revision', async () => {
    h.listSpy.mockResolvedValue({
      items: [work({ status: 'feedback_ready', status_label: '已点评' })],
    })
    const w = render()
    await flushPromises()
    const input = w.find('[data-testid="cw-revision-photo-input"]')

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['revision'], 'revision.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()

    expect(h.createOCRSpy).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'k12-xiaoming',
      source_asset_id: 'asset://k12-xiaoming/abc.png',
    }))
    expect(w.find('[data-testid="cw-revision-ocr-awaiting"]').exists()).toBe(true)
    expect((w.find('[data-testid="cw-revision-input"]').element as HTMLTextAreaElement).value)
      .toBe('OCR 原稿')
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeDefined()

    await w.find('[data-testid="cw-revision-input"]').setValue('家长校对后的修改稿')
    h.confirmOCRSpy.mockResolvedValueOnce({
      job_id: 'ocr-1', request_id: 'request-1',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'confirmed', ocr_raw: 'OCR 原稿', confirmed_content: '家长校对后的修改稿',
      confirmed_version: 2, confirmed_digest: 'revision-digest-v2', confirmed_at: 104,
      attempt_count: 1, created_at: 100, updated_at: 104,
    })
    await w.find('[data-testid="cw-revision-ocr-confirm"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="cw-revision-ocr-confirmed"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    await flushPromises()
    expect(h.revisionSpy).toHaveBeenCalledWith(
      'k12-xiaoming',
      'w1',
      '家长校对后的修改稿',
      'asset://k12-xiaoming/abc.png',
      { jobId: 'ocr-1', version: 2, digest: 'revision-digest-v2' },
    )
  })

  it('类型过滤 → 只拉对应类型', async () => {
    h.listSpy.mockResolvedValue({ items: [work(), work({ record_id: 'w2', work_type: 'art', title: '画作' })] })
    const w = render()
    await flushPromises()
    // 客户端过滤：点「美术作品」只剩 art
    await w.findAll('.k12cw__filter button').find((b) => b.text() === k12Zh.works.art)!.trigger('click')
    expect(w.text()).toContain('画作')
    expect(w.text()).not.toContain('《春天的校园》')
  })
})

describe('K12CreativeWorksPanel · KPI 行 + 点评规则（原型 2570-2586）', () => {
  it('三 KPI 从列表计算：全部 / 已点评（任一版本带 feedback）/ 待点评', async () => {
    h.listSpy.mockResolvedValue({ items: [
      work(), // draft，无 feedback → 待点评
      work({ record_id: 'w2', status: 'feedback_ready', status_label: '已点评',
        versions: [{ version_id: 'v1', content_markdown: 'x', feedback: '比喻好' }] }),
      work({ record_id: 'w3', work_type: 'art', title: '画作',
        versions: [{ version_id: 'v1', feedback: '构图清楚' }] }),
    ] })
    const w = render()
    await flushPromises()
    const kpis = w.findAll('[data-testid="cw-kpis"] .k12cw__kpi')
    expect(kpis.length).toBe(3)
    expect(kpis[0]!.text()).toContain('3') // 全部作品
    expect(kpis[1]!.text()).toContain('2') // 已点评
    expect(kpis[2]!.text()).toContain('1') // 待点评
  })

  it('点评规则 notice 照原型 2582 文案（不打分不代写边界）', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    const rules = w.find('[data-testid="cw-rules"]')
    expect(rules.exists()).toBe(true)
    expect(rules.text()).toContain('比对题目要求、原稿与修改稿')
    expect(rules.text()).toContain('只描述画面中可见的构图、色彩与表达')
    expect(rules.text()).toContain('不替孩子完成作品')
  })

  it('AI 点评显示生成中；失败原地可重试，只有真实成功响应才展示点评', async () => {
    const pending = deferred<CreativeWorkDTO>()
    const ready = work({
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [{
        version_id: 'v1',
        content_markdown: '柳枝像绿色的丝带',
        feedback: '比喻具体，可再补充声音细节',
        feedback_source: 'ai',
        feedback_skill: 'writing-feedback@1.0.0/embedded',
      }],
    })
    h.listSpy.mockResolvedValue({ items: [work()] })
    h.generateFeedbackSpy.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ready)
    const w = render()
    await flushPromises()

    await w.find('[data-testid="cw-feedback-generate"]').trigger('click')
    expect(w.find('[data-testid="cw-feedback-generating"]').exists()).toBe(true)
    pending.reject(new Error('模型响应超时'))
    await flushPromises()

    expect(w.find('[data-testid="cw-feedback-generate-error"]').text()).toContain('模型响应超时')
    expect(w.find('[data-testid="cw-feedback-generate-retry"]').exists()).toBe(true)
    expect(w.text()).not.toContain('比喻具体，可再补充声音细节')

    await w.find('[data-testid="cw-feedback-generate-retry"]').trigger('click')
    await flushPromises()
    expect(h.generateFeedbackSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="cw-feedback-generate-error"]').exists()).toBe(false)
    expect(w.text()).toContain('比喻具体，可再补充声音细节')
  })

  it('AI 点评切换孩子时真正 abort 旧的 240s 请求', async () => {
    const pending = deferred<CreativeWorkDTO>()
    h.listSpy.mockResolvedValue({ items: [work()] })
    h.generateFeedbackSpy.mockReturnValueOnce(pending.promise)
    const w = render()
    await flushPromises()

    await w.find('[data-testid="cw-feedback-generate"]').trigger('click')
    const signal = h.generateFeedbackSpy.mock.calls[0]![2] as AbortSignal
    expect(signal.aborted).toBe(false)
    await w.setProps({ agentId: 'k12-xiaohong' })

    expect(signal.aborted).toBe(true)
    expect(w.find('[data-testid="cw-feedback-generating"]').exists()).toBe(false)
  })

})

describe('K12CreativeWorksPanel · 添加作品弹窗（原型 5326-5361）', () => {
  it('「添加作品」按钮打开弹窗；默认语文写作，显示原稿字段', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-draft"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-intent"]').exists()).toBe(false)
  })

  it('类型切到美术 → 原稿字段换成创作意图；任务标签随类型变化', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    expect(w.text()).toContain(k12Zh.works.taskLabelWriting)
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')
    expect(w.find('[data-testid="cw-add-draft"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-add-intent"]').exists()).toBe(true)
    expect(w.text()).toContain(k12Zh.works.taskLabelArt)
  })

  it('必填校验：写作缺原稿时提交禁用；补齐后可提交', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    const submit = w.find('[data-testid="cw-add-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-add-title"]').setValue('《春天的校园》')
    await w.find('[data-testid="cw-add-task"]').setValue('写校园春景')
    expect(submit.attributes('disabled'), '写作缺原稿仍禁用').toBeDefined()
    await w.find('[data-testid="cw-add-draft"]').setValue('柳枝像绿色的丝带')
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('提交写作 → k12CreateCreativeWork 带 content_markdown，无 intent；成功后关弹窗并刷新', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-title"]').setValue('《春天的校园》')
    await w.find('[data-testid="cw-add-task"]').setValue('写校园春景')
    await w.find('[data-testid="cw-add-draft"]').setValue('柳枝像绿色的丝带')
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith({
      agent: 'k12-xiaoming', work_type: 'writing', title: '《春天的校园》',
      task: '写校园春景', intent: undefined, content_markdown: '柳枝像绿色的丝带',
    })
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
    expect(h.listSpy.mock.calls.length, '提交后重拉列表').toBeGreaterThanOrEqual(2)
  })

  it('提交美术 → 带 intent，不带 content_markdown（美术无必填原稿）', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')
    await w.find('[data-testid="cw-add-title"]').setValue('《雨后的校园》')
    await w.find('[data-testid="cw-add-task"]').setValue('水彩写生')
    await w.find('[data-testid="cw-add-intent"]').setValue('雨后安静感')
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith({
      agent: 'k12-xiaoming', work_type: 'art', title: '《雨后的校园》',
      task: '水彩写生', intent: '雨后安静感', content_markdown: undefined,
    })
  })

  it('作文照片：上传后 OCR 中→可编辑预览→家长确认，确认前不得保存', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const pending = deferred<Record<string, unknown>>()
    h.createOCRSpy.mockReturnValueOnce(pending.promise)
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-title"]').setValue('《春天的校园》')
    await w.find('[data-testid="cw-add-task"]').setValue('写校园春景')
    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] },
    })
    await flushPromises()

    expect(w.find('[data-testid="cw-ocr-processing"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    pending.resolve({
      job_id: 'ocr-photo-1', request_id: 'request-photo-1',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'awaiting_confirmation', ocr_raw: '柳枝象绿色丝带', attempt_count: 1,
      created_at: 100, updated_at: 101,
    })
    await flushPromises()

    expect((w.find('[data-testid="cw-add-draft"]').element as HTMLTextAreaElement).value)
      .toBe('柳枝象绿色丝带')
    expect(w.find('[data-testid="cw-ocr-awaiting"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-add-draft"]').setValue('柳枝像绿色丝带')
    h.confirmOCRSpy.mockResolvedValueOnce({
      job_id: 'ocr-photo-1', request_id: 'request-photo-1',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'confirmed', ocr_raw: '柳枝象绿色丝带', confirmed_content: '柳枝像绿色丝带',
      confirmed_version: 1, confirmed_digest: 'digest-v1', confirmed_at: 103,
      attempt_count: 1, created_at: 100, updated_at: 103,
    })
    await w.find('[data-testid="cw-ocr-confirm"]').trigger('click')
    await flushPromises()

    expect(h.confirmOCRSpy).toHaveBeenCalledWith('k12-xiaoming', 'ocr-photo-1', '柳枝像绿色丝带')
    expect(w.find('[data-testid="cw-ocr-confirmed"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith(expect.objectContaining({
      source_asset_id: 'asset://k12-xiaoming/abc.png',
      content_markdown: '柳枝像绿色丝带',
      ocr_job_id: 'ocr-photo-1', ocr_version: 1, ocr_confirmed_digest: 'digest-v1',
    }))
  })

  it('作文 OCR 失败：原位可重试，也可手工粘贴后确认', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    h.createOCRSpy.mockResolvedValueOnce({
      job_id: 'ocr-failed', request_id: 'request-failed',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'failed', error_message: '视觉模型超时', attempt_count: 1,
      created_at: 100, updated_at: 101,
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] },
    })
    await flushPromises()

    expect(w.find('[data-testid="cw-ocr-error"]').text()).toContain('视觉模型超时')
    expect(w.find('[data-testid="cw-ocr-retry"]').exists()).toBe(true)
    await w.find('[data-testid="cw-ocr-retry"]').trigger('click')
    await flushPromises()
    expect(h.retryOCRSpy).toHaveBeenCalledWith('k12-xiaoming', 'ocr-failed')
    expect((w.find('[data-testid="cw-add-draft"]').element as HTMLTextAreaElement).value)
      .toBe('重试 OCR 原稿')

    // A second failed job can skip model retry and use the documented manual-paste fallback.
    h.createOCRSpy.mockResolvedValueOnce({
      job_id: 'ocr-manual', request_id: 'request-manual',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'failed', error_message: '仍无法识别', attempt_count: 1,
      created_at: 110, updated_at: 111,
    })
    await pickPhoto(w, new File(['new-image'], 'manual.png', { type: 'image/png' }))
    await flushPromises()
    await w.find('[data-testid="cw-add-draft"]').setValue('家长手工粘贴的正文')
    h.confirmOCRSpy.mockResolvedValueOnce({
      job_id: 'ocr-manual', request_id: 'request-manual',
      source_asset_id: 'asset://k12-xiaoming/abc.png', source_digest: 'asset-digest',
      status: 'confirmed', confirmed_content: '家长手工粘贴的正文', confirmed_version: 1,
      confirmed_digest: 'manual-digest', confirmed_at: 112, attempt_count: 1,
      created_at: 110, updated_at: 112,
    })
    await w.find('[data-testid="cw-ocr-confirm"]').trigger('click')
    await flushPromises()
    expect(h.confirmOCRSpy).toHaveBeenLastCalledWith(
      'k12-xiaoming', 'ocr-manual', '家长手工粘贴的正文',
    )
  })

  // 20260718 控件统一（原型 creativeWorkDropzone）：弃裸选择按钮，改知识库「添加文档」
  // 同款拖放区——拖放或点击选择，dragover 有态，drop 复用真实上传管线（k12UploadAsset）。
  it('照片区为拖放区：拖放或点击选择 + 隐藏 file input', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    const drop = w.find('[data-testid="cw-add-photo"]')
    expect(drop.exists()).toBe(true)
    expect(drop.classes()).toContain('k12cw__drop')
    expect(drop.text()).toContain('拖放或点击')
    expect(w.find('[data-testid="cw-add-photo-input"]').exists()).toBe(true)
  })

  it('拖放图片到 dropzone → 走真实上传管线（k12UploadAsset）', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    const drop = w.find('[data-testid="cw-add-photo"]')
    const file = new File(['img'], 'draft.png', { type: 'image/png' })
    await drop.trigger('dragover')
    expect(drop.classes(), 'dragover 有态').toContain('k12cw__drop--over')
    await drop.trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()
    expect(h.uploadSpy).toHaveBeenCalledTimes(1)
    expect(h.uploadSpy.mock.calls[0]![0]).toBe('k12-xiaoming')
    expect((h.uploadSpy.mock.calls[0]![1] as File).name).toBe('draft.png')
    // 上传成功后 dropzone 让位给预览态
    expect(w.find('[data-testid="cw-photo-preview"]').exists()).toBe(true)
  })

  it('拖放非图片文件 → 拒收不上传', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    await w.find('[data-testid="cw-add-photo"]').trigger('drop', { dataTransfer: { files: [file] } })
    await flushPromises()
    expect(h.uploadSpy).not.toHaveBeenCalled()
  })

  it('照片 A 上传成功后改选 B，B 失败必须阻断保存；移除后才允许纯文本保存', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    h.uploadSpy
      .mockResolvedValueOnce({ asset_id: 'asset://k12-xiaoming/a.png', size: 3 })
      .mockRejectedValueOnce(new Error('B 上传失败'))
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')
    await w.find('[data-testid="cw-add-title"]').setValue('画作')
    await w.find('[data-testid="cw-add-task"]').setValue('水彩')

    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'a.png', { type: 'image/png' })] },
    })
    await flushPromises()
    await pickPhoto(w, new File(['b'], 'b.png', { type: 'image/png' }))
    await flushPromises()
    expect(w.find('[data-testid="cw-photo-error"]').text()).toContain('B 上传失败')
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).not.toHaveBeenCalled()

    await w.find('[data-testid="cw-photo-remove"]').trigger('click')
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith(expect.objectContaining({ source_asset_id: undefined }))
  })

  it('快速改选照片时最后一次选择获胜，旧上传晚返回也不得覆盖新 asset_id', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const a = deferred<{ asset_id: string; size: number }>()
    const b = deferred<{ asset_id: string; size: number }>()
    h.uploadSpy.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')
    await w.find('[data-testid="cw-add-title"]').setValue('画作')
    await w.find('[data-testid="cw-add-task"]').setValue('水彩')

    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['a'], 'a.png', { type: 'image/png' })] },
    })
    await pickPhoto(w, new File(['b'], 'b.png', { type: 'image/png' }))
    b.resolve({ asset_id: 'asset://k12-xiaoming/b.png', size: 3 })
    await flushPromises()
    a.resolve({ asset_id: 'asset://k12-xiaoming/a.png', size: 3 })
    await flushPromises()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()

    expect((h.uploadSpy.mock.calls[0]![3] as AbortSignal | undefined)?.aborted).toBe(true)
    expect(h.createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source_asset_id: 'asset://k12-xiaoming/b.png' }),
    )
  })
})

describe('K12CreativeWorksPanel · 点评联动出口（§3.10，写作 · 已点评）', () => {
  const readyWriting = () => work({
    status: 'feedback_ready', status_label: '已点评',
    versions: [{ version_id: 'v1', content_markdown: '柳枝像绿色的丝带', feedback: '比喻好' }],
  })

  it('feedback_ready 写作卡显示「好句加入积累」「确认并记入错题」', async () => {
    h.listSpy.mockResolvedValue({ items: [readyWriting()] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-accum-open"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-mistake-open"]').exists()).toBe(true)
  })

  it('美术卡不显示联动按钮（积累/错题出口只属于写作点评）', async () => {
    h.listSpy.mockResolvedValue({ items: [work({
      work_type: 'art', status: 'feedback_ready', status_label: '已点评',
      versions: [{ version_id: 'v1', feedback: '构图清楚' }],
    })] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-accum-open"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-mistake-open"]').exists()).toBe(false)
  })

  it('观察练习卡打印失败显示可见错误和原地重试，重试成功后清除错误', async () => {
    h.listSpy.mockResolvedValue({ items: [work({
      work_type: 'art',
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [{
        version_id: 'v1',
        feedback: '构图清楚',
        practice_card: '观察远近层次并画三棵树',
      }],
    })] })
    h.printSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const w = render()
    await flushPromises()

    await w.find('[data-testid="cw-card-print"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-card-print-error"]').text()).toContain('打印失败')
    await w.find('[data-testid="cw-card-print-retry"]').trigger('click')
    await flushPromises()

    expect(h.printSpy).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="cw-card-print-error"]').exists()).toBe(false)
  })

  it('好句加入积累：展开输入 → 确认调 k12AddAccumulation(语文·写作素材·带作品来源)', async () => {
    h.listSpy.mockResolvedValue({ items: [readyWriting()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-accum-open"]').trigger('click')
    const submit = w.find('[data-testid="cw-accum-submit"]')
    expect(submit.attributes('disabled'), '空输入禁用').toBeDefined()
    await w.find('[data-testid="cw-accum-input"]').setValue('柳枝像绿色的丝带，在春风里轻轻摆动。')
    await submit.trigger('click')
    await flushPromises()
    expect(h.accumSpy).toHaveBeenCalledWith({
      agent: 'k12-xiaoming', subject: '语文', entry_type: '写作素材',
      content: '柳枝像绿色的丝带，在春风里轻轻摆动。', source: '作品点评 · 《春天的校园》',
    })
  })

  it('确认并记入错题：展开输入 → 确认调 k12RecordMistake(语文，grade 留空由后端回填)', async () => {
    h.listSpy.mockResolvedValue({ items: [readyWriting()] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-mistake-open"]').trigger('click')
    await w.find('[data-testid="cw-mistake-input"]').setValue('习作中「轻轻的吹」用字待修改')
    await w.find('[data-testid="cw-mistake-submit"]').trigger('click')
    await flushPromises()
    expect(h.recordMistakeSpy).toHaveBeenCalledWith({
      agent: 'k12-xiaoming', subject: '语文', grade: '', problem: '习作中「轻轻的吹」用字待修改',
    })
  })
})
