import { expect, test, type Page, type Route } from '@playwright/test'

test.use({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
})

const now = '2026-07-23T14:00:00.000Z'
const k12AgentId = 'k12-tutor-current-source-interaction'
const k12SessionId = 'session-k12-current-source'
const genericSessionId = 'session-generic-current-source'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installChatInteractionMocks(page: Page) {
  await page.addInitScript(
    ({ agentId, sessionId }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [sessionId]: agentId }))
      localStorage.setItem('hc-theme', 'light')
    },
    { agentId: k12AgentId, sessionId: k12SessionId },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'test' }),
  )

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace(/^\/_hexclaw/, '')
    const method = route.request().method()

    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (path === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (path === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (path === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: k12AgentId,
            display_name: '小明的辅导助手 · 五年级下',
            description: '五年级下 · 各学科教材独立绑定',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级下',
            },
          },
        ],
        total: 1,
        default: k12AgentId,
      })
    }
    if (method === 'GET' && path === '/api/v1/sessions') {
      return json(route, {
        sessions: [
          {
            id: k12SessionId,
            title: k12AgentId,
            agent_id: k12AgentId,
            created_at: now,
            updated_at: now,
            message_count: 1,
          },
          {
            id: genericSessionId,
            title: '普通会话',
            created_at: now,
            updated_at: now,
            message_count: 1,
          },
        ],
        total: 2,
      })
    }
    if (
      method === 'GET' &&
      (path === `/api/v1/sessions/${k12SessionId}/messages` ||
        path === `/api/v1/sessions/${genericSessionId}/messages`)
    ) {
      return json(route, {
        messages: [
          {
            id: `${path}-message`,
            role: 'assistant',
            content: '当前源码运行态证据',
            timestamp: now,
            created_at: now,
          },
        ],
        total: 1,
      })
    }
    if (
      method === 'GET' &&
      (path === `/api/v1/sessions/${k12SessionId}/branches` ||
        path === `/api/v1/sessions/${genericSessionId}/branches`)
    ) {
      return json(route, { branches: [], total: 0 })
    }
    if (method === 'DELETE' && path === `/api/v1/sessions/${genericSessionId}`) {
      return json(route, { message: 'deleted' })
    }
    if (
      method === 'PUT' &&
      (path === `/api/v1/sessions/${k12SessionId}/title` ||
        path === `/api/v1/sessions/${genericSessionId}/title`)
    ) {
      return json(route, { message: 'updated' })
    }
    if (path === '/api/v1/skills') {
      return json(route, {
        dir: '/tmp/hexclaw-skills',
        total: 1,
        skills: [
          {
            name: 'essay-grader',
            description: '中英文作文批改',
            version: '1.0.0',
            author: 'hexclaw',
            tags: ['writing'],
            triggers: [],
            enabled: true,
          },
        ],
      })
    }
    if (path === '/api/v1/clawhub/search') {
      return json(route, { skills: [], total: 0 })
    }
    if (path === '/api/v1/prompts/all' || path === '/api/v1/prompts') {
      return json(route, { prompts: [], total: 0 })
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
      path === '/api/k12/practice-sets'
    ) {
      return json(route, { items: [] })
    }
    if (path === '/api/k12/creative-works') {
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

    return json(route, {})
  })
}

type StableVisualState = {
  nodeMarker: string | null
  rect: { x: number; y: number; width: number; height: number }
  transform: string
  backgroundColor: string
  color: string
  opacity: string
  boxShadow: string
}

async function stableVisualState(locator: ReturnType<Page['locator']>): Promise<StableVisualState> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      nodeMarker: element.getAttribute('data-e2e-stable-node'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      transform: style.transform,
      backgroundColor: style.backgroundColor,
      color: style.color,
      opacity: style.opacity,
      boxShadow: style.boxShadow,
    }
  })
}

async function waitForAnimations(locator: ReturnType<Page['locator']>) {
  await locator.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true })
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
  })
}

