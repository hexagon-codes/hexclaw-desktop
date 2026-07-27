import { test, expect, type Page, type Route } from '@playwright/test'

test.use({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
})

type SessionRow = {
  id: string
  title: string
  created_at: string
  updated_at: string
  message_count: number
}

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  created_at: string
  agent_name?: string
  metadata?: Record<string, unknown>
}

type DividerSnapshot = {
  state: string
  contract: string | null
  separatorCount: number
  inputAreaOwnDivider: boolean
  composerOwnBorder: boolean
  composerOwnRadius: boolean
  footerInsideMessage: boolean
  footerBeforeComposer: boolean
  messagesNodeStable: boolean
  bottomAnchorStable: boolean
  bottomAnchorInsideMessages: boolean
  messagesScrollable: boolean
}

const now = '2026-07-27T08:00:00.000Z'
const k12Agent = 'k12-tutor-bug-20260726-030'

const sessions: SessionRow[] = [
  {
    id: 's-completed',
    title: '普通完成会话',
    created_at: now,
    updated_at: now,
    message_count: 2,
  },
  {
    id: 's-streaming',
    title: '普通流式会话',
    created_at: now,
    updated_at: now,
    message_count: 1,
  },
  {
    id: 's-pending',
    title: '普通等待会话',
    created_at: now,
    updated_at: now,
    message_count: 1,
  },
  {
    id: 's-failed',
    title: '普通失败会话',
    created_at: now,
    updated_at: now,
    message_count: 2,
  },
  {
    id: 's-k12',
    title: '小明的辅导助手',
    created_at: now,
    updated_at: now,
    message_count: 2,
  },
]

const messagesBySession: Record<string, MessageRow[]> = {
  's-completed': [
    {
      id: 'completed-user',
      role: 'user',
      content: '普通完成问题',
      timestamp: now,
      created_at: now,
    },
    {
      id: 'completed-assistant',
      role: 'assistant',
      content: '普通完成回复',
      timestamp: now,
      created_at: now,
      metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
    },
  ],
  's-streaming': [
    {
      id: 'streaming-user',
      role: 'user',
      content: '普通流式问题',
      timestamp: now,
      created_at: now,
    },
  ],
  's-pending': [
    {
      id: 'pending-user',
      role: 'user',
      content: '普通等待问题',
      timestamp: now,
      created_at: now,
    },
  ],
  's-failed': [
    {
      id: 'failed-user',
      role: 'user',
      content: '普通失败问题',
      timestamp: now,
      created_at: now,
    },
    {
      id: 'failed-assistant',
      role: 'assistant',
      content: '模型服务暂时不可用，请重试。',
      timestamp: now,
      created_at: now,
      metadata: { is_error: true, provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
    },
  ],
  's-k12': [
    {
      id: 'k12-user',
      role: 'user',
      content: '介绍下你',
      timestamp: now,
      created_at: now,
    },
    {
      id: 'k12-assistant',
      role: 'assistant',
      content: '你好，我是小明的辅导助手。',
      timestamp: now,
      created_at: now,
      agent_name: '小明的辅导助手',
      metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
    },
  ],
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installBug030Boundary(page: Page) {
  await page.addInitScript(
    ({ agent }) => {
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      if (!localStorage.getItem('hexclaw_lastSessionId')) {
        localStorage.setItem('hexclaw_lastSessionId', 's-streaming')
      }
      localStorage.setItem(
        'hexclaw_sessionAgents',
        JSON.stringify({ 's-k12': agent }),
      )

      class Bug030WebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3

        url: string
        readyState = Bug030WebSocket.CONNECTING
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent<string>) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null

        constructor(url: string) {
          super()
          this.url = url
          setTimeout(() => {
            this.readyState = Bug030WebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          }, 0)
        }

        send(raw: string) {
          const payload = JSON.parse(raw) as {
            type?: string
            session_id?: string
            request_id?: string
          }
          if (payload.type !== 'resume') return
          if (payload.session_id === 's-streaming') {
            this.emit({
              type: 'stream_snapshot',
              session_id: 's-streaming',
              request_id: 'req-streaming',
              content: '普通流式回复中',
              done: false,
              metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
            })
          }
          if (payload.session_id === 's-pending') {
            this.emit({
              type: 'stream_snapshot',
              session_id: 's-pending',
              request_id: 'req-pending',
              content: '',
              done: false,
              metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
            })
          }
        }

        close() {
          if (this.readyState === Bug030WebSocket.CLOSED) return
          this.readyState = Bug030WebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.(event)
          this.dispatchEvent(event)
        }

        private emit(payload: Record<string, unknown>) {
          setTimeout(() => {
            if (this.readyState !== Bug030WebSocket.OPEN) return
            const event = new MessageEvent('message', { data: JSON.stringify(payload) })
            this.onmessage?.(event)
            this.dispatchEvent(event)
          }, 20)
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: Bug030WebSocket,
      })
    },
    { agent: k12Agent },
  )

  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
        knowledge: { enabled: true },
        llm: { default: 'HexClaw-GPT', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (path === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: 'HexClaw-GPT',
        providers: {
          'HexClaw-GPT': {
            api_key: 'test',
            base_url: 'http://127.0.0.1:18080/v1',
            model: 'gpt-5.6-sol',
            models: ['gpt-5.6-sol'],
          },
        },
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (path === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: k12Agent,
            display_name: '小明的辅导助手',
            description: '五年级下',
            provider: 'HexClaw-GPT',
            model: 'gpt-5.6-sol',
            metadata: {
              scenario: 'k12-tutor',
              'k12.child_name': '小明',
              'k12.learner_id': 'learner-bug-030',
              'k12.grade_term': '五年级下',
            },
          },
        ],
        total: 1,
        default: '',
      })
    }
    if (path === '/api/v1/streams/active') {
      return json(route, {
        streams: [
          {
            request_id: 'req-streaming',
            session_id: 's-streaming',
            user_id: 'desktop-user',
            content: '普通流式回复中',
            done: false,
            status: 'streaming',
            metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
            started_at: now,
            updated_at: now,
          },
          {
            request_id: 'req-pending',
            session_id: 's-pending',
            user_id: 'desktop-user',
            content: '',
            done: false,
            status: 'pending',
            metadata: { provider: 'HexClaw-GPT', model: 'gpt-5.6-sol' },
            started_at: now,
            updated_at: now,
          },
        ],
        total: 2,
      })
    }
    if (path === '/api/k12/view-descriptor') {
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
    if (
      path === '/api/k12/mistakes' ||
      path === '/api/k12/review-queue' ||
      path === '/api/k12/accumulation' ||
      path === '/api/k12/practice-sets' ||
      path === '/api/k12/creative-works'
    ) {
      return json(route, { items: [] })
    }
    if (path === '/api/k12/insight-report') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
      })
    }
    if (method === 'GET' && path === '/api/v1/sessions') {
      return json(route, { sessions, total: sessions.length })
    }

    const messageMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
    if (method === 'GET' && messageMatch) {
      const sessionId = decodeURIComponent(messageMatch[1] ?? '')
      const messages = messagesBySession[sessionId] ?? []
      return json(route, { messages, total: messages.length })
    }

    return json(route, {})
  })
}

