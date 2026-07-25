import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const SESSION_ID = 'e2e-math-session'
const NOW = '2026-07-23T08:00:00.000Z'
const EXACT_SOURCE = String.raw`$1\frac{1}{2} \times \frac{2}{3} =$$2\frac{1}{4} \div \frac{9}{8} =$`
const EXACT_FORMULAS = [
  String.raw`1\frac{1}{2} \times \frac{2}{3} =`,
  String.raw`2\frac{1}{4} \div \frac{9}{8} =`,
] as const
const EDITED_SECOND_FORMULA = String.raw`2\frac{1}{4} \div \frac{7}{8} =`
const CANCELLED_SECOND_FORMULA = String.raw`2\frac{1}{4} \div \frac{9}{10} =`
const EDITED_SOURCE = [EXACT_FORMULAS[0], EDITED_SECOND_FORMULA]
  .map((formula) => `$${formula}$`)
  .join('')
const LONG_SOURCE = String.raw`$\displaystyle \frac{1}{2}+\frac{2}{3}+\frac{3}{4}+\frac{4}{5}+\frac{5}{6}+\frac{6}{7}+\frac{7}{8}+\frac{8}{9}+\frac{9}{10}+\frac{10}{11}=x$`
const EDIT_EDGE_SOURCE = `A ${String.raw`\(x\)`} B $$\ny\n$$ C`
const DESKTOP_MIN_VIEWPORT = { width: 900, height: 900 } as const

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  created_at: string
  metadata?: Record<string, unknown>
}

type SessionRow = {
  id: string
  title: string
  user_id: string
  parent_session_id?: string
  branch_message_id?: string
  created_at: string
  updated_at: string
}

type ForkRequestEvidence = {
  sourceSessionId: string
  branchSessionId: string
  messageId: string
  includeMessage: boolean
}

type DeliveryEvidence = {
  sessionId: string
  requestId: string
  source: string
}

