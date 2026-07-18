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
  revisionSpy: vi.fn(),
  archiveSpy: vi.fn(),
  accumSpy: vi.fn(),
  recordMistakeSpy: vi.fn(),
  uploadSpy: vi.fn(),
  sendSpy: vi.fn(),
  cardDoneSpy: vi.fn(),
}))
vi.mock('@/api/k12', () => ({
  k12ListCreativeWorks: (agent: string, type?: string) => h.listSpy(agent, type),
  k12CreateCreativeWork: (req: unknown) => h.createSpy(req),
  k12AttachWorkFeedback: (a: string, id: string, fb: string) => h.feedbackSpy(a, id, fb),
  k12SubmitWorkRevision: (a: string, id: string, c?: string) => h.revisionSpy(a, id, c),
  k12ArchiveCreativeWork: (a: string, id: string) => h.archiveSpy(a, id),
  k12AddAccumulation: (req: unknown) => h.accumSpy(req),
  k12RecordMistake: (req: unknown) => h.recordMistakeSpy(req),
  k12UploadAsset: (a: string, f: File, p?: (n: number) => void) => h.uploadSpy(a, f, p),
  k12AssetURL: (agent: string, id: string) =>
    id.startsWith('asset://') ? `http://test/api/k12/assets/${id.slice(id.lastIndexOf('/') + 1)}?agent=${agent}` : '',
  k12SendWorkFeedback: (a: string, id: string, kind?: string) => h.sendSpy(a, id, kind),
  k12MarkPracticeCardDone: (a: string, id: string) => h.cardDoneSpy(a, id),
}))
vi.mock('../export', () => ({ printPracticePaper: vi.fn().mockResolvedValue(true) }))
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

beforeEach(() => {
  h.listSpy.mockReset()
  h.createSpy.mockReset().mockResolvedValue({ record_id: 'w-new', created: true })
  h.feedbackSpy.mockReset().mockResolvedValue(work({ status: 'feedback_ready', status_label: '已点评' }))
  h.revisionSpy.mockReset().mockResolvedValue(work({ status: 'revised', status_label: '已修改' }))
  h.archiveSpy.mockReset().mockResolvedValue({ ok: true })
  h.accumSpy.mockReset().mockResolvedValue({ record_id: 'a1', created: true })
  h.recordMistakeSpy.mockReset().mockResolvedValue({ record_created: true, record_id: 'm1' })
  h.uploadSpy.mockReset().mockResolvedValue({ asset_id: 'asset://k12-xiaoming/abc.png', size: 3 })
  h.sendSpy.mockReset().mockResolvedValue({ ok: true, target: '钉钉 · 妈妈' })
  h.cardDoneSpy.mockReset().mockResolvedValue(work())
})

describe('K12CreativeWorksPanel · 作品', () => {
  it('空 → 空态文案', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-empty"]').exists()).toBe(true)
  })

  it('按 agentId 隔离拉取', async () => {
    h.listSpy.mockResolvedValue({ items: [] })
    render()
    await flushPromises()
    expect(h.listSpy).toHaveBeenCalledWith('k12-xiaoming', undefined)
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

  it('手写点评输入旁注明 AI 生成点评待接线（不做假 AI）', async () => {
    h.listSpy.mockResolvedValue({ items: [work()] })
    const w = render()
    await flushPromises()
    expect(w.find('[data-testid="cw-ai-pending"]').text()).toContain('AI 生成点评待接线')
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
