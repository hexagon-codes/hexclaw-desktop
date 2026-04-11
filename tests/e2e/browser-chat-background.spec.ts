import { test, expect, type Page, type Route } from '@playwright/test'

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
}

const now = '2026-04-08T10:00:00.000Z'

const initialSessions: SessionRow[] = [
  { id: 's-active', title: '当前会话', created_at: now, updated_at: now, message_count: 2 },
  { id: 's-bg', title: '后台生成会话', created_at: now, updated_at: now, message_count: 1 },
]

const moreSessions: SessionRow[] = [
  { id: 's-more', title: '更早的会话', created_at: '2026-04-06T10:00:00.000Z', updated_at: '2026-04-06T10:00:00.000Z', message_count: 1 },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installMockBackend(page: Page) {
  const messagesBySession = new Map<string, MessageRow[]>([
    ['s-active', [
      { id: 'm-active-user', role: 'user', content: '当前会话问题', timestamp: now, created_at: now },
      { id: 'm-active-assistant', role: 'assistant', content: '当前会话回答', timestamp: now, created_at: now },
    ]],
    ['s-bg', [
      { id: 'm-bg-user', role: 'user', content: '后台会话问题', timestamp: now, created_at: now },
    ]],
  ])

  await page.exposeFunction('e2ePersistAssistant', (sessionId: string, content: string) => {
    const rows = messagesBySession.get(sessionId) ?? []
    rows.push({
      id: `m-${sessionId}-assistant-final`,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    messagesBySession.set(sessionId, rows)
  })

  await page.addInitScript(() => {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', 's-bg')
    localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify(['s-active']))

    class MockWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      url: string
      readyState = MockWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(url: string) {
        super()
        this.url = url
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
        }, 0)
      }

      send(raw: string) {
        const payload = JSON.parse(raw) as { type?: string; session_id?: string; request_id?: string }
        if (payload.type === 'resume' && payload.session_id === 's-bg' && payload.request_id === 'req-bg') {
          this.emit({
            type: 'stream_snapshot',
            session_id: 's-bg',
            request_id: 'req-bg',
            content: '后台生成中',
            done: false,
            metadata: { provider: 'MockProvider', model: 'mock-chat' },
          }, 20)
          this.emit({
            type: 'chunk',
            session_id: 's-bg',
            request_id: 'req-bg',
            content: '，继续生成',
            done: false,
            metadata: { provider: 'MockProvider', model: 'mock-chat' },
          }, 80)
          setTimeout(() => {
            const content = '后台生成完成'
            void (window as unknown as { e2ePersistAssistant?: (sessionId: string, content: string) => Promise<void> })
              .e2ePersistAssistant?.('s-bg', content)
            this.dispatchMessage({
              type: 'reply',
              session_id: 's-bg',
              request_id: 'req-bg',
              content,
              metadata: { provider: 'MockProvider', model: 'mock-chat' },
            })
          }, 2_000)
          return
        }

        if (payload.type === 'message') {
          const sessionId = payload.session_id ?? 's-active'
          this.emit({
            type: 'reply',
            session_id: sessionId,
            request_id: payload.request_id,
            content: '新消息回复完成',
            metadata: { provider: 'MockProvider', model: 'mock-chat' },
          }, 60)
        }
      }

      close() {
        if (this.readyState === MockWebSocket.CLOSED) return
        this.readyState = MockWebSocket.CLOSED
        const event = new CloseEvent('close')
        this.onclose?.(event)
        this.dispatchEvent(event)
      }

      private emit(payload: Record<string, unknown>, delay: number) {
        setTimeout(() => this.dispatchMessage(payload), delay)
      }

      private dispatchMessage(payload: Record<string, unknown>) {
        if (this.readyState !== MockWebSocket.OPEN) return
        const event = new MessageEvent('message', { data: JSON.stringify(payload) })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    })
  })

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path === '/api/v1/config/llm') {
      return json(route, {
        default: 'Ollama (本地)',
        providers: {
          'Ollama (本地)': {
            api_key: '',
            base_url: 'http://127.0.0.1:11434/v1',
            model: 'qwen3.5:9b',
            models: ['qwen3.5:9b'],
            compatible: '',
            tools_enabled: null,
            max_tools: 0,
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.88, ttl: '24h', max_entries: 1000 },
      })
    }

    if (path === '/api/v1/ollama/status') {
      return json(route, {
        running: true,
        version: 'e2e',
        associated: true,
        model_count: 1,
        models: [{ name: 'qwen3.5:9b', size: 1, modified: now }],
      })
    }

    if (path === '/api/v1/roles') return json(route, { roles: [] })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })

    if (path === '/api/v1/streams/active') {
      return json(route, {
        streams: [{
          request_id: 'req-bg',
          session_id: 's-bg',
          user_id: 'desktop-user',
          content: '后台生成中',
          done: false,
          status: 'streaming',
          metadata: { provider: 'MockProvider', model: 'mock-chat' },
          started_at: now,
          updated_at: now,
        }],
        total: 1,
      })
    }

    const messageMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
    if (method === 'GET' && messageMatch) {
      const sessionId = decodeURIComponent(messageMatch[1] ?? '')
      const messages = messagesBySession.get(sessionId) ?? []
      return json(route, { messages, total: messages.length })
    }

    if (method === 'GET' && path === '/api/v1/sessions') {
      const offset = Number(requestUrl.searchParams.get('offset') ?? '0')
      const rows = offset > 0 ? moreSessions : initialSessions
      return json(route, { sessions: rows, total: initialSessions.length + moreSessions.length })
    }

    if (method === 'GET' && path === '/api/v1/messages/search') {
      return json(route, {
        query: requestUrl.searchParams.get('q') ?? '',
        total: 1,
        results: [{
          session_title: '搜索命中的会话',
          rank: 1,
          message: {
            id: 'm-found',
            session_id: 's-found',
            role: 'assistant',
            content: '这是跨会话搜索命中的片段',
            timestamp: now,
            created_at: now,
          },
        }],
      })
    }

    return json(route, {})
  })
}

test('browser restores background stream, keeps session state isolated, and supports session history controls', async ({ page }) => {
  await installMockBackend(page)

  await page.goto('/chat')

  await expect(page.locator('[data-session-id="s-active"]')).toContainText('当前会话')
  await expect(page.locator('[data-session-id="s-bg"]')).toContainText('后台生成会话')
  await expect(page.locator('[data-session-id="s-active"].hc-sessions__item--pinned')).toBeVisible()
  await expect(page.locator('[data-session-id="s-bg"] .hc-sessions__spinner')).toBeVisible()

  await page.locator('[data-session-id="s-active"]').click()
  await expect(page.locator('.hc-chat__thread')).toContainText('当前会话回答')
  await expect(page.locator('.hc-chat__thread')).not.toContainText('后台生成完成')

  await expect(page.locator('[data-session-id="s-bg"] .hc-sessions__spinner')).toBeHidden({ timeout: 5_000 })

  await page.locator('[data-session-id="s-bg"]').click()
  await expect(page.locator('.hc-chat__thread')).toContainText('后台生成完成')

  await page.locator('.hc-sessions__filter-toggle').click()
  await page.locator('.hc-sessions__filter-input').fill('命中')
  await expect(page.locator('.hc-sessions__snippet')).toContainText('跨会话搜索命中的片段')

  await page.locator('.hc-sessions__filter-toggle').click()
  await page.locator('.hc-sessions__load-more').click()
  await expect(page.locator('[data-session-id="s-more"]')).toContainText('更早的会话')
})
