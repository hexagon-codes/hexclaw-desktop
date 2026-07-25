import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'

const SESSION_ID = 'session-outcome-unknown'
const OTHER_SESSION_ID = 'session-other-child'
const DISPATCH_ID = 'dispatch-recovering'
const AGENT_A = 'k12-tutor-mingming'
const AGENT_B = 'k12-tutor-xiaowang'
const NOW = '2026-07-23T09:00:00.000Z'
const IMAGE_TASK_BINDING_KEY = 'hexclaw.k12.image-task-bindings.v1'
const SESSION_AGENT_KEY = 'hexclaw_sessionAgents'

type ImageTaskRequest = {
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

function imageTaskStatus(stage: 'recovering' | 'completed') {
  return {
    dispatch: {
      dispatch_id: DISPATCH_ID,
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'homework-public-target' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: 'confirmed',
        anchor_state: 'located',
      },
      progress: { operation: 'homework', state: stage },
      version: 3,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function completedResult() {
  const question = {
    problem_id: 'problem-1',
    problem_kind: 'standalone',
    page_asset_id: 'asset-page-1',
    question: '4÷0.5=',
    raw_transcription: '4÷0.5=',
    canonical_markdown: '4\\div0.5=',
    canonical_valid: true,
    canonical_version: 1,
    knowledge_points: ['小数除法'],
    student_answer: '8',
    answer_canonical_markdown: '8',
    answer_canonical_valid: true,
    answer_state: 'present',
    confirmation_required: false,
    confirmed_version: 1,
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.08 },
  }
  return {
    dispatch_id: DISPATCH_ID,
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items: [
          {
            question,
            status: 'correct',
            result_kind: 'assessment',
            grade: {
              solution: '8',
              verdict: 'agree',
              evidence_type: 'numeric_exec',
              badge: 'verified-strong',
              out_of_scope: false,
              record_created: false,
              solve_only: false,
            },
          },
        ],
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64: 'QU5OT1RBVEVE',
          digest: 'sha256:annotated',
        },
      },
    },
  }
}

async function installBrowserRuntime(page: Page, imageTaskRequests: ImageTaskRequest[]) {
  await page.addInitScript(
    ({
      agentA,
      agentB,
      dispatchId,
      imageTaskBindingKey,
      otherSessionId,
      sessionAgentKey,
      sessionId,
    }) => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      if (!localStorage.getItem(sessionAgentKey)) {
        localStorage.setItem(
          sessionAgentKey,
          JSON.stringify({ [sessionId]: agentA, [otherSessionId]: agentB }),
        )
      }
      if (!localStorage.getItem(imageTaskBindingKey)) {
        localStorage.setItem(
          imageTaskBindingKey,
          JSON.stringify({
            version: 1,
            bindings: { [sessionId]: { agent_id: agentA, dispatch_id: dispatchId } },
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
      agentB: AGENT_B,
      dispatchId: DISPATCH_ID,
      imageTaskBindingKey: IMAGE_TASK_BINDING_KEY,
      otherSessionId: OTHER_SESSION_ID,
      sessionAgentKey: SESSION_AGENT_KEY,
      sessionId: SESSION_ID,
    },
  )

  let imageTaskStatusReads = 0
  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path.startsWith('/api/k12/image-tasks')) {
      imageTaskRequests.push({
        method,
        path,
        agent: requestUrl.searchParams.get('agent') ?? '',
      })
      if (method === 'GET' && path === `/api/k12/image-tasks/${DISPATCH_ID}`) {
        imageTaskStatusReads += 1
        return json(route, imageTaskStatus(imageTaskStatusReads === 1 ? 'recovering' : 'completed'))
      }
      if (method === 'GET' && path === `/api/k12/image-tasks/${DISPATCH_ID}/result`) {
        return json(route, completedResult())
      }
      return json(route, { error: 'unexpected image task route' }, 409)
    }

    if (
      path.startsWith('/api/k12/grading-jobs') ||
      path.startsWith('/api/k12/recognize') ||
      path.startsWith('/api/k12/creative-work-ocr-jobs')
    ) {
      imageTaskRequests.push({
        method,
        path,
        agent: requestUrl.searchParams.get('agent') ?? '',
      })
      return json(route, { error: 'removed public route' }, 410)
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
            agent_id: AGENT_A,
            created_at: NOW,
            updated_at: NOW,
            message_count: 0,
          },
          {
            id: OTHER_SESSION_ID,
            title: '小王的辅导助手',
            agent_id: AGENT_B,
            created_at: NOW,
            updated_at: NOW,
            message_count: 0,
          },
        ],
        total: 2,
      })
    }
    if (
      method === 'GET' &&
      (path === `/api/v1/sessions/${SESSION_ID}/messages` ||
        path === `/api/v1/sessions/${OTHER_SESSION_ID}/messages`)
    ) {
      return json(route, { messages: [], total: 0 })
    }
    if (
      method === 'GET' &&
      (path === `/api/v1/sessions/${SESSION_ID}/artifacts` ||
        path === `/api/v1/sessions/${OTHER_SESSION_ID}/artifacts`)
    ) {
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

async function expectRecoveringProjection(page: Page) {
  const inline = page.locator('#hc-chat-scenario-inline')
  const progress = inline.getByTestId('recognize-recovering')
  await expect(progress).toBeVisible()
  await expect(progress).toContainText('正在恢复批改结果')
  await expect(progress).toContainText('不会重新创建任务或重复提交')
  await expect(inline).not.toContainText('结果待核实')
  await expect(inline.getByRole('button', { name: '查看结果状态' })).toHaveCount(0)
  await expect(page.getByTestId('recognize-outcome-dialog')).toHaveCount(0)
  await expect(inline).not.toContainText('整卷处理中')
  await expect(inline).not.toContainText('重试当前阶段')
  return progress
}

async function screenshot(locator: ReturnType<Page['locator']>, testInfo: TestInfo, name: string) {
  await locator.screenshot({ path: testInfo.outputPath(name) })
}

function statusReads(requests: ImageTaskRequest[]) {
  return requests.filter(
    ({ method, path }) => method === 'GET' && path === `/api/k12/image-tasks/${DISPATCH_ID}`,
  )
}

function assertFacadeReadOnly(requests: ImageTaskRequest[]) {
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every(({ agent }) => agent === AGENT_A)).toBe(true)
  expect(
    requests.every(
      ({ method, path }) =>
        method === 'GET' &&
        (path === `/api/k12/image-tasks/${DISPATCH_ID}` ||
          path === `/api/k12/image-tasks/${DISPATCH_ID}/result`),
    ),
  ).toBe(true)
}

