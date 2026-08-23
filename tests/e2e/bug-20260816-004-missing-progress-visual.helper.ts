import type { Page, Route } from '@playwright/test'

export const bug004Agent = 'bug004-missing-progress-agent'
export const bug004Session = 'bug004-missing-progress-session'

const fixedNow = Date.parse('2026-08-22T08:00:00+08:00')

const weeklyPlan = {
  plan_id: 'bug004-weekly-plan',
  agent: bug004Agent,
  revision: 1,
  iso_week_year: 2026,
  iso_week_number: 34,
  timezone: 'Asia/Shanghai',
  week_start: '2026-08-17T00:00:00+08:00',
  week_end: '2026-08-23T23:59:59+08:00',
  local_start_date: '2026-08-17',
  local_end_date: '2026-08-23',
  status: 'draft',
  settings_revision: 1,
  curriculum_progress_revision: 0,
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      arithmetic_batch: null,
      items: [
        {
          item_id: 'bug004-due-1',
          position: 1,
          plan_section: 'due_review',
          source_kind: 'mistake',
          generation_method: 'original',
          source_ref: 'bug004-mistake-1',
          verification: {
            status: 'verified',
            evidence_refs: ['数学作业 · 表内除法错题'],
          },
          prompt_markdown: '36 ÷ 4 = ?',
          subject: '数学',
          knowledge_point: '表内除法',
          mastery_status: 'new',
        },
      ],
    },
    {
      plan_section: 'textbook_consolidation',
      status: 'disabled',
      failure_message: 'curriculum progress setup required',
      arithmetic_batch: null,
      items: [],
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'disabled',
      failure_message: 'curriculum progress setup required',
      arithmetic_batch: null,
      items: [],
    },
  ],
  manual_track_recommendations: {
    textbook_consolidation: { availability: 'setup_required', selected_item_count: 5 },
    arithmetic_warmup: { availability: 'setup_required', selected_item_count: 10 },
  },
  created_at: '2026-08-17T00:00:00+08:00',
  updated_at: '2026-08-22T08:00:00+08:00',
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

export async function installSourceFixture(page: Page, externalRequests: string[]) {
  await page.addInitScript(
    ({ agent, session, now }) => {
      localStorage.clear()
      sessionStorage.clear()
      Date.now = () => now
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
      )
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))

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
    { agent: bug004Agent, session: bug004Session, now: fixedNow },
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
    if (apiPath === '/api/v1/config' && method === 'GET') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (apiPath === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: bug004Agent,
            display_name: '小红的辅导助手',
            description: '缺教材进度同态夹具',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小红',
              'k12.learner_id': 'bug004-learner-hong',
              'k12.grade_term': '二年级下',
              'k12.textbook_edition': '',
            },
          },
        ],
        total: 1,
        default: bug004Agent,
      })
    }
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: bug004Session,
            title: '小红的辅导助手',
            created_at: '2026-08-22T07:00:00+08:00',
            updated_at: '2026-08-22T08:00:00+08:00',
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (
      apiPath === `/api/v1/sessions/${bug004Session}/messages` ||
      apiPath === `/api/v1/sessions/${bug004Session}/artifacts`
    ) {
      return json(route, { messages: [], artifacts: [], total: 0 })
    }
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
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
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, { progress: null, revision: 0 })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: bug004Agent,
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: '2026-08-17T00:00:00+08:00',
        updated_at: '2026-08-22T08:00:00+08:00',
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: weeklyPlan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
      return json(route, { items: [], total: 0 })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: 0,
        suggestion: '',
      })
    }
    if (apiPath === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath === '/api/k12/creative-works' || apiPath === '/api/k12/practice-sets') {
      return json(route, { items: [] })
    }
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
      return json(route, { items: [] })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

export async function installReferenceFixture(page: Page, externalRequests: string[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'hexclaw.prototype.k12Appearance.v1',
      JSON.stringify({ preference: 'k12', introSeen: true }),
    )
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
}

