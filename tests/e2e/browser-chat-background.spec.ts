import { mkdir, writeFile } from 'node:fs/promises'
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

type ChatWorkspaceMode = 'sessions' | 'artifacts' | 'context' | 'focus'

const now = '2026-04-08T10:00:00.000Z'

const initialSessions: SessionRow[] = [
  { id: 's-active', title: '当前会话', created_at: now, updated_at: now, message_count: 2 },
  { id: 's-bg', title: '后台生成会话', created_at: now, updated_at: now, message_count: 1 },
]

const moreSessions: SessionRow[] = [
  {
    id: 's-more',
    title: '更早的会话',
    created_at: '2026-04-06T10:00:00.000Z',
    updated_at: '2026-04-06T10:00:00.000Z',
    message_count: 1,
  },
  {
    id: 's-cross-year',
    title: '跨年会话',
    created_at: '2025-12-31T10:00:00.000Z',
    updated_at: '2025-12-31T10:00:00.000Z',
    message_count: 1,
  },
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
    [
      's-active',
      [
        {
          id: 'm-active-user',
          role: 'user',
          content: '当前会话问题',
          timestamp: now,
          created_at: now,
        },
        {
          id: 'm-active-assistant',
          role: 'assistant',
          content: '当前会话回答',
          timestamp: now,
          created_at: now,
          agent_name: '小王的辅导助手 · 五年级',
          metadata: { provider: 'Ollama (本地)', model: 'qwen3.5:9b' },
        },
      ],
    ],
    [
      's-bg',
      [{ id: 'm-bg-user', role: 'user', content: '后台会话问题', timestamp: now, created_at: now }],
    ],
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
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
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
        const payload = JSON.parse(raw) as {
          type?: string
          session_id?: string
          request_id?: string
        }
        if (
          payload.type === 'resume' &&
          payload.session_id === 's-bg' &&
          payload.request_id === 'req-bg'
        ) {
          this.emit(
            {
              type: 'stream_snapshot',
              session_id: 's-bg',
              request_id: 'req-bg',
              content: '后台生成中',
              done: false,
              metadata: { provider: 'MockProvider', model: 'mock-chat' },
            },
            20,
          )
          this.emit(
            {
              type: 'chunk',
              session_id: 's-bg',
              request_id: 'req-bg',
              content: '，继续生成',
              done: false,
              metadata: { provider: 'MockProvider', model: 'mock-chat' },
            },
            80,
          )
          setTimeout(() => {
            const content = '后台生成完成'
            void (
              window as unknown as {
                e2ePersistAssistant?: (sessionId: string, content: string) => Promise<void>
              }
            ).e2ePersistAssistant?.('s-bg', content)
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
          this.emit(
            {
              type: 'reply',
              session_id: sessionId,
              request_id: payload.request_id,
              content: '新消息回复完成',
              metadata: { provider: 'MockProvider', model: 'mock-chat' },
            },
            60,
          )
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
        streams: [
          {
            request_id: 'req-bg',
            session_id: 's-bg',
            user_id: 'desktop-user',
            content: '后台生成中',
            done: false,
            status: 'streaming',
            metadata: { provider: 'MockProvider', model: 'mock-chat' },
            started_at: now,
            updated_at: now,
          },
        ],
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
        results: [
          {
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
          },
        ],
      })
    }

    return json(route, {})
  })
}

async function expectWorkspaceMode(page: Page, mode: ChatWorkspaceMode) {
  const sessionRail = page.locator('.hc-chat__sidebar')
  const artifactsRail = page.locator('.hc-artifacts')
  const contextRail = page.locator('.hc-inspector')
  const toolbar = page.locator('.hc-chat__toolbar')
  const sessionsButton = toolbar.getByTitle('切换会话侧栏', { exact: true })
  const artifactsButton = toolbar.getByTitle('产物', { exact: true })
  const contextButton = toolbar.getByTitle('上下文面板', { exact: true })

  const visibleRail = {
    sessions: sessionRail,
    artifacts: artifactsRail,
    context: contextRail,
  } as const

  for (const [railName, rail] of Object.entries(visibleRail)) {
    if (railName === mode) await expect(rail).toBeVisible()
    else await expect(rail).toBeHidden()
  }

  const activeButton = {
    sessions: sessionsButton,
    artifacts: artifactsButton,
    context: contextButton,
  } as const
  for (const [buttonName, button] of Object.entries(activeButton)) {
    if (buttonName === mode) await expect(button).toHaveClass(/hc-chat__toolbar-btn--active/)
    else await expect(button).not.toHaveClass(/hc-chat__toolbar-btn--active/)
  }
}

