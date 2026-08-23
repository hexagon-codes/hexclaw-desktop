import { expect, test, type Page, type Route } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.resolve(
  desktopRoot,
  '../hexclaw-docs/test/evidence/bug-20260801-001-002-004-005-current-source',
)
const pixelDiffTool = path.resolve(desktopRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const sourceURL = process.env.HEX_K12_CURRENT_SOURCE_URL!
const referenceURL = process.env.HEX_K12_REFERENCE_URL!
const viewport = { width: 2048, height: 924 }
const fixedNowMs = Date.parse('2026-07-29T12:49:13+08:00')
const k12Appearance = JSON.stringify({ version: 1, preference: 'k12', introSeen: true })

type Theme = 'light' | 'dark'
type Surface = 'settings' | 'records' | 'insights'

function targetSelector(surface: Surface, implementation: boolean) {
  if (surface === 'settings') {
    return implementation ? '.hc-toolbar' : '.screen[data-pane="settings"] .tbar'
  }
  return implementation ? '.k12enh-tabs' : '#chatTutorView .chat-top.k12hd'
}

async function targetRect(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((nodes) => {
    const node = nodes.find((candidate) => {
      const rect = (candidate as HTMLElement).getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    if (!node) return { x: 0, y: 0, width: 0, height: 0 }
    const rect = (node as HTMLElement).getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

const recordIds = ['m-apple', 'm-circuit', 'm-loop', 'm-eq', 'm-believe', 'm-poem']
// 与原型会话栏逐项同态的固定业务夹具：会话标题、分组日期和消息数都来自
// prototype/app.html 的同一验收状态，避免用单会话假数据把整页比较降级成 NOT_COMPARABLE。
const sessionFixture = [
  {
    id: 'session-k12',
    title: '小明的辅导助手 · 五年级',
    agent_id: 'mingming',
    created_at: '2026-07-29T12:00:00+08:00',
    updated_at: '2026-07-29T12:48:00+08:00',
    message_count: 6,
  },
  {
    id: 'session-k12-hong',
    title: '🎓 小红的辅导助手 · 三年级',
    created_at: '2026-06-15T10:00:00+08:00',
    updated_at: '2026-06-15T10:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-decimal',
    title: '小数乘法讲解',
    created_at: '2026-07-29T14:32:00+08:00',
    updated_at: '2026-07-29T14:32:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-orphan',
    title: '已删除的智能体',
    created_at: '2026-07-29T09:18:00+08:00',
    updated_at: '2026-07-29T09:18:00+08:00',
    message_count: 28,
  },
  {
    id: 'session-research',
    title: '高级研究分析师',
    created_at: '2026-06-16T10:00:00+08:00',
    updated_at: '2026-06-16T10:00:00+08:00',
    message_count: 4,
  },
  {
    id: 'session-baidu',
    title: '百度热搜采集问题',
    created_at: '2026-06-16T09:00:00+08:00',
    updated_at: '2026-06-16T09:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-summary-1',
    title: '总结以下三条科技要点，并把…',
    created_at: '2026-06-13T10:00:00+08:00',
    updated_at: '2026-06-13T10:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-browser-1',
    title: '用 browser 工具访问 http://to…',
    created_at: '2026-06-12T10:00:00+08:00',
    updated_at: '2026-06-12T10:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-browser-2',
    title: '用 browser 工具访问 http://to…',
    created_at: '2026-06-12T09:00:00+08:00',
    updated_at: '2026-06-12T09:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-browser-3',
    title: '用 browser 工具访问 http://to…',
    created_at: '2026-06-12T08:00:00+08:00',
    updated_at: '2026-06-12T08:00:00+08:00',
    message_count: 1,
  },
  {
    id: 'session-baidu-page',
    title: '访问百度热搜榜页面 https://to…',
    created_at: '2026-06-12T07:00:00+08:00',
    updated_at: '2026-06-12T07:00:00+08:00',
    message_count: 2,
  },
  {
    id: 'session-summary-2',
    title: '总结以下三条科技要点，并把…',
    created_at: '2026-06-12T06:00:00+08:00',
    updated_at: '2026-06-12T06:00:00+08:00',
    message_count: 2,
  },
]
const pinnedSessionIds = ['session-k12', 'session-k12-hong']
const mistakes = [
  {
    record_id: 'm-apple',
    question: '苹果和梨的价钱',
    knowledge_point: '小数乘法',
    error_cause: '连续错 2 次',
    status: 'reviewing',
    review_state: 'scheduled',
    subject: '数学',
    review_kind: 'verify',
    entry_source: 'photo',
    created_at: 1785254400,
    version: 1,
  },
  {
    record_id: 'm-circuit',
    question: '小灯泡没有形成闭合回路',
    knowledge_point: '简单电路',
    error_cause: '实验图判断错误',
    status: 'reviewing',
    review_state: 'scheduled',
    subject: '科学',
    review_kind: 'verify',
    entry_source: 'photo',
    created_at: 1784044800,
    version: 1,
  },
  {
    record_id: 'm-loop',
    question: '重复执行积木少循环 1 次',
    knowledge_point: '图形化编程',
    error_cause: '运行结果已复核 · 到期可再练',
    status: 'retried',
    subject: '信息科技',
    review_kind: 'verify',
    entry_source: 'verified',
    created_at: 1783872000,
    version: 1,
  },
  {
    record_id: 'm-eq',
    question: '解方程 2x+15=43',
    knowledge_point: '简易方程',
    error_cause: '移项符号错',
    status: 'retried',
    subject: '数学',
    review_kind: 'verify',
    entry_source: 'verified',
    created_at: 1783612800,
    version: 1,
  },
  {
    record_id: 'm-believe',
    question: 'believe —— 拼成 belive（少 e）',
    knowledge_point: '错词',
    error_cause: 'Unit 4 听写错题',
    status: 'reviewing',
    review_state: 'scheduled',
    subject: '英语',
    review_kind: 'verbatim',
    entry_source: 'photo',
    created_at: 1783440000,
    version: 1,
  },
  {
    record_id: 'm-poem',
    question: '「梅须逊雪三分白」漏「须」字',
    knowledge_point: '默写',
    error_cause: '古诗默写错题',
    status: 'reviewing',
    review_state: 'scheduled',
    subject: '语文',
    review_kind: 'verbatim',
    entry_source: 'manual',
    created_at: 1783267200,
    version: 1,
  },
]
const insightReportFixture = {
  grade_term: '五年级',
  trend: { mastered: 6, reviewing: 5, retried: 6, archived: 0, total: 11 },
  weak_top3: [
    { knowledge_point: '简易方程', count: 5, share: 5 / 9, subject: '数学' },
    { knowledge_point: '小数乘法', count: 3, share: 3 / 9, subject: '数学' },
    { knowledge_point: '多边形面积', count: 1, share: 1 / 9, subject: '数学' },
  ],
  month_new_mistakes: 9,
  review_completion_rate: 0.72,
  consecutive_fail_kps: ['简易方程'],
  week_pending: 6,
  practice_pending: 1,
  suggestion:
    '“等式两边同时变化”连续 3 次未通过。建议先做 2 道等式性质热身，再进入本周复习卷中的方程题。',
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

const sharedFixturePath = path.resolve(
  desktopRoot,
  'tests/fixtures/local/bug-20260801-001-002-004-005-business-fixture.json',
)
const sharedFixtureSource = readFileSync(sharedFixturePath, 'utf8')
const sharedFixture = JSON.parse(sharedFixtureSource) as {
  schemaVersion: number
  fixtureId: string
  locale: string
  reducedMotion: boolean
  now: string
  appearance: Record<string, unknown>
  agents: unknown[]
  sessions: unknown[]
  pinnedSessionIds: string[]
  mistakes: unknown[]
  insightReport: unknown
}
const inlineFixtureState = {
  schemaVersion: sharedFixture.schemaVersion,
  fixtureId: sharedFixture.fixtureId,
  locale: sharedFixture.locale,
  reducedMotion: sharedFixture.reducedMotion,
  now: sharedFixture.now,
  appearance: sharedFixture.appearance,
  agents: [
    {
      name: 'mingming',
      display_name: '小明的辅导助手',
      description: '五年级辅导',
      provider: '',
      model: '',
      metadata: {
        scenario: 'k12-tutor',
        avatar: '🎓',
        'k12.child_name': '小明',
        'k12.grade_term': '五年级上',
        'k12.textbook_edition': '人教版',
      },
    },
  ],
  sessions: sessionFixture,
  pinnedSessionIds,
  mistakes,
  insightReport: insightReportFixture,
}
const sharedFixtureStateDigest = createHash('sha256')
  .update(JSON.stringify(canonicalize(inlineFixtureState)))
  .digest('hex')
if (
  sharedFixtureStateDigest !==
  createHash('sha256')
    .update(JSON.stringify(canonicalize(sharedFixture)))
    .digest('hex')
) {
  throw new Error('shared K12 business fixture drifted from browser harness state')
}
const sharedFixtureFileDigest = createHash('sha256').update(sharedFixtureSource).digest('hex')

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSourceFixture(page: Page, theme: Theme, externalRequests: string[]) {
  await page.addInitScript(
    ({ appearance, nextTheme, now, pinnedIds }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', nextTheme)
      localStorage.setItem('hc-k12-appearance-v1', appearance)
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming' }))
      localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(pinnedIds))

      class FixtureWebSocket extends EventTarget {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSING = 2
        static readonly CLOSED = 3
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSING = 2
        readonly CLOSED = 3
        binaryType: BinaryType = 'blob'
        bufferedAmount = 0
        extensions = ''
        protocol = ''
        readyState = FixtureWebSocket.CONNECTING
        url: string
        onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
        onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
        onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
        onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
        constructor(url: string | URL) {
          super()
          this.url = String(url)
          queueMicrotask(() => {
            this.readyState = FixtureWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.call(this as unknown as WebSocket, event)
            this.dispatchEvent(event)
          })
        }
        close() {
          this.readyState = FixtureWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.call(this as unknown as WebSocket, event)
          this.dispatchEvent(event)
        }
        send() {}
      }
      window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket
    },
    { appearance: k12Appearance, nextTheme: theme, now: fixedNowMs, pinnedIds: pinnedSessionIds },
  )

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { running: false, associated: false, models: [] }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/health') return json(route, { status: 'ok' })
    if (apiPath === '/api/v1/config') {
      return json(route, {
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        llm: { default: '', providers: {} },
        knowledge: { enabled: true },
        mcp: { enabled: true },
        cron: { enabled: true },
        webhook: { enabled: true },
        canvas: { enabled: true },
        voice: { enabled: true },
        sandbox: { network_enabled: true, allowed_paths: [] },
        security: {
          gateway_enabled: true,
          injection_detection: true,
          pii_filter: false,
          content_filter: true,
          rate_limit_rpm: 60,
        },
      })
    }
    if (apiPath === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: 'mingming',
            display_name: '小明的辅导助手',
            description: '五年级辅导',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级上',
              'k12.textbook_edition': '人教版',
            },
          },
        ],
        total: 1,
        default: 'mingming',
      })
    }
    if (apiPath === '/api/v1/sessions') {
      return json(route, {
        sessions: sessionFixture,
        total: sessionFixture.length,
      })
    }
    if (/^\/api\/v1\/sessions\/[^/]+\/messages$/.test(apiPath)) {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
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
      return json(route, { items: mistakes, total: 11 })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, insightReportFixture)
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, { progress: null })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: 'mingming',
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: '2026-07-29T12:49:13+08:00',
        updated_at: '2026-07-29T12:49:13+08:00',
      })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function installReferenceFixture(page: Page, theme: Theme) {
  await page.addInitScript(
    ({ appearance }) => {
      localStorage.setItem('hexclaw.prototype.k12Appearance.v1', appearance)
    },
    { appearance: JSON.stringify({ preference: 'k12', introSeen: true }) },
  )
  await page.goto(referenceURL)
  await page.evaluate((nextTheme) => {
    const api = window as typeof window & {
      applyThemeState?: (theme: Theme, announce: boolean) => void
    }
    api.applyThemeState?.(nextTheme, false)
  }, theme)
}