type MathBackendState = {
  sessions: Map<string, SessionRow>
  messagesBySession: Map<string, MessageRow[]>
  receivedSources: string[]
  forkRequests: ForkRequestEvidence[]
  deliveries: DeliveryEvidence[]
  nextBranchNumber: number
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function createMathBackendState(
  sourceMessages: MessageRow[],
  receivedSources: string[],
): MathBackendState {
  return {
    sessions: new Map([
      [
        SESSION_ID,
        {
          id: SESSION_ID,
          title: '数学公式真实组件回归',
          user_id: 'desktop-user',
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    ]),
    messagesBySession: new Map([[SESSION_ID, sourceMessages]]),
    receivedSources,
    forkRequests: [],
    deliveries: [],
    nextBranchNumber: 0,
  }
}

function sessionResponse(state: MathBackendState, session: SessionRow) {
  return {
    ...session,
    message_count: state.messagesBySession.get(session.id)?.length ?? 0,
  }
}

async function installMathHistoryBackend(page: Page, state: MathBackendState) {
  await page.addInitScript((sessionId) => {
    if (!sessionStorage.getItem('hexclaw:welcomeRedirectDone')) {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    }
    if (!localStorage.getItem('hexclaw_lastSessionId')) {
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
    }
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
      const sessions = [...state.sessions.values()].map((session) => sessionResponse(state, session))
      return json(route, {
        sessions,
        total: sessions.length,
      })
    }
    const messagesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
    if (method === 'GET' && messagesMatch) {
      const sessionId = decodeURIComponent(messagesMatch[1]!)
      const messages = state.messagesBySession.get(sessionId)
      if (!messages) return json(route, { error: 'session not found' }, 404)
      return json(route, { messages, total: messages.length })
    }
    const branchesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/branches$/)
    if (method === 'GET' && branchesMatch) {
      const sourceSessionId = decodeURIComponent(branchesMatch[1]!)
      const branches = [...state.sessions.values()]
        .filter((session) => session.parent_session_id === sourceSessionId)
        .map((session) => sessionResponse(state, session))
      return json(route, { branches, total: branches.length })
    }
    const forkMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/fork$/)
    if (method === 'POST' && forkMatch) {
      const sourceSessionId = decodeURIComponent(forkMatch[1]!)
      const sourceSession = state.sessions.get(sourceSessionId)
      const sourceMessages = state.messagesBySession.get(sourceSessionId)
      if (!sourceSession || !sourceMessages) {
        return json(route, { error: 'session not found' }, 404)
      }

      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
      const messageId = typeof body.message_id === 'string' ? body.message_id : ''
      const includeMessage = body.include_message !== false
      const messageIndex = messageId
        ? sourceMessages.findIndex((message) => message.id === messageId)
        : sourceMessages.length - 1
      if (messageId && messageIndex < 0) {
        return json(route, { error: 'message not found' }, 404)
      }

      const branchSessionId = `e2e-math-branch-${++state.nextBranchNumber}`
      const prefixEnd = messageIndex < 0 ? 0 : messageIndex + (includeMessage ? 1 : 0)
      const branchMessages = sourceMessages
        .slice(0, prefixEnd)
        .map((message) => ({ ...message, metadata: { ...message.metadata } }))
      const branch: SessionRow = {
        id: branchSessionId,
        title: `${sourceSession.title}（分支 ${state.nextBranchNumber}）`,
        user_id: sourceSession.user_id,
        parent_session_id: sourceSessionId,
        ...(messageId ? { branch_message_id: messageId } : {}),
        created_at: NOW,
        updated_at: NOW,
      }
      state.sessions.set(branchSessionId, branch)
      state.messagesBySession.set(branchSessionId, branchMessages)
      state.forkRequests.push({
        sourceSessionId,
        branchSessionId,
        messageId,
        includeMessage,
      })
      return json(route, {
        session: sessionResponse(state, branch),
        message: 'session forked',
      })
    }
    const deleteSessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)
    if (method === 'DELETE' && deleteSessionMatch) {
      const sessionId = decodeURIComponent(deleteSessionMatch[1]!)
      if (!state.sessions.has(sessionId)) {
        return json(route, { error: 'session not found' }, 404)
      }
      state.sessions.delete(sessionId)
      state.messagesBySession.delete(sessionId)
      return json(route, { message: 'session deleted' })
    }

    return json(route, {})
  })
}