test('chat workspace owns an opaque neutral canvas instead of leaking the shell glow', async ({
  page,
}) => {
  await installMockBackend(page)
  await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
  await page.goto('/chat')

  const chat = page.locator('.hc-chat')
  await expect(chat).toBeVisible()
  await expect(chat).toHaveCSS('background-color', 'rgb(251, 252, 254)')
  await expect(chat).toHaveCSS('background-image', 'none')

  const computed = await chat.evaluate((element) => {
    const style = getComputedStyle(element)
    const token = getComputedStyle(document.documentElement).getPropertyValue('--hc-bg-main').trim()
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      token,
      opacity: style.opacity,
    }
  })
  expect(computed).toEqual({
    backgroundColor: 'rgb(251, 252, 254)',
    backgroundImage: 'none',
    token: '#fbfcfe',
    opacity: '1',
  })

  await page.screenshot({
    path: 'test-results/bug-20260723-015-chat-solid-background.png',
    fullPage: true,
  })
})

test('session delete confirmation keeps its five-second cooldown hover visually inert', async ({
  page,
}) => {
  await installMockBackend(page)
  await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
  await page.goto('/chat')

  const session = page.locator('[data-session-id="s-bg"]')
  await session.hover()
  await session.getByRole('button', { name: '会话操作' }).click()
  const deleteItem = page.getByRole('menu').locator('.hc-ctx__item--danger')
  await expect(deleteItem.locator('.hc-ctx__label')).toHaveText('删除')
  await deleteItem.click()

  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', { name: '删除', exact: true })
  await expect(confirm).toBeDisabled()

  // The dialog has an approved entrance transition. Finish that transition before
  // measuring pointer hover so the geometry check cannot wait on a moving target.
  await dialog.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true })
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
  })

  const visualState = async () =>
    confirm.evaluate((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        transform: style.transform,
        boxShadow: style.boxShadow,
        transitionDuration: style.transitionDuration,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })

  const beforeHover = await visualState()
  await confirm.hover({ force: true })
  const afterHover = await visualState()
  expect(afterHover).toEqual(beforeHover)

  await dialog.screenshot({
    path: 'test-results/bug-20260723-007-delete-cooldown-hover.png',
  })
})

test('browser moves a pinned session into the first pinned section exactly once', async ({
  page,
}) => {
  await installMockBackend(page)
  await page.goto('/chat')

  const backgroundRow = page.locator('[data-session-id="s-bg"]')
  await backgroundRow.hover()
  await backgroundRow.getByRole('button', { name: '会话操作' }).click()
  await page.getByRole('menu').getByRole('menuitem', { name: '置顶' }).click()

  const sections = page.locator('.hc-sessions__section')
  const pinnedSection = sections.first()
  await expect(pinnedSection.locator('.hc-sessions__section-label')).toHaveText('已置顶')
  await expect(pinnedSection.locator('[data-session-id="s-bg"]')).toHaveCount(1)
  await expect(page.locator('[data-session-id="s-bg"]')).toHaveCount(1)
  await expect(backgroundRow).toHaveClass(/hc-sessions__item--pinned/)

  await backgroundRow.hover()
  await backgroundRow.locator('.hc-sessions__pin-action').click()
  await expect(pinnedSection.locator('[data-session-id="s-bg"]')).toHaveCount(0)
  await expect(page.locator('[data-session-id="s-bg"]')).toHaveCount(1)
  await expect(backgroundRow).not.toHaveClass(/hc-sessions__item--pinned/)
})