async function openSource(page: Page, surface: Surface) {
  if (surface === 'settings') {
    await page.goto(`${sourceURL}/settings`)
    await expect(page.locator('.hc-settings')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('tab', { name: '系统设置', exact: true }).click()
    await expect(page.getByRole('radiogroup', { name: '外观', exact: true })).toBeVisible()
    return
  }
  await page.goto(
    `${sourceURL}/chat?role=mingming&roleTitle=${encodeURIComponent('小明的辅导助手')}&scenarioTab=${surface}`,
  )
  await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
  if (surface === 'records') {
    await page.getByRole('tab', { name: '学习档案', exact: true }).click()
    await page.getByTestId('subtab-mistakes').click()
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
  } else {
    await page.getByRole('tab', { name: '学情', exact: true }).click()
    await expect(page.getByTestId('insight-priority-card')).toBeVisible()
  }
}

async function openReference(page: Page, surface: Surface) {
  await page.evaluate((nextSurface) => {
    const api = window as typeof window & {
      goRecords?: (learner: string, tab?: number) => void
      k12BookTab?: (tab: number) => void
      k12Tab?: (tab: string) => void
    }
    if (nextSurface === 'settings') {
      document.querySelector<HTMLButtonElement>('.sb-item[data-screen="settings"]')?.click()
      ;[
        ...document.querySelectorAll<HTMLButtonElement>(
          '.screen[data-pane="settings"] [role="tab"]',
        ),
      ]
        .find((tab) => tab.textContent?.trim() === '系统设置')
        ?.click()
      return
    }
    // 原型把记录本节点迁入 #k12ViewRecords 后，旧 seg() 仍从 .screen 查找
    // 容器，会在 browser fixture 中抛错。这里按现行 DOM 合同投影同一用户
    // 导航状态，避免用已失效的旧入口改变参考页的可见结构。
    api.goRecords?.('ming', 0)
    const chatView = document.querySelector<HTMLElement>('#k12ViewChat')
    const recordsView = document.querySelector<HTMLElement>('#k12ViewRecords')
    const toolbar = document.querySelector<HTMLElement>('#k12BookToolbar')
    const headerTabs = document.querySelectorAll<HTMLElement>(
      '#chatTutorView .k12tabs [role="tab"]',
    )
    const panels = document.querySelectorAll<HTMLElement>('#k12ViewRecords .subview')
    const bookTabs = document.querySelectorAll<HTMLElement>('#k12BookTabs [role="tab"]')
    const targetTab = nextSurface === 'records' ? 'records' : 'insights'
    const panelIndex = nextSurface === 'records' ? 1 : 5
    chatView?.style.setProperty('display', 'none')
    recordsView?.style.setProperty('display', 'flex')
    toolbar?.style.setProperty('display', nextSurface === 'records' ? 'flex' : 'none')
    headerTabs.forEach((tab) => {
      const selected = tab.dataset.tab === targetTab
      tab.classList.toggle('on', selected)
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    })
    panels.forEach((panel) => panel.classList.toggle('on', panel.dataset.sub === `rc${panelIndex}`))
    bookTabs.forEach((tab, index) => {
      const selected = nextSurface === 'records' && index === 1
      tab.classList.toggle('on', selected)
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    })
  }, surface)
  if (surface === 'settings') {
    await expect(page.locator('.system-theme-segmented')).toBeVisible()
  } else if (surface === 'records') {
    await expect(page.locator('#k12BookPanel1')).toBeVisible()
  } else {
    await expect(page.locator('#k12BookPanel5')).toBeVisible()
  }
}

async function collectFacts(page: Page, implementation: boolean, surface: Surface) {
  return page.evaluate(
    ({ isImplementation, nextSurface, expectedRecordIds }) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim()
      const visible = (node: Element) => {
        const element = node as HTMLElement
        return (
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
        )
      }
      const measure = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (!node || !visible(node)) return null
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          border: style.border,
          borderRadius: style.borderRadius,
          background: style.background,
          backgroundImage: style.backgroundImage,
          color: style.color,
          opacity: style.opacity,
          boxShadow: style.boxShadow,
          backdropFilter: style.getPropertyValue('backdrop-filter'),
          webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter'),
        }
      }
      const selectors = isImplementation
        ? {
            sidebar: '.hc-sidebar',
            main: '.hc-app__content',
            sessionSidebar: '.hc-chat__sidebar',
            sessionItem: '.hc-sessions__item',
            settingsRoot: '.hc-settings',
            k12Header: '.k12enh-tabs',
            settingsToolbar: '.hc-toolbar',
            themeGroup: '.hc-settings__theme-segmented',
            k12Group: '.k12-appearance-settings__grid',
            k12Card: '.k12-appearance-settings__card:first-child',
            recordsOuter: '#k12-enh-view-records',
            readingRail: '[data-testid="mistakes-section"]',
            insightsOuter: '#k12-enh-view-insights',
            insightTiles: '.k12ins__tiles',
            priority: '[data-testid="insight-priority-card"]',
          }
        : {
            sidebar: '.sb',
            main: '.mn',
            sessionSidebar: '.chat-sessions',
            sessionItem: '#prototypeSessionList .cs-item:not([hidden])',
            settingsRoot: '.screen[data-pane="settings"]',
            k12Header: '#chatTutorView .chat-top.k12hd',
            settingsToolbar: '.screen[data-pane="settings"] .tbar',
            themeGroup: '.system-theme-segmented',
            k12Group: '.system-k12-skin-grid',
            k12Card: '.system-k12-skin-card:first-child',
            recordsOuter: '#k12ViewRecords',
            readingRail: '#k12BookPanel1',
            insightsOuter: '#k12ViewRecords',
            insightTiles: '#k12BookPanel5 [data-learner-panel]:not([hidden]) .mini-grid',
            priority: '#k12BookPanel5 [data-learner-panel]:not([hidden]) .k12-priority-card',
          }
      const textList = (selector: string) =>
        [...document.querySelectorAll<HTMLElement>(selector)]
          .filter(visible)
          .map((node) => normalize(node.innerText))
      const numberList = (selector: string) =>
        textList(selector).map((text) => Number.parseInt(text.match(/\d+/)?.[0] ?? '-1', 10))
      const targetSelector = isImplementation
        ? nextSurface === 'settings'
          ? '.hc-toolbar'
          : '.k12enh-tabs'
        : nextSurface === 'settings'
          ? '.screen[data-pane="settings"] .tbar'
          : '#chatTutorView .chat-top.k12hd'
      const targetChildren = [...document.querySelectorAll<HTMLElement>(`${targetSelector} > *`)]
        .filter(visible)
        .map((node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            tag: node.tagName,
            className: node.className,
            text: normalize(node.innerText),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display,
            lineHeight: style.lineHeight,
            padding: style.padding,
            border: style.border,
            children: [...node.querySelectorAll<HTMLElement>(':scope > *')]
              .filter(visible)
              .map((child) => {
                const childRect = child.getBoundingClientRect()
                const childStyle = getComputedStyle(child)
                return {
                  tag: child.tagName,
                  className: child.className,
                  text: normalize(child.innerText),
                  rect: {
                    x: childRect.x,
                    y: childRect.y,
                    width: childRect.width,
                    height: childRect.height,
                  },
                  lineHeight: childStyle.lineHeight,
                  padding: childStyle.padding,
                  border: childStyle.border,
                }
              }),
          }
        })

      const settingsSemantic =
        nextSurface === 'settings'
          ? {
              topTabs: textList(`${selectors.settingsRoot} [role="tab"]`),
              activeTopTab: normalize(
                document.querySelector<HTMLElement>(
                  `${selectors.settingsRoot} [role="tab"][aria-selected="true"]`,
                )?.innerText,
              ),
              themeOptions: textList(`${selectors.themeGroup} [role="radio"]`),
              selectedTheme: normalize(
                document.querySelector<HTMLElement>(
                  `${selectors.themeGroup} [role="radio"][aria-checked="true"]`,
                )?.innerText,
              ),
              k12Options: textList(`${selectors.k12Group} [role="radio"]`).map((text) =>
                text.replace(/✓$/, '').trim(),
              ),
              selectedK12: normalize(
                document.querySelector<HTMLElement>(
                  `${selectors.k12Group} [role="radio"][aria-checked="true"]`,
                )?.innerText,
              )
                .replace(/✓$/, '')
                .trim(),
              visibleSummary: normalize(
                document.querySelector<HTMLElement>(selectors.settingsRoot)?.innerText,
              ),
            }
          : null
      const recordSelector = isImplementation
        ? '[data-testid="mistakes-section"] .rl-row[data-record-id]'
        : '#k12MistakeList .resource-row[data-mistake-key]:not([hidden])'
      const recordsSemantic =
        nextSurface === 'records'
          ? {
              recordIds: [...document.querySelectorAll<HTMLElement>(recordSelector)]
                .filter(visible)
                .map((row) =>
                  isImplementation ? (row.dataset.recordId ?? '') : (row.dataset.mistakeKey ?? ''),
                )
                .filter((id) => expectedRecordIds.includes(id))
                .sort(),
              expectedRecordIds: [...expectedRecordIds].sort(),
            }
          : null
      const insightsSemantic =
        nextSurface === 'insights'
          ? {
              tiles: numberList(
                isImplementation
                  ? '[data-testid^="insight-tile-"]'
                  : '#k12BookPanel5 [data-learner-panel]:not([hidden]) .mini-tile',
              ),
              weakCounts: numberList(
                isImplementation
                  ? '[data-testid="insight-weak-bar"]'
                  : '#k12BookPanel5 [data-learner-panel]:not([hidden]) .k12bar',
              ),
            }
          : null
      const sessionTitles =
        nextSurface === 'settings'
          ? []
          : textList(
              isImplementation
                ? '.hc-sessions__item .hc-sessions__title'
                : '#prototypeSessionList .cs-item:not([hidden]) .cs-t',
            ).map((text) => text.replace(/作业批改中$/, '').trim())

      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio,
          locale: navigator.language,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        },
        body: {
          theme: document.documentElement.dataset.theme,
          skin: document.body.dataset.k12SkinActive,
          scene: document.body.dataset.scene,
        },
        geometry: {
          sidebar: measure(selectors.sidebar),
          main: measure(selectors.main),
          sessionSidebar: measure(selectors.sessionSidebar),
          sessionItem: measure(selectors.sessionItem),
          k12Header: measure(selectors.k12Header),
          settingsToolbar: measure(selectors.settingsToolbar),
          themeGroup: measure(selectors.themeGroup),
          k12Group: measure(selectors.k12Group),
          k12Card: measure(selectors.k12Card),
          recordsOuter: measure(selectors.recordsOuter),
          readingRail: measure(selectors.readingRail),
          insightsOuter: measure(selectors.insightsOuter),
          insightTiles: measure(selectors.insightTiles),
          priority: measure(selectors.priority),
        },
        targetChildren,
        scene: {
          butterflies: document.querySelectorAll('.k12-ambient-butterfly').length,
          fireflies: document.querySelectorAll('.k12-ambient-firefly').length,
          blackboardOverlayNodes: document.querySelectorAll(
            '[data-k12-blackboard],.k12-blackboard,.k12-board',
          ).length,
          mainPersonNodes: document.querySelectorAll(
            '.k12-main-person,[data-k12-main-person],.k12-main-character',
          ).length,
          visibleRightRails: [
            ...document.querySelectorAll<HTMLElement>(
              '.hc-chat__side-panel,[data-testid="chat-side-panel"],.side-panel.on',
            ),
          ].filter(visible).length,
          cardToken: getComputedStyle(document.body).getPropertyValue('--hc-bg-card').trim(),
        },
        semantic: {
          sessionTitles,
          settings: settingsSemantic,
          records: recordsSemantic,
          insights: insightsSemantic,
        },
      }
    },
    { isImplementation: implementation, nextSurface: surface, expectedRecordIds: recordIds },
  )
}

