import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'

const ROOT = path.resolve(process.cwd())
const EVIDENCE_ROOT = path.join(ROOT, 'test/evidence/bug-20260723-015-current-source')
const RIGHT_PANEL_EVIDENCE_ROOT = path.join(
  ROOT,
  'test/evidence/bug-20260729-003-right-panel-current-source',
)
const PROTOTYPE_PATH = path.resolve(ROOT, '../hexclaw-docs/prototype/app.html')
const PROTOTYPE_URL = process.env.HEX_BUG015_PROTOTYPE_URL ?? 'http://127.0.0.1:16072/app.html'
const VIEWPORT = { width: 1440, height: 900 }
const PIXEL_THRESHOLD = 8
const MAX_NORMALIZED_PIXEL_RATIO = 0.01
const FIXED_NOW = Date.parse('2026-08-22T15:30:00+08:00')

// K12 背景验收只比较外壳，但记录页仍需消费与原型同态的数据，避免空态把业务主体的整页差异误报为背景差异。
// 这组 7 条是原型小明上下文可见的记录；total=11 与原型顶部学期累计口径一致，队列为前 6 条待复习记录。
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

type Theme = 'light' | 'dark'
type BackgroundMode = 'normal' | 'k12'
type Rectangle = { x: number; y: number; width: number; height: number }
type LayerKind = 'texture' | 'glow' | 'other' | 'none'
type LayerCandidate = { id: string; selector: string; pseudo?: '::before' | '::after' }
type LayerSnapshot = LayerCandidate & {
  found: boolean
  active: boolean
  kind: LayerKind
  rect?: Rectangle
  style?: {
    content: string
    display: string
    visibility: string
    opacity: string
    backgroundColor: string
    backgroundImage: string
    backgroundPosition: string
    backgroundSize: string
    backgroundRepeat: string
    backgroundBlendMode: string
    mixBlendMode: string
    position: string
    inset: string
    top: string
    right: string
    bottom: string
    left: string
    width: string
    height: string
    zIndex: string
    pointerEvents: string
  }
}

type Surface = {
  id: string
  mode: BackgroundMode
  sourceRoute: string
  prototypePane: 'chat' | 'agents' | 'settings'
  openPrototype?: 'records'
}

type RightPanelKind = 'context' | 'artifacts'
type RightPanelPhase = 'closed' | 'open'

type RightPanelEvidence = {
  kind: RightPanelKind
  phase: RightPanelPhase
  selector: string
  present: boolean
  rect: Rectangle
  style: {
    display: string
    visibility: string
    pointerEvents: string
    opacity: string
    width: string
    borderLeftWidth: string
    borderLeftStyle: string
    paddingTop: string
    paddingRight: string
    paddingBottom: string
    paddingLeft: string
  }
}

