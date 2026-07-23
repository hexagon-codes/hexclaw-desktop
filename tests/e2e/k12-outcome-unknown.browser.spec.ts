import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'

const SESSION_ID = 'session-outcome-unknown'
const JOB_ID = 'job-outcome-unknown'
const AGENT_A = 'k12-tutor-mingming'
const AGENT_B = 'k12-tutor-xiaowang'
const NOW = '2026-07-23T09:00:00.000Z'
const GRADING_BINDING_KEY = 'hexclaw.k12.grading-job-bindings.v1'
const SESSION_AGENT_KEY = 'hexclaw_sessionAgents'

type GradingRequest = {
  method: string
  path: string
  agent: string
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function outcomeUnknownStatus() {
  const job = {
    job_id: JOB_ID,
    submission_id: 'submission-outcome-unknown',
    stage: 'outcome_unknown',
    confirmation_state: 'confirmed',
    anchor_state: 'located',
    deadline: 0,
    idempotency_key: 'desktop|fixture|v1',
    confirmed_version: 1,
    stage_checkpoints: [],
    attempt_count: 1,
    failure_kind: 'provider_outcome_unknown',
    retryable: false,
    version: 3,
    created_at: 1,
    updated_at: 2,
  }
  return {
    job_id: JOB_ID,
    stage: 'outcome_unknown',
    confirmation_state: 'confirmed',
    anchor_state: 'located',
    deadline: 0,
    confirmed_version: 1,
    job,
  }
}

async function installBrowserRuntime(page: Page, gradingRequests: GradingRequest[]) {
  await page.addInitScript(
    ({ agentA, gradingBindingKey, jobId, sessionAgentKey, sessionId }) => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      if (!localStorage.getItem(sessionAgentKey)) {
        localStorage.setItem(sessionAgentKey, JSON.stringify({ [sessionId]: agentA }))
      }
      if (!localStorage.getItem(gradingBindingKey)) {
        localStorage.setItem(
          gradingBindingKey,
          JSON.stringify({
            version: 1,
            bindings: { [sessionId]: { agent_id: agentA, job_id: jobId } },
          }),
        )
      }

      class MockWebSocket extends EventTarget {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3

        readyState = MockWebSocket.CONNECTING
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent<string>) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onclose: ((event: CloseEvent) => void) | null = null

        constructor(_url: string) {
          super()
          setTimeout(() => {
            this.readyState = MockWebSocket.OPEN
            const event = new Event('open')
            this.onopen?.(event)
            this.dispatchEvent(event)
          }, 0)
        }

        send(_raw: string) {}

        close() {
          if (this.readyState === MockWebSocket.CLOSED) return
          this.readyState = MockWebSocket.CLOSED
          const event = new CloseEvent('close')
          this.onclose?.(event)
          this.dispatchEvent(event)
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      })
    },
    {
      agentA: AGENT_A,
      gradingBindingKey: GRADING_BINDING_KEY,
      jobId: JOB_ID,
      sessionAgentKey: SESSION_AGENT_KEY,
      sessionId: SESSION_ID,
    },
  )

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path.startsWith('/api/k12/grading-jobs')) {
      gradingRequests.push({
        method,
        path,
        agent: requestUrl.searchParams.get('agent') ?? '',
      })
      if (method === 'GET' && path === `/api/k12/grading-jobs/${JOB_ID}`) {
        return json(route, outcomeUnknownStatus())
      }
      return json(route, { error: 'unexpected grading route' }, 409)
    }

    if (path === '/api/v1/config/llm') {
      return json(route, {
        default: 'mock-provider',
        providers: {
          'mock-provider': {
            api_key: '',
            base_url: 'http://127.0.0.1:18080/v1',
            model: 'mock-model',
            models: ['mock-model'],
            compatible: 'openai',
            tools_enabled: false,
            max_tools: 0,
          },
        },
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false, similarity: 0.88, ttl: '24h', max_entries: 1000 },
      })
    }
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: true, version: 'e2e', associated: true, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [] })
    if (path === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (path === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (path === '/api/v1/knowledge/documents') {
      return json(route, { documents: [], total: 0 })
    }
    if (path === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: AGENT_A,
            display_name: '小明的辅导助手',
            model: 'mock-model',
            provider: 'mock-provider',
            metadata: {
              scenario: 'k12-tutor',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级上',
            },
          },
          {
            name: AGENT_B,
            display_name: '小王的辅导助手',
            model: 'mock-model',
            provider: 'mock-provider',
            metadata: {
              scenario: 'k12-tutor',
              'k12.child_name': '小王',
              'k12.grade_term': '五年级上',
            },
          },
        ],
        total: 2,
        default: AGENT_A,
      })
    }
    if (method === 'GET' && path === '/api/v1/sessions') {
      return json(route, {
        sessions: [
          {
            id: SESSION_ID,
            title: '小明的辅导助手',
            created_at: NOW,
            updated_at: NOW,
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (method === 'GET' && path === `/api/v1/sessions/${SESSION_ID}/messages`) {
      return json(route, { messages: [], total: 0 })
    }
    if (method === 'GET' && path === `/api/v1/sessions/${SESSION_ID}/artifacts`) {
      return json(route, { artifacts: [], total: 0 })
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

    return json(route, {})
  })
}

async function expectUnknownCard(page: Page) {
  const inline = page.locator('#hc-chat-scenario-inline')
  const card = inline.getByTestId('recognize-outcome-unknown')
  await expect(card).toBeVisible()
  await expect(card).toContainText('结果待核实')
  await expect(card).toContainText(
    '本次批改结果尚未确认。为避免重复调用，系统不会自动重试；刷新或重新打开后仍会保留此状态。',
  )
  await expect(card.getByRole('button', { name: '查看结果状态' })).toBeVisible()
  await expect(inline).not.toContainText('整卷处理中')
  await expect(inline).not.toContainText('重试当前阶段')
  return card
}

async function screenshot(locator: ReturnType<Page['locator']>, testInfo: TestInfo, name: string) {
  await locator.screenshot({ path: testInfo.outputPath(name) })
}

test('outcome_unknown stops polling, stays read-only, restores after refresh, and never crosses agents', async ({
  page,
}, testInfo) => {
  const gradingRequests: GradingRequest[] = []
  await installBrowserRuntime(page, gradingRequests)

  await page.goto('/chat', { waitUntil: 'domcontentloaded' })
  const card = await expectUnknownCard(page)
  await screenshot(card, testInfo, 'outcome-unknown-card.png')

  expect(gradingRequests).toEqual([
    {
      method: 'GET',
      path: `/api/k12/grading-jobs/${JOB_ID}`,
      agent: AGENT_A,
    },
  ])
  // One full polling interval later the terminal projection must still have issued no second GET.
  await page.waitForTimeout(2_800)
  expect(gradingRequests).toHaveLength(1)

  const detailTrigger = card.getByRole('button', { name: '查看结果状态' })
  await detailTrigger.focus()
  await detailTrigger.click()
  const detail = page.getByTestId('recognize-outcome-dialog')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('本次批改没有得到可确认的完整结果。')
  await expect(detail).toContainText(
    '为避免重复调用和重复计费，系统不会自动重试。已完成的内容会安全保留；你可以稍后再查看，刷新或重新打开后仍会恢复这个状态。',
  )
  await expect(detail).toContainText('当前状态等待结果核实待核实')
  await expect(detail).toContainText('已完成内容已安全保留，不会从头重复处理已保留')
  await expect(detail.getByRole('button')).toHaveCount(1)
  await expect(detail.getByRole('button', { name: '关闭' })).toBeVisible()
  await expect(detail).not.toContainText(/outcome_unknown|invocation|ledger|checkpoint|调用 ID/i)
  expect(gradingRequests).toHaveLength(1)
  await screenshot(detail, testInfo, 'outcome-unknown-detail.png')

  await detail.getByRole('button', { name: '关闭' }).click()
  await expect(detail).toBeHidden()
  await expect(detailTrigger).toBeFocused()
  expect(gradingRequests).toHaveLength(1)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expectUnknownCard(page)
  expect(gradingRequests).toEqual([
    expect.objectContaining({ method: 'GET', path: `/api/k12/grading-jobs/${JOB_ID}` }),
    expect.objectContaining({ method: 'GET', path: `/api/k12/grading-jobs/${JOB_ID}` }),
  ])
  expect(gradingRequests.every((request) => request.agent === AGENT_A)).toBe(true)
  expect(
    gradingRequests.some(
      (request) =>
        request.method !== 'GET' ||
        request.path.endsWith('/confirm') ||
        request.path.endsWith('/retry') ||
        request.path.endsWith('/result'),
    ),
  ).toBe(false)

  // Keep the same session and persisted GradingJob binding, but switch the session's active K12 agent.
  // The binding must fail closed: no card and no request for the other child's view.
  const callsBeforeOtherAgent = gradingRequests.length
  await page.evaluate(
    ({ agentB, sessionAgentKey, sessionId }) => {
      localStorage.setItem(sessionAgentKey, JSON.stringify({ [sessionId]: agentB }))
    },
    { agentB: AGENT_B, sessionAgentKey: SESSION_AGENT_KEY, sessionId: SESSION_ID },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByText('小王的辅导助手', { exact: false }).first()).toBeVisible()
  await expect(page.getByTestId('recognize-outcome-unknown')).toHaveCount(0)
  expect(gradingRequests).toHaveLength(callsBeforeOtherAgent)

  const persisted = await page.evaluate((key) => localStorage.getItem(key), GRADING_BINDING_KEY)
  expect(JSON.parse(persisted ?? 'null')).toEqual({
    version: 1,
    bindings: { [SESSION_ID]: { agent_id: AGENT_A, job_id: JOB_ID } },
  })
})