test('browser restores background stream, keeps session state isolated, and supports session history controls', async ({
  page,
}) => {
  await installMockBackend(page)

  await page.goto('/chat')

  await expect(page.locator('[data-session-id="s-active"]')).toContainText('当前会话')
  await expect(page.locator('[data-session-id="s-bg"]')).toContainText('后台生成会话')
  await expect(page.locator('[data-session-id="s-active"].hc-sessions__item--pinned')).toBeVisible()
  await expect(page.locator('[data-session-id="s-bg"] .hc-sessions__spinner')).toBeVisible()
  await expect(page.locator('.hc-chat__toolbar').getByTitle(/搜索/)).toHaveCount(0)
  await expect(page.locator('.hc-search-bar')).toHaveCount(0)

  const backgroundRow = page.locator('[data-session-id="s-bg"]')
  const rowHeightBefore = await backgroundRow.evaluate((el) => el.getBoundingClientRect().height)
  const pinAction = backgroundRow.locator('.hc-sessions__pin-action')
  const actionsTrigger = backgroundRow.getByRole('button', { name: '会话操作' })
  await expect(pinAction).toHaveCSS('opacity', '0')
  await expect(actionsTrigger).toHaveCSS('opacity', '0')
  await expect(pinAction.locator('.lucide-pin')).toHaveCount(1)

  await backgroundRow.hover()
  await expect(pinAction).toHaveCSS('opacity', '1')
  await expect(actionsTrigger).toHaveCSS('opacity', '1')
  await expect(pinAction).toHaveCSS('color', 'rgb(142, 142, 142)')
  await expect(actionsTrigger).toHaveCSS('color', 'rgb(142, 142, 142)')
  await expect(pinAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(actionsTrigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  const geometry = await backgroundRow.evaluate((element) => {
    const pinButton = element.querySelector<HTMLElement>('.hc-sessions__pin-action')
    const moreButton = element.querySelector<HTMLElement>('.hc-sessions__actions')
    const pinIcon = element.querySelector<SVGElement>('.hc-sessions__pin-action svg')
    const moreIcon = element.querySelector<SVGElement>('.hc-sessions__actions svg')
    if (!pinButton || !moreButton || !pinIcon || !moreIcon) {
      throw new Error('session row action controls are missing')
    }
    const pinButtonRect = pinButton.getBoundingClientRect()
    const moreButtonRect = moreButton.getBoundingClientRect()
    const pinRect = pinIcon.getBoundingClientRect()
    const moreRect = moreIcon.getBoundingClientRect()
    return {
      pinHitWidth: pinButtonRect.width,
      pinHitHeight: pinButtonRect.height,
      moreHitWidth: moreButtonRect.width,
      moreHitHeight: moreButtonRect.height,
      pinWidth: pinRect.width,
      pinHeight: pinRect.height,
      moreWidth: moreRect.width,
      moreHeight: moreRect.height,
      centerDistance: moreRect.left + moreRect.width / 2 - (pinRect.left + pinRect.width / 2),
    }
  })
  expect(geometry).toEqual({
    pinHitWidth: 24,
    pinHitHeight: 28,
    moreHitWidth: 24,
    moreHitHeight: 28,
    pinWidth: 18,
    pinHeight: 18,
    moreWidth: 20,
    moreHeight: 20,
    centerDistance: 24,
  })
  await backgroundRow.screenshot({ path: 'test-results/chat-session-row-hover@2x.png' })

  const primaryColor = await backgroundRow
    .locator('.hc-sessions__title')
    .evaluate((el) => getComputedStyle(el).color)
  await pinAction.hover()
  await expect(pinAction).toHaveCSS('color', primaryColor)
  await expect(actionsTrigger).toHaveCSS('color', 'rgb(142, 142, 142)')
  await expect(pinAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await backgroundRow.screenshot({ path: 'test-results/chat-session-pin-hover@2x.png' })

  await actionsTrigger.hover()
  await expect(actionsTrigger).toHaveCSS('color', primaryColor)
  await expect(pinAction).toHaveCSS('color', 'rgb(142, 142, 142)')
  await expect(actionsTrigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await actionsTrigger.click()
  const sessionMenu = page.getByRole('menu')
  await expect(sessionMenu).toBeVisible()
  await expect(sessionMenu).toContainText('重命名')
  await expect(sessionMenu).toContainText('置顶')
  await expect(sessionMenu).toContainText('查看分支')
  await expect(sessionMenu.getByText('删除', { exact: true })).toHaveCount(1)
  await expect(sessionMenu.getByText('删除会话', { exact: true })).toHaveCount(0)
  await expect(sessionMenu).not.toContainText('分享')
  await expect(sessionMenu).not.toContainText('复制标题')
  await page.screenshot({ path: 'test-results/chat-session-menu.png', fullPage: true })
  await sessionMenu.getByRole('menuitem', { name: '置顶' }).click()
  await expect(backgroundRow).toHaveClass(/hc-sessions__item--pinned/)
  const pinnedSection = page.locator('.hc-sessions__section').filter({
    has: page.locator('.hc-sessions__section-label', { hasText: /^已置顶$/ }),
  })
  await expect(pinnedSection.locator('[data-session-id="s-bg"]')).toBeVisible()
  await backgroundRow.hover()
  await expect(backgroundRow.locator('.hc-sessions__pin-action .lucide-pin-off')).toBeVisible()
  await expect(pinAction).toHaveCSS('width', '24px')
  await expect(pinAction).toHaveCSS('height', '28px')
  await expect(actionsTrigger).toHaveCSS('width', '24px')
  await expect(actionsTrigger).toHaveCSS('height', '28px')
  await backgroundRow.screenshot({ path: 'test-results/chat-session-pinned-hover@2x.png' })

  await pinAction.click()
  await expect(backgroundRow).not.toHaveClass(/hc-sessions__item--pinned/)
  await expect(pinnedSection.locator('[data-session-id="s-bg"]')).toHaveCount(0)
  await actionsTrigger.focus()
  await actionsTrigger.press('Shift+F10')
  await expect(sessionMenu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sessionMenu).toBeHidden()
  await expect(actionsTrigger).toBeFocused()
  const rowHeightAfter = await backgroundRow.evaluate((el) => el.getBoundingClientRect().height)
  expect(Math.round(rowHeightAfter - rowHeightBefore)).toBe(0)

  await page.locator('[data-session-id="s-active"]').click()
  await expect(page.locator('.hc-chat__thread')).toContainText('当前会话回答')
  await expect(page.locator('.hc-chat__thread')).not.toContainText('后台生成完成')

  await expect(page.locator('[data-session-id="s-bg"] .hc-sessions__spinner')).toBeHidden({
    timeout: 5_000,
  })

  await page.locator('[data-session-id="s-bg"]').click()
  await expect(page.locator('.hc-chat__thread')).toContainText('后台生成完成')

  const sessionSearch = page.locator('.hc-search__input')
  await expect(sessionSearch).toHaveAttribute('placeholder', '搜索会话与内容')
  await sessionSearch.fill('命中')
  await expect(page.locator('.hc-sessions__snippet')).toContainText('跨会话搜索命中的片段')

  await sessionSearch.fill('')
  await page.locator('.hc-sessions__load-more').click()
  const olderRow = page.locator('[data-session-id="s-more"]')
  await expect(olderRow).toContainText('更早的会话')
  const rowHeightBeforeRename = await olderRow.evaluate((el) => el.getBoundingClientRect().height)
  await olderRow.hover()
  await olderRow.getByRole('button', { name: '会话操作' }).click()
  await sessionMenu.getByRole('menuitem', { name: '重命名' }).click()
  const renameInput = olderRow.locator('.hc-sessions__rename-input')
  await expect(renameInput).toBeVisible()
  const rowHeightDuringRename = await olderRow.evaluate((el) => el.getBoundingClientRect().height)
  expect(rowHeightDuringRename - rowHeightBeforeRename).toBe(0)
  await renameInput.fill('归档后的会话')
  await renameInput.press('Enter')
  await expect(olderRow).toContainText('归档后的会话')

  await olderRow.hover()
  await olderRow.getByRole('button', { name: '会话操作' }).click()
  await sessionMenu.getByRole('menuitem', { name: /^删除(?:\s*⌫)?$/ }).click()
  const confirmDialog = page.getByRole('alertdialog', { name: '删除会话？' })
  await expect(confirmDialog).toContainText('归档后的会话')
  await confirmDialog.getByRole('button', { name: '删除' }).click()
  await expect(olderRow).toHaveCount(0)

  await page.screenshot({
    path: 'test-results/chat-session-actions-and-search.png',
    fullPage: true,
  })
})

test('browser renders today sessions as time and older sessions as dates', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-04-08T12:00:00+08:00') })
  await installMockBackend(page)
  await page.goto('/chat')

  await expect(page.locator('[data-session-id="s-active"] .hc-sessions__time')).toHaveText('18:00')

  await page.locator('.hc-sessions__load-more').click()
  await expect(page.locator('[data-session-id="s-more"] .hc-sessions__time')).toHaveText('4月6日')
  await expect(page.locator('[data-session-id="s-cross-year"] .hc-sessions__time')).toHaveText(
    '2025年12月31日',
  )
  const sessionTimes = await page.locator('.hc-sessions__time').allTextContents()
  expect(sessionTimes.join(' ')).not.toMatch(/今天|昨天|周[一二三四五六日天]/)

  const evidenceDir = process.env.HEX_SESSION_DATE_EVIDENCE_DIR?.trim()
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true })
    await page.screenshot({ path: `${evidenceDir}/implementation-date-full.png`, fullPage: true })
    await page.locator('.hc-sessions').screenshot({
      path: `${evidenceDir}/implementation-date-session-list.png`,
    })
    const geometry = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          text: element.textContent?.trim() ?? '',
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        }
      }
      return {
        list: read('.hc-sessions'),
        todayActive: read('[data-session-id="s-active"]'),
        sameYearOlder: read('[data-session-id="s-more"]'),
        crossYearOlder: read('[data-session-id="s-cross-year"]'),
      }
    })
    await writeFile(`${evidenceDir}/implementation-date-session-geometry.json`, JSON.stringify(geometry, null, 2))
  }
})