test.describe('2026-07-23 chat interaction current-source contract', () => {
  test('RED control rejects the former direct-delete interaction without a confirmation dialog', async ({
    page,
  }) => {
    test.skip(
      process.env.HEX_CHAT_INTERACTION_RED !== '1',
      'negative control runs only when explicitly proving the old symptom is detectable',
    )
    await page.setContent(`
      <div role="menu">
        <button role="menuitem">删除</button>
      </div>
    `)
    await page.getByRole('menuitem', { name: '删除', exact: true }).click()

    // The former interaction deleted directly from the menu. The accepted contract requires
    // a separate confirmation surface, therefore this assertion must fail for that old DOM.
    await expect(page.getByRole('alertdialog')).toBeVisible()
  })

  test.beforeEach(async ({ page }) => {
    await installChatInteractionMocks(page)
  })

  test('session identity, branch availability, and five-second shared delete confirmation work before any row click', async ({
    page,
    browserName,
  }) => {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' })

    const k12Row = page.locator(`[data-session-id="${k12SessionId}"]`)
    await expect(k12Row).toBeVisible()
    await expect(k12Row.locator('.hc-sessions__title')).toHaveText('🎓 小明的辅导助手 · 五年级下')

    const genericRow = page.locator(`[data-session-id="${genericSessionId}"]`)
    await genericRow.hover()
    const branchProbe = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(
        `/_hexclaw/api/v1/sessions/${genericSessionId}/branches`,
      ),
    )
    await genericRow.getByRole('button', { name: '会话操作' }).click()
    const branchResponse = await branchProbe
    expect(await branchResponse.json()).toEqual({ branches: [], total: 0 })
    const sessionMenu = page.getByRole('menu')
    const branches = sessionMenu.getByRole('menuitem', { name: '查看分支', exact: true })
    await expect(branches).toBeDisabled()
    await expect(page.getByTestId('branches-dialog')).toHaveCount(0)
    await page.screenshot({
      path: `tests/e2e/screenshots/current-source/bug-20260723-chat-session-menu-${browserName}-runtime.png`,
      fullPage: true,
    })

    const deleteItem = sessionMenu.locator('.hc-ctx__item--danger')
    await expect(deleteItem.locator('.hc-ctx__label')).toHaveText('删除')
    await deleteItem.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    const confirm = dialog.getByRole('button', { name: '删除', exact: true })
    await expect(confirm).toBeDisabled()

    // Exclude the approved dialog entrance animation; this contract measures pointer hover only.
    await waitForAnimations(dialog)
    await confirm.evaluate((element) => element.setAttribute('data-e2e-stable-node', 'confirm'))
    const beforeHover = await stableVisualState(confirm)
    await confirm.hover({ force: true })
    const afterHover = await stableVisualState(confirm)
    expect(afterHover).toEqual(beforeHover)

    await dialog.screenshot({
      path: `tests/e2e/screenshots/current-source/bug-20260723-chat-delete-${browserName}-runtime.png`,
    })

    await expect(confirm).toBeEnabled({ timeout: 6_500 })
    await confirm.click()
    await expect(dialog).toBeHidden()
    await expect(genericRow).toHaveCount(0)
  })

  test('right workspace close restores sessions only when the user did not explicitly collapse them', async ({
    page,
    browserName,
  }) => {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' })

    const toolbar = page.locator('.hc-chat__toolbar')
    const sessionsButton = toolbar.getByTitle('切换会话侧栏', { exact: true })
    const artifactsButton = toolbar.getByTitle('产物', { exact: true })
    const contextButton = toolbar.getByTitle('上下文面板', { exact: true })
    const sessions = page.locator('.hc-chat__sidebar')
    const artifacts = page.locator('.hc-artifacts')
    const context = page.locator('.hc-inspector')

    await expect(sessions).toBeVisible()
    await artifactsButton.click()
    await expect(artifacts).toBeVisible()
    await expect(sessions).toBeHidden()
    await artifactsButton.click()
    await expect(artifacts).toBeHidden()
    await expect(sessions).toBeVisible()

    await contextButton.click()
    await expect(context).toBeVisible()
    await expect(sessions).toBeHidden()
    await contextButton.click()
    await expect(context).toBeHidden()
    await expect(sessions).toBeVisible()

    // Explicit user collapse is sticky across a temporary right workspace.
    await sessionsButton.click()
    await expect(sessions).toBeHidden()
    await contextButton.click()
    await expect(context).toBeVisible()
    await contextButton.click()
    await expect(context).toBeHidden()
    await expect(sessions).toBeHidden()

    await page.screenshot({
      path: `tests/e2e/screenshots/current-source/bug-20260723-chat-workspace-${browserName}-runtime.png`,
      fullPage: true,
    })
  })

  test('shared split button hover keeps the same DOM node and hit geometry', async ({
    page,
    browserName,
  }) => {
    await page.goto('/integration', { waitUntil: 'domcontentloaded' })

    const split = page.locator('.hc-split-btn')
    await expect(split).toBeVisible()
    await split.evaluate((element) => element.setAttribute('data-e2e-stable-node', 'split'))
    const beforeHover = await stableVisualState(split)
    await split.hover()
    const afterHover = await stableVisualState(split)

    expect(afterHover.nodeMarker).toBe('split')
    expect(afterHover.rect).toEqual(beforeHover.rect)
    expect(afterHover.transform).toBe(beforeHover.transform)

    await split.screenshot({
      path: `tests/e2e/screenshots/current-source/bug-20260723-split-hover-${browserName}-runtime.png`,
    })
  })
})