test('recovering is transient, converges on the same dispatch, and restores after refresh/session switches', async ({
  page,
}, testInfo) => {
  const imageTaskRequests: ImageTaskRequest[] = []
  await installBrowserRuntime(page, imageTaskRequests)

  await page.goto('/chat', { waitUntil: 'domcontentloaded' })
  const progress = await expectRecoveringProjection(page)
  await screenshot(progress, testInfo, 'recovering-inline-progress.png')

  await expect(page.getByTestId('photo-grade-overlay')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('recognize-recovering')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(
    /outcome_unknown|provider_outcome_unknown|submission-outcome|invocation|ledger|checkpoint|调用 ID/i,
  )
  expect(statusReads(imageTaskRequests)).toHaveLength(3)
  assertFacadeReadOnly(imageTaskRequests)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('photo-grade-overlay')).toBeVisible({ timeout: 10_000 })
  const readsAfterRefresh = statusReads(imageTaskRequests).length
  expect(readsAfterRefresh).toBeGreaterThan(3)
  assertFacadeReadOnly(imageTaskRequests)

  const callsBeforeOtherSession = imageTaskRequests.length
  await page.locator(`[data-session-id="${OTHER_SESSION_ID}"]`).click()
  await expect(page.locator(`[data-session-id="${OTHER_SESSION_ID}"]`)).toHaveClass(
    /hc-sessions__item--active/,
  )
  await expect(page.getByTestId('recognize-recovering')).toHaveCount(0)
  await expect(page.getByTestId('photo-grade-overlay')).toHaveCount(0)
  expect(imageTaskRequests).toHaveLength(callsBeforeOtherSession)

  await page.locator(`[data-session-id="${SESSION_ID}"]`).click()
  await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveClass(
    /hc-sessions__item--active/,
  )
  await expect(page.getByTestId('photo-grade-overlay')).toBeVisible({ timeout: 10_000 })
  expect(statusReads(imageTaskRequests).length).toBeGreaterThan(readsAfterRefresh)
  assertFacadeReadOnly(imageTaskRequests)
  await expect(page.locator('body')).not.toContainText('结果待核实')
  await expect(page.getByRole('button', { name: '查看结果状态' })).toHaveCount(0)
  await expect(page.getByTestId('recognize-outcome-dialog')).toHaveCount(0)

  const persisted = await page.evaluate((key) => localStorage.getItem(key), IMAGE_TASK_BINDING_KEY)
  expect(JSON.parse(persisted ?? 'null')).toEqual({
    version: 1,
    bindings: { [SESSION_ID]: { agent_id: AGENT_A, dispatch_id: DISPATCH_ID } },
  })
})
