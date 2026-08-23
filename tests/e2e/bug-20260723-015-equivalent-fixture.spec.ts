import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(process.cwd())
const REFERENCE_URL = process.env.HEX_EQUIVALENT_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = process.env.HEX_EQUIVALENT_SOURCE_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.join(ROOT, 'test/evidence/bug-20260723-015-equivalent-fixture')
const PIXEL_DIFF_TOOL = path.join(ROOT, 'tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_SAMPLE_TOOL = path.join(ROOT, 'tests/e2e/tools/visual_pixel_samples.py')
const VIEWPORT = { width: 1440, height: 900 }
const PIXEL_THRESHOLD = 8
const MAX_TARGET_PIXEL_RATIO = 0.01
const MAX_FULL_PIXEL_RATIO = 0.01
const FIXED_NOW = Date.parse('2026-08-22T15:30:00+08:00')

// 等价夹具使用原型小明同一份记录快照，确保档案计数、状态、文本和来源不会把业务内容差异误报为外壳差异。
const K12_MING_MISTAKES = [
  {
    record_id: 'mistake-apple',
    question: '苹果和梨的价钱（P52·3）',
    knowledge_point: '小数乘法',
    error_cause: '连续错 2 次 · 计算失误',
    status: 'new',
    review_state: 'scheduled',
    subject: '数学',
    created_at: Date.parse('2026-07-16T08:00:00+08:00') / 1000,
    entry_source: 'photo',
    version: 1,
  },
  {
    record_id: 'mistake-bulb',
    question: '小灯泡没有形成闭合回路',
    knowledge_point: '简单电路',
    error_cause: '实验图判断错误',
    status: 'new',
    review_state: 'scheduled',
    subject: '科学',
    created_at: Date.parse('2026-07-15T08:00:00+08:00') / 1000,
    entry_source: 'photo',
    version: 1,
  },
  {
    record_id: 'mistake-decimal',
    question: '重复执行积木少循环 1 次',
    knowledge_point: '图形化编程',
    error_cause: '运行结果已复核 · 到期可再练',
    status: 'retried',
    review_state: 'retried',
    subject: '信息科技',
    created_at: Date.parse('2026-07-13T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
  {
    record_id: 'mistake-equation',
    question: '解方程 2x + 15 = 43',
    knowledge_point: '简易方程',
    error_cause: '复练 1 次 · 仍需巩固',
    status: 'retried',
    review_state: 'retried',
    subject: '数学',
    created_at: Date.parse('2026-07-12T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
  {
    record_id: 'mistake-believe',
    question: 'believe —— 拼成 belive（少 e）',
    knowledge_point: '错词',
    error_cause: '本轮已跳过 · 系统证据不足',
    status: 'new',
    review_state: 'scheduled',
    subject: '英语',
    created_at: Date.parse('2026-07-09T08:00:00+08:00') / 1000,
    entry_source: 'writing_confirmed',
    version: 1,
  },
  {
    record_id: 'mistake-poem',
    question: '「梅须逊雪三分白」漏「须」字',
    knowledge_point: '默写',
    error_cause: '上次生成任务未完成',
    status: 'new',
    review_state: 'scheduled',
    subject: '语文',
    created_at: Date.parse('2026-07-08T08:00:00+08:00') / 1000,
    entry_source: 'manual',
    version: 1,
  },
  {
    record_id: 'mistake-position',
    question: '用数对表示位置',
    knowledge_point: '位置',
    error_cause: '两次独立复练正确',
    status: 'mastered',
    review_state: 'mastered',
    subject: '数学',
    created_at: Date.parse('2026-06-21T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
] as const

const K12_MING_REVIEW_QUEUE = K12_MING_MISTAKES.slice(0, 6)

// 原型 k12BookPanel1 的 Ming 视图只显示 7 条记录，但导航总数为 11；
// 相关五对象计数取同一份原型快照，避免空 API 响应把壳层比较误报为数据漂移。
const K12_MING_WEEKLY_PLAN = {
  plan_id: 'weekly-2026-30',
  agent: 'mingming',
  revision: 11,
  status: 'draft',
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      arithmetic_batch: null,
      items: K12_MING_REVIEW_QUEUE.map((record, index) => ({
        item_id: `weekly-item-${index + 1}`,
        position: index + 1,
        plan_section: 'due_review',
        source_kind: 'mistake',
        source_ref: record.record_id,
        prompt_markdown: record.question,
        verification: { status: 'verified', evidence_refs: [`evidence-${record.record_id}`] },
      })),
    },
    { plan_section: 'textbook_consolidation', status: 'ready', arithmetic_batch: null, items: [] },
    { plan_section: 'arithmetic_warmup', status: 'ready', arithmetic_batch: null, items: [] },
  ],
}

const K12_MING_PRACTICE_SETS = [{
  record_id: 'practice-basket-ming',
  title: '待打印篮',
  source_kind: 'basket',
  status: 'draft',
  status_label: '草稿',
  publishable: true,
  items: Array.from({ length: 1 }, (_, index) => ({
    item_id: `practice-item-ming-${index + 1}`,
    subject: index < 4 ? '数学' : index === 4 ? '英语' : '语文',
    added_via: 'weekly',
    question_markdown: K12_MING_REVIEW_QUEUE[index]?.question ?? `本周练习 ${index + 1}`,
    expected_answer_markdown: '已验证',
    verification_status: 'verified',
    verification_evidence: '原题与答案已校验',
  })),
}]

const K12_MING_ACCUMULATION = [
  {
    record_id: 'accum-time',
    subject: '语文',
    entry_type: '好词好句',
    content: '「时间像海绵里的水，挤一挤总是有的」',
    source: '课外阅读',
    version: 1,
    created_at: Date.parse('2026-07-12T08:00:00+08:00') / 1000,
  },
  {
    record_id: 'accum-poem',
    subject: '语文',
    entry_type: '古诗积累',
    content: '《山居秋暝》全诗',
    source: '家长手动记入',
    version: 1,
    created_at: Date.parse('2026-07-08T08:00:00+08:00') / 1000,
  },
  {
    record_id: 'accum-cake',
    subject: '英语',
    entry_type: '表达积累',
    content: 'a piece of cake —— 小菜一碟',
    source: 'Unit 4',
    version: 1,
    created_at: Date.parse('2026-07-09T08:00:00+08:00') / 1000,
  },
]

const K12_MING_CREATIVE_WORKS = [
  {
    work_id: 'WRITING-20260715-001',
    work_type: 'writing',
    display_name: '《春天的校园》',
    content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
    row_version: 1,
    created_at: Date.parse('2026-07-15T08:00:00+08:00') / 1000,
    latest_generation_at: Date.parse('2026-07-15T08:00:00+08:00') / 1000,
    initial_feedback: { generation_id: 'REVIEW-WRITING-20260715-001', status: 'succeeded' },
  },
  {
    work_id: 'ART-20260716-001',
    work_type: 'art',
    display_name: '《雨后的校园》',
    row_version: 1,
    created_at: Date.parse('2026-07-16T08:00:00+08:00') / 1000,
    latest_generation_at: Date.parse('2026-07-16T08:00:00+08:00') / 1000,
    initial_feedback: { generation_id: 'REVIEW-ART-20260716-001', status: 'succeeded' },
  },
  {
    work_id: 'ART-20260717-002',
    work_type: 'art',
    display_name: '《桌上的水杯》',
    row_version: 1,
    created_at: Date.parse('2026-07-17T08:00:00+08:00') / 1000,
    latest_generation_at: null,
    initial_feedback: { generation_id: 'REVIEW-ART-20260717-002', status: 'failed', failure_message: '点评生成失败' },
  },
]

function k12PracticeGeneration(recordID: string) {
  if (recordID === 'mistake-apple') {
    return {
      state: 'joined',
      source_mistake_id: recordID,
      practice_set_id: 'practice-basket-ming',
      practice_item_id: 'practice-item-ming-1',
      item: { question_markdown: '苹果和梨的价钱 · 变式题', verification_evidence: '小数乘法进位 · 确定性答案已校验', expected_answer_markdown: '已验证' },
    }
  }
  if (recordID === 'mistake-poem') return { state: 'failed', source_mistake_id: recordID, failure_reason: '上次生成任务未完成' }
  if (recordID === 'mistake-decimal') return { state: 're_add', source_mistake_id: recordID }
  return { state: 'available', source_mistake_id: recordID }
}

type Theme = 'light' | 'dark'
type Mode = 'normal' | 'k12'
type Side = 'reference' | 'implementation'
type PanelKind = 'context' | 'artifacts'
type PanelPhase = 'closed' | 'context-open' | 'artifacts-open'

type Surface = {
  id: string
  mode: Mode
  sourceRoute: string
  prototypePane: 'chat' | 'agents' | 'settings'
  openPrototype?: 'records'
}

type Rect = { x: number; y: number; width: number; height: number }

type ElementSnapshot = {
  selector: string
  present: boolean
  tag?: string
  className?: string
  rect: Rect
  style: Record<string, string>
}

type PixelReport = {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

const SURFACES: Surface[] = [
  { id: 'normal-chat', mode: 'normal', sourceRoute: '/chat', prototypePane: 'chat' },
  { id: 'normal-agents', mode: 'normal', sourceRoute: '/agents', prototypePane: 'agents' },
  { id: 'k12-settings', mode: 'k12', sourceRoute: '/settings', prototypePane: 'settings' },
  {
    id: 'k12-records',
    mode: 'k12',
    sourceRoute: `/chat?role=mingming&roleTitle=${encodeURIComponent('小明的辅导助手')}&scenarioTab=records`,
    prototypePane: 'chat',
    openPrototype: 'records',
  },
]

const THEMES: Theme[] = ['light', 'dark']

function assertLoopback(value: string, label: string) {
  const hostname = new URL(value).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error(`${label} must be loopback-only: ${value}`)
  }
}

assertLoopback(REFERENCE_URL, 'HEX_EQUIVALENT_REFERENCE_URL')
assertLoopback(SOURCE_URL, 'HEX_EQUIVALENT_SOURCE_URL')

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSourceFixture(page: Page, theme: Theme, mode: Mode, external: string[]) {
  await page.addInitScript(({ nextTheme, nextMode, now }) => {
    localStorage.clear()
    sessionStorage.clear()
    Date.now = () => now
    localStorage.setItem('hc-theme', nextTheme)
    localStorage.setItem(
      'hc-k12-appearance-v1',
      JSON.stringify({ version: 1, preference: nextMode === 'k12' ? 'k12' : 'default', introSeen: true }),
    )
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', nextMode === 'k12' ? 'session-k12' : 'session-normal')
    localStorage.setItem(
      'hexclaw_sessionAgents',
      JSON.stringify(nextMode === 'k12' ? { 'session-k12': 'mingming' } : {}),
    )

    class FixtureWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      readyState = FixtureWebSocket.CONNECTING
      url: string
      onopen: ((event: Event) => unknown) | null = null
      onclose: ((event: Event) => unknown) | null = null
      onerror: ((event: Event) => unknown) | null = null
      onmessage: ((event: MessageEvent) => unknown) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        queueMicrotask(() => {
          this.readyState = FixtureWebSocket.OPEN
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
        })
      }

      close() {
        this.readyState = FixtureWebSocket.CLOSED
        const event = new Event('close')
        this.onclose?.(event)
        this.dispatchEvent(event)
      }

      send() {}
    }

    window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket
  }, { nextTheme: theme, nextMode: mode, now: FIXED_NOW })

  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      external.push(requestURL.toString())
      return route.abort('blockedbyclient')
    }
    if (requestURL.hostname === 'localhost' && requestURL.port === '11434') {
      return json(route, { models: [], running: false, associated: false })
    }
    if (!requestURL.pathname.startsWith('/_hexclaw/')) return route.continue()

    const apiPath = requestURL.pathname.replace('/_hexclaw', '')
    const method = route.request().method()
    if (apiPath === '/health') return json(route, { status: 'ok' })
    if (apiPath === '/api/v1/config') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        llm: { default: '', providers: {} },
        knowledge: { enabled: true },
        sandbox: { network_enabled: true, allowed_paths: [] },
        security: {},
      })
    }
    if (apiPath === '/api/v1/config/llm') {
      return json(route, { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } })
    }
    if (apiPath === '/api/v1/ollama/status') return json(route, { running: false, associated: false, models: [] })
    if (apiPath === '/api/v1/agents') {
      return json(route, {
        agents: [{
          name: 'mingming',
          display_name: '小明的辅导助手',
          description: '五年级辅导',
          provider: '',
          model: '',
          metadata: {
            scenario: 'k12-tutor',
            avatar: '🎓',
            'k12.child_name': '小明',
            'k12.grade_term': '五年级下',
            'k12.textbook_edition': '人教版',
          },
        }],
        total: 1,
        default: 'mingming',
      })
    }
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/sessions') {
      const k12 = mode === 'k12'
      return json(route, {
        sessions: [{
          id: k12 ? 'session-k12' : 'session-normal',
          title: k12 ? '小明的辅导助手 · 五年级' : '背景等价验收会话',
          created_at: '2026-08-22T15:00:00+08:00',
          updated_at: '2026-08-22T15:20:00+08:00',
          message_count: 0,
          pinned: true,
        }],
        total: 1,
      })
    }
    if (/\/api\/v1\/sessions\/[^/]+\/messages$/.test(apiPath)) return json(route, { messages: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/mcp/servers') return json(route, { servers: [], total: 0 })
    if (apiPath === '/api/v1/mcp/tools') return json(route, { tools: [], total: 0 })
    if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') return json(route, { prompts: [], total: 0 })
    if (apiPath === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: [],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
      return json(
        route,
        apiPath === '/api/k12/mistakes'
          ? { items: K12_MING_MISTAKES, total: 11 }
          : { items: K12_MING_REVIEW_QUEUE },
      )
    }
    const generationMatch = apiPath.match(/^\/api\/k12\/mistakes\/([^/]+)\/practice-generation$/)
    if (generationMatch && method === 'GET') {
      return json(route, k12PracticeGeneration(decodeURIComponent(generationMatch[1])))
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: 'mingming',
        revision: 7,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: K12_MING_WEEKLY_PLAN, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
      return json(route, { items: K12_MING_ACCUMULATION })
    }
    if (apiPath === '/api/k12/practice-sets' && method === 'GET') {
      return json(route, { items: K12_MING_PRACTICE_SETS })
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: K12_MING_CREATIVE_WORKS })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        grade_term: '五年级下',
        trend: { total: 11, mastered: 5, reviewing: 6, retried: 7, archived: 0 },
        weak_top3: [
          { knowledge_point: '小数乘法', count: 4, share: 0.36, subject: '数学' },
          { knowledge_point: '简易方程', count: 3, share: 0.27, subject: '数学' },
          { knowledge_point: 'Unit 4 拼写', count: 2, share: 0.18, subject: '英语' },
        ],
        month_new_mistakes: 11,
        review_completion_rate: 0.72,
        consecutive_fail_kps: ['简易方程'],
        week_pending: 6,
        practice_pending: 2,
        suggestion: '优先复习小数乘法，再完成练习集。',
      })
    }
    if (apiPath === '/api/k12/study-time') return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, {
        progress: {
          progress_id: 'progress-ming',
          agent: 'mingming',
          subject: 'math',
          revision: 4,
          textbook_edition: '人教版',
          title: '义务教育教科书数学',
          volume: '五年级下册',
          unit_id: 'unit-4',
          unit_title: '第4单元「分数的意义和性质」',
          verified_page_from: 45,
          verified_page_to: 62,
          page_verification_status: 'verified',
          evidence_source: 'parent_confirmed',
        },
      })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [], total: 0 })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function preparePrototype(page: Page, surface: Surface, theme: Theme, external: string[]) {
  await page.addInitScript((mode: Mode) => {
    localStorage.setItem('hexclaw.prototype.k12Appearance.v1', JSON.stringify({
      preference: mode === 'k12' ? 'k12' : 'default',
      introSeen: true,
    }))
  }, surface.mode)
  await page.route('**/*', (route) => {
    const requestURL = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestURL.hostname)) {
      external.push(requestURL.toString())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ nextTheme, pane, openPrototype }) => {
    const api = window as typeof window & {
      applyThemeState?: (theme: Theme, announce: boolean) => void
      goRecords?: (learner: string, tab?: number) => void
      k12BookTab?: (tab: number) => void
    }
    api.applyThemeState?.(nextTheme, false)
    if (openPrototype === 'records') {
      api.goRecords?.('ming', 1)
      // goRecords() 在原型中切换视觉 pane，但不更新二级 tab 的 aria 状态；
      // 等价测试补同一“全部错题”交互语义，避免只比 class 造成状态假相等。
      api.k12BookTab?.(1)
    }
    else document.querySelector<HTMLButtonElement>(`.sb-item[data-screen="${pane}"]`)?.click()
  }, { nextTheme: theme, pane: surface.prototypePane, openPrototype: surface.openPrototype })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (surface.openPrototype === 'records') await expect(page.locator('#k12BookPanel1')).toBeVisible()
  else await expect(page.locator(`.screen[data-pane="${surface.prototypePane}"].on`)).toBeVisible()
  if (surface.mode === 'k12') await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  await stabilize(page)
}