function computedStyleComparison(
  surface: Surface,
  reference: Awaited<ReturnType<typeof collectFacts>>,
  current: Awaited<ReturnType<typeof collectFacts>>,
) {
  if (surface === 'settings') {
    const toolbar = current.geometry.settingsToolbar
    const theme = current.body.theme
    const expectedBackgroundImage =
      theme === 'dark'
        ? 'linear-gradient(90deg, rgba(8, 40, 50, 0.97), rgba(9, 31, 54, 0.96))'
        : 'linear-gradient(90deg, rgba(230, 247, 228, 0.98), rgba(239, 249, 240, 0.96))'
    const expectedBackground =
      theme === 'dark'
        ? 'rgba(0, 0, 0, 0) linear-gradient(90deg, rgba(8, 40, 50, 0.97), rgba(9, 31, 54, 0.96)) repeat scroll 0% 0% / auto padding-box border-box'
        : 'rgba(0, 0, 0, 0) linear-gradient(90deg, rgba(230, 247, 228, 0.98), rgba(239, 249, 240, 0.96)) repeat scroll 0% 0% / auto padding-box border-box'
    const expected = {
      background: expectedBackground,
      backgroundImage: expectedBackgroundImage,
      boxShadow: 'rgba(255, 255, 255, 0.16) 0px 0.5px 0px 0px inset',
      backdropFilter: 'saturate(1.2) blur(18px)',
    }
    const differences = Object.entries(expected).flatMap(([field, value]) =>
      toolbar?.[field as keyof typeof toolbar] === value
        ? []
        : [
            {
              target: 'Settings toolbar',
              field,
              reference: value,
              current: toolbar?.[field as keyof typeof toolbar] ?? null,
            },
          ],
    )
    return { pass: differences.length === 0, differences }
  }
  const referenceHeader = reference.geometry.k12Header
  const currentHeader = current.geometry.k12Header
  const fields = ['background', 'backgroundImage', 'border', 'boxShadow', 'backdropFilter'] as const
  const differences = fields.flatMap((field) => {
    const referenceValue = referenceHeader?.[field] ?? null
    const currentValue = currentHeader?.[field] ?? null
    return referenceValue === currentValue
      ? []
      : [
          {
            target: 'K12 header',
            field,
            reference: referenceValue,
            current: currentValue,
          },
        ]
  })
  return { pass: differences.length === 0, differences }
}