export async function openSourceMissingProgress(page: Page, sourceURL: string) {
  await page.goto(
    `${sourceURL}/chat?role=${bug004Agent}&roleTitle=${encodeURIComponent('小红的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  const scenarioTabs = page.locator('.k12enh-seg')
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
  await page.locator('.weekly-progress--missing').waitFor({ state: 'visible', timeout: 30_000 })
}

export async function openReferenceMissingProgress(page: Page, referenceURL: string) {
  await page.goto(referenceURL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const api = window as typeof window & {
      applyThemeState?: (theme: 'light', announce: boolean) => void
      goRecords?: (learner: string, tab: number) => void
      k12BookTab?: (tab: number) => void
    }
    api.applyThemeState?.('light', false)
    api.goRecords?.('hong', 0)
    api.k12BookTab?.(0)
  })
  await page
    .locator('#k12BookPanel0 [data-learner-panel="hong"] .rc-week-progress--missing')
    .waitFor({ state: 'visible', timeout: 30_000 })
}

export async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
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

export interface CardFacts {
  text: string
  title: string
  button: string
  viewport: { width: number; height: number; dpr: number; locale: string }
  rects: Record<'card' | 'title' | 'button', { x: number; y: number; width: number; height: number }>
  styles: Record<
    'card' | 'title' | 'button',
    Record<string, string>
  >
  titleLineCount: number
  checks: {
    exactText: boolean
    exactTitle: boolean
    exactButton: boolean
    cardRow: boolean
    cardNoWrap: boolean
    titleNoWrap: boolean
    buttonNoWrap: boolean
    sameLine: boolean
    noOverlap: boolean
    noHorizontalOverflow: boolean
  }
}

export async function collectCardFacts(page: Page, selector: string): Promise<CardFacts> {
  return page.locator(selector).evaluate((card) => {
    const title = card.querySelector<HTMLElement>('b')
    const button = card.querySelector<HTMLElement>('button')
    if (!title || !button) throw new Error('missing-progress title/button not found')
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    const styles = (node: Element) => {
      const style = getComputedStyle(node)
      return {
        display: style.display,
        flexDirection: style.flexDirection,
        flexWrap: style.flexWrap,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        gap: style.gap,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        whiteSpace: style.whiteSpace,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow,
        borderStyle: style.borderStyle,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        padding: style.padding,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      }
    }
    const cardRect = card.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const cardStyle = getComputedStyle(card)
    const titleStyle = getComputedStyle(title)
    const buttonStyle = getComputedStyle(button)
    const range = document.createRange()
    range.selectNodeContents(title)
    const lineTops = [...range.getClientRects()].map((line) => Math.round(line.top * 10) / 10)
    const titleLineCount = new Set(lineTops).size
    const verticalOverlap =
      Math.min(titleRect.bottom, buttonRect.bottom) - Math.max(titleRect.top, buttonRect.top)
    const noOverlap =
      titleRect.right <= buttonRect.left + 0.5 || buttonRect.right <= titleRect.left + 0.5
    const noHorizontalOverflow =
      card.scrollWidth <= card.clientWidth + 1 &&
      cardRect.left >= -0.5 &&
      cardRect.right <= innerWidth + 0.5 &&
      titleRect.left >= cardRect.left - 0.5 &&
      titleRect.right <= cardRect.right + 0.5 &&
      buttonRect.left >= cardRect.left - 0.5 &&
      buttonRect.right <= cardRect.right + 0.5

    return {
      text: normalize((card as HTMLElement).innerText),
      title: normalize(title.innerText),
      button: normalize(button.innerText),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        locale: navigator.language,
      },
      rects: { card: rect(card), title: rect(title), button: rect(button) },
      styles: { card: styles(card), title: styles(title), button: styles(button) },
      titleLineCount,
      checks: {
        exactText:
          normalize((card as HTMLElement).innerText) ===
          '设置教材进度，推荐更贴合课堂 调整进度',
        exactTitle: normalize(title.innerText) === '设置教材进度，推荐更贴合课堂',
        exactButton: normalize(button.innerText) === '调整进度',
        cardRow: cardStyle.flexDirection === 'row',
        cardNoWrap: cardStyle.flexWrap === 'nowrap',
        titleNoWrap: titleStyle.whiteSpace === 'nowrap' && titleLineCount === 1,
        buttonNoWrap: buttonStyle.whiteSpace === 'nowrap',
        sameLine: verticalOverlap > 0,
        noOverlap,
        noHorizontalOverflow,
      },
    }
  })
}