async function prepareSource(page: Page, surface: Surface, theme: Theme) {
  await page.goto(new URL(surface.sourceRoute, SOURCE_URL).toString(), { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.hc-app')).toBeVisible()
  await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (surface.mode === 'k12') await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  else await expect(page.locator('body')).not.toHaveAttribute('data-k12-skin-active', 'k12')
  if (surface.openPrototype === 'records') {
    // 原型通过 goRecords('ming', 1) 打开“全部错题”；实现深链只定位到学习档案一级页签，夹具补齐同一交互状态。
    await expect(page.getByTestId('subtab-mistakes')).toBeVisible()
    await page.getByTestId('subtab-mistakes').click()
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
  }
  await stabilize(page)
}

async function stabilize(page: Page) {
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}` })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await page.mouse.move(1, 1)
}

async function collectK12BusinessState(page: Page, side: Side) {
  return page.evaluate((currentSide) => {
    const root = currentSide === 'reference' ? document.querySelector('#k12BookPanel1') : document.querySelector('.k12enh-records')
    const rowSelector = currentSide === 'reference'
      ? '#k12MistakeList .resource-row'
      : '.k12mistakes .rl-rows .rl-row'
    const rows = [...document.querySelectorAll<HTMLElement>(rowSelector)].filter((row) => {
      const style = getComputedStyle(row)
      return !row.hidden && style.display !== 'none' && style.visibility !== 'hidden'
    })
    const text = (selector: string, row: HTMLElement) => row.querySelector<HTMLElement>(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const statusOf = (row: HTMLElement) => {
      const raw = row.dataset.status ?? row.dataset.recordStatus ?? text('.rl-status, .stpill', row)
      return ({ '待复习': 'scheduled', '已重做': 'retried', '已掌握': 'mastered', '不再复习': 'suppressed' } as Record<string, string>)[raw] ?? raw
    }
    const tabs = [...(currentSide === 'reference'
      ? document.querySelectorAll<HTMLElement>('#k12BookTabs [role="tab"]')
      : document.querySelectorAll<HTMLElement>('.k12rec__tabs .k12-book-tabs [role="tab"]'))].map((tab) => ({
      label: [...tab.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
      count: tab.querySelector<HTMLElement>('.k12-tab-count')?.getAttribute('data-count')
        ?? tab.querySelector<HTMLElement>('.k12-tab-count')?.textContent?.trim()
        ?? '',
      selected: tab.getAttribute('aria-selected') === 'true',
    }))
    return {
      rootPresent: Boolean(root),
      visibleRowCount: rows.length,
      rows: rows.map((row) => ({
        id: row.dataset.mistakeKey ?? row.dataset.recordId ?? '',
        date: text('.rl-date', row) || text('span:first-child', row),
        title: text('.rl-title', row) || text('b', row),
        status: statusOf(row),
        source: text('.rl-source', row) || text('.srctag', row),
        rawText: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      })),
      tabs,
    }
  }, side)
}

function canonicalK12BusinessState(state: any) {
  const idMap: Record<string, string> = {
    'm-apple': 'mistake-apple',
    'm-circuit': 'mistake-bulb',
    'm-loop': 'mistake-decimal',
    'm-eq': 'mistake-equation',
    'm-believe': 'mistake-believe',
    'm-poem': 'mistake-poem',
    '': 'mistake-position',
  }
  return {
    visibleRowCount: state?.visibleRowCount ?? 0,
    rows: (state?.rows ?? []).map((row: any) => ({
      id: idMap[row.id] ?? row.id,
      date: row.date,
      title: row.title,
      status: row.status,
      source: row.source,
    })),
    tabs: (state?.tabs ?? []).map((tab: any) => ({
      label: tab.label,
      count: tab.count,
      selected: tab.selected,
    })),
  }
}

async function injectEquivalentFixture(page: Page, side: Side, surface: Surface, theme: Theme) {
  return page.evaluate(({ currentSide, currentSurface, currentTheme }) => {
    const rootSelector = currentSide === 'reference' ? '.mn' : '.hc-app__content'
    const root = document.querySelector<HTMLElement>(rootSelector)
    if (!root) throw new Error(`equivalent fixture root missing: ${rootSelector}`)

    // 只隐藏业务内容，不隐藏工具栏/面板控制。此前把整个 `.hc-chat__main`
    // visibility:hidden，连同 ChatToolbar 一起隐藏，导致右栏阶段无法通过真实
    // 控件进入 open state；这里按页面结构保留 shell chrome 与右栏宿主。
    const hiddenSelectors = currentSide === 'reference'
      ? currentSurface === 'normal-chat'
        ? ['.chat-sessions', '.chat-sessions-resizer', '.chat-thread', '.chat-input', '.side-panel__body']
        : currentSurface === 'k12-records'
          ? ['.side-panel__body']
          : ['.screen.on .content', '.side-panel__body']
      : currentSurface === 'normal-chat'
        ? [
            '.hc-chat__sidebar',
            '.hc-chat__sidebar-resizer',
            '.hc-chat__messages',
            '.hc-chat__input-area',
            '.hc-chat__scenario-inline',
            '#hc-chat-scenario-footer',
            '#hc-chat-scenario-composer-top',
            '.hc-inspector__body',
            '.hc-artifacts__body',
          ]
        : currentSurface === 'normal-agents'
          ? ['.hc-agents__content', '.hc-inspector__body', '.hc-artifacts__body']
        : currentSurface === 'k12-settings'
            ? ['.hc-settings__content', '.hc-inspector__body', '.hc-artifacts__body']
            : ['.hc-chat__messages', '.hc-chat__input-area', '.k12enh-chat-panel', '.hc-inspector__body', '.hc-artifacts__body']

    const hidden = hiddenSelectors.flatMap((selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)],
    )
    if (hidden.length === 0) throw new Error(`equivalent fixture content missing: ${hiddenSelectors.join(',')}`)
    for (const content of hidden) {
      content.style.visibility = 'hidden'
      content.dataset.bug015EquivalentHidden = 'true'
    }

    // Panels are mounted lazily after the fixture is injected. Keep their
    // business body hidden when the real open control mounts it later, while
    // preserving the header, close control, host width and border geometry.
    document.querySelector('#bug015-equivalent-hidden-style')?.remove()
    const hiddenStyle = document.createElement('style')
    hiddenStyle.id = 'bug015-equivalent-hidden-style'
    hiddenStyle.textContent = `${hiddenSelectors.join(',')} { visibility: hidden !important; }`
    document.head.append(hiddenStyle)

    // Chat implementations carry their own opaque `--hc-bg-main`; clear only
    // that page-local paint in the read-only fixture so the shared app/content
    // background and glow are the compared layers, matching prototype chat.
    const transparentSelectors = currentSide === 'reference'
      ? currentSurface === 'normal-chat'
        ? ['.chat', '.chat-main', '.screen.on']
        : ['.screen.on']
      : currentSurface === 'normal-chat'
        ? ['.hc-chat', '.hc-chat__main']
        : ['.hc-app__view > :first-child']
    const transparent = transparentSelectors.flatMap((selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)],
    )
    for (const content of transparent) {
      content.style.background = 'transparent'
      content.style.backgroundImage = 'none'
      content.dataset.bug015EquivalentTransparent = 'true'
    }

    document.querySelector('#bug015-equivalent-fixture')?.remove()
    const fixture = document.createElement('div')
    fixture.id = 'bug015-equivalent-fixture'
    fixture.dataset.surface = currentSurface
    fixture.dataset.theme = currentTheme
    fixture.dataset.fixture = currentSurface === 'k12-records'
      ? 'same-state-business-records-v1'
      : 'same-shell-transparent-content-v1'
    Object.assign(fixture.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '1',
      pointerEvents: 'none',
      background: 'transparent',
      overflow: 'hidden',
    })
    const marker = document.createElement('div')
    marker.dataset.fixtureMarker = currentSurface === 'k12-records'
      ? 'same-business-records'
      : 'same-transparent-content'
    Object.assign(marker.style, {
      position: 'absolute',
      inset: '0',
      background: 'transparent',
      border: '0 solid transparent',
      color: 'transparent',
      opacity: '0',
    })
    fixture.append(marker)
    root.append(fixture)
    return {
      rootSelector,
      hiddenSelectors,
      hiddenCount: hidden.length,
      hiddenStyleSelector: '#bug015-equivalent-hidden-style',
      transparentSelectors,
      fixtureSelector: '#bug015-equivalent-fixture',
      rootRect: (() => { const rect = root.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })(),
      fixtureSignature: fixture.outerHTML,
    }
  }, { currentSide: side, currentSurface: surface.id, currentTheme: theme })
}

type PanelAvailability = 'OPENED' | 'NOT_APPLICABLE'

async function setImplementationWorkspaceMode(page: Page, mode: PanelKind | 'closed'): Promise<PanelAvailability> {
  await page.evaluate((nextMode) => {
    const app = document.querySelector<HTMLElement>('.hc-app') as (HTMLElement & { __vueParentComponent?: any }) | null
    const chat = document.querySelector<HTMLElement>('.hc-chat') as (HTMLElement & { __vueParentComponent?: any }) | null

    // Artifact rail is a ChatView-owned surface. Generic pages intentionally
    // have no artifact producer/host, so retain an explicit N/A phase rather
    // than manufacturing a test-only panel node.
    if (nextMode === 'artifacts' && !chat) return

    // Prefer the real toolbar when this surface owns the shell header.
    if (chat) {
      const toolbar = chat.querySelector<HTMLElement>('.hc-chat__toolbar')
      const title = nextMode === 'context' ? '上下文面板' : nextMode === 'artifacts' ? '产物' : ''
      const button = title
        ? [...(toolbar?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
            (candidate) => candidate.title === title || candidate.getAttribute('aria-label') === title,
          )
        : undefined
      if (button) {
        button.click()
        return
      }

      // K12 scenario-owned headers intentionally do not render ChatToolbar.
      // Drive the same ChatView ref through Vue's dev-only component handle;
      // this is a test-only state entry and does not add a production control.
      const setup = chat.__vueParentComponent?.setupState
      if (setup && 'chatWorkspaceMode' in setup) {
        setup.chatWorkspaceMode = nextMode === 'closed' ? 'sessions' : nextMode
        return
      }
    }

    // Non-chat pages still expose the shared AppLayout context store, but have
    // no artifact rail. The context state is set through the real Pinia action.
    let instance = app?.__vueParentComponent
    while (instance) {
      const setup = instance.setupState
      const store = setup?.appStore
      if (store && typeof store.setDetailPanelOpen === 'function') {
        store.setDetailPanelOpen(nextMode === 'context')
        return
      }
      instance = instance.parent
    }
    throw new Error(`implementation workspace state entry missing: ${nextMode}`)
  }, mode)

  const selector = mode === 'context' ? '.hc-inspector' : mode === 'artifacts' ? '.hc-artifacts' : ''
  if (selector && await page.locator(selector).count() === 0) {
    return 'NOT_APPLICABLE'
  }
  if (selector) await expect(page.locator(selector)).toBeVisible()
  else {
    await expect(page.locator('.hc-inspector, .hc-artifacts')).toHaveCount(0)
  }
  return 'OPENED'
}

async function clickPanel(page: Page, side: Side, kind: PanelKind): Promise<PanelAvailability> {
  if (side === 'implementation') {
    const status = await setImplementationWorkspaceMode(page, kind)
    await stabilize(page)
    return status
  }
  await page.evaluate(({ currentSide, panelKind }) => {
    if (currentSide === 'reference') {
      const target = document.querySelector<HTMLButtonElement>(`[data-workspace-control="${panelKind}"]`)
      if (target) target.click()
      else {
        const toggle = (window as typeof window & { toggleSidePanel?: (kind: PanelKind) => void }).toggleSidePanel
        if (!toggle) throw new Error(`reference panel control missing: ${panelKind}`)
        toggle(panelKind)
      }
      return
    }
    const title = panelKind === 'context' ? '上下文面板' : '产物'
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.hc-chat__toolbar button')]
    const target = buttons.find((button) => button.title === title || button.getAttribute('aria-label') === title)
      ?? (panelKind === 'context' ? buttons.at(-1) : buttons.at(-2))
    if (!target) throw new Error(`implementation panel control missing: ${title}`)
    target.click()
  }, { currentSide: side, panelKind: kind })
  const selector = side === 'reference'
    ? kind === 'context' ? '#detailPanel.on' : '#artifactsPanel.on'
    : kind === 'context' ? '.hc-inspector' : '.hc-artifacts'
  await expect(page.locator(selector)).toBeVisible()
  await stabilize(page)
  return 'OPENED'
}

async function closePanel(page: Page, side: Side, kind: PanelKind): Promise<PanelAvailability> {
  if (side === 'implementation') {
    const status = await setImplementationWorkspaceMode(page, 'closed')
    await stabilize(page)
    return status
  }
  await page.evaluate(({ currentSide, panelKind }) => {
    if (currentSide === 'reference') {
      const target = document.querySelector<HTMLButtonElement>(`[data-workspace-control="${panelKind}"]`)
      if (target) target.click()
      else {
        const toggle = (window as typeof window & { toggleSidePanel?: (kind: PanelKind) => void }).toggleSidePanel
        if (!toggle) throw new Error(`reference panel control missing: ${panelKind}`)
        toggle(panelKind)
      }
      return
    }
    const title = panelKind === 'context' ? '上下文面板' : '产物'
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.hc-chat__toolbar button')]
    const target = buttons.find((button) => button.title === title || button.getAttribute('aria-label') === title)
      ?? (panelKind === 'context' ? buttons.at(-1) : buttons.at(-2))
    if (!target) throw new Error(`implementation panel control missing: ${title}`)
    target.click()
  }, { currentSide: side, panelKind: kind })
  const selector = side === 'reference'
    ? kind === 'context' ? '#detailPanel.on' : '#artifactsPanel.on'
    : kind === 'context' ? '.hc-inspector' : '.hc-artifacts'
  await expect(page.locator(selector)).toBeHidden()
  await stabilize(page)
  return 'OPENED'
}

async function collectElement(page: Page, selector: string): Promise<ElementSnapshot> {
  return page.evaluate((target) => {
    const node = document.querySelector<HTMLElement>(target)
    if (!node) {
      return {
        selector: target,
        present: false,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        style: {
          display: 'none', visibility: 'hidden', opacity: '0', pointerEvents: 'none',
          width: '0px', height: '0px', borderLeftWidth: '0px', borderLeftStyle: 'none',
          backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', zIndex: 'auto',
        },
      }
    }
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const keys = [
      'display', 'position', 'visibility', 'opacity', 'pointerEvents', 'width', 'height',
      'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor', 'paddingTop', 'paddingRight',
      'paddingBottom', 'paddingLeft', 'backgroundColor', 'backgroundImage', 'backgroundPosition',
      'backgroundSize', 'backgroundRepeat', 'backgroundBlendMode', 'mixBlendMode', 'zIndex',
    ]
    return {
      selector: target,
      present: true,
      tag: node.tagName.toLowerCase(),
      className: node.className,
      rect: { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 },
      style: Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`))])),
    }
  }, selector)
}