test('browser keeps sessions, artifacts, context, and focus as one mutually exclusive workspace state', async ({
  page,
}) => {
  await installMockBackend(page)
  await page.goto('/chat')
  await page.locator('[data-session-id="s-active"]').click()
  await expect(
    page.getByTestId('chat-message-assistant').filter({ hasText: '当前会话回答' }),
  ).toBeVisible()

  const toolbar = page.locator('.hc-chat__toolbar')
  const sessionsButton = toolbar.getByTitle('切换会话侧栏', { exact: true })
  const artifactsButton = toolbar.getByTitle('产物', { exact: true })
  const contextButton = toolbar.getByTitle('上下文面板', { exact: true })
  const assistantRow = page
    .getByTestId('chat-message-assistant')
    .filter({ hasText: '当前会话回答' })
  const assistantBody = assistantRow.locator('.hc-msg__body')
  const userRow = page.getByTestId('chat-message-user').filter({ hasText: '当前会话问题' })

  await expectWorkspaceMode(page, 'sessions')
  await expect(assistantBody).toHaveCSS('max-width', '780px')

  // 当前激活的任一工作区入口再点一次都收起为 focus，sessions 也不例外。
  await sessionsButton.click()
  await expectWorkspaceMode(page, 'focus')
  await sessionsButton.click()
  await expectWorkspaceMode(page, 'sessions')

  await artifactsButton.click()
  await expectWorkspaceMode(page, 'artifacts')
  await artifactsButton.click()
  await expectWorkspaceMode(page, 'sessions')

  await contextButton.click()
  await expectWorkspaceMode(page, 'context')
  await page.locator('.hc-inspector__btn').dblclick()
  await expectWorkspaceMode(page, 'sessions')

  // 从右侧面板直接切到另一右侧面板，两者必须互斥；再切 sessions 也必须关闭右侧面板。
  await artifactsButton.click()
  await expectWorkspaceMode(page, 'artifacts')
  await contextButton.click()
  await expectWorkspaceMode(page, 'context')
  await sessionsButton.click()
  await expectWorkspaceMode(page, 'sessions')
  // 用户显式折叠会话栏后，关闭右侧工作区保持全宽对话。
  await sessionsButton.click()
  await expectWorkspaceMode(page, 'focus')
  await artifactsButton.click()
  await expectWorkspaceMode(page, 'artifacts')
  await artifactsButton.click()
  await expectWorkspaceMode(page, 'focus')

  const focusGeometry = await assistantRow.evaluate((row) => {
    const body = row.querySelector<HTMLElement>('.hc-msg__body')
    if (!body) throw new Error('assistant message body is missing')
    const rowRect = row.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    return {
      bodyWidth: bodyRect.width,
      bodyRightGap: rowRect.right - bodyRect.right,
      maxWidth: getComputedStyle(body).maxWidth,
    }
  })
  expect(focusGeometry.maxWidth).toBe('none')
  expect(focusGeometry.bodyWidth).toBeGreaterThan(780)
  expect(Math.abs(focusGeometry.bodyRightGap)).toBeLessThanOrEqual(1)

  const userGeometry = await userRow.evaluate((row) => {
    const body = row.querySelector<HTMLElement>('.hc-msg__body--user')
    if (!body) throw new Error('user message body is missing')
    const rowRect = row.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    return {
      rowWidth: rowRect.width,
      bodyWidth: bodyRect.width,
      maxWidth: getComputedStyle(body).maxWidth,
    }
  })
  expect(userGeometry.maxWidth).toBe('70%')
  expect(userGeometry.bodyWidth).toBeLessThanOrEqual(userGeometry.rowWidth * 0.7 + 1)
})