function criticalGeometry(
  surface: Surface,
  reference: Awaited<ReturnType<typeof collectFacts>>,
  current: Awaited<ReturnType<typeof collectFacts>>,
) {
  const checks: Array<{
    name: string
    pass: boolean
    reference?: number | null
    current?: number | null
  }> = []
  const addEqual = (name: string, left?: number | null, right?: number | null) =>
    checks.push({
      name,
      reference: left,
      current: right,
      pass: left != null && right != null && Math.abs(left - right) <= 0.01,
    })
  addEqual(
    'global sidebar width',
    reference.geometry.sidebar?.rect.width,
    current.geometry.sidebar?.rect.width,
  )
  checks.push({
    name: 'reference sidebar is 226px',
    reference: reference.geometry.sidebar?.rect.width,
    pass: reference.geometry.sidebar?.rect.width === 226,
  })
  checks.push({
    name: 'current sidebar is 226px',
    current: current.geometry.sidebar?.rect.width,
    pass: current.geometry.sidebar?.rect.width === 226,
  })
  if (surface === 'settings') {
    addEqual(
      'theme segmented height',
      reference.geometry.themeGroup?.rect.height,
      current.geometry.themeGroup?.rect.height,
    )
    addEqual(
      'K12 card height',
      reference.geometry.k12Card?.rect.height,
      current.geometry.k12Card?.rect.height,
    )
    checks.push({
      name: 'theme segmented is 44px',
      current: current.geometry.themeGroup?.rect.height,
      pass: current.geometry.themeGroup?.rect.height === 44,
    })
    checks.push({
      name: 'K12 card is 60px',
      current: current.geometry.k12Card?.rect.height,
      pass: current.geometry.k12Card?.rect.height === 60,
    })
  } else {
    addEqual(
      'session sidebar width',
      reference.geometry.sessionSidebar?.rect.width,
      current.geometry.sessionSidebar?.rect.width,
    )
    checks.push({
      name: 'current session sidebar is 256px',
      current: current.geometry.sessionSidebar?.rect.width,
      pass: current.geometry.sessionSidebar?.rect.width === 256,
    })
    if (surface === 'records')
      addEqual(
        'records reading rail width',
        reference.geometry.readingRail?.rect.width,
        current.geometry.readingRail?.rect.width,
      )
    if (surface === 'insights')
      addEqual(
        'insights tile rail width',
        reference.geometry.insightTiles?.rect.width,
        current.geometry.insightTiles?.rect.width,
      )
  }
  checks.push({
    name: 'current blackboard overlay absent',
    current: current.scene.blackboardOverlayNodes,
    pass: current.scene.blackboardOverlayNodes === 0,
  })
  checks.push({
    name: 'current main person DOM absent',
    current: current.scene.mainPersonNodes,
    pass: current.scene.mainPersonNodes === 0,
  })
  checks.push({
    name: 'current right rail absent',
    current: current.scene.visibleRightRails,
    pass: current.scene.visibleRightRails === 0,
  })
  return { pass: checks.every((check) => check.pass), checks }
}