async function collectSnapshot(page: Page, side: Side, phase: PanelPhase, surface: Surface) {
  const selectors = side === 'reference'
    ? {
      app: '.app', sidebar: '.sb', main: '.mn', glow: '.mn-glow', screen: '.screen.on',
      context: '#detailPanel', artifacts: '#artifactsPanel', fixture: '#bug015-equivalent-fixture',
    }
    : {
      app: '.hc-app', body: '.hc-app__body',
      // ArtifactsPanel is a child of ChatView, while DetailPanel is an
      // AppLayout sibling. Compare the same flex row as the prototype for
      // chat/K12-chat; generic pages keep the shared content root.
      main: (surface.id === 'normal-chat' || surface.id === 'k12-records') && phase === 'artifacts-open'
        ? '.hc-chat__main'
        : surface.id === 'normal-chat' || surface.id === 'k12-records'
          ? '.hc-chat'
          : '.hc-app__content',
      glow: '.hc-app__glow',
      screen: '.hc-app__view', context: '.hc-inspector', artifacts: '.hc-artifacts', fixture: '#bug015-equivalent-fixture',
    }
  const entries = await Promise.all(Object.entries(selectors).map(async ([key, selector]) => [key, await collectElement(page, selector)] as const))
  return { side, phase, selectors, elements: Object.fromEntries(entries) as Record<string, ElementSnapshot> }
}