test('browser keeps assistant actions inline and user actions hover-revealed at the approved compact geometry', async ({
  page,
}) => {
  await installMockBackend(page)
  await page.goto('/chat')
  await page.locator('[data-session-id="s-active"]').click()

  await expect(page.locator('[data-session-id="s-active"] .hc-sessions__time')).toHaveText(
    '4月8日',
  )

  const assistantRow = page
    .getByTestId('chat-message-assistant')
    .filter({ hasText: '当前会话回答' })
  const assistantMeta = assistantRow.locator('.hc-msg__meta')
  const assistantActions = assistantRow.locator('.hc-msg-actions')
  const assistantTime = assistantRow.locator('.hc-msg__time')
  await expect(assistantMeta.locator('span')).toHaveCount(2)
  await expect(assistantActions).toHaveAttribute('role', 'toolbar')
  await expect(assistantActions).toBeVisible()
  await expect(assistantTime).toHaveCount(1)
  await expect(assistantTime).toHaveText(/^\d{2}:\d{2}$/)

  const assistantTimeOrder = await assistantRow.evaluate((row) => {
    const actions = row.querySelector<HTMLElement>('.hc-msg-actions')
    const time = row.querySelector<HTMLElement>('.hc-msg__time')
    if (!actions || !time) throw new Error('assistant message time is missing')
    return actions.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING
  })
  expect(assistantTimeOrder).toBeTruthy()

  const assistantVisual = await assistantActions.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      height: element.getBoundingClientRect().height,
      opacity: Number(style.opacity),
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    }
  })
  expect(assistantVisual.height).toBe(24)
  expect(assistantVisual.opacity).toBeGreaterThanOrEqual(0.6)
  expect(assistantVisual.opacity).toBeLessThanOrEqual(0.8)
  expect(assistantVisual.visibility).toBe('visible')
  expect(assistantVisual.pointerEvents).toBe('auto')
  expect(assistantVisual.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(assistantVisual.borderTopWidth).toBe('0px')
  expect(assistantVisual.boxShadow).toBe('none')

  const assistantControlGeometry = await assistantActions.evaluate((element) => {
    const buttons = Array.from(element.querySelectorAll<HTMLElement>('.hc-msg-actions__btn'))
    const icons = Array.from(element.querySelectorAll<SVGElement>('.hc-msg-actions__btn svg'))
    return {
      buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
      buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
      iconWidths: icons.map((icon) => icon.getBoundingClientRect().width),
      iconHeights: icons.map((icon) => icon.getBoundingClientRect().height),
    }
  })
  expect(new Set(assistantControlGeometry.buttonWidths)).toEqual(new Set([24]))
  expect(new Set(assistantControlGeometry.buttonHeights)).toEqual(new Set([24]))
  expect(new Set(assistantControlGeometry.iconWidths)).toEqual(new Set([14]))
  expect(new Set(assistantControlGeometry.iconHeights)).toEqual(new Set([14]))

  const assistantFooterGeometry = await assistantRow.evaluate((row) => {
    const meta = row.querySelector<HTMLElement>('.hc-msg__meta')
    const actions = row.querySelector<HTMLElement>('.hc-msg-actions')
    if (!meta || !actions) throw new Error('assistant footer controls are missing')
    const metaRect = meta.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    return {
      gap: actionsRect.left - metaRect.right,
      centerDelta: Math.abs(
        actionsRect.top + actionsRect.height / 2 - (metaRect.top + metaRect.height / 2),
      ),
    }
  })
  expect(assistantFooterGeometry.gap).toBeGreaterThanOrEqual(8)
  expect(assistantFooterGeometry.gap).toBeLessThanOrEqual(10)
  expect(assistantFooterGeometry.centerDelta).toBeLessThanOrEqual(1)

  await expect(assistantActions.getByTestId('message-more')).toHaveCount(0)
  await expect(assistantActions.getByTestId('message-fork')).toHaveCount(1)
  await expect(assistantActions.getByTestId('message-delete')).toHaveCount(0)

  const userRow = page.getByTestId('chat-message-user').filter({ hasText: '当前会话问题' })
  const userActionsSlot = userRow.locator('.hc-msg__actions-float--right')
  const userActions = userRow.locator('.hc-msg-actions')
  await expect(userActions).toHaveAttribute('role', 'toolbar')
  await expect(userActionsSlot).toHaveCSS('visibility', 'hidden')
  await expect(userActionsSlot).toHaveCSS('pointer-events', 'none')
  await expect(userRow.locator('.hc-msg__time--right')).toHaveCount(1)
  await expect(userRow.locator('.hc-msg__time--right')).toHaveText(/^\d{2}:\d{2}$/)
  await expect(userRow.locator('.hc-msg__time--right')).toHaveCSS('visibility', 'hidden')
  await userRow.hover()
  await expect(userActionsSlot).toHaveCSS('visibility', 'visible')
  await expect(userActionsSlot).toHaveCSS('pointer-events', 'auto')
  await expect(userActionsSlot).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')

  const userFooterGeometry = await userRow.evaluate((row) => {
    const actions = row.querySelector<HTMLElement>('.hc-msg-actions')
    if (!actions) throw new Error('user footer controls are missing')
    const firstButton = actions.querySelector<HTMLElement>('.hc-msg-actions__btn')
    const firstIcon = actions.querySelector<SVGElement>('.hc-msg-actions__btn svg')
    if (!firstButton || !firstIcon) throw new Error('user action geometry is missing')
    const buttonRect = firstButton.getBoundingClientRect()
    const iconRect = firstIcon.getBoundingClientRect()
    return {
      buttonWidth: buttonRect.width,
      buttonHeight: buttonRect.height,
      iconWidth: iconRect.width,
      iconHeight: iconRect.height,
    }
  })
  expect(userFooterGeometry.buttonWidth).toBe(24)
  expect(userFooterGeometry.buttonHeight).toBe(24)
  expect(userFooterGeometry.iconWidth).toBe(14)
  expect(userFooterGeometry.iconHeight).toBe(14)
  await expect(userRow.locator('.hc-msg__time--right')).toHaveCSS('visibility', 'visible')

  const userTimeOrder = await userRow.evaluate((row) => {
    const actions = row.querySelector<HTMLElement>('.hc-msg-actions')
    const time = row.querySelector<HTMLElement>('.hc-msg__time--right')
    if (!actions || !time) throw new Error('user message time is missing')
    return time.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING
  })
  expect(userTimeOrder).toBeTruthy()

  await expect(userActions.getByTestId('message-more')).toHaveCount(0)
  await expect(userActions.getByTestId('message-fork')).toHaveCount(0)
  await expect(userActions.getByTestId('message-delete')).toHaveCount(0)

  const evidenceDir = process.env.HEX_TIME_EVIDENCE_DIR?.trim()
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true })
    const collectGeometry = () =>
      page.evaluate(() => {
        const read = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            text: element.textContent?.trim() ?? '',
            display: style.display,
            opacity: style.opacity,
            visibility: style.visibility,
            pointerEvents: style.pointerEvents,
            gap: style.gap,
          }
        }
        const assistantActions = document.querySelector<HTMLElement>(
          '[data-testid="chat-message-assistant"] .hc-msg-actions',
        )
        const assistantTime = document.querySelector<HTMLElement>(
          '[data-testid="chat-message-assistant"] .hc-msg__time',
        )
        const userActions = document.querySelector<HTMLElement>(
          '[data-testid="chat-message-user"] .hc-msg-actions',
        )
        const userTime = document.querySelector<HTMLElement>(
          '[data-testid="chat-message-user"] .hc-msg__time--right',
        )
        return {
          assistant: {
            meta: read('[data-testid="chat-message-assistant"] .hc-msg__meta'),
            actions: read('[data-testid="chat-message-assistant"] .hc-msg-actions'),
            time: read('[data-testid="chat-message-assistant"] .hc-msg__time'),
            timeAfterActions:
              !!assistantActions &&
              !!assistantTime &&
              Boolean(
                assistantActions.compareDocumentPosition(assistantTime) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              ),
          },
          user: {
            controls: read('[data-testid="chat-message-user"] .hc-msg__actions-float--right'),
            actions: read('[data-testid="chat-message-user"] .hc-msg-actions'),
            time: read('[data-testid="chat-message-user"] .hc-msg__time--right'),
            timeBeforeActions:
              !!userActions &&
              !!userTime &&
              Boolean(
                userTime.compareDocumentPosition(userActions) & Node.DOCUMENT_POSITION_FOLLOWING,
              ),
          },
          sessionDate: read('[data-session-id="s-active"] .hc-sessions__time'),
        }
      })

    await page.screenshot({ path: `${evidenceDir}/implementation-user-hover.png`, fullPage: true })
    await page.locator('.hc-sessions').screenshot({ path: `${evidenceDir}/implementation-session-list.png` })
    await assistantRow.screenshot({ path: `${evidenceDir}/implementation-assistant-row.png` })
    await userRow.screenshot({ path: `${evidenceDir}/implementation-user-hover-row.png` })
    await assistantRow.locator('.hc-msg__footer').screenshot({
      path: `${evidenceDir}/implementation-assistant-footer.png`,
    })
    await userRow.locator('.hc-msg__footer--right').screenshot({
      path: `${evidenceDir}/implementation-user-hover-footer.png`,
    })
    const hoverGeometry = await collectGeometry()
    await page.mouse.move(1, 1)
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${evidenceDir}/implementation-user-hidden.png`, fullPage: true })
    await userRow.screenshot({ path: `${evidenceDir}/implementation-user-hidden-row.png` })
    await userRow.locator('.hc-msg__footer--right').screenshot({
      path: `${evidenceDir}/implementation-user-hidden-footer.png`,
    })
    const hiddenGeometry = await collectGeometry()
    await writeFile(
      `${evidenceDir}/implementation-geometry.json`,
      JSON.stringify({ hover: hoverGeometry, hidden: hiddenGeometry }, null, 2),
    )
  }
})