function semanticComparison(
  surface: Surface,
  reference: Awaited<ReturnType<typeof collectFacts>>,
  current: Awaited<ReturnType<typeof collectFacts>>,
) {
  const expectedSettings = {
    topTabs: ['LLM 服务商', '自动化权限', '系统设置'],
    activeTopTab: '系统设置',
    themeOptions: ['浅色', '深色', '跟随系统'],
    k12Options: ['K12 专属皮肤 全局皮肤；全部页面显示完整场景', '通用外观 保持 HexClaw 默认界面'],
    selectedK12: 'K12 专属皮肤 全局皮肤；全部页面显示完整场景',
  }
  const settingsTargetSignature = (
    settings: Awaited<ReturnType<typeof collectFacts>>['semantic']['settings'],
  ) =>
    settings
      ? {
          topTabs: settings.topTabs,
          activeTopTab: settings.activeTopTab,
          themeOptions: settings.themeOptions,
          selectedTheme: settings.selectedTheme,
          k12Options: settings.k12Options,
          selectedK12: settings.selectedK12,
        }
      : null
  const comparable =
    surface === 'settings'
      ? JSON.stringify(settingsTargetSignature(reference.semantic.settings)) ===
          JSON.stringify(settingsTargetSignature(current.semantic.settings)) &&
        JSON.stringify({
          topTabs: current.semantic.settings?.topTabs,
          activeTopTab: current.semantic.settings?.activeTopTab,
          themeOptions: current.semantic.settings?.themeOptions,
          k12Options: current.semantic.settings?.k12Options,
          selectedK12: current.semantic.settings?.selectedK12,
        }) === JSON.stringify(expectedSettings)
      : surface === 'records'
        ? JSON.stringify(reference.semantic.records?.recordIds) ===
            JSON.stringify(recordIds.slice().sort()) &&
          JSON.stringify(current.semantic.records?.recordIds) ===
            JSON.stringify(recordIds.slice().sort()) &&
          JSON.stringify(reference.semantic.sessionTitles) ===
            JSON.stringify(current.semantic.sessionTitles)
        : JSON.stringify(reference.semantic.insights) ===
            JSON.stringify(current.semantic.insights) &&
          JSON.stringify(current.semantic.insights) ===
            JSON.stringify({ tiles: [11, 6, 6, 1], weakCounts: [5, 3, 1] }) &&
          JSON.stringify(reference.semantic.sessionTitles) ===
            JSON.stringify(current.semantic.sessionTitles)
  return {
    comparable,
    comparisonScope:
      surface === 'settings'
        ? 'target-surface settings controls; runtime version/mode/language summary is retained as evidence but excluded'
        : 'target-surface K12 header plus deterministic business fixture',
    reference: reference.semantic,
    current: current.semantic,
  }
}