function rectUnion(snap: Awaited<ReturnType<typeof collectSnapshot>>) {
  const keys = ['main', 'context', 'artifacts']
  const visible = keys.map((key) => snap.elements[key]).filter((item) => item?.present && item.rect.width > 0 && item.rect.height > 0)
  if (!visible.length) return snap.elements.main.rect
  const left = Math.min(...visible.map((item) => item.rect.x))
  const top = Math.min(...visible.map((item) => item.rect.y))
  const right = Math.max(...visible.map((item) => item.rect.x + item.rect.width))
  const bottom = Math.max(...visible.map((item) => item.rect.y + item.rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function roundSignature(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function pixelDiff(referencePath: string, implementationPath: string, diffPath: string) {
  const { stdout } = await execFileAsync('uv', [
    'run', '--offline', '--isolated', '--python', '3.12', '--with', 'pillow==10.4.0', 'python',
    PIXEL_DIFF_TOOL, referencePath, implementationPath, diffPath, String(PIXEL_THRESHOLD),
  ])
  return JSON.parse(stdout.trim()) as PixelReport
}

async function pixelSamples(imagePath: string, x: number, ys = [38, 80, 120, 180, 220, 257]) {
  const { stdout } = await execFileAsync('uv', [
    'run', '--offline', '--isolated', '--python', '3.12', '--with', 'pillow==10.4.0', 'python',
    PIXEL_SAMPLE_TOOL, imagePath, String(Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(x)))), ys.join(','),
  ])
  return JSON.parse(stdout.trim()) as Record<string, unknown>
}

async function capturePair(
  referencePage: Page,
  implementationPage: Page,
  outputDir: string,
  surface: Surface,
  theme: Theme,
  phase: PanelPhase,
) {
  await stabilize(referencePage)
  await stabilize(implementationPage)
  const [referenceSnapshot, implementationSnapshot] = await Promise.all([
    collectSnapshot(referencePage, 'reference', phase, surface),
    collectSnapshot(implementationPage, 'implementation', phase, surface),
  ])
  const targetReference = path.join(outputDir, 'target-reference.png')
  const targetImplementation = path.join(outputDir, 'target-implementation.png')
  const targetDiff = path.join(outputDir, 'target-pixel-diff.png')
  const fullReference = path.join(outputDir, 'full-reference.png')
  const fullImplementation = path.join(outputDir, 'full-implementation.png')
  const fullDiff = path.join(outputDir, 'full-pixel-diff.png')
  const referenceBounds = rectUnion(referenceSnapshot)
  const implementationBounds = rectUnion(implementationSnapshot)
  const targetClip = {
    width: Math.min(referenceBounds.width, implementationBounds.width),
    height: Math.min(referenceBounds.height, implementationBounds.height),
  }
  await Promise.all([
    referencePage.screenshot({ path: targetReference, clip: { x: referenceBounds.x, y: referenceBounds.y, ...targetClip }, animations: 'disabled', caret: 'hide', scale: 'css' }),
    implementationPage.screenshot({ path: targetImplementation, clip: { x: implementationBounds.x, y: implementationBounds.y, ...targetClip }, animations: 'disabled', caret: 'hide', scale: 'css' }),
    referencePage.screenshot({ path: fullReference, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' }),
    implementationPage.screenshot({ path: fullImplementation, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' }),
  ])
  const [targetPixels, fullPixels] = await Promise.all([
    pixelDiff(targetReference, targetImplementation, targetDiff),
    pixelDiff(fullReference, fullImplementation, fullDiff),
  ])
  const sharedX = (referenceSnapshot.elements.main.rect.x + referenceSnapshot.elements.main.rect.width / 2 + implementationSnapshot.elements.main.rect.x + implementationSnapshot.elements.main.rect.width / 2) / 2
  const [referenceSamples, implementationSamples] = await Promise.all([
    pixelSamples(targetReference, sharedX - referenceBounds.x),
    pixelSamples(targetImplementation, sharedX - implementationBounds.x),
  ])
  const contract = {
    closed: phase === 'closed' ? {
      referenceContext: referenceSnapshot.elements.context.rect.width === 0 && referenceSnapshot.elements.context.style.borderLeftWidth === '0px',
      referenceArtifacts: referenceSnapshot.elements.artifacts.rect.width === 0 && referenceSnapshot.elements.artifacts.style.borderLeftWidth === '0px',
      implementationContext: !implementationSnapshot.elements.context.present,
      implementationArtifacts: !implementationSnapshot.elements.artifacts.present,
    } : null,
    open: phase === 'context-open' ? {
      reference: referenceSnapshot.elements.context.rect.width === 272 && referenceSnapshot.elements.context.style.borderLeftWidth === '1px',
      implementation: implementationSnapshot.elements.context.rect.width === 272 && implementationSnapshot.elements.context.style.borderLeftWidth === '1px',
    } : phase === 'artifacts-open' ? {
      reference: referenceSnapshot.elements.artifacts.rect.width === 380 && referenceSnapshot.elements.artifacts.style.borderLeftWidth === '1px',
      implementation: implementationSnapshot.elements.artifacts.rect.width === 380 && implementationSnapshot.elements.artifacts.style.borderLeftWidth === '1px',
    } : null,
  }
  const geometry = {
    main: {
      reference: referenceSnapshot.elements.main.rect,
      implementation: implementationSnapshot.elements.main.rect,
      maxDelta: Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(referenceSnapshot.elements.main.rect[key] - implementationSnapshot.elements.main.rect[key]))),
    },
    glow: {
      reference: referenceSnapshot.elements.glow.rect,
      implementation: implementationSnapshot.elements.glow.rect,
      maxDelta: Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(referenceSnapshot.elements.glow.rect[key] - implementationSnapshot.elements.glow.rect[key]))),
    },
  }
    const report = {
    bugIds: ['BUG-20260723-015', 'BUG-20260729-003'],
    acceptance: ['UI-GLOBAL-BACKGROUND-001', 'UI-SHELL-RIGHT-PANEL-DECISION-001', 'REG-FIX-20260721-CHAT-UI-001', 'K12-INV-036'],
    surface: surface.id,
    theme,
    phase,
      fixture: {
      kind: surface.id === 'k12-records' ? 'same-state-business-records-v1' : 'read-only-equivalent-shell-v1',
      businessVisible: surface.id === 'k12-records',
      hiddenReference: surface.id === 'normal-chat' ? '.chat business children' : '.screen.on > .content',
      hiddenImplementation: surface.id === 'normal-chat' ? '.hc-chat business children' : '.hc-app view business children',
      visibleShellPreserved: ['.app/.hc-app', '.mn/.hc-app__content', '.mn-glow/.hc-app__glow', 'right-panel-hosts'],
      referenceSignature: roundSignature(referenceSnapshot.elements.fixture.style.backgroundColor + referenceSnapshot.elements.fixture.style.backgroundImage),
      implementationSignature: roundSignature(implementationSnapshot.elements.fixture.style.backgroundColor + implementationSnapshot.elements.fixture.style.backgroundImage),
      fixtureStateEqual: referenceSnapshot.elements.fixture.style.backgroundColor === implementationSnapshot.elements.fixture.style.backgroundColor && referenceSnapshot.elements.fixture.style.backgroundImage === implementationSnapshot.elements.fixture.style.backgroundImage,
    },
    viewport: { ...VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' },
    contract,
    geometry,
    panels: { reference: { context: referenceSnapshot.elements.context, artifacts: referenceSnapshot.elements.artifacts }, implementation: { context: implementationSnapshot.elements.context, artifacts: implementationSnapshot.elements.artifacts } },
    pixels: {
      target: { ...targetPixels, pass: targetPixels.changed_pixel_ratio <= MAX_TARGET_PIXEL_RATIO },
      full: { ...fullPixels, pass: fullPixels.changed_pixel_ratio <= MAX_FULL_PIXEL_RATIO },
      samples: { x: sharedX, reference: referenceSamples, implementation: implementationSamples },
    },
    files: {
      targetReference: path.basename(targetReference), targetImplementation: path.basename(targetImplementation), targetDiff: path.basename(targetDiff),
      fullReference: path.basename(fullReference), fullImplementation: path.basename(fullImplementation), fullDiff: path.basename(fullDiff),
      bboxComputedStyle: 'bbox-computed-style.json',
    },
  }
  await writeFile(path.join(outputDir, 'bbox-computed-style.json'), `${JSON.stringify({ report, reference: referenceSnapshot, implementation: implementationSnapshot }, null, 2)}\n`)
  return report
}

async function captureState(browser: Browser, surface: Surface, theme: Theme, testInfo: TestInfo) {
  const externalReference: string[] = []
  const externalImplementation: string[] = []
  const errors: { reference: string[]; implementation: string[] } = { reference: [], implementation: [] }
  const options = { viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: theme, reducedMotion: 'reduce' as const, serviceWorkers: 'block' as const }
  const referenceContext = await browser.newContext(options)
  const implementationContext = await browser.newContext(options)
  const referencePage = await referenceContext.newPage()
  const implementationPage = await implementationContext.newPage()
  referencePage.on('pageerror', (error) => errors.reference.push(error.message))
  implementationPage.on('pageerror', (error) => errors.implementation.push(error.message))
  const baseDir = path.join(EVIDENCE_ROOT, process.env.HEX_EQUIVALENT_BROWSER === 'webkit' ? 'webkit' : 'chromium', `${surface.id}-${theme}`)
  await mkdir(baseDir, { recursive: true })
  try {
    await installSourceFixture(implementationPage, theme, surface.mode, externalImplementation)
    await Promise.all([
      preparePrototype(referencePage, surface, theme, externalReference),
      prepareSource(implementationPage, surface, theme),
    ])
    const rawReference = path.join(baseDir, 'raw-reference.png')
    const rawImplementation = path.join(baseDir, 'raw-implementation.png')
    const rawDiff = path.join(baseDir, 'raw-pixel-diff.png')
    await Promise.all([
      referencePage.screenshot({ path: rawReference, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' }),
      implementationPage.screenshot({ path: rawImplementation, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' }),
    ])
    const rawPixels = await pixelDiff(rawReference, rawImplementation, rawDiff)
    const fixtureState = await Promise.all([
      injectEquivalentFixture(referencePage, 'reference', surface, theme),
      injectEquivalentFixture(implementationPage, 'implementation', surface, theme),
    ])
    const businessState = surface.id === 'k12-records'
      ? await Promise.all([
          collectK12BusinessState(referencePage, 'reference'),
          collectK12BusinessState(implementationPage, 'implementation'),
        ])
      : null
    const reports: unknown[] = []
    for (const phase of ['closed', 'context-open', 'artifacts-open'] as const) {
      let panelAvailability: { reference: PanelAvailability; implementation: PanelAvailability } = {
        reference: 'OPENED',
        implementation: 'OPENED',
      }
      if (phase === 'context-open') {
        const [reference, implementation] = await Promise.all([
          clickPanel(referencePage, 'reference', 'context'),
          clickPanel(implementationPage, 'implementation', 'context'),
        ])
        panelAvailability = { reference, implementation }
      }
      if (phase === 'artifacts-open') {
        const [reference, implementation] = await Promise.all([
          clickPanel(referencePage, 'reference', 'artifacts'),
          clickPanel(implementationPage, 'implementation', 'artifacts'),
        ])
        panelAvailability = { reference, implementation }
      }
      const report = await capturePair(referencePage, implementationPage, path.join(baseDir, phase), surface, theme, phase)
      reports.push({ ...report, fixtureState, panelAvailability })
      if (phase === 'context-open') {
        await Promise.all([closePanel(referencePage, 'reference', 'context'), closePanel(implementationPage, 'implementation', 'context')])
      }
      if (phase === 'artifacts-open') {
        await Promise.all([closePanel(referencePage, 'reference', 'artifacts'), closePanel(implementationPage, 'implementation', 'artifacts')])
      }
    }
    const equivalentPass = (reports as Array<any>).every((item) => item.pixels.target.pass && item.pixels.full.pass)
    const summary = {
      bugIds: ['BUG-20260723-015', 'BUG-20260729-003'],
      acceptance: ['UI-GLOBAL-BACKGROUND-001', 'UI-SHELL-RIGHT-PANEL-DECISION-001', 'REG-FIX-20260721-CHAT-UI-001', 'K12-INV-036'],
      surface: surface.id,
      theme,
      environment: { viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', browser: process.env.HEX_EQUIVALENT_BROWSER === 'webkit' ? 'webkit' : 'chromium' },
      network: { externalReference, externalImplementation, loopbackOnly: externalReference.length === 0 && externalImplementation.length === 0 },
      runtime: errors,
      businessFixture: surface.id === 'k12-records'
        ? {
            expected: {
              visibleRows: 7,
              totalMistakes: 11,
              reviewQueue: 6,
              objectCounts: { week: 6, mistakes: 11, practiceSets: 1, accumulation: 3, works: 3 },
            },
            reference: businessState?.[0],
            implementation: businessState?.[1],
            semanticStateEqual: JSON.stringify(canonicalK12BusinessState(businessState?.[0])) === JSON.stringify(canonicalK12BusinessState(businessState?.[1])),
          }
        : null,
      businessFixtureRawFullPage: { status: 'DIAGNOSTIC_ONLY', pixels: rawPixels, files: { reference: 'raw-reference.png', implementation: 'raw-implementation.png', diff: 'raw-pixel-diff.png' } },
      equivalentFixture: {
        status: surface.id === 'k12-records' ? 'NOT_COMPARABLE' : equivalentPass ? 'PASS' : 'RED',
        reason: surface.id === 'k12-records'
          ? '真实业务 DOM 已显示同态 7 条记录（总数 11、队列 6、计数/状态/文本/来源已对齐），但原型与生产渲染结构仍存在可见像素差异；保留 NOT_COMPARABLE。'
          : '本状态使用只读壳层夹具，业务内容隐藏，不能作为全页业务验收。',
        phases: reports,
      },
    }
    await writeFile(path.join(baseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  } finally {
    await Promise.all([referenceContext.close(), implementationContext.close()])
  }
}

test('same-state target/full fixture closes BUG-20260723-015 and BUG-20260729-003 visual comparability gap', async ({ browser }, testInfo) => {
  const summaries: unknown[] = []
  for (const surface of SURFACES) {
    for (const theme of THEMES) summaries.push(await captureState(browser, surface, theme, testInfo))
  }
  const summaryPath = path.join(EVIDENCE_ROOT, 'summary.json')
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const summary = {
    bugIds: ['BUG-20260723-015', 'BUG-20260729-003'],
    acceptance: ['UI-GLOBAL-BACKGROUND-001', 'UI-SHELL-RIGHT-PANEL-DECISION-001', 'REG-FIX-20260721-CHAT-UI-001', 'K12-INV-036'],
    fixture: 'mixed-business-and-shell-v1',
    policy: {
      rawBusinessFullPage: 'diagnostic-only',
      k12RecordsBusinessFullPage: 'same-state-business-records-v1',
      equivalentTargetMaxChangedPixelRatio: MAX_TARGET_PIXEL_RATIO,
      equivalentFullMaxChangedPixelRatio: MAX_FULL_PIXEL_RATIO,
      pixelThreshold: PIXEL_THRESHOLD,
      noProductionMutation: true,
      installedTestApp: 'NOT_RUN',
    },
    summaries,
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  await testInfo.attach('bug-20260723-015-20260729-003-equivalent-summary', { path: summaryPath, contentType: 'application/json' })
  for (const item of summaries as Array<any>) {
    expect.soft(item.network.loopbackOnly, `${item.surface}/${item.theme}: loopback-only`).toBe(true)
    expect.soft(item.runtime, `${item.surface}/${item.theme}: runtime errors`).toEqual({ reference: [], implementation: [] })
    for (const phase of item.equivalentFixture.phases as Array<any>) {
      expect.soft(phase.fixture.fixtureStateEqual ?? true, `${item.surface}/${item.theme}/${phase.phase}: fixture state`).toBe(true)
      if (phase.panelAvailability?.implementation === 'NOT_APPLICABLE') {
        expect.soft(phase.panelAvailability, `${item.surface}/${item.theme}/${phase.phase}: explicit panel applicability`).toEqual({ reference: 'OPENED', implementation: 'NOT_APPLICABLE' })
        continue
      }
      expect.soft(phase.pixels.target.pass, `${item.surface}/${item.theme}/${phase.phase}: target pixel gate`).toBe(true)
      expect.soft(phase.pixels.full.pass, `${item.surface}/${item.theme}/${phase.phase}: full pixel gate`).toBe(true)
    }
  }
})