async function installTauriMathBackend(
  page: Page,
  state: MathBackendState,
) {
  await page.exposeFunction(
    'e2eMathBackendChat',
    (params: { message?: unknown; session_id?: unknown; request_id?: unknown }) => {
      const source = String(params.message ?? '')
      const sessionId = String(params.session_id ?? SESSION_ID)
      const messages = state.messagesBySession.get(sessionId)
      if (!messages) throw new Error(`unknown E2E math session: ${sessionId}`)
      const requestId = String(params.request_id ?? `e2e-request-${messages.length}`)
      const timestamp = new Date().toISOString()
      state.receivedSources.push(source)
      state.deliveries.push({ sessionId, requestId, source })
      messages.push(
        {
          id: requestId,
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

type InkRole = 'numerator' | 'fraction-line' | 'denominator'

type InkVisibility = {
  role: InkRole
  width: number
  height: number
  horizontalRatio: number
  verticalRatio: number
  clippedBy: string[]
}

async function measureFractionInk(fraction: Locator): Promise<InkVisibility[]> {
  return fraction.evaluate((fractionElement) => {
    type Rect = {
      left: number
      right: number
      top: number
      bottom: number
      width: number
      height: number
    }

    function rectOf(element: Element): Rect {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }

    function union(elements: Element[]): Rect {
      const rects = elements.map(rectOf).filter((rect) => rect.width > 0 && rect.height > 0)
      if (rects.length === 0) throw new Error('KaTeX fraction slot has no measurable ink')
      const left = Math.min(...rects.map((rect) => rect.left))
      const right = Math.max(...rects.map((rect) => rect.right))
      const top = Math.min(...rects.map((rect) => rect.top))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      return { left, right, top, bottom, width: right - left, height: bottom - top }
    }

    function clips(value: string): boolean {
      return value !== 'visible'
    }

    function visibility(rect: Rect, anchor: Element) {
      let visibleLeft = rect.left
      let visibleRight = rect.right
      let visibleTop = rect.top
      let visibleBottom = rect.bottom
      const clippedBy = new Set<string>()

      for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        const ancestorRect = ancestor.getBoundingClientRect()
        const label =
          ancestor.id || Array.from(ancestor.classList).join('.') || ancestor.tagName.toLowerCase()

        if (clips(style.overflowX)) {
          visibleLeft = Math.max(visibleLeft, ancestorRect.left)
          visibleRight = Math.min(visibleRight, ancestorRect.right)
          clippedBy.add(label)
        }
        if (clips(style.overflowY)) {
          visibleTop = Math.max(visibleTop, ancestorRect.top)
          visibleBottom = Math.min(visibleBottom, ancestorRect.bottom)
          clippedBy.add(label)
        }
      }

      const visibleWidth = Math.max(0, visibleRight - visibleLeft)
      const visibleHeight = Math.max(0, visibleBottom - visibleTop)
      return {
        horizontalRatio: rect.width > 0 ? visibleWidth / rect.width : 0,
        verticalRatio: rect.height > 0 ? visibleHeight / rect.height : 0,
        clippedBy: [...clippedBy],
      }
    }

    const line = fractionElement.querySelector<HTMLElement>('.frac-line')
    const vlist = line?.parentElement?.parentElement
    if (!line || !vlist?.classList.contains('vlist')) {
      throw new Error('KaTeX fraction line/vlist structure is incomplete')
    }

    const positionedSlots = Array.from(vlist.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    )
    const numericSlots = positionedSlots
      .filter((slot) => !slot.contains(line))
      .map((slot) => {
        const deepestMathOrd = Array.from(slot.querySelectorAll<HTMLElement>('.mord')).filter(
          (candidate) => !candidate.querySelector('.mord'),
        )
        return {
          slot,
          rect: union(deepestMathOrd.length > 0 ? deepestMathOrd : [slot]),
        }
      })
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)

    const lineRect = rectOf(line)
    const lineCenter = (lineRect.top + lineRect.bottom) / 2
    const numerator = numericSlots
      .filter(({ rect }) => (rect.top + rect.bottom) / 2 < lineCenter)
      .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]
    const denominator = numericSlots
      .filter(({ rect }) => (rect.top + rect.bottom) / 2 > lineCenter)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!numerator || !denominator) {
      throw new Error('KaTeX numerator/denominator ink could not be classified')
    }

    const measurements: Array<{ role: InkRole; rect: Rect; anchor: Element }> = [
      { role: 'numerator', rect: numerator.rect, anchor: numerator.slot },
      { role: 'fraction-line', rect: lineRect, anchor: line },
      { role: 'denominator', rect: denominator.rect, anchor: denominator.slot },
    ]
    return measurements.map(({ role, rect, anchor }) => ({
      role,
      width: rect.width,
      height: rect.height,
      ...visibility(rect, anchor),
    }))
  })
}

async function expectFractionInkVisible(fraction: Locator) {
  const measurements = await measureFractionInk(fraction)
  expect(measurements.map(({ role }) => role)).toEqual([
    'numerator',
    'fraction-line',
    'denominator',
  ])
  for (const ink of measurements) {
    expect(ink.width, `${ink.role} must have measurable width`).toBeGreaterThan(0)
    expect(ink.height, `${ink.role} must have measurable height`).toBeGreaterThan(0)
    expect(
      ink.horizontalRatio,
      `${ink.role} is horizontally clipped by ${ink.clippedBy.join(', ') || 'an unknown box'}`,
    ).toBeGreaterThanOrEqual(0.98)
    expect(
      ink.verticalRatio,
      `${ink.role} is vertically clipped by ${ink.clippedBy.join(', ') || 'an unknown box'}`,
    ).toBeGreaterThanOrEqual(0.98)
  }
}

async function expectAllFractionInkVisible(formula: Locator) {
  const fractions = formula.locator('.katex-html .mfrac')
  const count = await fractions.count()
  expect(count, 'formula must contain at least one rendered fraction').toBeGreaterThan(0)
  for (let index = 0; index < count; index += 1) {
    await expectFractionInkVisible(fractions.nth(index))
  }
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
      const viewport = formula.querySelector<HTMLElement>(
        ':scope > .hc-math-viewport.hc-math-viewport--inline',
      )
      if (!viewport) throw new Error('formula has no dedicated inline viewport')
      const rect = formula.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        shellOverflowX: getComputedStyle(formula).overflowX,
        shellOverflowY: getComputedStyle(formula).overflowY,
        viewportClientWidth: viewport.clientWidth,
        viewportScrollWidth: viewport.scrollWidth,
        viewportScrollable: viewport.classList.contains('hc-math-viewport--scrollable'),
        viewportTabIndex: viewport.getAttribute('tabindex'),
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
    expect(formula.shellOverflowX).toBe('visible')
    expect(formula.shellOverflowY).toBe('visible')
    expect(formula.viewportScrollWidth).toBeLessThanOrEqual(formula.viewportClientWidth + 1)
    expect(formula.viewportScrollable).toBe(false)
    expect(formula.viewportTabIndex).toBeNull()
  }
  for (let index = 0; index < 2; index += 1) {
    await expectAllFractionInkVisible(wrappers.nth(index))
  }
}