async function captureTargetEvidence(
  reference: Page,
  source: Page,
  surface: Surface,
  stem: string,
  targetRoot: string,
) {
  const referenceSelector = targetSelector(surface, false)
  const sourceSelector = targetSelector(surface, true)
  const [referenceBounds, sourceBounds] = await Promise.all([
    targetRect(reference, referenceSelector),
    targetRect(source, sourceSelector),
  ])
  const commonWidth = Math.min(referenceBounds.width, sourceBounds.width)
  const commonHeight = Math.min(referenceBounds.height, sourceBounds.height)
  const targetGeometry = {
    reference: referenceBounds,
    current: sourceBounds,
    widthEqual: Math.abs(referenceBounds.width - sourceBounds.width) <= 0.01,
    heightEqual: Math.abs(referenceBounds.height - sourceBounds.height) <= 0.01,
    originEqual:
      Math.abs(referenceBounds.x - sourceBounds.x) <= 0.01 &&
      Math.abs(referenceBounds.y - sourceBounds.y) <= 0.01,
  }
  const referencePath = path.join(targetRoot, `target-reference-${stem}.png`)
  const currentPath = path.join(targetRoot, `target-current-${stem}.png`)
  const diffPath = path.join(targetRoot, `target-diff-${stem}.png`)
  if (commonWidth <= 0 || commonHeight <= 0) {
    return {
      selector: { reference: referenceSelector, current: sourceSelector },
      geometry: targetGeometry,
      pixel: { pass: false, reason: 'target region has no visible area' },
    }
  }
  await Promise.all([
    reference.screenshot({
      path: referencePath,
      clip: {
        x: referenceBounds.x,
        y: referenceBounds.y,
        width: commonWidth,
        height: commonHeight,
      },
      animations: 'disabled',
    }),
    source.screenshot({
      path: currentPath,
      clip: { x: sourceBounds.x, y: sourceBounds.y, width: commonWidth, height: commonHeight },
      animations: 'disabled',
    }),
  ])
  const { stdout } = await execFileAsync(
    'uv',
    [
      'run',
      '--offline',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      pixelDiffTool,
      referencePath,
      currentPath,
      diffPath,
      '8',
    ],
    { cwd: desktopRoot },
  )
  const diff = JSON.parse(stdout.trim())
  return {
    selector: { reference: referenceSelector, current: sourceSelector },
    geometry: targetGeometry,
    pixel: {
      ...diff,
      pass:
        targetGeometry.widthEqual && targetGeometry.heightEqual && diff.changed_pixel_ratio <= 0.01,
    },
  }
}

