import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const SESSION_ID = 'e2e-math-session'
const NOW = '2026-07-23T08:00:00.000Z'
const EXACT_SOURCE = String.raw`$1\frac{1}{2} \times \frac{2}{3} =$$2\frac{1}{4} \div \frac{9}{8} =$`
const EXACT_FORMULAS = [
  String.raw`1\frac{1}{2} \times \frac{2}{3} =`,
  String.raw`2\frac{1}{4} \div \frac{9}{8} =`,
] as const
const LONG_SOURCE = String.raw`$\displaystyle \frac{1}{2}+\frac{2}{3}+\frac{3}{4}+\frac{4}{5}+\frac{5}{6}+\frac{6}{7}+\frac{7}{8}+\frac{8}{9}+\frac{9}{10}+\frac{10}{11}=x$`

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  created_at: string
  metadata?: Record<string, unknown>
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installMathHistoryBackend(page: Page, messages: MessageRow[]) {
  await page.addInitScript((sessionId) => {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', sessionId)
  }, SESSION_ID)

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()

    if (path === '/health') return json(route, { status: 'healthy' })
    if (path === '/api/v1/config/llm') {
      return json(route, {
        default: 'E2E Provider',
        providers: {
          'E2E Provider': {
            api_key: 'e2e-only',
            base_url: 'http://127.0.0.1:18080/v1',
            model: 'e2e-math-model',
            models: ['e2e-math-model'],
            enabled: true,
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.88, ttl: '24h', max_entries: 1000 },
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, model_count: 0, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [] })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (path === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (method === 'GET' && path === '/api/v1/sessions') {
      return json(route, {
        sessions: [
          {
            id: SESSION_ID,
            title: '数学公式真实组件回归',
            user_id: 'desktop-user',
            created_at: NOW,
            updated_at: NOW,
            message_count: messages.length,
          },
        ],
        total: 1,
      })
    }
    if (method === 'GET' && path === `/api/v1/sessions/${SESSION_ID}/messages`) {
      return json(route, { messages, total: messages.length })
    }

    return json(route, {})
  })
}

async function installTauriMathBackend(
  page: Page,
  messages: MessageRow[],
  receivedSources: string[],
) {
  await page.exposeFunction(
    'e2eMathBackendChat',
    (params: { message?: unknown; session_id?: unknown; request_id?: unknown }) => {
      const source = String(params.message ?? '')
      const sessionId = String(params.session_id ?? SESSION_ID)
      const requestId = String(params.request_id ?? `e2e-request-${messages.length}`)
      const timestamp = new Date().toISOString()
      receivedSources.push(source)
      messages.push(
        {
          id: `${requestId}-user`,
          role: 'user',
          content: source,
          timestamp,
          created_at: timestamp,
        },
        {
          id: `${requestId}-assistant`,
          role: 'assistant',
          content: source,
          timestamp,
          created_at: timestamp,
          metadata: { provider: 'E2E Provider', model: 'e2e-math-model' },
        },
      )
      return JSON.stringify({
        reply: source,
        session_id: sessionId,
        metadata: { provider: 'E2E Provider', model: 'e2e-math-model' },
      })
    },
  )

  await page.addInitScript(() => {
    class RejectedWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3

      readonly url: string
      readyState = RejectedWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        queueMicrotask(() => {
          this.readyState = RejectedWebSocket.CLOSED
          const event = new Event('error')
          this.onerror?.(event)
          this.dispatchEvent(event)
        })
      }

      send() {}

      close() {
        this.readyState = RejectedWebSocket.CLOSED
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: RejectedWebSocket,
    })

    const callbacks: Record<number, (...args: unknown[]) => void> = {}
    let nextCallbackId = 1
    ;(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {},
    }
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: {},
      transformCallback(callback: (...args: unknown[]) => void) {
        const id = nextCallbackId++
        callbacks[id] = callback
        return id
      },
      unregisterCallback(id: number) {
        delete callbacks[id]
      },
      convertFileSrc(path: string) {
        return path
      },
      async invoke(cmd: string, args?: Record<string, unknown>) {
        if (cmd === 'plugin:event|listen') return nextCallbackId++
        if (cmd === 'plugin:event|unlisten') return null
        if (cmd === 'plugin:event|emit') return null
        if (cmd === 'check_engine_health') return true
        if (cmd === 'get_sidecar_status') {
          return {
            ready: true,
            base_url: `${window.location.origin}/_hexclaw`,
            port: 0,
          }
        }
        if (cmd === 'backend_chat') {
          return (
            window as unknown as {
              e2eMathBackendChat: (params: Record<string, unknown>) => Promise<string>
            }
          ).e2eMathBackendChat((args?.params ?? {}) as Record<string, unknown>)
        }
        return null
      },
    }
  })
}