test('real /chat send and history replay keep adjacent user and assistant formulas intact in WebKit', async ({
  page,
  browserName,
}) => {
  const persistedMessages: MessageRow[] = []
  const receivedSources: string[] = []
  const backend = createMathBackendState(persistedMessages, receivedSources)
  await installMathHistoryBackend(page, backend)
  await installTauriMathBackend(page, backend)

  await page.setViewportSize(DESKTOP_MIN_VIEWPORT)
  await page.goto('/chat')
  const input = page.getByTestId('chat-input')
  await expect(input).toBeVisible()
  await input.focus()
  await input.evaluate((element, source) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', source)
    clipboardData.setData(
      'text/html',
      '<math><semantics><mfrac><mn>1</mn><mn>2</mn></mfrac>'
        + '<annotation encoding="application/x-tex">1\\frac{1}{2}</annotation>'
        + '</semantics></math>',
    )
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
  }, EXACT_SOURCE)
  await expect(input).toHaveAttribute('data-canonical-source', EXACT_SOURCE)
  await expect(input.locator('[data-edit-math-state="rendered"]')).toHaveCount(2)
  await expect(input.locator('annotation[encoding="application/x-tex"]')).toHaveText([
    ...EXACT_FORMULAS,
  ])
  const composerProjection = await input.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.katex-mathml, annotation').forEach((node) => node.remove())
    return clone.textContent ?? ''
  })
  expect(composerProjection).not.toContain(String.raw`\frac`)
  await page.screenshot({
    path: `tests/e2e/screenshots/current-source/bug-20260723-math-composer-${browserName}-runtime.png`,
    fullPage: true,
  })
  await page.getByTestId('chat-send').click()

  const userRow = page.getByTestId('chat-message-user').last()
  const assistantRow = page.getByTestId('chat-message-assistant').last()
  await expectTwoAtomicFormulas(userRow)
  await expectTwoAtomicFormulas(assistantRow)
  expect(receivedSources).toEqual([EXACT_SOURCE])
  expect(persistedMessages.map((message) => message.content)).toEqual([EXACT_SOURCE, EXACT_SOURCE])

  await page.reload()
  const replayedUser = page.getByTestId('chat-message-user').last()
  const replayedAssistant = page.getByTestId('chat-message-assistant').last()
  await expectTwoAtomicFormulas(replayedUser)
  await expectTwoAtomicFormulas(replayedAssistant)
  await page.screenshot({
    path: `tests/e2e/screenshots/current-source/bug-20260723-math-${browserName}-runtime.png`,
    fullPage: true,
  })
})