for (const surface of ['settings', 'records', 'insights'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${surface} ${theme}: equivalent fixture paired evidence`, async ({ browser }) => {
      const externalRequests: string[] = []
      const contextOptions = {
        viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        reducedMotion: 'reduce' as const,
      }
      const sourceContext = await browser.newContext(contextOptions)
      const referenceContext = await browser.newContext(contextOptions)
      const source = await sourceContext.newPage()
      const reference = await referenceContext.newPage()
      try {
        await installSourceFixture(source, theme, externalRequests)
        await installReferenceFixture(reference, theme)
        await Promise.all([openSource(source, surface), openReference(reference, surface)])
        const normalization: string[] = []
        await Promise.all([
          expect(source.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12'),
          expect(reference.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12'),
          expect(source.locator('html')).toHaveAttribute('data-theme', theme),
          expect(reference.locator('html')).toHaveAttribute('data-theme', theme),
        ])
        await Promise.all([source.mouse.move(1800, 20), reference.mouse.move(1800, 20)])

        await mkdir(evidenceRoot, { recursive: true })
        const stem = `${theme}-${surface}-2048x924-dpr1-zh-CN-reduced-motion-chromium`
        const referencePath = path.join(evidenceRoot, `reference-${stem}.png`)
        const currentPath = path.join(evidenceRoot, `current-${stem}.png`)
        const diffPath = path.join(evidenceRoot, `diff-${stem}.png`)
        await Promise.all([
          reference.screenshot({ path: referencePath, animations: 'disabled' }),
          source.screenshot({ path: currentPath, animations: 'disabled' }),
        ])
        const [referenceFacts, currentFacts] = await Promise.all([
          collectFacts(reference, false, surface),
          collectFacts(source, true, surface),
        ])
        const target = await captureTargetEvidence(reference, source, surface, stem, evidenceRoot)
        const semantic = semanticComparison(surface, referenceFacts, currentFacts)
        const geometry = criticalGeometry(surface, referenceFacts, currentFacts)
        const computedStyle = computedStyleComparison(surface, referenceFacts, currentFacts)
        const { stdout } = await execFileAsync(
          'uv',
          [
            'run',
            '--offline',
            '--isolated',
            '--python',
            '3.12',
            '--with',
            'pillow==10.4.0',
            'python',
            pixelDiffTool,
            referencePath,
            currentPath,
            diffPath,
            '8',
          ],
          { cwd: desktopRoot },
        )
        const pixel = {
          ...JSON.parse(stdout.trim()),
          pass: JSON.parse(stdout.trim()).changed_pixel_ratio <= 0.01,
        }
        const comparison = {
          surface,
          theme,
          fixtureProvenance: {
            path: path.relative(desktopRoot, sharedFixturePath),
            fileSha256: sharedFixtureFileDigest,
            stateSha256: sharedFixtureStateDigest,
            fixtureId: sharedFixture.fixtureId,
          },
          fixtureNormalization: normalization,
          semantic,
          criticalGeometry: geometry,
          computedStyle,
          pixel,
          target,
          network: { externalRequests },
        }
        await Promise.all([
          writeFile(
            path.join(evidenceRoot, `bbox-computed-${theme}-${surface}.json`),
            JSON.stringify({ reference: referenceFacts, current: currentFacts }, null, 2),
          ),
          writeFile(
            path.join(evidenceRoot, `semantic-${theme}-${surface}.json`),
            JSON.stringify(semantic, null, 2),
          ),
          writeFile(
            path.join(evidenceRoot, `comparison-${theme}-${surface}.json`),
            JSON.stringify(comparison, null, 2),
          ),
        ])

        expect(referenceFacts.viewport).toEqual(currentFacts.viewport)
        expect(referenceFacts.viewport).toEqual({
          width: 2048,
          height: 924,
          devicePixelRatio: 1,
          locale: 'zh-CN',
          reducedMotion: true,
        })
        expect(geometry.pass).toBe(true)
        if (surface !== 'settings') {
          expect(target.geometry.widthEqual).toBe(true)
          expect(target.geometry.heightEqual).toBe(true)
          expect(target.geometry.originEqual).toBe(true)
          expect(target.pixel.pass).toBe(true)
        }
        expect(externalRequests).toEqual([])
      } finally {
        await Promise.all([sourceContext.close(), referenceContext.close()])
      }
    })
  }
}
