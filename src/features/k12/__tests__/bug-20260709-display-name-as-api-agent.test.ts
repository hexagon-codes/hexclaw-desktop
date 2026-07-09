/**
 * 审计单验证（20260709 · High）：K12 recognize/grade/prep 链路把 display name 当 API agent 发送。
 *
 * 后端契约：agent = agents.name（内部名，隔离键），非 display name
 * （scenarios/k12/API.md:147；apihttp/handler.go:218 用 req.Agent 作 AgentName）。
 *
 * 接线现状：ChatView scenarioCtx 传 agentId(内部名) + agentName(display_name)；
 * K12ChatEnhancement 只把 agentName 传进 RecognizeGuardPanel（该组件根本没有 agentId prop）→
 * grade / coldStart / 内联备课卡全用 display name 当隔离键 → 错孩子作用域 / profile 查不到 /
 * 记录写错键。
 *
 * 断言的是**正确行为**（API 收到的 agent === agentId 内部名）——测试失败即证明 bug 存在。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

const AGENT_ID = 'k12-tutor-KKE5v8zQ' // agents.name（后端隔离键）
const DISPLAY_NAME = '小明的辅导老师' // display_name（仅供展示）

const { k12Grade, k12ColdStart, k12PrepCard, k12Recognize } = vi.hoisted(() => ({
  k12Grade: vi.fn().mockResolvedValue({
    badge: 'verified-strong', evidence_type: 'program', record_created: true, record_id: 'r1',
  }),
  k12ColdStart: vi.fn().mockResolvedValue({ grade_term: '五年级上', inferred: true }),
  k12PrepCard: vi.fn().mockResolvedValue({ knowledge_points: ['20以内加法'], sections: [] }),
  k12Recognize: vi.fn().mockResolvedValue({
    questions: [{ question: '1+1=?', knowledge_points: ['20以内加法'] }],
  }),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard,
  k12Grade,
  k12Recognize,
  k12ColdStart,
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'], message_badges: [], composer_placeholder: '',
    composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1,
  }),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(metadata: Record<string, string>) {
  return mount(K12ChatEnhancement, {
    // 与 ChatView scenarioCtx 完全一致的传参形态：agentId=内部名，agentName=display_name
    props: { agentId: AGENT_ID, agentName: DISPLAY_NAME, metadata, descriptor: K12_VIEW_DESCRIPTOR },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

/** 打开识题面板 → 填图 → 识题（公共前置动作） */
async function recognizeOnce(w: ReturnType<typeof render>) {
  const toggle = document.querySelector('#hc-chat-scenario-composer-actions [data-testid="k12-recognize-toggle"]') as HTMLElement
  expect(toggle, '前置：composer 拍照识题入口存在').toBeTruthy()
  toggle.click()
  await flushPromises()
  await w.find('[data-testid="recognize-b64"]').setValue('data:image/png;base64,Zm9v')
  await w.find('[data-testid="recognize-run"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="rq-item"]').exists(), '前置：识题回显护栏出题').toBe(true)
}

describe('审计单-High-2：K12 grade/coldStart/prep 必须用 agents.name 作 API agent（非 display name）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  })

  it('★grade：批改请求的 agent 必须是 agentId（内部名），不得是 display name', async () => {
    const w = render({ 'k12.grade_term': '五年级上' })
    await recognizeOnce(w)

    await w.find('[data-testid="rq-answer-0"]').setValue('2')
    await w.find('[data-testid="rq-grade-0"]').trigger('click')
    await flushPromises()

    expect(k12Grade).toHaveBeenCalledTimes(1)
    const req = k12Grade.mock.calls[0]![0] as { agent: string }
    expect(
      req.agent,
      `grade 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 会写错孩子作用域`,
    ).toBe(AGENT_ID)
  })

  it('★prep（识题后内联辅导要点）：k12PrepCard 的 agent 必须是 agentId（内部名）', async () => {
    const w = render({ 'k12.grade_term': '五年级上' })
    await recognizeOnce(w)

    expect(k12PrepCard).toHaveBeenCalledTimes(1)
    const req = k12PrepCard.mock.calls[0]![0] as { agent: string }
    expect(
      req.agent,
      `prep-card 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 导致 profile 查找失败`,
    ).toBe(AGENT_ID)
  })

  it('★coldStart（无年级冷启动倒查建档）：k12ColdStart 的 agent 必须是 agentId（内部名）', async () => {
    const w = render({}) // 无 k12.grade_term → 冷启动入口出现
    await recognizeOnce(w)

    const infer = w.find('[data-testid="coldstart-infer"]')
    expect(infer.exists(), '前置：无年级 + 已识题 → 冷启动倒查入口出现').toBe(true)
    await infer.trigger('click')
    await flushPromises()

    expect(k12ColdStart).toHaveBeenCalledTimes(1)
    const req = k12ColdStart.mock.calls[0]![0] as { agent: string }
    expect(
      req.agent,
      `coldStart 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 会把建档写到错误的键`,
    ).toBe(AGENT_ID)
  })
})