const RIGHT_PANEL_WIDTHS: Record<RightPanelKind, number> = {
  context: 272,
  artifacts: 380,
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

// 右侧面板专属用例自行保存成对截图与 diff，关闭 runner 的 retain-on-failure trace，避免手工创建双 context 的收尾竞态。
test.use({ trace: 'off', screenshot: 'off' })

const REFERENCE_CANDIDATES: LayerCandidate[] = [
  { id: 'app-before', selector: '.app', pseudo: '::before' },
  { id: 'app-after', selector: '.app', pseudo: '::after' },
  { id: 'main-before', selector: '.mn', pseudo: '::before' },
  { id: 'main-after', selector: '.mn', pseudo: '::after' },
  { id: 'main-glow', selector: '.mn-glow' },
  { id: 'main-glow-before', selector: '.mn-glow', pseudo: '::before' },
  { id: 'main-glow-after', selector: '.mn-glow', pseudo: '::after' },
]

const IMPLEMENTATION_CANDIDATES: LayerCandidate[] = [
  { id: 'app-before', selector: '.hc-app', pseudo: '::before' },
  { id: 'app-after', selector: '.hc-app', pseudo: '::after' },
  { id: 'body-before', selector: '.hc-app__body', pseudo: '::before' },
  { id: 'body-after', selector: '.hc-app__body', pseudo: '::after' },
  { id: 'content-before', selector: '.hc-app__content', pseudo: '::before' },
  { id: 'content-after', selector: '.hc-app__content', pseudo: '::after' },
  { id: 'main-glow', selector: '.hc-app__glow' },
  { id: 'main-glow-before', selector: '.hc-app__glow', pseudo: '::before' },
  { id: 'main-glow-after', selector: '.hc-app__glow', pseudo: '::after' },
]

function assertLoopback(value: string, label: string) {
  const parsed = new URL(value)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must be loopback-only: ${value}`)
  }
}

assertLoopback(PROTOTYPE_URL, 'HEX_BUG015_PROTOTYPE_URL')

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installSourceFixture(
  page: Page,
  theme: Theme,
  mode: BackgroundMode,
  externalRequests: string[],
) {
  await page.addInitScript(
    ({ nextTheme, nextMode, now }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', nextTheme)
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({
          version: 1,
          preference: nextMode === 'k12' ? 'k12' : 'default',
          introSeen: true,
        }),
      )
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      if (nextMode === 'k12') {
        localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
        localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming' }))
      } else {
        localStorage.setItem('hexclaw_lastSessionId', 'session-normal')
        localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({}))
      }

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
        onclose: ((this: WebSocket, event: CloseEvent) => unknown) | null = null
        onerror: ((this: WebSocket, event: Event) => unknown) | null = null
        onmessage: ((this: WebSocket, event: MessageEvent) => unknown) | null = null
        onopen: ((this: WebSocket, event: Event) => unknown) | null = null

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
    { nextTheme: theme, nextMode: mode, now: FIXED_NOW },
  )

  await page.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname)) {
      externalRequests.push(requestUrl.toString())
      return route.abort('blockedbyclient')
    }
    if (requestUrl.hostname === 'localhost' && requestUrl.port === '11434') {
      return json(route, { models: [], running: false, associated: false })
    }
    if (!requestUrl.pathname.startsWith('/_hexclaw/')) return route.continue()

    const apiPath = requestUrl.pathname.replace('/_hexclaw', '')
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
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/sessions') {
      const k12Session = mode === 'k12'
      return json(route, {
        sessions: [
          {
            id: k12Session ? 'session-k12' : 'session-normal',
            title: k12Session ? '小明的辅导助手 · 五年级' : '背景事实验收会话',
            created_at: '2026-08-22T15:00:00+08:00',
            updated_at: '2026-08-22T15:20:00+08:00',
            message_count: 0,
            pinned: true,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === '/api/v1/sessions/session-k12/messages') {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === '/api/v1/sessions/session-normal/messages') {
      return json(route, { messages: [], total: 0 })
    }
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
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
    if (apiPath === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, { progress: null })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [], total: 0 })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function preparePrototype(page: Page, surface: Surface, theme: Theme, external: string[]) {
  await page.addInitScript((mode: BackgroundMode) => {
    localStorage.setItem(
      'hexclaw.prototype.k12Appearance.v1',
      JSON.stringify({ preference: mode === 'k12' ? 'k12' : 'default', introSeen: true }),
    )
  }, surface.mode)
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      external.push(url.toString())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  await page.goto(PROTOTYPE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ nextTheme, pane, openPrototype }) => {
      const api = window as typeof window & {
        applyThemeState?: (theme: Theme, announce: boolean) => void
        goRecords?: (learner: string, tab?: number) => void
      }
      api.applyThemeState?.(nextTheme, false)
      if (openPrototype === 'records') {
        api.goRecords?.('ming', 1)
      } else {
        document.querySelector<HTMLButtonElement>(`.sb-item[data-screen="${pane}"]`)?.click()
      }
    },
    { nextTheme: theme, pane: surface.prototypePane, openPrototype: surface.openPrototype },
  )
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (surface.openPrototype === 'records') {
    await expect(page.locator('#k12BookPanel1')).toBeVisible()
  } else {
    await expect(page.locator(`.screen[data-pane="${surface.prototypePane}"].on`)).toBeVisible()
  }
  if (surface.mode === 'k12') {
    await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  }
  await stabilize(page)
}

async function prepareSource(page: Page, sourceUrl: string, surface: Surface, theme: Theme) {
  await page.goto(new URL(surface.sourceRoute, sourceUrl).toString(), {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('.hc-app')).toBeVisible()
  await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  if (surface.mode === 'k12') {
    await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  } else {
    await expect(page.locator('body')).not.toHaveAttribute('data-k12-skin-active', 'k12')
  }
  await stabilize(page)
}

async function stabilize(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function collectLayers(page: Page, candidates: LayerCandidate[]): Promise<LayerSnapshot[]> {
  return page.evaluate((items) => {
    const round = (value: number) => Math.round(value * 100) / 100
    return items.map((candidate) => {
      const element = document.querySelector<HTMLElement>(candidate.selector)
      if (!element) return { ...candidate, found: false, active: false, kind: 'none' as const }
      const style = getComputedStyle(element, candidate.pseudo)
      const backgroundImage = style.backgroundImage
      const pseudoPainted =
        !candidate.pseudo ||
        (style.content !== 'none' && style.content !== 'normal' && style.content !== '')
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0
      const active = pseudoPainted && visible && backgroundImage !== 'none'
      const kind: LayerKind = backgroundImage.includes('image/svg+xml')
        ? 'texture'
        : backgroundImage.includes('radial-gradient')
          ? 'glow'
          : backgroundImage === 'none'
            ? 'none'
            : 'other'
      const rect = element.getBoundingClientRect()
      return {
        ...candidate,
        found: true,
        active,
        kind,
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        },
        style: {
          content: style.content,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage,
          backgroundPosition: style.backgroundPosition,
          backgroundSize: style.backgroundSize,
          backgroundRepeat: style.backgroundRepeat,
          backgroundBlendMode: style.backgroundBlendMode,
          mixBlendMode: style.mixBlendMode,
          position: style.position,
          inset: style.inset,
          top: style.top,
          right: style.right,
          bottom: style.bottom,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
        },
      }
    })
  }, candidates)
}

async function collectElement(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements, target) => {
    const round = (value: number) => Math.round(value * 100) / 100
    return elements.map((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        selector: target,
        tag: element.tagName.toLowerCase(),
        className: (element as HTMLElement).className,
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        },
        style: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          borderLeftWidth: style.borderLeftWidth,
          borderLeftColor: style.borderLeftColor,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          zIndex: style.zIndex,
        },
      }
    })
  }, selector)
}

const rightPanelSelectors = {
  reference: {
    context: '#detailPanel',
    artifacts: '#artifactsPanel',
  },
  implementation: {
    context: '.hc-inspector',
    artifacts: '.hc-artifacts',
  },
} as const

async function collectRightPanelEvidence(
  page: Page,
  kind: RightPanelKind,
  phase: RightPanelPhase,
  selector: string,
): Promise<RightPanelEvidence> {
  return page.evaluate(
    ({ kind: panelKind, phase: panelPhase, selector: panelSelector }) => {
      const round = (value: number) => Math.round(value * 100) / 100
      const element = document.querySelector<HTMLElement>(panelSelector)
      if (!element) {
        // Desktop 用 v-if 彻底移除关闭态面板；按严格 0px/hidden/no-hit-area 语义记录。
        return {
          kind: panelKind,
          phase: panelPhase,
          selector: panelSelector,
          present: false,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          style: {
            display: 'none',
            visibility: 'hidden',
            pointerEvents: 'none',
            opacity: '0',
            width: '0px',
            borderLeftWidth: '0px',
            borderLeftStyle: 'none',
            paddingTop: '0px',
            paddingRight: '0px',
            paddingBottom: '0px',
            paddingLeft: '0px',
          },
        }
      }
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        kind: panelKind,
        phase: panelPhase,
        selector: panelSelector,
        present: true,
        rect: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        },
        style: {
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          opacity: style.opacity,
          width: style.width,
          borderLeftWidth: style.borderLeftWidth,
          borderLeftStyle: style.borderLeftStyle,
          paddingTop: style.paddingTop,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
        },
      }
    },
    { kind, phase, selector },
  )
}

function rightPanelClosedPass(evidence: RightPanelEvidence) {
  return (
    evidence.rect.width === 0 &&
    evidence.style.width === '0px' &&
    evidence.style.borderLeftWidth === '0px' &&
    evidence.style.visibility === 'hidden' &&
    evidence.style.pointerEvents === 'none' &&
    evidence.style.paddingTop === '0px' &&
    evidence.style.paddingRight === '0px' &&
    evidence.style.paddingBottom === '0px' &&
    evidence.style.paddingLeft === '0px'
  )
}

function rightPanelOpenPass(evidence: RightPanelEvidence) {
  const expectedWidth = RIGHT_PANEL_WIDTHS[evidence.kind]
  return (
    evidence.present &&
    evidence.rect.width === expectedWidth &&
    evidence.style.width === `${expectedWidth}px` &&
    evidence.style.borderLeftWidth === '1px' &&
    evidence.style.visibility === 'visible' &&
    evidence.style.pointerEvents === 'auto' &&
    evidence.style.paddingTop === '0px' &&
    evidence.style.paddingRight === '0px' &&
    evidence.style.paddingBottom === '0px' &&
    evidence.style.paddingLeft === '0px'
  )
}

async function clickRightPanelControl(page: Page, kind: RightPanelKind, reference: boolean) {
  if (reference) {
    await page.locator(`[data-workspace-control="${kind}"]`).click()
    return
  }
  const title = kind === 'context' ? '上下文面板' : '产物'
  await page.locator('.hc-chat__toolbar').getByTitle(title, { exact: true }).click()
}

async function captureRightPanelPair(
  referencePage: Page,
  implementationPage: Page,
  outputDirectory: string,
  kind: RightPanelKind,
  phase: RightPanelPhase,
) {
  await stabilize(referencePage)
  await stabilize(implementationPage)
  const referenceSelector = rightPanelSelectors.reference[kind]
  const implementationSelector = rightPanelSelectors.implementation[kind]
  const [referencePanel, implementationPanel] = await Promise.all([
    collectRightPanelEvidence(referencePage, kind, phase, referenceSelector),
    collectRightPanelEvidence(implementationPage, kind, phase, implementationSelector),
  ])
  const stateDirectory = path.join(outputDirectory, `${kind}-${phase}`)
  const referencePath = path.join(stateDirectory, 'reference.png')
  const implementationPath = path.join(stateDirectory, 'implementation.png')
  const diffPath = path.join(stateDirectory, 'pixel-diff.png')
  await mkdir(path.dirname(referencePath), { recursive: true })
  await Promise.all([
    referencePage.screenshot({ path: referencePath, animations: 'disabled', caret: 'hide' }),
    implementationPage.screenshot({
      path: implementationPath,
      animations: 'disabled',
      caret: 'hide',
    }),
  ])
  const pixelDiff = await runPixelDiff(referencePage, referencePath, implementationPath, diffPath)
  const report = {
    bug: 'BUG-20260729-003',
    kind,
    phase,
    acceptance: 'DESKTOP-UI-RIGHT-PANEL-20260822-001',
    viewport: VIEWPORT,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    referencePanel,
    implementationPanel,
    gates: {
      reference:
        phase === 'closed'
          ? rightPanelClosedPass(referencePanel)
          : rightPanelOpenPass(referencePanel),
      implementation:
        phase === 'closed'
          ? rightPanelClosedPass(implementationPanel)
          : rightPanelOpenPass(implementationPanel),
      pairedScreenshotSize:
        pixelDiff.width === VIEWPORT.width && pixelDiff.height === VIEWPORT.height,
    },
    pixels: pixelDiff,
    files: {
      reference: path.basename(referencePath),
      implementation: path.basename(implementationPath),
      diff: path.basename(diffPath),
    },
  }
  await writeFile(
    path.join(path.dirname(referencePath), 'bbox-computed-style.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  return report
}

function layerOfKind(layers: LayerSnapshot[], kind: 'texture' | 'glow') {
  return layers.find((layer) => layer.kind === kind)
}

function activeKindExactSet(layers: LayerSnapshot[]) {
  return layers
    .filter((layer) => layer.active && (layer.kind === 'texture' || layer.kind === 'glow'))
    .map((layer) => layer.kind)
    .sort()
}

function near(reference: number | undefined, implementation: number | undefined, tolerance = 1) {
  return (
    reference !== undefined &&
    implementation !== undefined &&
    Math.abs(reference - implementation) <= tolerance
  )
}

function paintChecks(
  mode: BackgroundMode,
  referenceLayers: LayerSnapshot[],
  implementationLayers: LayerSnapshot[],
) {
  const expectedSet = mode === 'k12' ? ['glow'] : ['glow', 'texture']
  const referenceTexture = layerOfKind(referenceLayers, 'texture')
  const implementationTexture = layerOfKind(implementationLayers, 'texture')
  const referenceGlow = layerOfKind(referenceLayers, 'glow')
  const implementationGlow = layerOfKind(implementationLayers, 'glow')
  const checks = [
    {
      id: 'reference-active-exact-set',
      reference: expectedSet,
      implementation: activeKindExactSet(referenceLayers),
      pass: JSON.stringify(activeKindExactSet(referenceLayers)) === JSON.stringify(expectedSet),
    },
    {
      id: 'implementation-active-exact-set',
      reference: expectedSet,
      implementation: activeKindExactSet(implementationLayers),
      pass:
        JSON.stringify(activeKindExactSet(implementationLayers)) === JSON.stringify(expectedSet),
    },
    {
      id: 'texture-background-image',
      reference: referenceTexture?.style?.backgroundImage,
      implementation: implementationTexture?.style?.backgroundImage,
      pass:
        referenceTexture?.style?.backgroundImage === implementationTexture?.style?.backgroundImage,
    },
    {
      id: 'texture-background-size',
      reference: referenceTexture?.style?.backgroundSize,
      implementation: implementationTexture?.style?.backgroundSize,
      pass:
        referenceTexture?.style?.backgroundSize === implementationTexture?.style?.backgroundSize,
    },
    {
      id: 'texture-opacity',
      reference: referenceTexture?.style?.opacity,
      implementation: implementationTexture?.style?.opacity,
      pass: referenceTexture?.style?.opacity === implementationTexture?.style?.opacity,
    },
    {
      id: 'texture-z-index',
      reference: referenceTexture?.style?.zIndex,
      implementation: implementationTexture?.style?.zIndex,
      pass: referenceTexture?.style?.zIndex === implementationTexture?.style?.zIndex,
    },
    {
      id: 'texture-bbox-x',
      reference: referenceTexture?.rect?.x,
      implementation: implementationTexture?.rect?.x,
      pass: near(referenceTexture?.rect?.x, implementationTexture?.rect?.x),
    },
    {
      id: 'texture-bbox-y',
      reference: referenceTexture?.rect?.y,
      implementation: implementationTexture?.rect?.y,
      pass: near(referenceTexture?.rect?.y, implementationTexture?.rect?.y),
    },
    {
      id: 'texture-bbox-width',
      reference: referenceTexture?.rect?.width,
      implementation: implementationTexture?.rect?.width,
      pass: near(referenceTexture?.rect?.width, implementationTexture?.rect?.width),
    },
    {
      id: 'texture-bbox-height',
      reference: referenceTexture?.rect?.height,
      implementation: implementationTexture?.rect?.height,
      pass: near(referenceTexture?.rect?.height, implementationTexture?.rect?.height),
    },
    {
      id: 'glow-background-image',
      reference: referenceGlow?.style?.backgroundImage,
      implementation: implementationGlow?.style?.backgroundImage,
      pass: referenceGlow?.style?.backgroundImage === implementationGlow?.style?.backgroundImage,
    },
    {
      id: 'glow-opacity',
      reference: referenceGlow?.style?.opacity,
      implementation: implementationGlow?.style?.opacity,
      pass: referenceGlow?.style?.opacity === implementationGlow?.style?.opacity,
    },
    {
      id: 'glow-z-index',
      reference: referenceGlow?.style?.zIndex,
      implementation: implementationGlow?.style?.zIndex,
      pass: referenceGlow?.style?.zIndex === implementationGlow?.style?.zIndex,
    },
    {
      id: 'glow-bbox-x',
      reference: referenceGlow?.rect?.x,
      implementation: implementationGlow?.rect?.x,
      pass: near(referenceGlow?.rect?.x, implementationGlow?.rect?.x),
    },
    {
      id: 'glow-bbox-y',
      reference: referenceGlow?.rect?.y,
      implementation: implementationGlow?.rect?.y,
      pass: near(referenceGlow?.rect?.y, implementationGlow?.rect?.y),
    },
    {
      id: 'glow-bbox-height',
      reference: referenceGlow?.rect?.height,
      implementation: implementationGlow?.rect?.height,
      pass: near(referenceGlow?.rect?.height, implementationGlow?.rect?.height),
    },
  ]
  return {
    pass: checks.every((check) => check.pass),
    checks,
    excludedPendingDecision: [
      'glow bbox width',
      'main content bbox width',
      'closed context/artifacts panel gutter and border width',
    ],
  }
}

async function installNormalizedPlane(
  page: Page,
  theme: Theme,
  texture: LayerSnapshot | undefined,
  glow: LayerSnapshot | undefined,
) {
  await page.evaluate(
    ({ nextTheme, textureStyle, glowStyle }) => {
      document.querySelector('#bug015-normalized-plane')?.remove()
      const plane = document.createElement('div')
      plane.id = 'bug015-normalized-plane'
      Object.assign(plane.style, {
        position: 'fixed',
        inset: '0 auto auto 0',
        width: '1000px',
        height: '620px',
        overflow: 'hidden',
        zIndex: '2147483647',
        background: nextTheme === 'light' ? 'rgb(244, 248, 252)' : 'rgb(11, 21, 37)',
      })
      const textureNode = document.createElement('div')
      textureNode.dataset.layer = 'texture'
      Object.assign(textureNode.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        opacity: textureStyle?.opacity ?? '0',
        backgroundImage: textureStyle?.backgroundImage ?? 'none',
        backgroundSize: textureStyle?.backgroundSize ?? 'auto',
        backgroundPosition: textureStyle?.backgroundPosition ?? '0% 0%',
        backgroundRepeat: textureStyle?.backgroundRepeat ?? 'repeat',
        backgroundBlendMode: textureStyle?.backgroundBlendMode ?? 'normal',
        mixBlendMode: textureStyle?.mixBlendMode ?? 'normal',
      })
      const glowNode = document.createElement('div')
      glowNode.dataset.layer = 'glow'
      Object.assign(glowNode.style, {
        position: 'absolute',
        inset: '0 0 auto 0',
        height: '220px',
        pointerEvents: 'none',
        opacity: glowStyle?.opacity ?? '0',
        backgroundImage: glowStyle?.backgroundImage ?? 'none',
        backgroundSize: glowStyle?.backgroundSize ?? 'auto',
        backgroundPosition: glowStyle?.backgroundPosition ?? '0% 0%',
        backgroundRepeat: glowStyle?.backgroundRepeat ?? 'repeat',
        backgroundBlendMode: glowStyle?.backgroundBlendMode ?? 'normal',
        mixBlendMode: glowStyle?.mixBlendMode ?? 'normal',
      })
      plane.append(textureNode, glowNode)
      document.body.append(plane)
    },
    { nextTheme: theme, textureStyle: texture?.style, glowStyle: glow?.style },
  )
}

async function runPixelDiff(
  page: Page,
  referencePath: string,
  implementationPath: string,
  diffPath: string,
) {
  const referenceDataUrl = `data:image/png;base64,${(await readFile(referencePath)).toString('base64')}`
  const implementationDataUrl = `data:image/png;base64,${(await readFile(implementationPath)).toString('base64')}`
  const result = await page.evaluate(
    async ({ referenceDataUrl, implementationDataUrl, threshold }) => {
      const loadImage = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('Unable to decode paired screenshot'))
          image.src = src
        })
      const [reference, implementation] = await Promise.all([
        loadImage(referenceDataUrl),
        loadImage(implementationDataUrl),
      ])
      if (
        reference.naturalWidth !== implementation.naturalWidth ||
        reference.naturalHeight !== implementation.naturalHeight
      ) {
        throw new Error(
          `Paired screenshot size mismatch: reference=${reference.naturalWidth}x${reference.naturalHeight}, implementation=${implementation.naturalWidth}x${implementation.naturalHeight}`,
        )
      }
      const width = reference.naturalWidth
      const height = reference.naturalHeight
      const referenceCanvas = document.createElement('canvas')
      const implementationCanvas = document.createElement('canvas')
      const diffCanvas = document.createElement('canvas')
      for (const canvas of [referenceCanvas, implementationCanvas, diffCanvas]) {
        canvas.width = width
        canvas.height = height
      }
      const referenceContext = referenceCanvas.getContext('2d', { willReadFrequently: true })!
      const implementationContext = implementationCanvas.getContext('2d', {
        willReadFrequently: true,
      })!
      const diffContext = diffCanvas.getContext('2d')!
      referenceContext.drawImage(reference, 0, 0)
      implementationContext.drawImage(implementation, 0, 0)
      const referencePixels = referenceContext.getImageData(0, 0, width, height).data
      const implementationPixels = implementationContext.getImageData(0, 0, width, height).data
      const visiblePixels = diffContext.createImageData(width, height)
      let changedPixels = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let offset = 0; offset < referencePixels.length; offset += 4) {
        const changed =
          Math.abs(referencePixels[offset]! - implementationPixels[offset]!) > threshold ||
          Math.abs(referencePixels[offset + 1]! - implementationPixels[offset + 1]!) > threshold ||
          Math.abs(referencePixels[offset + 2]! - implementationPixels[offset + 2]!) > threshold
        const pixel = offset / 4
        const x = pixel % width
        const y = Math.floor(pixel / width)
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visiblePixels.data[offset] = 255
          visiblePixels.data[offset + 1] = 35
          visiblePixels.data[offset + 2] = 35
        } else {
          const gray = Math.round(
            referencePixels[offset]! * 0.299 +
              referencePixels[offset + 1]! * 0.587 +
              referencePixels[offset + 2]! * 0.114,
          )
          const dimmed = Math.round(gray * 0.45)
          visiblePixels.data[offset] = dimmed
          visiblePixels.data[offset + 1] = dimmed
          visiblePixels.data[offset + 2] = dimmed
        }
        visiblePixels.data[offset + 3] = 255
      }
      diffContext.putImageData(visiblePixels, 0, 0)
      const totalPixels = width * height
      return {
        summary: {
          width,
          height,
          threshold,
          changedPixels,
          totalPixels,
          changedPixelRatio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
          changedBBox: changedPixels === 0 ? null : ([minX, minY, maxX + 1, maxY + 1] as number[]),
        },
        image: diffCanvas.toDataURL('image/png'),
      }
    },
    { referenceDataUrl, implementationDataUrl, threshold: PIXEL_THRESHOLD },
  )
  await writeFile(diffPath, Buffer.from(result.image.split(',', 2)[1]!, 'base64'))
  return result.summary
}

async function sha256(filePath: string) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

async function captureState(
  browser: Browser,
  testInfo: TestInfo,
  sourceBaseUrl: string,
  surface: Surface,
  theme: Theme,
) {
  const stateId = `${surface.id}-${theme}`
  const outputDirectory = path.join(EVIDENCE_ROOT, stateId)
  await mkdir(outputDirectory, { recursive: true })
  const referenceExternal: string[] = []
  const implementationExternal: string[] = []
  const pageErrors: { reference: string[]; implementation: string[] } = {
    reference: [],
    implementation: [],
  }
  const options = {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: theme,
    reducedMotion: 'reduce' as const,
    serviceWorkers: 'block' as const,
  }
  const referenceContext = await browser.newContext(options)
  const implementationContext = await browser.newContext(options)
  const referencePage = await referenceContext.newPage()
  const implementationPage = await implementationContext.newPage()
  referencePage.on('pageerror', (error) => pageErrors.reference.push(error.message))
  implementationPage.on('pageerror', (error) => pageErrors.implementation.push(error.message))
  try {
    await installSourceFixture(implementationPage, theme, surface.mode, implementationExternal)
    await Promise.all([
      preparePrototype(referencePage, surface, theme, referenceExternal),
      prepareSource(implementationPage, sourceBaseUrl, surface, theme),
    ])

    const [referenceLayers, implementationLayers] = await Promise.all([
      collectLayers(referencePage, REFERENCE_CANDIDATES),
      collectLayers(implementationPage, IMPLEMENTATION_CANDIDATES),
    ])
    const checks = paintChecks(surface.mode, referenceLayers, implementationLayers)
    const [referenceMain, implementationMain, referencePanels, implementationPanels] =
      await Promise.all([
        collectElement(referencePage, '.mn'),
        collectElement(implementationPage, '.hc-app__content'),
        collectElement(referencePage, '#detailPanel, #artifactsPanel'),
        collectElement(
          implementationPage,
          '.hc-inspector, .hc-artifacts, #hc-chat-scenario-sidepanel',
        ),
      ])

    const pageReferencePath = path.join(outputDirectory, 'page-reference.png')
    const pageImplementationPath = path.join(outputDirectory, 'page-implementation.png')
    const pageDiffPath = path.join(outputDirectory, 'page-diff.png')
    await Promise.all([
      referencePage.screenshot({ path: pageReferencePath, animations: 'disabled', caret: 'hide' }),
      implementationPage.screenshot({
        path: pageImplementationPath,
        animations: 'disabled',
        caret: 'hide',
      }),
    ])
    const pagePixel = await runPixelDiff(
      referencePage,
      pageReferencePath,
      pageImplementationPath,
      pageDiffPath,
    )

    await Promise.all([
      installNormalizedPlane(
        referencePage,
        theme,
        layerOfKind(referenceLayers, 'texture'),
        layerOfKind(referenceLayers, 'glow'),
      ),
      installNormalizedPlane(
        implementationPage,
        theme,
        layerOfKind(implementationLayers, 'texture'),
        layerOfKind(implementationLayers, 'glow'),
      ),
    ])
    const referencePath = path.join(outputDirectory, 'reference.png')
    const implementationPath = path.join(outputDirectory, 'implementation.png')
    const diffPath = path.join(outputDirectory, 'diff.png')
    await Promise.all([
      referencePage
        .locator('#bug015-normalized-plane')
        .screenshot({ path: referencePath, animations: 'disabled' }),
      implementationPage
        .locator('#bug015-normalized-plane')
        .screenshot({ path: implementationPath, animations: 'disabled' }),
    ])
    const normalizedPixel = await runPixelDiff(
      referencePage,
      referencePath,
      implementationPath,
      diffPath,
    )

    const rightPanelDecision = {
      status: 'BLOCKED_PENDING_USER_DECISION',
      declaredConflict: {
        implementationClosedGutterPx: 0,
        prototypeHistoricalClosedGutterPx: 2,
      },
      rule: '本门只记录关闭右栏 0px 与原型历史 2px 的审批冲突；不修改任一侧，不比较 glow/main width，不影响纹理、glow paint、opacity、z-index 或非宽度 bbox 子门。',
      measuredCurrentWorkspace: {
        referenceMain,
        implementationMain,
        referencePanels,
        implementationPanels,
      },
    }
    const externalRequests = [...referenceExternal, ...implementationExternal]
    const subGates = {
      layerExactSet: {
        status: checks.checks
          .filter((check) => check.id.endsWith('active-exact-set'))
          .every((check) => check.pass)
          ? 'PASS'
          : 'RED',
      },
      texturePaintAndGeometry: {
        status: checks.checks
          .filter((check) => check.id.startsWith('texture-'))
          .every((check) => check.pass)
          ? 'PASS'
          : 'RED',
      },
      glowPaintOpacityZIndexAndNonWidthGeometry: {
        status: checks.checks
          .filter((check) => check.id.startsWith('glow-'))
          .every((check) => check.pass)
          ? 'PASS'
          : 'RED',
      },
      normalizedPairedPixels: {
        status: normalizedPixel.changedPixelRatio <= MAX_NORMALIZED_PIXEL_RATIO ? 'PASS' : 'RED',
        threshold: MAX_NORMALIZED_PIXEL_RATIO,
        actual: normalizedPixel.changedPixelRatio,
      },
      loopbackOnly: { status: externalRequests.length === 0 ? 'PASS' : 'RED' },
      runtimeErrors: {
        status:
          pageErrors.reference.length === 0 && pageErrors.implementation.length === 0
            ? 'PASS'
            : 'RED',
      },
      closedRightPanelDecision: { status: rightPanelDecision.status },
      rawPagePixels: {
        status: 'DIAGNOSTIC_ONLY',
        reason:
          '整页包含不同产品 DOM；背景通过门使用同态固定检查平面。原始整页三件套仅用于定位遮盖或场景层差异。',
        actual: pagePixel.changedPixelRatio,
      },
    }
    const nonConflictPass =
      checks.pass &&
      normalizedPixel.changedPixelRatio <= MAX_NORMALIZED_PIXEL_RATIO &&
      externalRequests.length === 0 &&
      pageErrors.reference.length === 0 &&
      pageErrors.implementation.length === 0
    const report = {
      bug: 'BUG-20260723-015',
      state: stateId,
      surface,
      theme,
      status: nonConflictPass ? 'NON_CONFLICT_PASS' : 'RED',
      environment: {
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        reducedMotion: 'reduce',
        splashDetachedBeforeCapture: true,
      },
      fixture: {
        kind: 'same-state normalized global-background plane',
        size: { width: 1000, height: 620 },
        base: theme === 'light' ? 'rgb(244, 248, 252)' : 'rgb(11, 21, 37)',
        source: 'actual computed texture/glow paint from each live route',
      },
      subGates,
      checks,
      pixels: { normalized: normalizedPixel, rawPageDiagnostic: pagePixel },
      layers: { reference: referenceLayers, implementation: implementationLayers },
      rightPanelDecision,
      network: { externalRequests },
      runtime: { pageErrors },
      files: {
        reference: 'reference.png',
        implementation: 'implementation.png',
        diff: 'diff.png',
        pageReference: 'page-reference.png',
        pageImplementation: 'page-implementation.png',
        pageDiff: 'page-diff.png',
      },
    }
    const reportPath = path.join(outputDirectory, 'background-evidence.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    for (const [name, filePath, contentType] of [
      [`${stateId}-reference`, referencePath, 'image/png'],
      [`${stateId}-implementation`, implementationPath, 'image/png'],
      [`${stateId}-diff`, diffPath, 'image/png'],
      [`${stateId}-background-evidence`, reportPath, 'application/json'],
    ] as const) {
      await testInfo.attach(name, { path: filePath, contentType })
    }
    return report
  } finally {
    await Promise.all([referenceContext.close(), implementationContext.close()])
  }
}

test.describe('BUG-20260723-015 · 全局背景事实验收', () => {
  test('普通与 K12 关键 route 在 Light/Dark 保持唯一纹理/glow；右栏冲突独立阻塞', async ({
    browser,
  }, testInfo) => {
    const sourceBaseUrl = String(testInfo.project.use.baseURL ?? '')
    assertLoopback(sourceBaseUrl, 'current-source baseURL')
    const sourcePaths = {
      appLayout: path.join(ROOT, 'src/components/layout/AppLayout.vue'),
      globalCss: path.join(ROOT, 'src/assets/styles/global.css'),
      k12Presentation: path.join(ROOT, 'src/features/k12/appearance/K12GlobalPresentation.vue'),
      pairedTest: path.join(
        ROOT,
        'tests/e2e/browser-live-bug-20260723-015-global-background.spec.ts',
      ),
    }
    const sourceBefore = Object.fromEntries(
      await Promise.all(
        Object.entries(sourcePaths).map(async ([name, filePath]) => [name, await sha256(filePath)]),
      ),
    )
    const reports = []
    for (const surface of SURFACES) {
      for (const theme of THEMES) {
        reports.push(await captureState(browser, testInfo, sourceBaseUrl, surface, theme))
      }
    }
    const sourceAfter = Object.fromEntries(
      await Promise.all(
        Object.entries(sourcePaths).map(async ([name, filePath]) => [name, await sha256(filePath)]),
      ),
    )
    const sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter)
    const installedCandidate = {
      status: 'BLOCKED',
      candidate: 'src-tauri/target/release/bundle/macos/HexClaw Test.app',
      reason:
        '现有 Test.app 没有可复用的只读 WKWebView harness，可同时注入普通/K12 同态 fixture、切换 Light/Dark、读取 pseudo-element computed style 并输出成对 diff；现有 native harness 为其他场景专用且会改写临时 bundle。',
      applicationsTouched: false,
      userDataTouched: false,
    }
    const summary = {
      bug: 'BUG-20260723-015',
      acceptance: 'UI-GLOBAL-BACKGROUND-001',
      status: reports.every((report) => report.status === 'NON_CONFLICT_PASS')
        ? 'NON_CONFLICT_PASS_RIGHT_PANEL_BLOCKED'
        : 'RED_RIGHT_PANEL_BLOCKED',
      prototype: {
        repositorySiblingPath: '../hexclaw-docs/prototype/app.html',
        sha256: await sha256(PROTOTYPE_PATH),
      },
      sourceStability: { stable: sourceStable, before: sourceBefore, after: sourceAfter },
      states: reports.map((report) => ({
        state: report.state,
        status: report.status,
        subGates: report.subGates,
      })),
      rightPanelDecision: {
        status: 'BLOCKED_PENDING_USER_DECISION',
        implementationClosedGutterPx: 0,
        prototypeHistoricalClosedGutterPx: 2,
        excludedFromOtherBackgroundGates: true,
      },
      installedCandidate,
    }
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      path.join(EVIDENCE_ROOT, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    await writeFile(
      path.join(EVIDENCE_ROOT, 'README.md'),
      `# BUG-20260723-015 current-source background evidence\n\n` +
        `- Non-conflict background status: **${summary.status}**\n` +
        `- Right-panel 0px/2px decision: **BLOCKED_PENDING_USER_DECISION**; excluded from every other sub-gate.\n` +
        `- States: ${reports.map((report) => `${report.state}=${report.status}`).join(', ')}\n` +
        `- Installed candidate: **${installedCandidate.status}** — ${installedCandidate.reason}\n` +
        `- Network: loopback-only; non-loopback requests are blocked and reported.\n` +
        `- Capture invariant: implementation splash was detached before every capture.\n`,
    )

    for (const report of reports) {
      expect
        .soft(report.checks.checks, `${report.state}: paint/bbox checks`)
        .toEqual(report.checks.checks.map((check) => ({ ...check, pass: true })))
      expect
        .soft(report.pixels.normalized.changedPixelRatio, `${report.state}: normalized pixel diff`)
        .toBeLessThanOrEqual(MAX_NORMALIZED_PIXEL_RATIO)
      expect.soft(report.network.externalRequests, `${report.state}: loopback-only`).toEqual([])
      expect.soft(report.runtime.pageErrors, `${report.state}: runtime errors`).toEqual({
        reference: [],
        implementation: [],
      })
      expect
        .soft(report.rightPanelDecision.status, `${report.state}: decision stays isolated`)
        .toBe('BLOCKED_PENDING_USER_DECISION')
    }
    expect.soft(sourceStable, 'source files remained unchanged during capture').toBe(true)
  })
})