test('editing a real user message keeps formulas rendered until one canonical source is activated', async ({
  page,
}) => {
  const persistedMessages: MessageRow[] = []
  const receivedSources: string[] = []
  const backend = createMathBackendState(persistedMessages, receivedSources)
  await installMathHistoryBackend(page, backend)
  await installTauriMathBackend(page, backend)

  await page.setViewportSize(DESKTOP_MIN_VIEWPORT)
  await page.goto('/chat')
  await page.getByTestId('chat-input').fill(EXACT_SOURCE)
  await page.getByTestId('chat-send').click()

  const userRow = page.getByTestId('chat-message-user').last()
  await userRow.hover()
  await userRow.getByRole('button', { name: '编辑消息' }).click()
  const editCard = userRow.locator('.hc-msg__edit-card')
  const editor = editCard.getByTestId('message-math-editor')

  await expect(editCard.locator('textarea')).toHaveCount(0)
  await expect(editor).toHaveAttribute('data-canonical-source', EXACT_SOURCE)
  await expect(editor.locator('[data-edit-math-state="rendered"]')).toHaveCount(2)
  await expect(editor.locator('annotation[encoding="application/x-tex"]')).toHaveText([
    ...EXACT_FORMULAS,
  ])
  const initiallyRendered = editor.locator('[data-edit-math-state="rendered"]')
  await expectAllFractionInkVisible(initiallyRendered.nth(0))
  await expectAllFractionInkVisible(initiallyRendered.nth(1))
  const visibleProjection = await editor.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.katex-mathml, annotation').forEach((node) => node.remove())
    return clone.textContent ?? ''
  })
  expect(visibleProjection).not.toContain(String.raw`\frac`)

  await initiallyRendered
    .nth(1)
    .locator('.katex-html .mfrac')
    .first()
    .locator('.mord')
    .last()
    .click()
  await expect(editor.locator('[data-edit-math-state="rendered"]')).toHaveCount(1)
  await expect(editor.locator('[data-edit-math-state="source-active"]')).toHaveText(
    `$${EXACT_FORMULAS[1]}$`,
  )

  const activeSource = editor.locator('[data-edit-math-state="source-active"]')
  await activeSource.fill(`$${EDITED_SECOND_FORMULA}$`)
  await editCard.getByRole('button', { name: '取消' }).focus()
  await expect(editor).toHaveAttribute('data-canonical-source', EDITED_SOURCE)
  await expect(editor.locator('[data-edit-math-state="rendered"]')).toHaveCount(2)
  await expectAllFractionInkVisible(editor.locator('[data-edit-math-state="rendered"]').nth(0))
  await expectAllFractionInkVisible(editor.locator('[data-edit-math-state="rendered"]').nth(1))

  const firstFormula = editor.locator('[data-edit-math-state="rendered"]').first()
  await firstFormula.evaluate((formula) => {
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNode(formula)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const copied = await editor.evaluate((element) => {
    const clipboardData = new DataTransfer()
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    })
    element.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      text: clipboardData.getData('text/plain'),
    }
  })
  expect(copied).toEqual({
    defaultPrevented: true,
    text: `$${EXACT_FORMULAS[0]}$`,
  })

  const cut = await editor.evaluate((element) => {
    const clipboardData = new DataTransfer()
    const event = new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    })
    element.dispatchEvent(event)
    return {
      defaultPrevented: event.defaultPrevented,
      text: clipboardData.getData('text/plain'),
    }
  })
  expect(cut).toEqual({
    defaultPrevented: true,
    text: `$${EXACT_FORMULAS[0]}$`,
  })
  await expect(editor).toHaveAttribute('data-canonical-source', `$${EDITED_SECOND_FORMULA}$`)
  await editor.focus()
  await page.keyboard.press('Meta+z')
  await expect(editor).toHaveAttribute('data-canonical-source', EDITED_SOURCE)

  await editor
    .locator('[data-edit-math-state="rendered"]')
    .first()
    .evaluate((formula) => {
      const editorElement = formula.parentElement!
      const selection = window.getSelection()!
      const range = document.createRange()
      range.setStart(editorElement, Array.from(editorElement.childNodes).indexOf(formula) + 1)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      ;(editorElement as HTMLElement).focus()
    })
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveAttribute('data-canonical-source', `$${EDITED_SECOND_FORMULA}$`)
  await page.keyboard.press('Meta+z')
  await expect(editor).toHaveAttribute('data-canonical-source', EDITED_SOURCE)
  await page.keyboard.press('Meta+z')
  await expect(editor).toHaveAttribute('data-canonical-source', EXACT_SOURCE)

  await editor.evaluate(() => {
    ;(window as unknown as { e2eHistoryDefaultPrevented?: boolean }).e2eHistoryDefaultPrevented =
      false
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        ;(
          window as unknown as { e2eHistoryDefaultPrevented?: boolean }
        ).e2eHistoryDefaultPrevented = event.defaultPrevented
      }
    })
  })
  await page.keyboard.press('Meta+z')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { e2eHistoryDefaultPrevented?: boolean }).e2eHistoryDefaultPrevented,
    ),
  ).toBe(true)
  await expect(editor).toHaveAttribute('data-canonical-source', EXACT_SOURCE)

  await page.keyboard.press('Meta+Shift+z')
  await expect(editor).toHaveAttribute('data-canonical-source', EDITED_SOURCE)
  await editCard.getByRole('button', { name: '发送' }).click()
  await expect(userRow.locator('.hc-msg__edit-card')).toHaveCount(0)
  expect(receivedSources).toEqual([EXACT_SOURCE, EDITED_SOURCE])
  expect(backend.forkRequests).toHaveLength(1)
  const firstFork = backend.forkRequests[0]!
  expect(firstFork).toMatchObject({
    sourceSessionId: SESSION_ID,
    messageId: persistedMessages[0]!.id,
    includeMessage: false,
  })
  expect(backend.deliveries.at(-1)).toMatchObject({
    sessionId: firstFork.branchSessionId,
    source: EDITED_SOURCE,
  })
  expect(backend.messagesBySession.get(SESSION_ID)?.map((message) => message.content)).toEqual([
    EXACT_SOURCE,
    EXACT_SOURCE,
  ])
  expect(
    backend.messagesBySession.get(firstFork.branchSessionId)?.map((message) => message.content),
  ).toEqual([EDITED_SOURCE, EDITED_SOURCE])
  expect(backend.sessions.get(firstFork.branchSessionId)).toMatchObject({
    parent_session_id: SESSION_ID,
    branch_message_id: persistedMessages[0]!.id,
  })

  await page.reload()
  const replayedUser = page.getByTestId('chat-message-user').last()
  await expect(renderedFormulaAnnotations(replayedUser)).toHaveText([
    EXACT_FORMULAS[0],
    EDITED_SECOND_FORMULA,
  ])
  await expectAllFractionInkVisible(replayedUser.locator('.hc-math-inline').nth(0))
  await expectAllFractionInkVisible(replayedUser.locator('.hc-math-inline').nth(1))

  await replayedUser.hover()
  await replayedUser.getByRole('button', { name: '编辑消息' }).click()
  const cancelCard = replayedUser.locator('.hc-msg__edit-card')
  const cancelEditor = cancelCard.getByTestId('message-math-editor')
  await cancelEditor.locator('[data-edit-math-state="rendered"]').nth(1).click()
  await cancelEditor
    .locator('[data-edit-math-state="source-active"]')
    .fill(`$${CANCELLED_SECOND_FORMULA}$`)
  await cancelCard.getByRole('button', { name: '取消' }).click()

  await expect(replayedUser.locator('.hc-msg__edit-card')).toHaveCount(0)
  await expect(renderedFormulaAnnotations(replayedUser)).toHaveText([
    EXACT_FORMULAS[0],
    EDITED_SECOND_FORMULA,
  ])
  expect(receivedSources).toEqual([EXACT_SOURCE, EDITED_SOURCE])

  await replayedUser.hover()
  await replayedUser.getByRole('button', { name: '编辑消息' }).click()
  const clearCard = replayedUser.locator('.hc-msg__edit-card')
  const clearEditor = clearCard.getByTestId('message-math-editor')
  await clearEditor.locator('[data-edit-math-state="rendered"]').first().click()
  await clearCard.getByRole('button', { name: '清空输入内容' }).click()
  await expect(clearEditor).toHaveAttribute('data-canonical-source', '')
  await expect(clearEditor.locator('[data-edit-math-state]')).toHaveCount(0)

  await clearEditor.focus()
  await page.keyboard.press('Meta+z')
  await expect(clearEditor).toHaveAttribute('data-canonical-source', EDITED_SOURCE)
  await expect(clearEditor.locator('[data-edit-math-state="rendered"]')).toHaveCount(2)
  await clearCard.getByRole('button', { name: '发送' }).click()
  await expect(replayedUser.locator('.hc-msg__edit-card')).toHaveCount(0)
  expect(receivedSources).toEqual([EXACT_SOURCE, EDITED_SOURCE, EDITED_SOURCE])
  expect(backend.forkRequests).toHaveLength(2)
  const secondFork = backend.forkRequests[1]!
  expect(secondFork).toMatchObject({
    sourceSessionId: firstFork.branchSessionId,
    includeMessage: false,
  })
  expect(backend.deliveries.at(-1)).toMatchObject({
    sessionId: secondFork.branchSessionId,
    source: EDITED_SOURCE,
  })
  expect(backend.sessions.get(secondFork.branchSessionId)).toMatchObject({
    parent_session_id: firstFork.branchSessionId,
    branch_message_id: secondFork.messageId,
  })
})