function renderedFormulaAnnotations(row: Locator) {
  return row.locator('.hc-math-inline annotation[encoding="application/x-tex"]')
}

async function expectTwoAtomicFormulas(row: Locator) {
  const wrappers = row.locator('.hc-math-inline')
  await expect(wrappers).toHaveCount(2)
  await expect(renderedFormulaAnnotations(row)).toHaveText([...EXACT_FORMULAS])
  await expect(row.locator('.hc-math-inline .katex-mathml')).toHaveCount(2)

  const geometry = await row.evaluate((element) => {
    const host =
      element.querySelector<HTMLElement>('.hc-msg__text') ??
      element.querySelector<HTMLElement>('.markdown-body')
    const formulas = Array.from(element.querySelectorAll<HTMLElement>('.hc-math-inline'))
    if (!host || formulas.length !== 2) throw new Error('real formula surface is incomplete')
    const hostRect = host.getBoundingClientRect()
    const first = formulas[0]!
    const second = formulas[1]!
    const measurements = formulas.map((formula) => {
      const rect = formula.getBoundingClientRect()
      const maxScrollLeft = Math.max(0, formula.scrollWidth - formula.clientWidth)
      formula.scrollLeft = formula.scrollWidth
      const reachedEnd = Math.abs(formula.scrollLeft - maxScrollLeft) <= 1
      formula.scrollLeft = 0
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        clientWidth: formula.clientWidth,
        scrollWidth: formula.scrollWidth,
        maxScrollLeft,
        reachedEnd,
      }
    })
    return {
      hostLeft: hostRect.left,
      hostRight: hostRect.right,
      hostWidth: hostRect.width,
      adjacent: first.nextElementSibling === second,
      measurements,
    }
  })

  expect(geometry.adjacent).toBe(true)
  for (const formula of geometry.measurements) {
    expect(formula.left).toBeGreaterThanOrEqual(geometry.hostLeft - 1)
    expect(formula.right).toBeLessThanOrEqual(geometry.hostRight + 1)
    expect(formula.width).toBeLessThanOrEqual(geometry.hostWidth + 1)
    expect(formula.scrollWidth).toBeGreaterThanOrEqual(formula.clientWidth)
    expect(formula.reachedEnd).toBe(true)
  }
}

test('real /chat send and history replay keep adjacent user and assistant formulas intact in WebKit', async ({
  page,
  browserName,
}) => {
  const persistedMessages: MessageRow[] = []
  const receivedSources: string[] = []
  await installMathHistoryBackend(page, persistedMessages)
  await installTauriMathBackend(page, persistedMessages, receivedSources)

  await page.setViewportSize({ width: 520, height: 900 })
  await page.goto('/chat')
  const input = page.getByTestId('chat-input')
  await expect(input).toBeVisible()
  await input.fill(EXACT_SOURCE)
  await page.getByTestId('chat-send').click()

  const userRow = page.getByTestId('chat-message-user').last()
  const assistantRow = page.getByTestId('chat-message-assistant').last()
  await expectTwoAtomicFormulas(userRow)
  await expectTwoAtomicFormulas(assistantRow)
  expect(receivedSources).toEqual([EXACT_SOURCE])
  expect(persistedMessages.map((message) => message.content)).toEqual([
    EXACT_SOURCE,
    EXACT_SOURCE,
  ])

  await page.reload()
  const replayedUser = page.getByTestId('chat-message-user').last()
  const replayedAssistant = page.getByTestId('chat-message-assistant').last()
  await expectTwoAtomicFormulas(replayedUser)
  await expectTwoAtomicFormulas(replayedAssistant)
  await page.screenshot({
    path: `test-results/bug-20260723-math-${browserName}-runtime.png`,
    fullPage: true,
  })
})

test('real overflowing formulas become local keyboard scroll regions in WebKit', async ({ page }) => {
  const persistedMessages: MessageRow[] = []
  const receivedSources: string[] = []
  await installMathHistoryBackend(page, persistedMessages)
  await installTauriMathBackend(page, persistedMessages, receivedSources)

  await page.setViewportSize({ width: 520, height: 900 })
  await page.goto('/chat')
  await page.getByTestId('chat-input').fill(LONG_SOURCE)
  await page.getByTestId('chat-send').click()

  for (const row of [
    page.getByTestId('chat-message-user').last(),
    page.getByTestId('chat-message-assistant').last(),
  ]) {
    const formula = row.locator('.hc-math-inline')
    await expect(formula).toHaveCount(1)
    await expect(formula).toHaveAttribute('tabindex', '0')
    await expect.poll(
      () => formula.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeGreaterThan(0)

    await formula.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => formula.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  }

  expect(receivedSources).toEqual([LONG_SOURCE])
})
