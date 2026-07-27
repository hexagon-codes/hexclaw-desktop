import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12RecordsView from '../views/K12RecordsView.vue'
import K12PracticeSetsPanel from '../views/K12PracticeSetsPanel.vue'
import bookTabsSource from '../components/K12BookTabs.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import practiceSource from '../views/K12PracticeSetsPanel.vue?raw'
import type { PracticeItemDTO, PracticeSetDTO } from '@/api/k12'

// 唯一 UI 权威：hexclaw-docs/prototype/app.html:2207-2330 / CSS:1169-1295。
// 本文件只钉学习档案 P0 漂移；领域 API 行为仍由既有专项测试覆盖。
const h = vi.hoisted(() => ({
  listMistakes: vi.fn(),
  reviewQueue: vi.fn(),
  listAccumulation: vi.fn(),
  report: vi.fn(),
  listPracticeSets: vi.fn(),
  listCreativeWorks: vi.fn(),
}))

vi.mock('@/api/k12', async () => ({
  ...(await import('./weekly-practice-api-mock')).weeklyPracticeApiMockDefaults('ming'),
  k12ListMistakes: (...args: unknown[]) => h.listMistakes(...args),
  k12ReviewQueue: (...args: unknown[]) => h.reviewQueue(...args),
  k12ListAccumulation: (...args: unknown[]) => h.listAccumulation(...args),
  k12InsightReport: (...args: unknown[]) => h.report(...args),
  k12ListPracticeSets: (...args: unknown[]) => h.listPracticeSets(...args),
  k12ListCreativeWorks: (...args: unknown[]) => h.listCreativeWorks(...args),
  k12MarkMastered: vi.fn().mockResolvedValue({ ok: true }),
  k12DeleteMistake: vi.fn().mockResolvedValue({ ok: true }),
  k12GetMistakePracticeGeneration: vi.fn().mockImplementation((_agent: string, recordID: string) =>
    Promise.resolve({ state: 'available', source_mistake_id: recordID })),
  k12RecordMistake: vi.fn(),
  k12AddAccumulation: vi.fn(),
  k12AddToBasket: vi.fn(),
  k12FillPracticeBasket: vi.fn(),
  k12GenerateCustomPaper: vi.fn(),
  k12RemoveFromBasket: vi.fn(),
  k12FinalizePracticeSet: vi.fn(),
  k12AdvancePracticeSet: vi.fn(),
  k12SubmitPracticeSet: vi.fn(),
  k12GradePracticeSet: vi.fn(),
  k12CancelPracticeSet: vi.fn(),
  k12GetPracticePaper: vi.fn(),
  k12GetPracticePrintJobPaper: vi.fn(),
  k12PreparePracticePrintJob: vi.fn(),
  k12RecordPracticePrintEvent: vi.fn(),
  k12RetryPracticePrintJob: vi.fn(),
  k12UploadAsset: vi.fn(),
  k12AssetURL: vi.fn().mockReturnValue('/asset'),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

vi.mock('../export', () => ({
  exportArchiveDocument: vi.fn(),
  worksheetFilename: vi.fn().mockReturnValue('worksheet'),
  download: vi.fn(),
  printPracticePaper: vi.fn(),
  printPracticePaperWithReceipt: vi.fn(),
  savePracticePaperPdf: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function practiceItem(
  id: string,
  subject: string,
  verification_status: PracticeItemDTO['verification_status'] = 'verified',
): PracticeItemDTO {
  return {
    item_id: id,
    subject,
    question_markdown: `题目 ${id}`,
    verification_status,
    verification_evidence: verification_status === 'verified' ? '独立验算' : undefined,
    blocked_reason: verification_status === 'verified' ? undefined : '暂不支持自动验证',
  }
}

function basket(items: PracticeItemDTO[]): PracticeSetDTO {
  return {
    record_id: 'draft-1',
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

function renderRecords(props: Record<string, unknown> = {}) {
  return mount(K12RecordsView, {
    props: {
      agentId: 'ming',
      agentName: '小明的辅导助手',
      grade: '五年级上 · 人教版',
      ...props,
    },
    global: { plugins: [createPinia(), i18n()] },
  })
}

function renderPractice() {
  return mount(K12PracticeSetsPanel, {
    props: { agentId: 'ming' },
    global: { plugins: [i18n()] },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  h.listMistakes.mockReset().mockResolvedValue({
    items: [
      {
        record_id: 'm1',
        question: '小数乘法',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'scheduled',
        review_state: 'scheduled',
        version: 0,
        subject: '数学',
      },
      {
        record_id: 'm2',
        question: 'believe',
        knowledge_point: '错词',
        error_cause: '少 e',
        status: 'scheduled',
        review_state: 'scheduled',
        version: 1,
        subject: '英语',
      },
      {
        record_id: 'm3',
        question: '古诗默写',
        knowledge_point: '默写',
        error_cause: '漏字',
        status: 'mastered',
        version: 2,
        subject: '语文',
      },
    ],
  })
  h.reviewQueue.mockReset().mockResolvedValue({
    items: [
      {
        record_id: 'm1',
        question: '小数乘法',
        knowledge_point: '小数乘法',
        error_cause: '进位',
        status: 'scheduled',
        review_state: 'scheduled',
        version: 0,
        subject: '数学',
      },
      {
        record_id: 'm2',
        question: 'believe',
        knowledge_point: '错词',
        error_cause: '少 e',
        status: 'scheduled',
        review_state: 'scheduled',
        version: 1,
        subject: '英语',
      },
    ],
  })
  h.listAccumulation.mockReset().mockResolvedValue({
    items: [
      {
        record_id: 'a1',
        subject: '语文',
        entry_type: '好词好句',
        content: '春风又绿江南岸',
        status: '已积累',
      },
    ],
  })
  h.report.mockReset().mockResolvedValue({
    trend: { mastered: 1, reviewing: 2, retried: 1, archived: 0, total: 4 },
    weak_top3: [],
    month_new_mistakes: 3,
    review_completion_rate: 0.5,
    consecutive_fail_kps: [],
    suggestion: '',
  })
  h.listPracticeSets.mockReset().mockResolvedValue({
    items: [basket([practiceItem('p1', '数学'), practiceItem('p2', '科学', 'needs_review')])],
  })
  h.listCreativeWorks
    .mockReset()
    .mockResolvedValue({ items: [{ record_id: 'w1' }, { record_id: 'w2' }] })
})

describe('学习档案 P0 · 原型唯一权威', () => {
  it('五个 borderless 对象 Tab 始终显示真实 count，选中态无浮起阴影', async () => {
    const wrapper = renderRecords()
    await flushPromises()

    const tabs = wrapper.findAll('.k12rec__tabs [role="tablist"] button')
    expect(tabs).toHaveLength(5)
    expect(tabs.map((tab) => tab.find('.k12-tab-count').attributes('data-count'))).toEqual([
      '0',
      '3',
      '2',
      '1',
      '2',
    ])
    expect(recordsSource).toContain('<K12BookTabs')
    expect(bookTabsSource).toMatch(
      /\.k12-book-tabs\s*\{[^}]*background:\s*transparent;[^}]*border:\s*none;/s,
    )
    expect(bookTabsSource).toMatch(
      /\.k12-book-tabs button\.on\s*\{[^}]*box-shadow:\s*none;/s,
    )
  })

  it('作品工具栏只显示一个加号图标和纯文案', async () => {
    h.listCreativeWorks.mockResolvedValue({ items: [] })
    const wrapper = renderRecords()
    await flushPromises()
    await wrapper.get('[data-testid="subtab-works"]').trigger('click')

    const add = wrapper.get('[data-testid="cw-add-open"]')
    expect(add.text()).toBe('添加作品')
    expect(add.findAll('svg')).toHaveLength(1)
  })

  it('本周主操作只保留打印与发送；整周更多和旧本地行动卡不回流', async () => {
    const wrapper = renderRecords()
    await flushPromises()

    expect(wrapper.find('[data-testid="review-split"]').exists()).toBe(false)
    expect(
      wrapper.get('[data-testid="final-artifact-actions"]').findAll('button').map((button) =>
        button.text(),
      ),
    ).toEqual(['打印', '发送到手机'])
    expect(wrapper.find('button[aria-label="更多本周该练操作"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="custom-paper-form"]').exists()).toBe(false)

    const hero = wrapper.get('.weekly-hero')
    expect(hero.text()).toContain('0项本周该练')
    expect(hero.find('[data-testid="build-review-set"]').exists()).toBe(false)
    expect(hero.findAll('[data-testid^="mistake-archive-"]')).toHaveLength(0)
    expect(hero.text()).not.toContain('不再复习')
  })

  it('全部错题显示结果数，并同时支持学科与状态筛选', async () => {
    const wrapper = renderRecords()
    await flushPromises()
    await wrapper.get('[data-testid="subtab-mistakes"]').trigger('click')

    expect(wrapper.get('[data-testid="mistake-result-count"]').text()).toBe('显示 3 / 3 道')
    expect(
      wrapper
        .findAll('.k12rec__filter-row--subject .k12rec__filter')
        .map((button) => button.text()),
    ).toEqual(['全部', '数学', '语文', '英语', '科学', '信息科技'])
    await wrapper.get('[data-testid="mistake-subject-英语"]').trigger('click')
    expect(wrapper.get('[data-testid="mistake-result-count"]').text()).toBe('显示 1 / 3 道')
    expect(wrapper.get('.k12mistakes').text()).toContain('believe')
    expect(wrapper.get('.k12mistakes').text()).not.toContain('小数乘法')

    await wrapper.get('[data-testid="mistake-subject-all"]').trigger('click')
    await wrapper.get('[data-testid="mistake-status-scheduled"]').trigger('click')
    expect(wrapper.get('[data-testid="mistake-result-count"]').text()).toBe('显示 2 / 3 道')
    expect(wrapper.get('.k12mistakes').text()).toContain('believe')
    expect(wrapper.get('.k12mistakes').text()).not.toContain('古诗默写')
  })

  it('学情结构化下钻每次都重放 target/subject/status，不沿用用户上次手动筛选', async () => {
    const masteredMath = { target: 'mistakes', subject: '数学', status: 'mastered' } as const
    const wrapper = renderRecords({
      target: masteredMath.target,
      subject: masteredMath.subject,
      status: masteredMath.status,
      navigation: masteredMath,
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="subtab-mistakes"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-testid="mistake-subject-数学"]').attributes('aria-pressed')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="mistake-status-mastered"]').attributes('aria-pressed')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="mistake-result-count"]').text()).toBe('显示 0 / 3 道')

    await wrapper.get('[data-testid="mistake-subject-语文"]').trigger('click')
    await wrapper.get('[data-testid="mistake-status-all"]').trigger('click')
    expect(wrapper.get('[data-testid="mistake-subject-语文"]').attributes('aria-pressed')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="mistake-status-all"]').attributes('aria-pressed')).toBe(
      'true',
    )

    // 即使下钻值与上次相同，新的结构化命令也必须清理当前局部筛选。
    await wrapper.setProps({ navigation: { ...masteredMath } })
    await flushPromises()
    expect(wrapper.get('[data-testid="mistake-subject-数学"]').attributes('aria-pressed')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="mistake-status-mastered"]').attributes('aria-pressed')).toBe(
      'true',
    )
  })

  it('错题仍在加载时只在全部错题对象显示加载态，不污染本周计划', async () => {
    let resolveMistakes!: (value: unknown) => void
    h.listMistakes.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMistakes = resolve
      }),
    )
    const wrapper = renderRecords({ target: 'mistakes' })

    expect(wrapper.find('[data-testid="records-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="review-empty-card"]').exists()).toBe(false)

    resolveMistakes({ items: [] })
    await flushPromises()
  })

  it('五个对象均已成功加载且全零时，本周计划稳定表达空周，不恢复旧全局 FTUE', async () => {
    h.listMistakes.mockReset().mockResolvedValue({ items: [] })
    h.reviewQueue.mockReset().mockResolvedValue({ items: [] })
    h.listAccumulation.mockReset().mockResolvedValue({ items: [] })
    h.listPracticeSets.mockReset().mockResolvedValue({ items: [] })
    h.listCreativeWorks.mockReset().mockResolvedValue({ items: [] })

    const wrapper = renderRecords()
    await flushPromises()

    expect(wrapper.find('[data-testid="records-ftue"]').exists()).toBe(false)
    expect(wrapper.get('.weekly-hero').text()).toContain('0项本周该练')
    expect(wrapper.find('[data-testid="setup-weekly-progress"]').exists()).toBe(true)
    expect(
      wrapper.findAll('.k12-tab-count').map((count) => count.attributes('data-count')),
    ).toEqual(['0', '0', '0', '0', '0'])
  })

  it('其他对象尚未落定时不抢跑旧全局 FTUE，也不阻塞本周计划', async () => {
    let resolvePractice!: (value: unknown) => void
    h.listMistakes.mockReset().mockResolvedValue({ items: [] })
    h.reviewQueue.mockReset().mockResolvedValue({ items: [] })
    h.listAccumulation.mockReset().mockResolvedValue({ items: [] })
    h.listPracticeSets.mockReset().mockReturnValue(
      new Promise((resolve) => {
        resolvePractice = resolve
      }),
    )
    h.listCreativeWorks.mockReset().mockResolvedValue({ items: [] })

    const wrapper = renderRecords()
    await flushPromises()

    expect(wrapper.find('[data-testid="records-ftue"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="records-ftue-loading"]').exists()).toBe(false)
    expect(wrapper.find('.weekly-hero').exists()).toBe(true)

    resolvePractice({ items: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="records-ftue"]').exists()).toBe(false)
    expect(wrapper.find('.weekly-hero').exists()).toBe(true)
  })

  it('任一旁路对象加载失败时不伪装成全零 FTUE，也不污染本周计划', async () => {
    h.listMistakes.mockReset().mockResolvedValue({ items: [] })
    h.reviewQueue.mockReset().mockResolvedValue({ items: [] })
    h.listAccumulation.mockReset().mockResolvedValue({ items: [] })
    h.listPracticeSets.mockReset().mockResolvedValue({ items: [] })
    h.listCreativeWorks.mockReset().mockRejectedValue(new Error('作品加载失败'))

    const wrapper = renderRecords()
    await flushPromises()

    expect(wrapper.find('[data-testid="records-ftue"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="records-ftue-error"]').exists()).toBe(false)
    expect(wrapper.find('.weekly-hero').exists()).toBe(true)
  })

  it('积累分科筛选为空不等于积累对象全空，不误显示 FTUE', async () => {
    h.listMistakes.mockReset().mockResolvedValue({ items: [] })
    h.reviewQueue.mockReset().mockResolvedValue({ items: [] })
    h.listAccumulation.mockReset().mockImplementation((_agent: string, subject?: string) =>
      Promise.resolve({
        items:
          subject === '英语'
            ? []
            : [
                {
                  record_id: 'a1',
                  subject: '语文',
                  entry_type: '好词好句',
                  content: '春风又绿江南岸',
                  status: '已积累',
                },
              ],
      }),
    )
    h.listPracticeSets.mockReset().mockResolvedValue({ items: [] })
    h.listCreativeWorks.mockReset().mockResolvedValue({ items: [] })

    const wrapper = renderRecords()
    await flushPromises()
    await wrapper.get('[data-testid="subtab-accumulation"]').trigger('click')
    await wrapper.get('[data-testid="accum-filter-english"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="records-ftue"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="accum-empty-card"]').exists()).toBe(true)
  })

  it('学习档案溢出菜单支持完整菜单语义、键盘导航、外点关闭与焦点恢复', async () => {
    const wrapper = mount(K12RecordsView, {
      attachTo: document.body,
      props: { agentId: 'ming', agentName: '小明的辅导助手', grade: '五年级上 · 人教版' },
      global: { plugins: [createPinia(), i18n()] },
    })
    await flushPromises()
    await wrapper.get('[data-testid="subtab-mistakes"]').trigger('click')

    const trigger = wrapper.get('[data-testid="records-more-trigger"]')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    const menu = wrapper.get('[data-testid="records-more-menu"]')
    expect(menu.attributes('role')).toBe('menu')
    const items = menu.findAll('[role="menuitem"]')
    expect(items).toHaveLength(4)
    ;(items[0]!.element as HTMLElement).focus()
    await items[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1]!.element)
    await items[1]!.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(items[3]!.element)
    await items[3]!.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(items[0]!.element)
    await items[0]!.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="records-more-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('[data-testid="records-more-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })
})

describe('练习集 P0 · 原型唯一权威', () => {
  it('待打印头只保留打印/发送，不提供原型不存在的预览按钮', async () => {
    const wrapper = renderPractice()
    await flushPromises()
    expect(wrapper.find('[data-testid="ps-paper-preview"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ps-finalize-print"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ps-finalize-send"]').exists()).toBe(true)
  })

  it('加载失败只显示错误与重试，不同时误报待打印/历史为空', async () => {
    h.listPracticeSets.mockReset().mockRejectedValue(new Error('网络中断'))
    const wrapper = renderPractice()
    await flushPromises()
    expect(wrapper.get('[data-testid="ps-error"]').text()).toContain('网络中断')
    expect(wrapper.find('[data-testid="ps-basket-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ps-history-empty"]').exists()).toBe(false)
  })

  it('题目行和 blocked 降权严格复用原型度量', () => {
    expect(practiceSource).toMatch(
      /\.k12ps__item\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*22px minmax\(0,\s*1fr\) auto;[^}]*padding:\s*10px 12px;[^}]*border-radius:\s*10px;/s,
    )
    expect(practiceSource).toMatch(/\.k12ps__item--blocked\s*\{[^}]*opacity:\s*(?:0)?\.72;/s)
  })
})