test.describe('BUG-20260729-003 · 右侧面板严格零占位验收', () => {
  test('closed panels are strict zero-width and open panels keep the approved width + border', async ({
    browser,
  }, testInfo) => {
    const sourceBaseUrl = String(testInfo.project.use.baseURL ?? '')
    assertLoopback(sourceBaseUrl, 'current-source baseURL')
    const externalRequests: string[] = []
    const options = {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light' as const,
      reducedMotion: 'reduce' as const,
      serviceWorkers: 'block' as const,
    }
    const referenceContext = await browser.newContext(options)
    const implementationContext = await browser.newContext(options)
    const referencePage = await referenceContext.newPage()
    const implementationPage = await implementationContext.newPage()
    const surface: Surface = {
      id: 'right-panel',
      mode: 'normal',
      sourceRoute: '/chat',
      prototypePane: 'chat',
    }
    const outputDirectory = path.join(RIGHT_PANEL_EVIDENCE_ROOT, testInfo.project.name)
    const reports: Array<Awaited<ReturnType<typeof captureRightPanelPair>>> = []

    try {
      await installSourceFixture(implementationPage, 'light', 'normal', externalRequests)
      await Promise.all([
        preparePrototype(referencePage, surface, 'light', externalRequests),
        prepareSource(implementationPage, sourceBaseUrl, surface, 'light'),
      ])

      for (const kind of ['context', 'artifacts'] as const) {
        reports.push(
          await captureRightPanelPair(
            referencePage,
            implementationPage,
            outputDirectory,
            kind,
            'closed',
          ),
        )

        await Promise.all([
          clickRightPanelControl(referencePage, kind, true),
          clickRightPanelControl(implementationPage, kind, false),
        ])
        const referenceOpenSelector = kind === 'context' ? '#detailPanel.on' : '#artifactsPanel.on'
        const implementationOpenSelector = kind === 'context' ? '.hc-inspector' : '.hc-artifacts'
        await Promise.all([
          expect(referencePage.locator(referenceOpenSelector)).toBeVisible(),
          expect(implementationPage.locator(implementationOpenSelector)).toBeVisible(),
        ])
        reports.push(
          await captureRightPanelPair(
            referencePage,
            implementationPage,
            outputDirectory,
            kind,
            'open',
          ),
        )

        await Promise.all([
          clickRightPanelControl(referencePage, kind, true),
          clickRightPanelControl(implementationPage, kind, false),
        ])
        await Promise.all([stabilize(referencePage), stabilize(implementationPage)])
      }

      const summary = {
        bug: 'BUG-20260729-003',
        acceptance: 'DESKTOP-UI-RIGHT-PANEL-20260822-001',
        status: reports.every(
          (report) =>
            report.gates.reference &&
            report.gates.implementation &&
            report.gates.pairedScreenshotSize,
        )
          ? 'PASS'
          : 'RED',
        environment: {
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          reducedMotion: 'reduce',
        },
        contract: {
          closed: {
            width: '0px',
            borderLeftWidth: '0px',
            visibility: 'hidden',
            pointerEvents: 'none',
            padding: '0px',
          },
          open: {
            context: { width: '272px', borderLeftWidth: '1px' },
            artifacts: { width: '380px', borderLeftWidth: '1px' },
          },
        },
        reports,
        externalRequests,
        files: reports.flatMap((report) => {
          const directory = `${report.kind}-${report.phase}`
          return [
            `${directory}/${report.files.reference}`,
            `${directory}/${report.files.implementation}`,
            `${directory}/${report.files.diff}`,
            `${directory}/bbox-computed-style.json`,
          ]
        }),
      }
      await mkdir(outputDirectory, { recursive: true })
      const summaryPath = path.join(outputDirectory, 'summary.json')
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
      await testInfo.attach('bug-20260729-003-right-panel-summary', {
        path: summaryPath,
        contentType: 'application/json',
      })
      for (const report of reports) {
        const directory = path.join(outputDirectory, `${report.kind}-${report.phase}`)
        await Promise.all([
          testInfo.attach(`${report.kind}-${report.phase}-reference`, {
            path: path.join(directory, report.files.reference),
            contentType: 'image/png',
          }),
          testInfo.attach(`${report.kind}-${report.phase}-implementation`, {
            path: path.join(directory, report.files.implementation),
            contentType: 'image/png',
          }),
          testInfo.attach(`${report.kind}-${report.phase}-diff`, {
            path: path.join(directory, report.files.diff),
            contentType: 'image/png',
          }),
        ])
        expect
          .soft(report.gates.reference, `${report.kind}/${report.phase}: prototype panel contract`)
          .toBe(true)
        expect
          .soft(
            report.gates.implementation,
            `${report.kind}/${report.phase}: implementation panel contract`,
          )
          .toBe(true)
        expect
          .soft(
            report.gates.pairedScreenshotSize,
            `${report.kind}/${report.phase}: paired screenshots share viewport`,
          )
          .toBe(true)
      }
      expect.soft(externalRequests, 'right-panel evidence stays loopback-only').toEqual([])
    } finally {
      await Promise.all([referenceContext.close(), implementationContext.close()])
    }
  })
})