test('formula editing preserves delimiter, display, paste and drop boundaries in a real browser', async ({
  page,
}) => {
  const persistedMessages: MessageRow[] = [
    {
      id: 'edit-edge-user',
      role: 'user',
      content: EDIT_EDGE_SOURCE,
      timestamp: NOW,
      created_at: NOW,
    },
  ]
  const receivedSources: string[] = []
  const backend = createMathBackendState(persistedMessages, receivedSources)
  await installMathHistoryBackend(page, backend)
  await installTauriMathBackend(page, backend)

  await page.setViewportSize(DESKTOP_MIN_VIEWPORT)
  await page.goto('/chat')

  const userRow = page.getByTestId('chat-message-user').last()
  await userRow.hover()
  await userRow.getByRole('button', { name: '编辑消息' }).click()
  const editCard = userRow.locator('.hc-msg__edit-card')
  const editor = editCard.getByTestId('message-math-editor')

  await editor.locator('[data-edit-math-state="rendered"]').first().click()
  expect(
    await editor.evaluate((element) => ({
      source: element.querySelector<HTMLElement>('[data-edit-math-state="source-active"]')
        ?.textContent,
      caret: window.getSelection()?.anchorOffset,
    })),
  ).toEqual({ source: String.raw`\(x\)`, caret: 2 })

  await editor.locator('[data-edit-math-state="rendered"]').last().click()
  expect(
    await editor.evaluate((element) => {
      const active = element.querySelector<HTMLElement>('[data-edit-math-state="source-active"]')!
      return {
        source: active.textContent,
        caret: window.getSelection()?.anchorOffset,
        display: getComputedStyle(active).display,
      }
    }),
  ).toEqual({ source: '$$\ny\n$$', caret: 3, display: 'block' })

  await editCard.getByRole('button', { name: '取消' }).focus()
  const exactPaste = '  $z$  \n'
  await editor.evaluate((element, text) => {
    const firstText = element.querySelector<HTMLElement>('[data-edit-text]')!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(firstText, 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    clipboardData.setData(
      'text/html',
      '<math><semantics><mi>z</mi><annotation encoding="application/x-tex">z</annotation></semantics></math>',
    )
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
  }, exactPaste)
  await expect(editor).toHaveAttribute('data-canonical-source', exactPaste + EDIT_EDGE_SOURCE)

  await editor.focus()
  await page.keyboard.press('Meta+z')
  await expect(editor).toHaveAttribute('data-canonical-source', EDIT_EDGE_SOURCE)

  await editor.evaluate((element) => {
    const firstText = element.querySelector<HTMLElement>('[data-edit-text]')!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(firstText, 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    const documentWithCaret = document as Document & {
      caretPositionFromPoint?: () => { offsetNode: Node; offset: number }
      caretRangeFromPoint?: () => Range
    }
    Object.defineProperty(documentWithCaret, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: firstText, offset: 2 }),
    })
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'X')
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 10,
        dataTransfer,
      }),
    )
  })
  await expect(editor).toHaveAttribute(
    'data-canonical-source',
    `A X${String.raw`\(x\)`} B $$\ny\n$$ C`,
  )
})

