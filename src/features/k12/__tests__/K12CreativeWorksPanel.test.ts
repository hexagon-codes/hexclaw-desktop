import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import K12CreativeWorksPanel from '../views/K12CreativeWorksPanel.vue'
import type { CreativeWorkDTO } from '@/api/k12'
import apiSource from '@/api/k12.ts?raw'

// 作品面板（PRD §3.10）：纯文本走 /creative-works*，带图手工录入走 ImageTaskDispatch；
// 只点评不打分不代写（INV-011）。
// 验证：列表/类型过滤、保存/上传后由服务端自动点评、修改稿走 revision、版本时间线渲染，
// 以及详情仅保留最新点评的重新生成入口。
const h = vi.hoisted(() => ({
  listSpy: vi.fn(),
  createSpy: vi.fn(),
  generateFeedbackSpy: vi.fn(),
  revisionSpy: vi.fn(),
  uploadSpy: vi.fn(),
  createImageTaskSpy: vi.fn(),
  getImageTaskSpy: vi.fn(),
  getImageTaskResultSpy: vi.fn(),
  confirmImageTaskSpy: vi.fn(),
  retryImageTaskSpy: vi.fn(),
  cancelImageTaskSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListCreativeWorks: (agent: string, type?: string) => h.listSpy(agent, type),
  k12CreateCreativeWork: (req: unknown) => h.createSpy(req),
  k12GenerateWorkFeedback: (...args: unknown[]) => h.generateFeedbackSpy(...args),
  k12SubmitWorkRevision: (
    a: string,
    id: string,
    c?: string,
    asset?: string,
    ocr?: { jobId: string; version: number; digest: string },
  ) =>
    ocr === undefined
      ? asset === undefined
        ? h.revisionSpy(a, id, c)
        : h.revisionSpy(a, id, c, asset)
      : h.revisionSpy(a, id, c, asset, ocr),
  k12UploadAsset: (a: string, f: File, p?: (n: number) => void, signal?: AbortSignal) =>
    h.uploadSpy(a, f, p, signal),
  k12CreateImageTask: (req: unknown) => h.createImageTaskSpy(req),
  k12GetImageTask: (agent: string, dispatchId: string) => h.getImageTaskSpy(agent, dispatchId),
  k12GetImageTaskResult: (agent: string, dispatchId: string) =>
    h.getImageTaskResultSpy(agent, dispatchId),
  k12ConfirmImageTask: (dispatchId: string, req: unknown) => h.confirmImageTaskSpy(dispatchId, req),
  k12RetryImageTask: (dispatchId: string, req: unknown) => h.retryImageTaskSpy(dispatchId, req),
  k12CancelImageTask: (dispatchId: string, req: unknown) => h.cancelImageTaskSpy(dispatchId, req),
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://')
      ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}`
      : '',
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh } },
  })
}

function work(over: Partial<CreativeWorkDTO> = {}): CreativeWorkDTO {
  return {
    record_id: 'w1',
    work_type: 'writing',
    title: '《春天的校园》',
    task: '写景',
    status: 'draft',
    status_label: '待点评',
    versions: [{ version_id: 'v1', content_markdown: '柳枝像绿色的丝带' }],
    ...over,
  }
}

type ManualEntry =
  | { kind: 'new_work'; task_intent: 'writing' | 'artwork' }
  | {
      kind: 'revision'
      task_intent: 'writing' | 'artwork'
      work_id: string
      base_version_id: string
    }

type ManualCreativeStatus =
  | 'preparing'
  | 'awaiting_confirmation'
  | 'ready'
  | 'promoted'
  | 'failed'
  | 'cancelled'

const manualDispatches = new Map<string, Record<string, any>>()

function manualCreativeDispatch(
  entry: ManualEntry,
  status: ManualCreativeStatus,
  {
    dispatchId = `creative-dispatch-${manualDispatches.size + 1}`,
    version = 1,
    canonicalContent = entry.task_intent === 'writing' ? 'OCR 原稿' : undefined,
  }: { dispatchId?: string; version?: number; canonicalContent?: string } = {},
) {
  const dispatch = {
    dispatch_id: dispatchId,
    task_intent: entry.task_intent,
    status:
      status === 'awaiting_confirmation'
        ? 'awaiting_confirmation'
        : status === 'failed'
          ? 'failed'
          : status === 'cancelled'
            ? 'cancelled'
            : 'routed',
    intent_evidence: ['parent_selected'],
    intent_confidence: 1,
    confirmation_candidates: [],
    target: { type: 'creative_work_intake', id: `intake-${dispatchId}` },
    target_projection: {
      kind: 'creative',
      intake_id: `intake-${dispatchId}`,
      work_type: entry.task_intent === 'writing' ? 'writing' : 'art',
      status,
      entry_kind: entry.kind,
      promotion_policy: 'explicit_commit',
      commit_required: status !== 'promoted',
      commit_state: status === 'promoted' ? 'committed' : 'pending',
      canonical_version: canonicalContent ? version : undefined,
      canonical_content: canonicalContent,
      ...(status === 'promoted'
        ? {
            work: {
              work_id: entry.kind === 'revision' ? entry.work_id : 'w-new',
              display_name: entry.task_intent === 'writing' ? '语文写作' : '美术作品',
            },
          }
        : {}),
    },
    progress: { operation: 'promotion', state: status },
    version,
    created_at: 100,
    updated_at: 101,
    _entry: entry,
  }
  manualDispatches.set(dispatchId, dispatch)
  return dispatch
}

function imageTaskCreateResponse(req: Record<string, any>) {
  const entry = req.creative_entry as ManualEntry
  const status = entry.task_intent === 'writing' ? 'awaiting_confirmation' : 'ready'
  return { created: true, dispatch: manualCreativeDispatch(entry, status) }
}

function imageTaskConfirmResponse(dispatchId: string, req: Record<string, any>) {
  const current = manualDispatches.get(dispatchId)
  const entry = current?._entry as ManualEntry
  const action = req.creative?.action
  const status = action === 'commit' ? 'promoted' : 'ready'
  const canonicalContent =
    action === 'freeze_ocr'
      ? req.creative.canonical_content
      : current?.target_projection?.canonical_content
  return {
    dispatch: manualCreativeDispatch(entry, status, {
      dispatchId,
      version: Number(current?.version ?? 1) + 1,
      canonicalContent,
    }),
  }
}

function render(attachToDocument = false) {
  return mount(K12CreativeWorksPanel, {
    props: { agentId: 'k12-xiaoming' },
    // Unit tests inspect the dialog through the component wrapper; the browser suite verifies
    // that production Teleport places the fixed overlay at the viewport root.
    global: { plugins: [i18n()], stubs: { Teleport: true } },
    ...(attachToDocument ? { attachTo: document.body } : {}),
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
  h.generateFeedbackSpy
    .mockReset()
    .mockResolvedValue(work({ status: 'feedback_ready', status_label: '已点评' }))
  h.revisionSpy.mockReset().mockResolvedValue(work({ status: 'revised', status_label: '已修改' }))
  h.uploadSpy.mockReset().mockResolvedValue({ asset_id: 'asset://k12-xiaoming/abc.png', size: 3 })
  manualDispatches.clear()
  h.createImageTaskSpy.mockReset().mockImplementation(imageTaskCreateResponse)
  h.getImageTaskSpy.mockReset().mockImplementation((_agent: string, dispatchId: string) => ({
    dispatch: manualDispatches.get(dispatchId),
  }))
  h.getImageTaskResultSpy.mockReset().mockResolvedValue({ result: null })
  h.confirmImageTaskSpy.mockReset().mockImplementation(imageTaskConfirmResponse)
  h.retryImageTaskSpy.mockReset().mockImplementation((dispatchId: string) => {
    const current = manualDispatches.get(dispatchId)
    const entry = current?._entry as ManualEntry
    return {
      dispatch: manualCreativeDispatch(
        entry,
        entry.task_intent === 'writing' ? 'awaiting_confirmation' : 'ready',
        {
          dispatchId,
          version: Number(current?.version ?? 1) + 1,
          canonicalContent: entry.task_intent === 'writing' ? '重试 OCR 原稿' : undefined,
        },
      ),
    }
  })
  h.cancelImageTaskSpy.mockReset().mockImplementation(async (dispatchId: string) => {
    const current = manualDispatches.get(dispatchId)
    const entry = current?._entry as ManualEntry
    return {
      dispatch: manualCreativeDispatch(entry, 'cancelled', {
        dispatchId,
        version: Number(current?.version ?? 1) + 1,
        canonicalContent: current?.target_projection?.canonical_content,
      }),
    }
  })
})

describe('K12CreativeWorksPanel · 作品', () => {
  it('点击作品缩略图会把焦点移入独立预览层，Escape 关闭后焦点回到缩略图', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          work_type: 'art',
          versions: [{ version_id: 'v1', source_asset_id: 'asset://k12-xiaoming/art.png' }],
        }),
      ],
    })
    const w = render(true)
    await flushPromises()

    const thumbnail = w.get('[data-testid="cw-thumb"]')
    ;(thumbnail.element as HTMLElement).focus()
    await thumbnail.trigger('click')
    await nextTick()
    const preview = w.get('[data-testid="cw-image-preview"]')
    expect(preview.get('img').attributes('src')).toContain('art.png')
    expect(document.activeElement).toBe(preview.element)

    await preview.trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(w.find('[data-testid="cw-image-preview"]').exists()).toBe(false)
    expect(document.activeElement).toBe(thumbnail.element)
  })

  it('每次真实加载后向父层同步作品总数', async () => {
    h.listSpy.mockResolvedValue({ items: [work(), work({ record_id: 'w2' })] })
    const w = render()
    await flushPromises()

    expect(w.emitted('count')).toEqual([[0], [2]])
  })

  it('空 → 空态文案', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-empty-title"]').text()).toBe('还没有作品')
    expect(w.find('[data-testid="cw-empty"]').text()).toContain(
      '作文和画作在这里持续修改、看到成长',
    )
    expect(w.find('[data-testid="cw-add-open"]').exists()).toBe(true)
  })

  it('筛选无结果与作品档案真空态分账', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()

    await w
      .findAll('.k12cw__filter button')
      .find((button) => button.text() === k12Zh.works.art)!
      .trigger('click')

    expect(w.get('[data-testid="cw-empty-title"]').text()).toBe('当前类型下没有作品')
    expect(w.get('[data-testid="cw-empty"]').text()).not.toContain('还没有作品')
  })

  it('加载中显示明确阶段，不用省略号伪装空态', async () => {
    const pending = deferred<{ items: CreativeWorkDTO[] }>()
    h.listSpy.mockReturnValueOnce(pending.promise)
    const w = render()
    await w.vm.$nextTick()

    const loading = w.get('[data-testid="cw-loading"]')
    expect(loading.attributes('role')).toBe('status')
    expect(loading.text()).toBe('正在加载作品…')

    pending.resolve({ items: [] })
    await flushPromises()
  })

  it('作品详情按原型打开模态框，Escape 关闭后焦点回到触发按钮', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [{ version_id: 'v1', content_markdown: '原稿', feedback: '点评' }],
        }),
      ],
    })
    const w = render(true)
    await flushPromises()
    const opener = w.get('[data-testid="cw-detail-toggle"]')
    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()

    const dialog = w.get('[data-testid="cw-detail-modal"]')
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.text()).toContain('作品详情 · 《春天的校园》')
    expect(document.activeElement).toBe(dialog.element)
    expect(w.find('.k12cw__card--expanded').exists()).toBe(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(w.find('[data-testid="cw-detail-modal"]').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
    w.unmount()
  })

  it('作品详情模态框点击遮罩或关闭按钮均关闭，并标注触发按钮展开态', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()
    const opener = w.get('[data-testid="cw-detail-toggle"]')
    expect(opener.attributes('aria-expanded')).toBe('false')
    await opener.trigger('click')
    await flushPromises()
    expect(opener.attributes('aria-expanded')).toBe('true')
    expect(w.get('[data-testid="cw-detail-modal"]').text()).toContain('作品详情 · 《春天的校园》')
    expect(w.get('[data-testid="cw-feedback-auto-pending"]').text()).toBe(
      k12Zh.works.feedbackAutoPending,
    )
    expect(w.find('[data-testid="cw-feedback-regenerate"]').exists()).toBe(false)
    await w.get('[data-testid="cw-detail-close"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-detail-modal"]').exists()).toBe(false)

    await opener.trigger('click')
    await flushPromises()
    await w.get('[data-testid="cw-detail-overlay"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="cw-detail-modal"]').exists()).toBe(false)
  })

  it('作品详情只保留版本、最新点评、上传修改稿、重新生成点评和关闭', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '原稿',
              feedback: '旧点评继续可读',
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()
    await w.get('[data-testid="cw-detail-toggle"]').trigger('click')
    await flushPromises()

    expect(w.get('[data-testid="cw-version-content"]').text()).toContain('原稿')
    expect(w.get('[data-testid="cw-version-feedback"]').text()).toContain('旧点评继续可读')
    expect(w.find('[data-testid="cw-revision-submit"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-feedback-regenerate"]').exists()).toBe(true)
    for (const retired of [
      'cw-feedback-input',
      'cw-feedback-submit',
      'cw-feedback-generate',
      'cw-send-feedback',
      'cw-practice-card',
      'cw-accum-open',
      'cw-mistake-open',
      'cw-archive',
    ]) {
      expect(w.find(`[data-testid="${retired}"]`).exists()).toBe(false)
    }
  })

  it('作品详情模态框把 Tab 焦点圈在弹窗内', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render(true)
    await flushPromises()
    await w.get('[data-testid="cw-detail-toggle"]').trigger('click')
    await flushPromises()

    const dialog = w.get('[data-testid="cw-detail-modal"]')
    const buttons = dialog.findAll('button:not([disabled])')
    const first = buttons[0]!.element as HTMLButtonElement
    const last = buttons[buttons.length - 1]!.element as HTMLButtonElement
    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)

    first.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    )
    expect(document.activeElement).toBe(last)
    w.unmount()
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
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '**春天**的校园',
              feedback: '建议补充 `声音` 细节',
              feedback_source: 'ai',
              feedback_skill: 'writing-feedback@1.0.0/embedded',
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    expect(w.find('[data-testid="cw-version-content"] strong').text()).toBe('春天')
    expect(w.find('[data-testid="cw-version-feedback"] code').text()).toBe('声音')
    const provenance = w.find('[data-testid="cw-feedback-provenance"]')
    expect(provenance.text()).toContain('AI 生成')
    expect(provenance.text()).toContain('writing-feedback@1.0.0/embedded')
  })

  it('结构化点评作为 canonical UI 投影，仅展示观察、限制、建议和来源', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              feedback: '旧兼容投影不应成为唯一事实源',
              structured_feedback: {
                feedback_id: 'feedback-1',
                version_id: 'v1',
                feedback_type: 'writing',
                evidence_refs: ['content-ref:sha256:abc#full'],
                observations: [
                  { dimension: 'expression', evidence: '使用了“绿色的丝带”这个可见比喻。' },
                ],
                source_snapshot: {
                  source: 'ai',
                  method_ref: 'writing-feedback@1.0.0/embedded',
                  capability: 'evidence_based_feedback',
                },
                limitations: '仅依据家长确认后的本版原文。',
                suggestions: ['由孩子补充一个听觉细节。'],
                projection_markdown: '### 观察\n\n使用了“绿色的丝带”这个可见比喻。',
              },
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    const feedback = w.get('[data-testid="cw-structured-feedback"]')
    expect(feedback.text()).toContain('使用了“绿色的丝带”这个可见比喻。')
    expect(feedback.text()).toContain('仅依据家长确认后的本版原文。')
    expect(feedback.text()).toContain('由孩子补充一个听觉细节。')
    expect(feedback.text()).not.toContain('发送')
    expect(feedback.text()).not.toContain('收藏')
    expect(feedback.text()).not.toContain('记录语言问题')
    expect(feedback.text()).toContain('writing-feedback@1.0.0/embedded')
  })

  it('历史 polluted structured feedback 回退到安全 Markdown 投影，不显示被污染 atom 或 raw 标记', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              feedback: '兼容点评投影',
              structured_feedback: {
                feedback_id: 'feedback-polluted',
                version_id: 'v1',
                feedback_type: 'writing',
                evidence_refs: ['content-ref:sha256:polluted#full'],
                observations: [
                  {
                    dimension: 'expression',
                    evidence:
                      '旧解析残留 RAW_POLLUTED_ATOM ### **不应按事实行显示**\n### 下一步\n多行 projection',
                  },
                ],
                source_snapshot: {
                  source: 'ai',
                  method_ref: 'writing-feedback@legacy',
                  capability: 'evidence_based_feedback',
                },
                limitations: '仅依据当前原稿。',
                suggestions: ['由孩子补充听觉细节。'],
                projection_markdown:
                  '### 观察\n\n使用了**绿色的丝带**这个比喻。\n\n### 下一步\n\n- 由孩子补充听觉细节。\n\n<img src=x onerror="window.__unsafe_feedback=1">',
              },
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    const projection = w.get('[data-testid="cw-structured-feedback-projection"]')
    expect(projection.get('h3').text()).toBe('观察')
    expect(projection.get('strong').text()).toBe('绿色的丝带')
    expect(w.text()).not.toMatch(/###|\*\*/)
    expect(w.text()).not.toContain('RAW_POLLUTED_ATOM')
    expect(projection.find('img').exists()).toBe(false)
    const renderer = w
      .findAllComponents(MarkdownRenderer)
      .find(
        (component) => component.attributes('data-testid') === 'cw-structured-feedback-projection',
      )
    expect(renderer?.props('showArtifacts')).toBe(false)
  })

  it('历史 polluted structured feedback 无可用投影时 fail-closed，不回退显示污染 atom', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              structured_feedback: {
                feedback_id: 'feedback-polluted-without-projection',
                version_id: 'v1',
                feedback_type: 'writing',
                evidence_refs: ['content-ref:sha256:polluted-empty#full'],
                observations: [
                  {
                    dimension: 'expression',
                    evidence: 'RAW_ATOM_WITHOUT_PROJECTION\n### **不得泄漏**',
                  },
                ],
                source_snapshot: {
                  source: 'ai',
                  method_ref: 'writing-feedback@legacy',
                  capability: 'evidence_based_feedback',
                },
                limitations: '仅依据当前原稿。',
                suggestions: [],
                projection_markdown: '',
              },
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    expect(w.text()).not.toContain('RAW_ATOM_WITHOUT_PROJECTION')
    expect(w.text()).not.toMatch(/###|\*\*/)
    expect(w.find('.k12cw__feedback-facts').exists()).toBe(false)
  })

  it('所有作品点评 Markdown renderer 都关闭 artifact 执行面', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '原稿',
              structured_feedback: {
                feedback_id: 'feedback-clean',
                version_id: 'v1',
                feedback_type: 'writing',
                evidence_refs: ['content-ref:sha256:clean#full'],
                observations: [{ dimension: 'expression', evidence: '比喻有可见依据。' }],
                source_snapshot: {
                  source: 'ai',
                  method_ref: 'writing-feedback@1.0.0/embedded',
                  capability: 'evidence_based_feedback',
                },
                limitations: '仅依据本版原文。',
                suggestions: ['补充一个声音细节。'],
                projection_markdown: '### 观察\n\n比喻有可见依据。',
              },
            },
            {
              version_id: 'v2',
              content_markdown: '修改稿',
              feedback: '家长点评',
              feedback_source: 'parent',
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    const reviewRenderers = w
      .findAllComponents(MarkdownRenderer)
      .filter((component) => component.element.closest('.k12cw__vfeedback'))
    expect(reviewRenderers).toHaveLength(3)
    for (const renderer of reviewRenderers) {
      expect(renderer.props('showArtifacts')).toBe(false)
    }
  })

  it('旧版本点评不让当前修改稿进入已点评态或显示重新生成入口', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          work_type: 'art',
          status: 'revised',
          status_label: '已修改',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '原画',
              feedback: '旧版点评',
            },
            { version_id: 'v2', content_markdown: '当前修改稿' },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    expect(w.get('[data-testid="cw-feedback-auto-pending"]').text()).toBe(
      k12Zh.works.feedbackAutoPending,
    )
    expect(w.find('[data-testid="cw-feedback-regenerate"]').exists()).toBe(false)
  })

  it('已归档作品只保留历史事实和关闭动作，不显示练习卡、发送等执行动作', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          work_type: 'art',
          status: 'archived',
          status_label: '已归档',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '原画',
              feedback: '构图清楚',
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    for (const testId of [
      'cw-send-feedback',
      'cw-card-print',
      'cw-card-save-pdf',
      'cw-card-send',
      'cw-card-done',
      'cw-feedback-generate',
      'cw-feedback-submit',
      'cw-feedback-regenerate',
      'cw-feedback-auto-pending',
      'cw-revision-submit',
      'cw-accum-open',
      'cw-mistake-open',
    ]) {
      expect(w.find(`[data-testid="${testId}"]`).exists()).toBe(false)
    }
    await w.get('[data-testid="cw-detail-toggle"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="cw-detail-modal"]').text()).toContain('关闭')
  })

  it('待点评作品只显示服务端自动点评状态，不提供手写或首次生成入口', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()

    expect(w.get('[data-testid="cw-feedback-auto-pending"]').text()).toBe(
      k12Zh.works.feedbackAutoPending,
    )
    expect(w.find('[data-testid="cw-feedback-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-feedback-submit"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-feedback-generate"]').exists()).toBe(false)
    expect(w.find('[data-testid="cw-feedback-regenerate"]').exists()).toBe(false)
    expect(h.generateFeedbackSpy).not.toHaveBeenCalled()
  })

  it('已点评 → 提交修改稿走 revision', async () => {
    h.listSpy.mockResolvedValue({
      items: [work({ status: 'feedback_ready', status_label: '已点评' })],
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-revision-input"]').setValue('柳枝像绿色的丝带，风一吹沙沙响')
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    await flushPromises()
    expect(h.revisionSpy).toHaveBeenCalledWith(
      'k12-xiaoming',
      'w1',
      '柳枝像绿色的丝带，风一吹沙沙响',
    )
    expect(h.generateFeedbackSpy).not.toHaveBeenCalled()
  })

  it('美术修改稿可只上传照片；快速改选时中止 A，B 通过 revision dispatch 单独 commit', async () => {
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
    expect(h.createImageTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-xiaoming',
        source_asset_refs: ['asset://k12-xiaoming/revision-b.png'],
        creative_entry: {
          kind: 'revision',
          task_intent: 'artwork',
          work_id: 'w1',
          base_version_id: 'v1',
        },
      }),
    )
    expect(h.confirmImageTaskSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agent: 'k12-xiaoming',
        creative: { action: 'commit', content_markdown: undefined },
      }),
    )
    expect(h.revisionSpy).not.toHaveBeenCalled()
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
    const firstDispatchId = [...manualDispatches.keys()][0]!
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['b'], 'revision-b.png', { type: 'image/png' })],
    })
    await input.trigger('change')
    await flushPromises()

    expect(h.cancelImageTaskSpy).toHaveBeenCalledWith(firstDispatchId, {
      agent: 'k12-xiaoming',
      version: 1,
    })
    expect(w.find('[data-testid="cw-revision-photo-error"]').text()).toContain('B 上传失败')
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    expect(h.revisionSpy).not.toHaveBeenCalled()
  })

  it('作文修改稿照片先 freeze_ocr，再以同一 revision dispatch 单独 commit', async () => {
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

    expect(h.createImageTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-xiaoming',
        source_asset_refs: ['asset://k12-xiaoming/abc.png'],
        creative_entry: {
          kind: 'revision',
          task_intent: 'writing',
          work_id: 'w1',
          base_version_id: 'v1',
        },
      }),
    )
    expect(w.find('[data-testid="cw-revision-ocr-awaiting"]').exists()).toBe(true)
    expect((w.find('[data-testid="cw-revision-input"]').element as HTMLTextAreaElement).value).toBe(
      'OCR 原稿',
    )
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeDefined()

    await w.find('[data-testid="cw-revision-input"]').setValue('家长校对后的修改稿')
    await w.find('[data-testid="cw-revision-ocr-confirm"]').trigger('click')
    await flushPromises()

    expect(h.confirmImageTaskSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        agent: 'k12-xiaoming',
        creative: {
          action: 'freeze_ocr',
          canonical_version: 1,
          canonical_content: '家长校对后的修改稿',
        },
      }),
    )
    expect(w.find('[data-testid="cw-revision-ocr-confirmed"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-revision-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-revision-submit"]').trigger('click')
    await flushPromises()
    expect(h.confirmImageTaskSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        agent: 'k12-xiaoming',
        creative: {
          action: 'commit',
          content_markdown: '家长校对后的修改稿',
        },
      }),
    )
    expect(h.revisionSpy).not.toHaveBeenCalled()
  })

  it('类型过滤 → 只拉对应类型', async () => {
    h.listSpy.mockResolvedValue({
      items: [work(), work({ record_id: 'w2', work_type: 'art', title: '画作' })],
    })
    const w = render()
    await flushPromises()
    // 客户端过滤：点「美术作品」只剩 art
    await w
      .findAll('.k12cw__filter button')
      .find((b) => b.text() === k12Zh.works.art)!
      .trigger('click')
    expect(w.text()).toContain('画作')
    expect(w.text()).not.toContain('《春天的校园》')
  })
})

describe('K12CreativeWorksPanel · KPI 行 + 点评规则（原型 2570-2586）', () => {
  it('三 KPI 从最新版本计算：全部 / 已点评 / 待点评', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work(), // draft，无 feedback → 待点评
        work({
          record_id: 'w2',
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [{ version_id: 'v1', content_markdown: 'x', feedback: '比喻好' }],
        }),
        work({
          record_id: 'w3',
          work_type: 'art',
          title: '画作',
          status: 'revised',
          status_label: '已修改',
          versions: [
            { version_id: 'v1', feedback: '旧版构图点评' },
            { version_id: 'v2', content_markdown: '修改稿' },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()
    const kpis = w.findAll('[data-testid="cw-kpis"] .k12cw__kpi')
    expect(kpis.length).toBe(3)
    expect(kpis[0]!.text()).toContain('3') // 全部作品
    expect(kpis[1]!.text()).toContain('1') // 最新版本已点评
    expect(kpis[2]!.text()).toContain('2') // 初稿与修改稿正在自动点评
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

  it('重新生成点评时保留旧点评；失败给固定提示，重试成功后替换为新点评', async () => {
    const pending = deferred<CreativeWorkDTO>()
    const reviewed = work({
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [
        {
          version_id: 'v1',
          content_markdown: '柳枝像绿色的丝带',
          feedback: '旧点评仍应保留',
          feedback_source: 'ai',
        },
      ],
    })
    const ready = work({
      status: 'feedback_ready',
      status_label: '已点评',
      versions: [
        {
          version_id: 'v1',
          content_markdown: '柳枝像绿色的丝带',
          feedback: '比喻具体，可再补充声音细节',
          feedback_source: 'ai',
          feedback_skill: 'writing-feedback@1.0.0/embedded',
        },
      ],
    })
    h.listSpy.mockResolvedValue({ items: [reviewed] })
    h.generateFeedbackSpy.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ready)
    const w = render()
    await flushPromises()

    await w.get('[data-testid="cw-feedback-regenerate"]').trigger('click')
    await nextTick()
    const regenerating = w.get('[data-testid="cw-feedback-regenerate"]')
    expect(regenerating.text()).toBe('正在重新生成…')
    expect(regenerating.attributes('disabled')).toBeDefined()
    expect(regenerating.attributes('aria-busy')).toBe('true')
    expect(w.text()).toContain('旧点评仍应保留')

    pending.reject(new Error('模型响应超时'))
    await flushPromises()

    const error = w.get('[data-testid="cw-feedback-regenerate-error"]')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toBe('重新生成失败，旧点评已保留。你可以重试。')
    expect(w.text()).toContain('旧点评仍应保留')
    expect(w.get('[data-testid="cw-feedback-regenerate"]').text()).toBe('重新生成点评')

    await w.get('[data-testid="cw-feedback-regenerate"]').trigger('click')
    await flushPromises()
    expect(h.generateFeedbackSpy).toHaveBeenCalledTimes(2)
    const firstCall = h.generateFeedbackSpy.mock.calls[0]!
    const secondCall = h.generateFeedbackSpy.mock.calls[1]!
    expect(firstCall).toEqual(['k12-xiaoming', 'w1', expect.any(String), expect.any(AbortSignal)])
    expect(secondCall).toEqual(['k12-xiaoming', 'w1', expect.any(String), expect.any(AbortSignal)])
    expect(firstCall[2]).not.toBe(secondCall[2])
    expect(w.find('[data-testid="cw-feedback-regenerate-error"]').exists()).toBe(false)
    expect(w.text()).toContain('比喻具体，可再补充声音细节')
  })

  it('上传修改稿输入具有可访问名称，详情不存在手写点评输入', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()
    expect(w.get('[data-testid="cw-revision-input"]').attributes('aria-label')).toBe(
      k12Zh.works.submitRevision,
    )
    expect(w.find('[data-testid="cw-feedback-input"]').exists()).toBe(false)
  })

  it('重新生成点评时切换孩子会 abort 旧请求', async () => {
    const pending = deferred<CreativeWorkDTO>()
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [{ version_id: 'v1', content_markdown: '原稿', feedback: '旧点评' }],
        }),
      ],
    })
    h.generateFeedbackSpy.mockReturnValueOnce(pending.promise)
    const w = render()
    await flushPromises()

    await w.get('[data-testid="cw-feedback-regenerate"]').trigger('click')
    const signal = h.generateFeedbackSpy.mock.calls[0]![3] as AbortSignal
    expect(signal.aborted).toBe(false)
    await w.setProps({ agentId: 'k12-xiaohong' })
    await flushPromises()

    expect(signal.aborted).toBe(true)
    expect(w.get('[data-testid="cw-feedback-regenerate"]').text()).toBe('重新生成点评')
  })
})

describe('K12CreativeWorksPanel · 添加作品弹窗（原型 5326-5361）', () => {
  it('公开 API 不再导出退役的 OCR、手写点评、归档、发送和练习卡动作', () => {
    expect(apiSource).not.toMatch(
      /export\s+(?:async\s+)?function\s+k12(?:Create|Get|Retry|Confirm)CreativeWorkOCR/,
    )
    expect(apiSource).not.toMatch(
      /export\s+(?:async\s+)?function\s+k12(?:AttachWorkFeedback|ArchiveCreativeWork|SendWorkFeedback|MarkPracticeCardDone)/,
    )
  })

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

  it('添加作品弹窗沿用既定字段顺序、按钮与文案', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')

    const ordered = [
      w.get('[data-testid="cw-add-photo"]').element,
      w.get('[data-testid="cw-add-title"]').element,
      w.get('[data-testid="cw-add-task"]').element,
      w.get('[data-testid="cw-add-draft"]').element,
      w.get('[data-testid="cw-add-submit"]').element,
    ]
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(
        ordered[index]!.compareDocumentPosition(ordered[index + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(w.get('[data-testid="cw-add-photo"]').text()).toContain(k12Zh.works.photoChoose)
    expect(w.get('[data-testid="cw-add-submit"]').text()).toBe(k12Zh.works.save)
    expect(
      w
        .get('[data-testid="cw-add-modal"]')
        .findAll('button')
        .some((button) => button.text() === k12Zh.works.cancel),
    ).toBe(true)
  })

  it('关闭尚未提交的带图作品会取消 intake，不触发 commit 或创建作品', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-type-art"]').trigger('click')
    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['art'], 'art.png', { type: 'image/png' })] },
    })
    await flushPromises()
    const dispatchId = [...manualDispatches.keys()][0]!

    const cancel = w
      .get('[data-testid="cw-add-modal"]')
      .findAll('button')
      .find((button) => button.text() === k12Zh.works.cancel)!
    await cancel.trigger('click')
    await flushPromises()

    expect(h.cancelImageTaskSpy).toHaveBeenCalledWith(dispatchId, {
      agent: 'k12-xiaoming',
      version: 1,
    })
    expect(h.confirmImageTaskSpy).not.toHaveBeenCalled()
    expect(h.createSpy).not.toHaveBeenCalled()
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
  })

  it('Escape 关闭弹窗并把焦点还给打开按钮', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render(true)
    await flushPromises()
    const opener = w.find('[data-testid="cw-add-open"]')
    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
    w.unmount()
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
    await nextTick()
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeUndefined()
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
      agent: 'k12-xiaoming',
      work_type: 'writing',
      title: '《春天的校园》',
      task: '写校园春景',
      intent: undefined,
      content_markdown: '柳枝像绿色的丝带',
    })
    expect(w.find('[data-testid="cw-add-modal"]').exists()).toBe(false)
    expect(h.listSpy.mock.calls.length, '提交后重拉列表').toBeGreaterThanOrEqual(2)
    expect(h.generateFeedbackSpy).not.toHaveBeenCalled()
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
      agent: 'k12-xiaoming',
      work_type: 'art',
      title: '《雨后的校园》',
      task: '水彩写生',
      intent: '雨后安静感',
      content_markdown: undefined,
    })
  })

  it('作文照片：new_work dispatch 先 freeze_ocr，确认后仍须单独 commit 才建作品', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const pending = deferred<Record<string, unknown>>()
    h.createImageTaskSpy.mockReturnValueOnce(pending.promise)
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
    const entry: ManualEntry = { kind: 'new_work', task_intent: 'writing' }
    pending.resolve({
      created: true,
      dispatch: manualCreativeDispatch(entry, 'awaiting_confirmation', {
        dispatchId: 'dispatch-writing-new',
        canonicalContent: '柳枝象绿色丝带',
      }),
    })
    await flushPromises()

    expect(h.createImageTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-xiaoming',
        source_session: 'creative-works:k12-xiaoming',
        source_kind: 'desktop',
        source_asset_refs: ['asset://k12-xiaoming/abc.png'],
        creative_entry: { kind: 'new_work', task_intent: 'writing' },
      }),
    )
    expect((w.find('[data-testid="cw-add-draft"]').element as HTMLTextAreaElement).value).toBe(
      '柳枝象绿色丝带',
    )
    expect(w.find('[data-testid="cw-ocr-awaiting"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-add-draft"]').setValue('柳枝像绿色丝带')
    await w.find('[data-testid="cw-ocr-confirm"]').trigger('click')
    await flushPromises()

    expect(h.confirmImageTaskSpy).toHaveBeenNthCalledWith(1, 'dispatch-writing-new', {
      agent: 'k12-xiaoming',
      version: 1,
      creative: {
        action: 'freeze_ocr',
        canonical_version: 1,
        canonical_content: '柳枝像绿色丝带',
      },
    })
    expect(w.find('[data-testid="cw-ocr-confirmed"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.confirmImageTaskSpy).toHaveBeenNthCalledWith(2, 'dispatch-writing-new', {
      agent: 'k12-xiaoming',
      version: 2,
      creative: {
        action: 'commit',
        work_title: '《春天的校园》',
        task_requirement: '写校园春景',
        intent: undefined,
        content_markdown: '柳枝像绿色丝带',
      },
    })
    expect(h.createSpy).not.toHaveBeenCalled()
  })

  it('作文 OCR 失败：原位可重试，也可手工粘贴后确认', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const entry: ManualEntry = { kind: 'new_work', task_intent: 'writing' }
    h.createImageTaskSpy.mockResolvedValueOnce({
      created: true,
      dispatch: manualCreativeDispatch(entry, 'failed', {
        dispatchId: 'dispatch-writing-failed',
        canonicalContent: undefined,
      }),
    })
    const w = render()
    await flushPromises()
    await w.find('[data-testid="cw-add-open"]').trigger('click')
    await w.find('[data-testid="cw-add-photo"]').trigger('drop', {
      dataTransfer: { files: [new File(['image'], 'draft.png', { type: 'image/png' })] },
    })
    await flushPromises()

    expect(w.find('[data-testid="cw-ocr-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="cw-ocr-retry"]').exists()).toBe(true)
    await w.find('[data-testid="cw-ocr-retry"]').trigger('click')
    await flushPromises()
    expect(h.retryImageTaskSpy).toHaveBeenCalledWith('dispatch-writing-failed', {
      agent: 'k12-xiaoming',
      version: 1,
    })
    expect((w.find('[data-testid="cw-add-draft"]').element as HTMLTextAreaElement).value).toBe(
      '重试 OCR 原稿',
    )

    // A second failed job can skip model retry and use the documented manual-paste fallback.
    h.createImageTaskSpy.mockResolvedValueOnce({
      created: true,
      dispatch: manualCreativeDispatch(entry, 'failed', {
        dispatchId: 'dispatch-writing-manual',
        canonicalContent: undefined,
      }),
    })
    await pickPhoto(w, new File(['new-image'], 'manual.png', { type: 'image/png' }))
    await flushPromises()
    await w.find('[data-testid="cw-add-draft"]').setValue('家长手工粘贴的正文')
    await w.find('[data-testid="cw-ocr-confirm"]').trigger('click')
    await flushPromises()
    expect(h.confirmImageTaskSpy).toHaveBeenLastCalledWith('dispatch-writing-manual', {
      agent: 'k12-xiaoming',
      version: 1,
      creative: {
        action: 'freeze_ocr',
        canonical_version: 1,
        canonical_content: '家长手工粘贴的正文',
      },
    })
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
    await nextTick()
    expect(w.find('[data-testid="cw-add-photo"]').classes(), 'dragover 有态').toContain(
      'k12cw__drop--over',
    )
    await w
      .find('[data-testid="cw-add-photo"]')
      .trigger('drop', { dataTransfer: { files: [file] } })
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
    await w
      .find('[data-testid="cw-add-photo"]')
      .trigger('drop', { dataTransfer: { files: [file] } })
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
    const firstDispatchId = [...manualDispatches.keys()][0]!
    await pickPhoto(w, new File(['b'], 'b.png', { type: 'image/png' }))
    await flushPromises()
    expect(h.cancelImageTaskSpy).toHaveBeenCalledWith(firstDispatchId, {
      agent: 'k12-xiaoming',
      version: 1,
    })
    expect(w.find('[data-testid="cw-photo-error"]').text()).toContain('B 上传失败')
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).not.toHaveBeenCalled()

    await w.find('[data-testid="cw-photo-remove"]').trigger('click')
    expect(w.find('[data-testid="cw-add-submit"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-testid="cw-add-submit"]').trigger('click')
    await flushPromises()
    expect(h.createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'k12-xiaoming',
        work_type: 'art',
        title: '画作',
        task: '水彩',
      }),
    )
    expect(h.createSpy.mock.calls[0]![0]).not.toHaveProperty('source_asset_id')
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
    expect(h.createImageTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source_asset_refs: ['asset://k12-xiaoming/b.png'],
        creative_entry: { kind: 'new_work', task_intent: 'artwork' },
      }),
    )
    expect(h.confirmImageTaskSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        creative: {
          action: 'commit',
          work_title: '画作',
          task_requirement: '水彩',
          intent: undefined,
          content_markdown: undefined,
        },
      }),
    )
    expect(h.createSpy).not.toHaveBeenCalled()
  })
})

describe('K12CreativeWorksPanel · 退役动作不再投影', () => {
  it('写作和美术都不恢复发送、练习卡、积累或错题入口', async () => {
    h.listSpy.mockResolvedValue({
      items: [
        work({
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v1',
              content_markdown: '柳枝像绿色的丝带',
              feedback: '比喻好',
            },
          ],
        }),
        work({
          record_id: 'w-art',
          work_type: 'art',
          title: '《校园水彩》',
          status: 'feedback_ready',
          status_label: '已点评',
          versions: [
            {
              version_id: 'v-art',
              feedback: '构图清楚',
            },
          ],
        }),
      ],
    })
    const w = render()
    await flushPromises()

    for (const retired of [
      'cw-send-feedback',
      'cw-card-print',
      'cw-card-save-pdf',
      'cw-card-send',
      'cw-card-done',
      'cw-accum-open',
      'cw-mistake-open',
      'cw-archive',
    ]) {
      expect(w.find(`[data-testid="${retired}"]`).exists()).toBe(false)
    }
  })
})