async function selectSession(page: Page, sessionId: string) {
  const row = page.locator(`[data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible()
  await row.click()
  await expect(row).toHaveClass(/hc-sessions__item--active/)
  await expect(page.locator('.hc-chat__input-area')).toBeVisible()
}

async function captureDividerSnapshot(
  page: Page,
  state: string,
  requireFooter: boolean,
): Promise<DividerSnapshot> {
  return page.locator('.hc-chat__input-area').evaluate(
    (inputArea, args) => {
      const { state, requireFooter } = args
      const main = inputArea.parentElement
      const messages = main?.querySelector<HTMLElement>('.hc-chat__messages') ?? null
      const composer = inputArea.querySelector<HTMLElement>('.hc-composer__box') ?? null
      const footer =
        messages?.querySelector<HTMLElement>('.hc-msg__footer:not(.hc-msg__footer--right)') ?? null
      const bottomAnchor = messages?.lastElementChild ?? null

      const stableWindow = window as Window & {
        __bug030MessagesNode?: Element
        __bug030BottomAnchor?: Element
      }
      const messagesNodeStable =
        !stableWindow.__bug030MessagesNode || stableWindow.__bug030MessagesNode === messages
      const bottomAnchorStable =
        !stableWindow.__bug030BottomAnchor || stableWindow.__bug030BottomAnchor === bottomAnchor
      if (messages) stableWindow.__bug030MessagesNode = messages
      if (bottomAnchor) stableWindow.__bug030BottomAnchor = bottomAnchor

      const px = (value: string) => Number.parseFloat(value) || 0
      const hasPseudoPaint = (style: CSSStyleDeclaration) => {
        const content = style.content
        const hasContent = content !== 'none' && content !== 'normal' && content !== '""'
        return (
          hasContent &&
          (px(style.borderTopWidth) > 0 ||
            px(style.borderBottomWidth) > 0 ||
            style.boxShadow !== 'none' ||
            style.backgroundImage !== 'none' ||
            (style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
              style.backgroundColor !== 'transparent'))
        )
      }
      const hasLinePaint = (element: Element) => {
        const style = getComputedStyle(element)
        return (
          px(style.borderTopWidth) > 0 ||
          px(style.borderBottomWidth) > 0 ||
          style.boxShadow !== 'none' ||
          style.backgroundImage !== 'none' ||
          hasPseudoPaint(getComputedStyle(element, '::before')) ||
          hasPseudoPaint(getComputedStyle(element, '::after'))
        )
      }

      const mainRect = main?.getBoundingClientRect()
      const inputRect = inputArea.getBoundingClientRect()
      const seamY = inputRect.top
      const separatorCount =
        main && mainRect
          ? Array.from(main.children).filter((candidate) => {
              const rect = candidate.getBoundingClientRect()
              const spansContent = rect.width >= mainRect.width * 0.75
              const touchesSeam = rect.top <= seamY + 1 && rect.bottom >= seamY - 1
              return spansContent && touchesSeam && hasLinePaint(candidate)
            }).length
          : -1

      const inputStyle = getComputedStyle(inputArea)
      const composerStyle = composer ? getComputedStyle(composer) : null
      const inputAreaOwnDivider =
        px(inputStyle.borderTopWidth) > 0 ||
        inputStyle.boxShadow !== 'none' ||
        inputStyle.backgroundImage !== 'none' ||
        hasPseudoPaint(getComputedStyle(inputArea, '::before')) ||
        hasPseudoPaint(getComputedStyle(inputArea, '::after'))

      return {
        state,
        contract: inputArea.getAttribute('data-layout-contract'),
        separatorCount,
        inputAreaOwnDivider,
        composerOwnBorder: Boolean(
          composerStyle &&
            Math.max(
              px(composerStyle.borderTopWidth),
              px(composerStyle.borderRightWidth),
              px(composerStyle.borderBottomWidth),
              px(composerStyle.borderLeftWidth),
            ) > 0,
        ),
        composerOwnRadius: Boolean(composerStyle && px(composerStyle.borderTopLeftRadius) > 0),
        footerInsideMessage: !requireFooter || Boolean(footer?.closest('.hc-msg')),
        footerBeforeComposer:
          !requireFooter ||
          Boolean(footer && footer.getBoundingClientRect().bottom <= inputRect.top + 1),
        messagesNodeStable,
        bottomAnchorStable,
        bottomAnchorInsideMessages: Boolean(
          messages && bottomAnchor && messages.contains(bottomAnchor),
        ),
        messagesScrollable:
          Boolean(messages) && ['auto', 'scroll'].includes(getComputedStyle(messages).overflowY),
      }
    },
    { state, requireFooter },
  )
}

test('BUG-20260726-030 keeps the shared composer seam divider-free across ordinary, K12, lifecycle and restore projections', async ({
  page,
}) => {
  await installBug030Boundary(page)
  await page.goto('/chat')
  await expect(page.locator('.hc-chat')).toBeVisible({ timeout: 20_000 })

  const snapshots: DividerSnapshot[] = []

  await selectSession(page, 's-streaming')
  snapshots.push(await captureDividerSnapshot(page, 'ordinary:streaming', false))

  await selectSession(page, 's-pending')
  snapshots.push(await captureDividerSnapshot(page, 'ordinary:pending', false))

  await selectSession(page, 's-completed')
  await expect(page.getByText('普通完成回复', { exact: true })).toBeVisible()
  snapshots.push(await captureDividerSnapshot(page, 'ordinary:completed', true))

  await selectSession(page, 's-failed')
  await expect(page.getByText('模型服务暂时不可用，请重试。', { exact: true })).toBeVisible()
  snapshots.push(await captureDividerSnapshot(page, 'ordinary:failed', true))

  await selectSession(page, 's-completed')
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('hexclaw_lastSessionId')))
    .toBe('s-completed')
  await page.reload()
  await expect(page.locator('[data-session-id="s-completed"]')).toHaveClass(
    /hc-sessions__item--active/,
  )
  await expect(page.getByText('普通完成回复', { exact: true })).toBeVisible()
  snapshots.push(await captureDividerSnapshot(page, 'ordinary:session-restore', true))

  await page.evaluate(() => localStorage.setItem('hexclaw_lastSessionId', 's-k12'))
  await page.goto(
    `/chat?role=${encodeURIComponent(k12Agent)}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
  )
  await expect(page.locator('.k12enh-seg')).toBeVisible()
  await expect(page.locator('.hc-chat__input-area')).toBeVisible()
  await expect(page.getByText('你好，我是小明的辅导助手。', { exact: true })).toBeVisible()
  snapshots.push(await captureDividerSnapshot(page, 'k12:completed', true))

  expect(
    snapshots.map(
      ({
        state,
        separatorCount,
        inputAreaOwnDivider,
        composerOwnBorder,
        composerOwnRadius,
        footerInsideMessage,
        footerBeforeComposer,
        messagesNodeStable,
        bottomAnchorStable,
        bottomAnchorInsideMessages,
        messagesScrollable,
      }) => ({
        state,
        separatorCount,
        inputAreaOwnDivider,
        composerOwnBorder,
        composerOwnRadius,
        footerInsideMessage,
        footerBeforeComposer,
        messagesNodeStable,
        bottomAnchorStable,
        bottomAnchorInsideMessages,
        messagesScrollable,
      }),
    ),
  ).toEqual(
    snapshots.map(({ state }) => ({
      state,
      separatorCount: 0,
      inputAreaOwnDivider: false,
      composerOwnBorder: true,
      composerOwnRadius: true,
      footerInsideMessage: true,
      footerBeforeComposer: true,
      messagesNodeStable: true,
      bottomAnchorStable: true,
      bottomAnchorInsideMessages: true,
      messagesScrollable: true,
    })),
  )

  // Permanent structural identity: deliberately RED on unchanged production until
  // the shared ChatView layout owner exposes the already-approved contract.
  expect(snapshots.map(({ state, contract }) => ({ state, contract }))).toEqual(
    snapshots.map(({ state }) => ({
      state,
      contract: 'shared-chat-composer-no-divider',
    })),
  )
})