test('real overflowing formulas become local keyboard scroll regions in WebKit', async ({
  page,
}) => {
  const persistedMessages: MessageRow[] = []
  const receivedSources: string[] = []
  const backend = createMathBackendState(persistedMessages, receivedSources)
  await installMathHistoryBackend(page, backend)
  await installTauriMathBackend(page, backend)

  await page.setViewportSize(DESKTOP_MIN_VIEWPORT)
  await page.goto('/chat')
  await page.getByTestId('chat-input').fill(LONG_SOURCE)
  await page.getByTestId('chat-send').click()

  for (const row of [
    page.getByTestId('chat-message-user').last(),
    page.getByTestId('chat-message-assistant').last(),
  ]) {
    const formula = row.locator('.hc-math-inline')
    const viewport = formula.locator(':scope > .hc-math-viewport.hc-math-viewport--inline')
    await expect(formula).toHaveCount(1)
    await expect(viewport).toHaveCount(1)
    await expect(formula).not.toHaveAttribute('tabindex', /.+/)
    await expect(viewport).toHaveClass(/hc-math-viewport--scrollable/)
    await expect(viewport).toHaveAttribute('tabindex', '0')
    expect(
      await formula.evaluate((shell) => {
        const scrollViewport = shell.querySelector<HTMLElement>(':scope > .hc-math-viewport')!
        const shellStyle = getComputedStyle(shell)
        const viewportStyle = getComputedStyle(scrollViewport)
        return {
          shellOverflowX: shellStyle.overflowX,
          shellOverflowY: shellStyle.overflowY,
          viewportOverflowX: viewportStyle.overflowX,
          viewportOverflowY: viewportStyle.overflowY,
        }
      }),
    ).toEqual({
      shellOverflowX: 'visible',
      shellOverflowY: 'visible',
      viewportOverflowX: 'auto',
      viewportOverflowY: 'hidden',
    })
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0)

    const fractions = formula.locator('.katex-html .mfrac')
    await expect(fractions).toHaveCount(10)
    await expectFractionInkVisible(fractions.first())

    await viewport.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await page.keyboard.press('End')
    await expect
      .poll(() =>
        viewport.evaluate((element) =>
          Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)),
        ),
      )
      .toBeLessThanOrEqual(1)
    await expectFractionInkVisible(fractions.last())
  }

  expect(receivedSources).toEqual([LONG_SOURCE])
})
