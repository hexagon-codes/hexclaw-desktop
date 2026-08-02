import { expect, test, type Page, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REFERENCE_URL = process.env.HEX_K12_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = 'http://127.0.0.1:5173'
const EVIDENCE_ROOT =
  '/Users/guoyanjun/work/hexclaw-docs/test/evidence/k12-skin-desktop-v9-20260802'
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const VIEWPORT = { width: 2048, height: 924 }
const K12_RECORD = JSON.stringify({ version: 1, preference: 'k12', introSeen: true })
const FIXTURE_NOW = '2026-07-29T12:49:13+08:00'
const K12_TUTOR_SOURCE_MESSAGE_ID = 'k12-tutor-p52-message'
const K12_TUTOR_DISPATCH_ID = 'k12-tutor-p52-dispatch'

// This is the public, recoverable ImageTask fixture corresponding to the
// authoritative K12 tutor scene. It is deliberately served through the same
// Sidecar-facing routes used by Desktop rather than injected into the DOM.
// The source has fourteen canonical chat-message wrappers plus one TaskShell;
// the prototype nests that TaskShell inside its fifteenth message wrapper.
// Geometry records both facts and compares the normalized visible message-unit
// count so the structural difference cannot be mistaken for business-state
// drift.
const k12TutorSourceMessages = [
  {
    id: K12_TUTOR_SOURCE_MESSAGE_ID,
    role: 'user',
    content: '📷 数学练习册 P52\n粘贴 / 手机拍照',
    timestamp: '2026-07-29T19:32:00+08:00',
    created_at: '2026-07-29T19:32:00+08:00',
  },
  {
    id: 'k12-tutor-message-2',
    role: 'assistant',
    content:
      '已完成必要核对。这是人教版五年级上册 · 第五单元《简易方程》练习页，共 3 道题；系统会继续自动批改并生成家长讲解。',
    timestamp: '2026-07-29T19:33:00+08:00',
    created_at: '2026-07-29T19:33:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-3',
    role: 'user',
    content: '1',
    timestamp: '2026-07-29T19:34:00+08:00',
    created_at: '2026-07-29T19:34:00+08:00',
  },
  {
    id: 'k12-tutor-message-4',
    role: 'assistant',
    content: '已程序验算。竖式先别管小数点，算完再数两个因数一共的小数位。',
    timestamp: '2026-07-29T19:35:00+08:00',
    created_at: '2026-07-29T19:35:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-5',
    role: 'user',
    content: '2',
    timestamp: '2026-07-29T19:36:00+08:00',
    created_at: '2026-07-29T19:36:00+08:00',
  },
  {
    id: 'k12-tutor-message-6',
    role: 'assistant',
    content: '先问孩子：要让左边只剩下 2x，等式两边应该同时做什么？',
    timestamp: '2026-07-29T19:37:00+08:00',
    created_at: '2026-07-29T19:37:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-7',
    role: 'user',
    content: '3',
    timestamp: '2026-07-29T19:38:00+08:00',
    created_at: '2026-07-29T19:38:00+08:00',
  },
  {
    id: 'k12-tutor-message-8',
    role: 'assistant',
    content: '先别急着告诉孩子答案：21.4 元里，苹果一共花了多少钱？',
    timestamp: '2026-07-29T19:39:00+08:00',
    created_at: '2026-07-29T19:39:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-9',
    role: 'user',
    content: '孩子的解法：3.8×3=10.4，21.4−10.4=11，11÷2=5.5。',
    timestamp: '2026-07-29T19:40:00+08:00',
    created_at: '2026-07-29T19:40:00+08:00',
  },
  {
    id: 'k12-tutor-message-10',
    role: 'assistant',
    content: '思路完全对，卡在第一步的小数乘法：3.8 × 3 正确是 11.4。',
    timestamp: '2026-07-29T19:41:00+08:00',
    created_at: '2026-07-29T19:41:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-11',
    role: 'assistant',
    content: '整页批改完成：作业原图作为结果主体，2 题已程序验算，第 3 题需要关注。',
    timestamp: '2026-07-29T19:42:00+08:00',
    created_at: '2026-07-29T19:42:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-12',
    role: 'user',
    content: '📷 另一张照片',
    timestamp: '2026-07-29T19:43:00+08:00',
    created_at: '2026-07-29T19:43:00+08:00',
  },
  {
    id: 'k12-tutor-message-13',
    role: 'assistant',
    content: '涉及【二元一次方程组】（初一内容）。这道题超出了小明五年级上的进度。',
    timestamp: '2026-07-29T19:44:00+08:00',
    created_at: '2026-07-29T19:44:00+08:00',
    agent_name: 'mingming',
  },
  {
    id: 'k12-tutor-message-14',
    role: 'assistant',
    content: '已标记超纲，不进入错题与学情；仍可保留原图和识别文本。',
    timestamp: '2026-07-29T19:45:00+08:00',
    created_at: '2026-07-29T19:45:00+08:00',
    agent_name: 'mingming',
  },
]

const k12TutorRecoveryDispatch = {
  dispatch_id: K12_TUTOR_DISPATCH_ID,
  task_intent: 'completed_homework',
  status: 'awaiting_confirmation',
  provider_display_name: 'HexClaw-GPT',
  model_id: 'gpt-5.6-sol',
  retryable: false,
  automatic_budget_seconds: 300,
  automatic_started_at: 1785295800,
  automatic_deadline_at: 1785296100,
  automatic_remaining_seconds: 258,
  operation_deadline_at: 1785296400,
  intent_evidence: ['answer_regions_present'],
  intent_confidence: 0.99,
  confirmation_candidates: [],
  target: { type: 'homework_submission', id: 'submission-k12-tutor-p52' },
  target_projection: {
    kind: 'homework',
    stage: 'awaiting_confirmation',
    confirmation_state: 'pending',
    anchor_state: 'located',
    recognition: {
      subject: '数学',
      questions: [
        {
          problem_id: 'k12-tutor-p1',
          problem_kind: 'standalone',
          source_number_path: ['一', '1'],
          display_label: '一、1',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '4 ÷ 0.5 = 8',
          raw_transcription: '4 ÷ 0.5 = 8',
          canonical_markdown: '4 \\div 0.5 = 8',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数除法'],
          answer_state: 'present',
          student_answer: '8',
          answer_canonical_valid: true,
          confirmation_required: false,
          confirmed_version: 1,
        },
        {
          problem_id: 'k12-tutor-p2',
          problem_kind: 'standalone',
          source_number_path: ['一', '2'],
          display_label: '一、2',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '10 × 0.01 = 0.1',
          raw_transcription: '10 × 0.01 = 0.1',
          canonical_markdown: '10 \\times 0.01 = 0.1',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数乘法'],
          answer_state: 'present',
          student_answer: '0.1',
          answer_canonical_valid: true,
          confirmation_required: true,
          confirmation_reasons: ['decimal_point'],
          confirmed_version: 0,
        },
        {
          problem_id: 'k12-tutor-p3-1',
          problem_kind: 'subproblem',
          parent_problem_id: 'k12-tutor-p3',
          subproblem_no: '1',
          source_number_path: ['三', '1'],
          display_label: '三、1',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '列出求梨总价的算式',
          raw_transcription: '列出求梨总价的算式',
          canonical_markdown: '列出求梨总价的算式',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['小数乘法'],
          answer_state: 'present',
          student_answer: '',
          answer_canonical_valid: true,
          confirmation_required: true,
          confirmation_reasons: ['evidence_conflict'],
          confirmed_version: 0,
        },
        {
          problem_id: 'k12-tutor-p3-2',
          problem_kind: 'subproblem',
          parent_problem_id: 'k12-tutor-p3',
          subproblem_no: '2',
          source_number_path: ['三', '2'],
          display_label: '三、2',
          page_asset_id: 'asset://k12-tutor/p52.png',
          question: '求梨每千克多少元',
          raw_transcription: '求梨每千克多少元',
          canonical_markdown: '求梨每千克多少元',
          canonical_valid: true,
          canonical_version: 1,
          knowledge_points: ['简易方程'],
          answer_state: 'present',
          student_answer: '',
          answer_canonical_valid: true,
          confirmation_required: false,
          confirmed_version: 1,
        },
      ],
    },
    progressive: {
      structure_version: 1,
      snapshot_revision: 8,
      problem_progress: [
        {
          problem_id: 'k12-tutor-p1',
          status: 'completed',
          input_revision: 1,
          published_revision: 1,
          current_disposition: 'result',
        },
        {
          problem_id: 'k12-tutor-p2',
          status: 'assessing',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'open',
        },
        {
          problem_id: 'k12-tutor-p3-1',
          status: 'awaiting_confirmation',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'open',
        },
        {
          problem_id: 'k12-tutor-p3-2',
          status: 'awaiting_confirmation',
          input_revision: 1,
          published_revision: 0,
          current_disposition: 'open',
        },
      ],
      coverage: {
        total: 4,
        published: 1,
        skipped: 0,
        awaiting: 2,
        failed: 0,
        status: 'in_progress',
        projection_revision: 8,
      },
    },
  },
  progress: { operation: 'homework', state: 'awaiting_confirmation' },
  version: 8,
  created_at: 1785295800,
  updated_at: 1785295842,
}

const k12Mistakes = [
  {
    record_id: 'm-apple',
    question: '苹果每千克 3.8 元，买 3 千克多少钱？',
    knowledge_point: '小数乘法',
    error_cause: '进位时遗漏小数点',
    status: 'reviewing',
    review_state: 'scheduled',
    version: 1,
    due_at: 1785081600,
    subject: '数学',
    review_kind: 'verify',
  },
  {
    record_id: 'm-eq',
    question: '解方程 2x + 15 = 43',
    knowledge_point: '简易方程',
    error_cause: '移项符号错',
    status: 'reviewing',
    review_state: 'scheduled',
    version: 1,
    due_at: 1785081600,
    subject: '数学',
    review_kind: 'verify',
  },
  {
    record_id: 'm-believe',
    question: 'believe —— 拼成 belive（少 e）',
    knowledge_point: 'Unit 4 听写',
    error_cause: '少写一个 e',
    status: 'reviewing',
    review_state: 'scheduled',
    version: 1,
    due_at: 1785081600,
    subject: '英语',
    review_kind: 'verbatim',
  },
  {
    record_id: 'm-poem',
    question: '梅须逊雪三分白，雪却输梅一段香',
    knowledge_point: '古诗默写',
    error_cause: '“逊”字书写错误',
    status: 'mastered',
    review_state: 'completed',
    version: 1,
    due_at: 1785081600,
    subject: '语文',
    review_kind: 'verbatim',
  },
]

const emptyWeeklyPlan = {
  plan_id: 'weekly-appearance-v9',
  agent: 'mingming',
  revision: 1,
  iso_week_year: 2026,
  iso_week_number: 31,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-27T00:00:00+08:00',
  week_end: '2026-08-02T23:59:59+08:00',
  local_start_date: '2026-07-27',
  local_end_date: '2026-08-02',
  status: 'draft',
  settings_revision: 1,
  tracks: [
    { plan_section: 'due_review', status: 'ready', items: [], arithmetic_batch: null },
    {
      plan_section: 'textbook_consolidation',
      status: 'disabled',
      items: [],
      arithmetic_batch: null,
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'disabled',
      items: [],
      arithmetic_batch: null,
    },
  ],
  manual_track_recommendations: {
    textbook_consolidation: {
      availability: 'setup_required',
      selected_item_count: 5,
      recommended_item_count: 5,
      min_item_count: 1,
      max_item_count: 10,
    },
    arithmetic_warmup: {
      availability: 'available',
      selected_item_count: 10,
      recommended_item_count: 10,
      min_item_count: 1,
      max_item_count: 20,
    },
  },
  created_at: FIXTURE_NOW,
  updated_at: FIXTURE_NOW,
}

const logs = [
  {
    id: 'log-1',
    timestamp: '2026-07-29T12:48:02+08:00',
    level: 'info',
    source: 'sidecar',
    message: 'engine started · listening on :16060',
    trace_id: 'boot-16060',
    domain: 'runtime',
  },
  {
    id: 'log-2',
    timestamp: '2026-07-29T12:48:02+08:00',
    level: 'debug',
    source: 'channels',
    message: 'loaded 6 platform adapters, 0 instances enabled',
    trace_id: 'adapter-load',
    domain: 'channels',
  },
  {
    id: 'log-3',
    timestamp: '2026-07-29T12:48:05+08:00',
    level: 'info',
    source: 'llm',
    message: 'local model (Ollama) connected · qwen3.5:9b ready',
    trace_id: 'ollama-ready',
    domain: 'llm',
  },
  {
    id: 'log-4',
    timestamp: '2026-07-29T12:49:13+08:00',
    level: 'warn',
    source: 'knowledge',
    message: 'embedding 未配置，知识库使用基础检索',
    trace_id: 'kb-fallback',
    domain: 'knowledge',
  },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installSourceFixture(
  page: Page,
  options?: { freshK12Entry?: boolean; k12TutorRecovery?: boolean },
) {
  const k12TutorRecovery = options?.k12TutorRecovery ?? false
  await page.setViewportSize(VIEWPORT)
  await page.addInitScript(
    ({ k12Record, freshK12Entry }) => {
      if (!sessionStorage.getItem('__hexclawK12V9FixtureInitialized')) {
        localStorage.clear()
        sessionStorage.clear()
        sessionStorage.setItem('__hexclawK12V9FixtureInitialized', '1')
        localStorage.setItem('hc-theme', 'light')
        localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
        localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
        localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming' }))
        if (!freshK12Entry) localStorage.setItem('hc-k12-appearance-v1', k12Record)
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

      // Desktop now owns the logs stream through NativeSidecarWebSocket rather
      // than window.WebSocket. Keep this browser-only fixture on the same
      // observable contract: opening the mocked Tauri socket emits one ordered
      // `open` event, so LogsStore loads the HTTP fixture below. Do not set
      // `isTauri`, otherwise regular HTTP fixture calls would bypass page.route.
      const fixtureCallbacks = new Map<number, (event: unknown) => void>()
      let nextFixtureCallbackId = 0
      const fixtureWindow = window as typeof window & {
        __TAURI_INTERNALS__?: Record<string, unknown>
      }
      const fixtureTauri = fixtureWindow.__TAURI_INTERNALS__ ?? {}
      fixtureTauri.transformCallback = (callback: (event: unknown) => void) => {
        const callbackId = ++nextFixtureCallbackId
        fixtureCallbacks.set(callbackId, callback)
        return callbackId
      }
      fixtureTauri.unregisterCallback = (callbackId: number) => {
        fixtureCallbacks.delete(callbackId)
      }
      fixtureTauri.invoke = async (
        command: string,
        args?: { onEvent?: { id?: number } },
      ): Promise<string | null> => {
        if (command === 'sidecar_socket_open') {
          const callbackId = args?.onEvent?.id
          if (typeof callbackId !== 'number') {
            throw new Error('fixture sidecar socket requires an event channel')
          }
          queueMicrotask(() => {
            fixtureCallbacks.get(callbackId)?.({ index: 0, message: { type: 'open' } })
          })
          return `k12-fixture-socket-${callbackId}`
        }
        if (command === 'sidecar_socket_close') return null
        throw new Error(`unsupported fixture Tauri command: ${command}`)
      }
      fixtureWindow.__TAURI_INTERNALS__ = fixtureTauri
    },
    { k12Record: K12_RECORD, freshK12Entry: options?.freshK12Entry ?? false },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { running: false, associated: false, models: [] }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/health') return json(route, { status: 'ok' })
    if (apiPath === '/api/v1/logs') return json(route, { logs, total: logs.length })
    if (apiPath === '/api/v1/logs/stats') {
      return json(route, {
        total: logs.length,
        by_level: { debug: 1, info: 2, warn: 1, error: 0 },
        by_source: { sidecar: 1, channels: 1, llm: 1, knowledge: 1 },
        requests_per_minute: 0,
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
    if (apiPath === '/api/v1/config') {
      return json(route, {
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        llm: { default: '', providers: {} },
        knowledge: { enabled: true },
        mcp: { enabled: true },
        cron: { enabled: true },
        webhook: { enabled: true },
        canvas: { enabled: true },
        voice: { enabled: true },
        sandbox: { network_enabled: true, allowed_paths: [] },
        security: {
          gateway_enabled: true,
          injection_detection: true,
          pii_filter: false,
          content_filter: true,
          rate_limit_rpm: 60,
        },
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
            description: '五年级下辅导',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
            },
          },
        ],
        total: 1,
        default: 'mingming',
      })
    }
    if (apiPath === '/api/v1/sessions') {
      return json(route, {
        sessions: [
          {
            id: 'session-k12',
            title: '小明的辅导助手 · 五年级',
            created_at: '2026-07-29T12:00:00+08:00',
            updated_at: '2026-07-29T12:48:00+08:00',
            message_count: k12TutorRecovery ? k12TutorSourceMessages.length : 0,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === '/api/v1/sessions/session-k12/messages') {
      return json(route, {
        messages: k12TutorRecovery ? k12TutorSourceMessages : [],
        total: k12TutorRecovery ? k12TutorSourceMessages.length : 0,
      })
    }
    if (apiPath === '/api/v1/streams/active') {
      return json(route, { streams: [], total: 0 })
    }
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
    if (apiPath === '/api/k12/image-tasks/recoverable' && method === 'GET') {
      return json(route, {
        items: k12TutorRecovery
          ? [
              {
                source_session: 'session-k12',
                source_message_id: K12_TUTOR_SOURCE_MESSAGE_ID,
                dispatch: k12TutorRecoveryDispatch,
              },
            ]
          : [],
      })
    }
    if (
      apiPath === `/api/k12/image-tasks/${K12_TUTOR_DISPATCH_ID}` &&
      method === 'GET' &&
      k12TutorRecovery
    ) {
      return json(route, { dispatch: k12TutorRecoveryDispatch })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        grade_term: '五年级',
        trend: { mastered: 6, reviewing: 5, retried: 6, archived: 0, total: 11 },
        weak_top3: [
          { knowledge_point: '简易方程', count: 5, share: 5 / 9, subject: '数学' },
          { knowledge_point: '小数乘法', count: 3, share: 3 / 9, subject: '数学' },
          { knowledge_point: '多边形面积', count: 1, share: 1 / 9, subject: '数学' },
        ],
        month_new_mistakes: 9,
        review_completion_rate: 0.72,
        consecutive_fail_kps: ['简易方程'],
        week_pending: 6,
        practice_pending: 6,
        suggestion:
          '“等式两边同时变化”连续 3 次未通过。建议先做 2 道等式性质热身，再进入本周复习卷中的方程题。',
      })
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, { progress: null })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: 'mingming',
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: FIXTURE_NOW,
        updated_at: FIXTURE_NOW,
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: emptyWeeklyPlan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
      return json(route, { items: k12Mistakes })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function installReferenceFixture(page: Page, theme: 'light' | 'dark') {
  await page.setViewportSize(VIEWPORT)
  await page.addInitScript(
    ({ k12Record }) => {
      try {
        localStorage.setItem('hexclaw.prototype.k12Appearance.v1', k12Record)
      } catch {
        // The authoritative prototype is normally served over HTTP; file:// remains diagnostic-only.
      }
    },
    { k12Record: JSON.stringify({ preference: 'k12', introSeen: true }) },
  )
  await page.goto(REFERENCE_URL)
  await page.evaluate((nextTheme) => {
    const prototypeWindow = window as typeof window & {
      applyThemeState?: (theme: 'light' | 'dark', announce: boolean) => void
    }
    prototypeWindow.applyThemeState?.(nextTheme, false)
    document.querySelector<HTMLButtonElement>('.sb-item[data-screen="logs"]')?.click()
  }, theme)
  await expect(page.locator('.screen[data-pane="logs"]')).toHaveClass(/\bon\b/)
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
}

async function installReferenceSettingsFixture(page: Page, theme: 'light' | 'dark') {
  await page.setViewportSize(VIEWPORT)
  await page.addInitScript(
    ({ k12Record }) => {
      localStorage.setItem('hexclaw.prototype.k12Appearance.v1', k12Record)
    },
    { k12Record: JSON.stringify({ preference: 'k12', introSeen: true }) },
  )
  await page.goto(REFERENCE_URL)
  await page.evaluate((nextTheme) => {
    const prototypeWindow = window as typeof window & {
      applyThemeState?: (theme: 'light' | 'dark', announce: boolean) => void
    }
    prototypeWindow.applyThemeState?.(nextTheme, false)
    document.querySelector<HTMLButtonElement>('.sb-item[data-screen="settings"]')?.click()
    const tabs = document.querySelectorAll<HTMLButtonElement>(
      '.screen[data-pane="settings"] [role="tab"]',
    )
    ;[...tabs].find((tab) => tab.textContent?.trim() === '系统设置')?.click()
  }, theme)
  await expect(page.locator('.screen[data-pane="settings"]')).toHaveClass(/\bon\b/)
  await expect(page.getByRole('tab', { name: '系统设置', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
}

async function waitForTransientFeedbackToSettle(source: Page, reference: Page) {
  await Promise.all([
    expect(source.locator('.hc-toast')).toHaveCount(0, { timeout: 10_000 }),
    expect(reference.locator('#toast')).not.toHaveClass(/\bon\b/, { timeout: 10_000 }),
  ])
}

async function sourceGeometry(page: Page) {
  return page.evaluate(() => {
    const measure = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        opacity: style.opacity,
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: {
        theme: document.documentElement.dataset.theme,
        skin: document.body.dataset.k12SkinActive,
        scene: document.body.dataset.scene,
        sceneLevel: document.body.dataset.k12SceneLevel,
      },
      sidebar: measure('.hc-sidebar'),
      main: measure('.hc-app__content'),
      sidebarScene: measure('.k12-global-presentation__sidebar-scene'),
      mainScene: measure('.k12-global-presentation__main-scene'),
      butterflies: document.querySelectorAll('.k12-ambient-butterfly').length,
      fireflies: document.querySelectorAll('.k12-ambient-firefly').length,
      navItems: [...document.querySelectorAll<HTMLElement>('.hc-sidebar__item')].map((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          id: node.dataset.navId,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          color: style.color,
          background: style.backgroundImage,
        }
      }),
    }
  })
}

async function referenceGeometry(page: Page) {
  return page.evaluate(() => {
    const measure = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        opacity: style.opacity,
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: {
        theme: document.documentElement.dataset.theme,
        skin: document.body.dataset.k12SkinActive,
        scene: document.body.dataset.scene,
        sceneLevel: document.body.dataset.k12SceneLevel,
      },
      sidebar: measure('.sb'),
      main: measure('.mn'),
      sidebarScene: measure('.k12-sidebar-art'),
      mainScene: measure('.mn'),
      butterflies: document.querySelectorAll('.k12-ambient-butterfly').length,
      fireflies: document.querySelectorAll('.k12-ambient-firefly').length,
      navItems: [...document.querySelectorAll<HTMLElement>('.sb-item')].map((node) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          id: node.dataset.screen,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          color: style.color,
          background: style.backgroundImage,
        }
      }),
    }
  })
}

async function writeComparisonEvidence(
  theme: 'light' | 'dark',
  source: Page,
  reference: Page,
  browserName: string,
) {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  await waitForTransientFeedbackToSettle(source, reference)
  const engineSuffix = browserName === 'webkit' ? '' : `-${browserName}`
  const referencePath = path.join(
    EVIDENCE_ROOT,
    `reference-${theme}-logs-2048x924${engineSuffix}.png`,
  )
  const sourcePath = path.join(
    EVIDENCE_ROOT,
    `implementation-${theme}-logs-2048x924${engineSuffix}.png`,
  )
  const diffPath = path.join(EVIDENCE_ROOT, `diff-${theme}-logs-2048x924${engineSuffix}.png`)
  await reference.screenshot({ path: referencePath, animations: 'disabled' })
  await source.screenshot({ path: sourcePath, animations: 'disabled' })
  const [referenceFacts, sourceFacts] = await Promise.all([
    referenceGeometry(reference),
    sourceGeometry(source),
  ])
  await writeFile(
    path.join(EVIDENCE_ROOT, `geometry-${theme}-logs-2048x924${engineSuffix}.json`),
    JSON.stringify({ reference: referenceFacts, implementation: sourceFacts }, null, 2),
  )
  const { stdout } = await execFileAsync(
    'python3',
    [PIXEL_DIFF_TOOL, referencePath, sourcePath, diffPath, '8'],
    { cwd: process.cwd() },
  )
  await writeFile(
    path.join(EVIDENCE_ROOT, `pixel-diff-${theme}-logs${engineSuffix}.json`),
    stdout.trim(),
  )
  return { referenceFacts, sourceFacts, pixelDiff: JSON.parse(stdout) }
}

async function writeGlobalRouteEvidence(
  routeId: string,
  source: Page,
  reference: Page,
  browserName: string,
) {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  await waitForTransientFeedbackToSettle(source, reference)
  const engineSuffix = browserName === 'webkit' ? '' : `-${browserName}`
  const stem = `light-global-${routeId}-2048x924${engineSuffix}`
  const referencePath = path.join(EVIDENCE_ROOT, `reference-${stem}.png`)
  const sourcePath = path.join(EVIDENCE_ROOT, `implementation-${stem}.png`)
  const diffPath = path.join(EVIDENCE_ROOT, `diff-${stem}.png`)
  await Promise.all([
    reference.screenshot({ path: referencePath, animations: 'disabled' }),
    source.screenshot({ path: sourcePath, animations: 'disabled' }),
  ])
  const [referenceFacts, sourceFacts] = await Promise.all([
    referenceGeometry(reference),
    sourceGeometry(source),
  ])
  await writeFile(
    path.join(EVIDENCE_ROOT, `geometry-${stem}.json`),
    JSON.stringify({ reference: referenceFacts, implementation: sourceFacts }, null, 2),
  )
  const { stdout } = await execFileAsync(
    'python3',
    [PIXEL_DIFF_TOOL, referencePath, sourcePath, diffPath, '8'],
    { cwd: process.cwd() },
  )
  await writeFile(path.join(EVIDENCE_ROOT, `pixel-diff-${stem}.json`), stdout.trim())
  return { referenceFacts, sourceFacts, pixelDiff: JSON.parse(stdout) }
}

async function settingsGeometry(page: Page, implementation: boolean) {
  return page.evaluate(
    async (selectors) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim()
      const digest = async (value: string) => {
        const bytes = new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
        )
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      }
      const measure = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          border: style.border,
          borderRadius: style.borderRadius,
          background: style.background,
          color: style.color,
        }
      }
      const selectedRadio = (selector: string) =>
        normalizeText(
          document.querySelector<HTMLElement>(`${selector} [role="radio"][aria-checked="true"]`)
            ?.textContent,
        )
      const settingsRoot = document.querySelector<HTMLElement>(selectors.root)
      const activeTopTab = normalizeText(
        settingsRoot?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent,
      )
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        theme: document.documentElement.dataset.theme,
        skin: document.body.dataset.k12SkinActive,
        themeGroup: measure(selectors.themeGroup),
        k12Group: measure(selectors.k12Group),
        k12Card: measure(selectors.k12Card),
        genericCard: measure(selectors.genericCard),
        runtimeState: {
          activeTopTab,
          themeChoice: selectedRadio(selectors.themeGroup),
          k12AppearanceChoice: selectedRadio(selectors.k12Group),
          // Store a digest only: settings can contain user-controlled model
          // and provider labels, which must not leak into visual evidence.
          visibleConfigurationHash: await digest(
            normalizeText(settingsRoot?.innerText || settingsRoot?.textContent),
          ),
        },
      }
    },
    implementation
      ? {
          root: '.hc-settings',
          themeGroup: '.hc-settings__theme-segmented',
          k12Group: '.k12-appearance-settings__grid',
          k12Card: '.k12-appearance-settings__card:first-child',
          genericCard: '.k12-appearance-settings__card:last-child',
        }
      : {
          root: '.screen[data-pane="settings"]',
          themeGroup: '.system-theme-segmented',
          k12Group: '.system-k12-skin-grid',
          k12Card: '.system-k12-skin-card:first-child',
          genericCard: '.system-k12-skin-card:last-child',
        },
  )
}

async function writeSettingsEvidence(
  theme: 'light' | 'dark',
  source: Page,
  reference: Page,
  browserName: string,
) {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  await waitForTransientFeedbackToSettle(source, reference)
  await Promise.all([source.mouse.move(1200, 20), reference.mouse.move(1200, 20)])
  const engineSuffix = browserName === 'webkit' ? '' : `-${browserName}`
  const referencePath = path.join(
    EVIDENCE_ROOT,
    `reference-${theme}-settings-2048x924${engineSuffix}.png`,
  )
  const sourcePath = path.join(
    EVIDENCE_ROOT,
    `implementation-${theme}-settings-2048x924${engineSuffix}.png`,
  )
  const diffPath = path.join(EVIDENCE_ROOT, `diff-${theme}-settings-2048x924${engineSuffix}.png`)
  await reference.screenshot({ path: referencePath, animations: 'disabled' })
  await source.screenshot({ path: sourcePath, animations: 'disabled' })
  const [referenceFacts, sourceFacts] = await Promise.all([
    settingsGeometry(reference, false),
    settingsGeometry(source, true),
  ])
  const stateDifferences = [
    [
      'activeTopTab',
      referenceFacts.runtimeState.activeTopTab,
      sourceFacts.runtimeState.activeTopTab,
    ],
    ['themeChoice', referenceFacts.runtimeState.themeChoice, sourceFacts.runtimeState.themeChoice],
    [
      'k12AppearanceChoice',
      referenceFacts.runtimeState.k12AppearanceChoice,
      sourceFacts.runtimeState.k12AppearanceChoice,
    ],
    [
      'visibleConfigurationHash',
      referenceFacts.runtimeState.visibleConfigurationHash,
      sourceFacts.runtimeState.visibleConfigurationHash,
    ],
  ].flatMap(([field, referenceValue, implementationValue]) =>
    JSON.stringify(referenceValue) === JSON.stringify(implementationValue)
      ? []
      : [{ field, reference: referenceValue, implementation: implementationValue }],
  )
  const stateEquivalence = {
    comparable: stateDifferences.length === 0,
    differences: stateDifferences,
    rule: 'VIS-026 requires the same visible settings state; geometry alone cannot establish equivalence.',
  }
  await writeFile(
    path.join(EVIDENCE_ROOT, `geometry-${theme}-settings-2048x924${engineSuffix}.json`),
    JSON.stringify(
      { reference: referenceFacts, implementation: sourceFacts, stateEquivalence },
      null,
      2,
    ),
  )
  const { stdout } = await execFileAsync(
    'python3',
    [PIXEL_DIFF_TOOL, referencePath, sourcePath, diffPath, '8'],
    { cwd: process.cwd() },
  )
  await writeFile(
    path.join(EVIDENCE_ROOT, `pixel-diff-${theme}-settings${engineSuffix}.json`),
    stdout.trim(),
  )
  return { referenceFacts, sourceFacts, stateEquivalence, pixelDiff: JSON.parse(stdout) }
}

function displacement(before: DOMRect | DOMRectReadOnly, after: DOMRect | DOMRectReadOnly) {
  return Math.hypot(after.x - before.x, after.y - before.y)
}

/**
 * The approved ≤6px Dark-firefly limit is the element's own translate vector
 * from its static anchor. A breathing scale intentionally changes a sampled
 * bounding box edge, so bbox delta is retained as a visibility signal but is
 * not a measure of travel amplitude.
 */
function transformTranslation(transform: string) {
  const matrix = transform.match(/^matrix\(([^)]+)\)$/)
  if (matrix) {
    const values = matrix[1]!.split(',').map((value) => Number.parseFloat(value.trim()))
    if (values.length === 6 && values.every(Number.isFinite)) {
      const x = values[4]!
      const y = values[5]!
      return { x, y, magnitude: Math.hypot(x, y) }
    }
  }

  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/)
  if (matrix3d) {
    const values = matrix3d[1]!.split(',').map((value) => Number.parseFloat(value.trim()))
    if (values.length === 16 && values.every(Number.isFinite)) {
      const x = values[12]!
      const y = values[13]!
      return { x, y, magnitude: Math.hypot(x, y) }
    }
  }

  throw new Error(`expected an animating CSS matrix, received ${transform}`)
}

type K12VisualSurface = 'tutor' | 'records' | 'insights'

async function openReferenceK12Surface(
  page: Page,
  theme: 'light' | 'dark',
  surface: K12VisualSurface,
) {
  await page.addInitScript(
    ({ k12Record }) => {
      localStorage.setItem('hexclaw.prototype.k12Appearance.v1', k12Record)
    },
    { k12Record: JSON.stringify({ preference: 'k12', introSeen: true }) },
  )
  await page.goto(REFERENCE_URL)
  await page.evaluate(
    ({ nextTheme, nextSurface }) => {
      const api = window as typeof window & {
        applyThemeState?: (theme: 'light' | 'dark', announce: boolean) => void
        goK12Learner?: (learner: string) => void
        goRecords?: (learner: string, tab: number) => void
        k12BookTab?: (tab: number) => void
        k12Tab?: (tab: string) => void
      }
      api.applyThemeState?.(nextTheme, false)
      if (nextSurface === 'tutor') {
        api.goK12Learner?.('ming')
        return
      }
      api.goRecords?.('ming', nextSurface === 'records' ? 1 : 0)
      if (nextSurface === 'records') api.k12BookTab?.(1)
      else api.k12Tab?.('insights')
    },
    { nextTheme: theme, nextSurface: surface },
  )
  const ready =
    surface === 'tutor'
      ? '#chatTutorView .chat-top.k12hd'
      : surface === 'records'
        ? '#k12ViewRecords'
        : '#k12BookPanel5'
  await expect(page.locator(ready)).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function openSourceK12Surface(
  page: Page,
  theme: 'light' | 'dark',
  surface: K12VisualSurface,
) {
  const scenarioTab =
    surface === 'records'
      ? '&scenarioTab=records'
      : surface === 'insights'
        ? '&scenarioTab=insights'
        : ''
  await page.goto(
    `/chat?role=mingming&roleTitle=${encodeURIComponent('小明的辅导助手')}${scenarioTab}`,
  )
  if (theme === 'dark') {
    await page.evaluate(() => localStorage.setItem('hc-theme', 'dark'))
    await page.reload()
  }
  // Vite's first cold transform of the K12 feature graph can exceed Playwright's
  // 5s assertion default; the fixture itself is deterministic once mounted.
  await expect(page.locator('.k12enh-seg')).toBeVisible({ timeout: 30_000 })
  if (surface === 'records') {
    await expect(page.locator('.k12rec')).toBeVisible()
    const mistakes = page.getByTestId('subtab-mistakes')
    await mistakes.click()
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
  } else if (surface === 'insights') {
    await expect(page.getByTestId('insight-panel')).toBeVisible()
    await expect(page.getByTestId('insight-priority-card')).toBeVisible()
  }
  await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function k12SurfaceGeometry(page: Page, implementation: boolean) {
  return page.evaluate(async (isImplementation) => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? '').replace(/\s+/g, ' ').trim()
    const digest = async (value: string) => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      )
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    const measure = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      }
    }
    const selectors = isImplementation
      ? {
          sidebar: '.hc-sidebar',
          main: '.hc-app__content',
          scene: '.k12-global-presentation__main-scene',
          chatSidebar: '.hc-chat__sidebar',
          tutor: '.k12enh',
          records: '.k12rec',
          insights: '[data-testid="insight-panel"]',
          tiles: '.k12ins__tiles',
          priority: '[data-testid="insight-priority-card"]',
        }
      : {
          sidebar: '.sb',
          main: '.mn',
          scene: '.mn',
          chatSidebar: '.chat-sessions',
          tutor: '#chatTutorView',
          records: '#k12ViewRecords',
          insights: '#k12BookPanel5',
          tiles: '#k12BookPanel5 .mini-grid',
          priority: '#k12BookPanel5 .k12-priority-card',
        }
    const messageWrappers = isImplementation
      ? document.querySelectorAll('.hc-msg').length
      : document.querySelectorAll('#k12ThreadMing .msg').length
    const taskShells = isImplementation
      ? document.querySelectorAll('[data-testid="k12-photo-assistant-message"]').length
      : document.querySelectorAll('#k12ThreadMing [data-k12-task-shell]').length
    const messageNodes = Array.from(
      document.querySelectorAll<HTMLElement>(isImplementation ? '.hc-msg' : '#k12ThreadMing .msg'),
    )
    const taskShellNodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        isImplementation
          ? '[data-testid="k12-photo-assistant-message"]'
          : '#k12ThreadMing [data-k12-task-shell]',
      ),
    )
    const messageRole = (node: HTMLElement) =>
      isImplementation
        ? node.classList.contains('hc-msg--user')
          ? 'user'
          : 'assistant'
        : node.classList.contains('user')
          ? 'user'
          : 'assistant'
    // VIS-026 evidence must retain only irreversible content signatures. It
    // intentionally does not write fixture conversation copy to disk.
    const messageSignatures = await Promise.all(
      messageNodes.map(async (node) => ({
        role: messageRole(node),
        contentHash: await digest(normalizeText(node.innerText || node.textContent)),
      })),
    )
    const taskShellSignatures = await Promise.all(
      taskShellNodes.map(async (node) => ({
        fixtureKey:
          node.getAttribute('data-source-message-id') ??
          node.getAttribute('data-session-operation-id') ??
          '',
        intent: node.getAttribute('data-task-intent') ?? '',
        stage:
          node
            .querySelector<HTMLElement>('[data-task-progress-state]')
            ?.getAttribute('data-task-progress-state') ??
          node.getAttribute('data-task-stage') ??
          '',
        contentHash: await digest(normalizeText(node.innerText || node.textContent)),
      })),
    )
    const scrollContainer = document.querySelector<HTMLElement>(
      isImplementation ? '.hc-chat__messages' : '#k12ViewChat .chat-thread',
    )
    const scrollRect = scrollContainer?.getBoundingClientRect()
    const firstVisibleMessage = messageNodes
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(
        ({ rect }) => !!scrollRect && rect.bottom > scrollRect.top && rect.top < scrollRect.bottom,
      )
      .sort((left, right) => left.rect.top - right.rect.top)[0]
    const visibleScrollAnchor = firstVisibleMessage
      ? {
          kind: 'message',
          role: messageRole(firstVisibleMessage.node),
          contentHash: await digest(
            normalizeText(
              firstVisibleMessage.node.innerText || firstVisibleMessage.node.textContent,
            ),
          ),
          relativeTop: Math.round((firstVisibleMessage.rect.top - scrollRect!.top) * 100) / 100,
          containsTaskShell: Boolean(
            firstVisibleMessage.node.querySelector(
              isImplementation
                ? '[data-testid="k12-photo-assistant-message"]'
                : '[data-k12-task-shell]',
            ),
          ),
        }
      : null
    const activeTab = normalizeText(
      document.querySelector<HTMLElement>(
        isImplementation
          ? '.k12enh-seg [role="tab"][aria-selected="true"]'
          : '.k12tabs [role="tab"][aria-selected="true"]',
      )?.textContent,
    )
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      body: {
        theme: document.documentElement.dataset.theme,
        skin: document.body.dataset.k12SkinActive,
        scene: document.body.dataset.scene,
        sceneLevel: document.body.dataset.k12SceneLevel,
      },
      sidebar: measure(selectors.sidebar),
      main: measure(selectors.main),
      scene: measure(selectors.scene),
      chatSidebar: measure(selectors.chatSidebar),
      tutor: measure(selectors.tutor),
      records: measure(selectors.records),
      insights: measure(selectors.insights),
      tiles: measure(selectors.tiles),
      priority: measure(selectors.priority),
      butterflies: document.querySelectorAll('.k12-ambient-butterfly').length,
      fireflies: document.querySelectorAll('.k12-ambient-firefly').length,
      blackboardOverlayNodes: document.querySelectorAll(
        '[data-k12-blackboard],.k12-blackboard,.k12-board',
      ).length,
      runtimeState: {
        // The prototype embeds TaskProgressCard in a .msg wrapper; Desktop
        // renders its same source-anchored TaskShell as a Teleport sibling.
        // Preserve the raw wrapper count and compare the visual message-unit
        // count so the fixture checks user-visible business state, not a
        // framework-specific wrapper nesting detail.
        messageWrappers,
        messages: messageWrappers + (isImplementation ? taskShells : 0),
        taskShells,
        activeTab,
        messageSequence: {
          count: messageSignatures.length,
          digest: await digest(JSON.stringify(messageSignatures)),
        },
        taskShellSequence: {
          count: taskShellSignatures.length,
          digest: await digest(JSON.stringify(taskShellSignatures)),
        },
        visibleScrollAnchor,
        composerLocked: isImplementation
          ? Boolean(
              document.querySelector<HTMLElement>(
                '.hc-chat__input-area [data-testid="chat-input"][aria-disabled="true"]',
              ),
            )
          : Boolean(
              document.querySelector<HTMLButtonElement>(
                '#k12ViewChat .chat-input[data-session-operation-lock] .ci-send:disabled',
              ),
            ),
      },
    }
  }, implementation)
}

async function writeK12SurfaceEvidence(
  surface: K12VisualSurface,
  theme: 'light' | 'dark',
  source: Page,
  reference: Page,
  browserName: string,
) {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  await waitForTransientFeedbackToSettle(source, reference)
  await Promise.all([source.mouse.move(1100, 20), reference.mouse.move(1100, 20)])
  const engineSuffix = browserName === 'webkit' ? '' : `-${browserName}`
  const stem = `${theme}-k12-${surface}-2048x924${engineSuffix}`
  const referencePath = path.join(EVIDENCE_ROOT, `reference-${stem}.png`)
  const sourcePath = path.join(EVIDENCE_ROOT, `implementation-${stem}.png`)
  const diffPath = path.join(EVIDENCE_ROOT, `diff-${stem}.png`)
  await reference.screenshot({ path: referencePath, animations: 'disabled' })
  await source.screenshot({ path: sourcePath, animations: 'disabled' })
  const [referenceFacts, sourceFacts] = await Promise.all([
    k12SurfaceGeometry(reference, false),
    k12SurfaceGeometry(source, true),
  ])
  const stateDifferences = [
    ['messages', referenceFacts.runtimeState.messages, sourceFacts.runtimeState.messages],
    ['taskShells', referenceFacts.runtimeState.taskShells, sourceFacts.runtimeState.taskShells],
    [
      'composerLocked',
      referenceFacts.runtimeState.composerLocked,
      sourceFacts.runtimeState.composerLocked,
    ],
    ['activeTab', referenceFacts.runtimeState.activeTab, sourceFacts.runtimeState.activeTab],
    [
      'messageSequence',
      referenceFacts.runtimeState.messageSequence,
      sourceFacts.runtimeState.messageSequence,
    ],
    [
      'taskShellSequence',
      referenceFacts.runtimeState.taskShellSequence,
      sourceFacts.runtimeState.taskShellSequence,
    ],
    [
      'visibleScrollAnchor',
      referenceFacts.runtimeState.visibleScrollAnchor,
      sourceFacts.runtimeState.visibleScrollAnchor,
    ],
  ].flatMap(([field, referenceValue, implementationValue]) =>
    JSON.stringify(referenceValue) === JSON.stringify(implementationValue)
      ? []
      : [{ field, reference: referenceValue, implementation: implementationValue }],
  )
  const stateEquivalence = {
    comparable: stateDifferences.length === 0,
    differences: stateDifferences,
    rule: 'VIS-026 requires the same business state; pixel difference is diagnostic only when this value is false.',
  }
  await writeFile(
    path.join(EVIDENCE_ROOT, `geometry-${stem}.json`),
    JSON.stringify(
      {
        reference: referenceFacts,
        implementation: sourceFacts,
        stateEquivalence,
      },
      null,
      2,
    ),
  )
  const { stdout } = await execFileAsync(
    'python3',
    [PIXEL_DIFF_TOOL, referencePath, sourcePath, diffPath, '8'],
    { cwd: process.cwd() },
  )
  await writeFile(path.join(EVIDENCE_ROOT, `pixel-diff-${stem}.json`), stdout.trim())
  return { referenceFacts, sourceFacts, stateEquivalence, pixelDiff: JSON.parse(stdout) }
}

async function writeResponsiveEvidence(
  viewport: { width: number; height: number },
  source: Page,
  reference: Page,
  browserName: string,
) {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const engineSuffix = browserName === 'webkit' ? '' : `-${browserName}`
  const stem = `light-k12-insights-${viewport.width}x${viewport.height}${engineSuffix}`
  const referencePath = path.join(EVIDENCE_ROOT, `reference-${stem}.png`)
  const sourcePath = path.join(EVIDENCE_ROOT, `implementation-${stem}.png`)
  const diffPath = path.join(EVIDENCE_ROOT, `diff-${stem}.png`)
  await reference.screenshot({ path: referencePath, animations: 'disabled' })
  await source.screenshot({ path: sourcePath, animations: 'disabled' })
  const [referenceFacts, sourceFacts] = await Promise.all([
    k12SurfaceGeometry(reference, false),
    k12SurfaceGeometry(source, true),
  ])
  const responsiveFacts = await source.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    fireflyLayerDisplay: getComputedStyle(
      document.querySelector<HTMLElement>('.k12-global-presentation__fireflies')!,
    ).display,
  }))
  await writeFile(
    path.join(EVIDENCE_ROOT, `geometry-${stem}.json`),
    JSON.stringify(
      { reference: referenceFacts, implementation: sourceFacts, responsive: responsiveFacts },
      null,
      2,
    ),
  )
  const { stdout } = await execFileAsync(
    'python3',
    [PIXEL_DIFF_TOOL, referencePath, sourcePath, diffPath, '8'],
    { cwd: process.cwd() },
  )
  await writeFile(path.join(EVIDENCE_ROOT, `pixel-diff-${stem}.json`), stdout.trim())
  return { referenceFacts, sourceFacts, responsiveFacts, pixelDiff: JSON.parse(stdout) }
}

test.describe('K12-SKIN-DESKTOP v9 @ WebKit', () => {
  test('GOV-014/LAYOUT-021/VIS-028: authoritative light and dark shell evidence', async ({
    browser,
    browserName,
  }) => {
    // A paired light/dark capture writes four full-resolution PNGs and two
    // pixel-difference artifacts. WebKit can spend more than the default
    // 60 seconds encoding those evidence files even after every UI assertion
    // has completed, so keep the test bounded without turning it flaky.
    test.setTimeout(180_000)
    const contextOptions = {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: 'no-preference' as const,
    }
    const sourceContext = await browser.newContext({ ...contextOptions, baseURL: SOURCE_URL })
    const referenceContext = await browser.newContext(contextOptions)
    const page = await sourceContext.newPage()
    const reference = await referenceContext.newPage()

    try {
      await installSourceFixture(page)
      await page.goto('/logs')
      await expect(page.locator('.hc-logs-page')).toBeVisible()
      await expect(page.getByText('engine started · listening on :16060')).toBeVisible()
      await expect(page.locator('[data-testid="k12-global-presentation"]')).toHaveCount(1)

      await installReferenceFixture(reference, 'light')
      const light = await writeComparisonEvidence('light', page, reference, browserName)

      expect(light.sourceFacts.body.skin).toBe('k12')
      expect(light.sourceFacts.viewport.devicePixelRatio).toBe(1)
      expect(light.referenceFacts.viewport.devicePixelRatio).toBe(1)
      expect(light.sourceFacts.sidebar?.rect.width).toBe(226)
      expect(light.referenceFacts.sidebar?.rect.width).toBe(226)
      expect(light.sourceFacts.butterflies).toBe(2)
      expect(light.referenceFacts.butterflies).toBe(2)
      expect(light.sourceFacts.fireflies).toBe(18)
      expect(light.referenceFacts.fireflies).toBe(18)

      await page.evaluate(() => localStorage.setItem('hc-theme', 'dark'))
      await page.reload()
      await expect(page.locator('.hc-logs-page')).toBeVisible()
      await reference.evaluate(() => {
        const prototypeWindow = window as typeof window & {
          applyThemeState?: (theme: 'dark', announce: boolean) => void
        }
        prototypeWindow.applyThemeState?.('dark', false)
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(reference.locator('html')).toHaveAttribute('data-theme', 'dark')
      const dark = await writeComparisonEvidence('dark', page, reference, browserName)
      expect(dark.sourceFacts.viewport.devicePixelRatio).toBe(1)
      expect(dark.referenceFacts.viewport.devicePixelRatio).toBe(1)
      expect(dark.sourceFacts.fireflies).toBe(18)
      expect(dark.referenceFacts.fireflies).toBe(18)
    } finally {
      await Promise.all([sourceContext.close(), referenceContext.close()])
    }
  })

  test('GLOBAL-019/A11Y-025: one shared scene across all eight keyboard-reachable pages', async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(240_000)
    const contextOptions = {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: 'no-preference' as const,
    }
    const sourceContext = await browser.newContext({ ...contextOptions, baseURL: SOURCE_URL })
    const referenceContext = await browser.newContext(contextOptions)
    const source = await sourceContext.newPage()
    const reference = await referenceContext.newPage()
    const routes = [
      { id: 'chat', path: '/chat' },
      { id: 'agents', path: '/agents' },
      { id: 'knowledge', path: '/knowledge' },
      { id: 'automation', path: '/automation' },
      { id: 'channels', path: '/channels' },
      { id: 'integration', path: '/integration' },
      { id: 'logs', path: '/logs' },
      { id: 'settings', path: '/settings' },
    ] as const
    const evidence: Record<string, unknown> = {}

    try {
      await installSourceFixture(source)
      await source.goto('/logs')
      // `page.goto()` resolves before Vue Router has necessarily mounted its
      // direct-route component. Waiting for the real logs surface prevents a
      // keyboard assertion from starting while the URL is /logs but the app
      // is still rendering its bootstrap /chat route.
      await expect(source.locator('.hc-logs-page')).toBeVisible()
      // The visible route can mount before the native startup splash has
      // completed its 700 ms minimum display plus fade-out. Wait for that
      // interaction shield to be removed before exercising actual keyboard
      // navigation, rather than retrying an activation that a user could not
      // yet perform.
      await expect(source.locator('#splash-screen')).toHaveCount(0)
      await installReferenceFixture(reference, 'light')

      for (const route of routes) {
        const sourceNav = source.locator(`[data-nav-id="${route.id}"]`)
        await sourceNav.focus()
        await expect(sourceNav).toBeFocused()
        // Exercise the same physical keyboard path a user uses. The first
        // lazy-loaded view can take longer than Playwright's default 5 s
        // while Vite transforms it, but it must still produce the real URL
        // and active route rather than a page-local visual switch.
        await source.keyboard.press('Enter')
        await expect(source).toHaveURL(new RegExp(`${route.path.replace('/', '\\/')}(?:[?#]|$)`), {
          timeout: 20_000,
        })
        await expect(sourceNav).toHaveClass(/hc-sidebar__item--active/)

        const referenceNav = reference.locator(`.sb-item[data-screen="${route.id}"]`)
        await referenceNav.click()
        await expect(referenceNav).toHaveClass(/\bon\b/)

        await expect(source.locator('[data-testid="k12-global-presentation"]')).toHaveCount(1)
        await expect(source.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
        await expect(source.locator('.k12-global-presentation__sidebar-scene')).toHaveCSS(
          'background-image',
          /k12-scene-light\.png/,
        )
        await expect(source.locator('.k12-global-presentation__main-scene')).toHaveCSS(
          'background-image',
          /k12-content-light\.png/,
        )
        await expect(source.locator('.k12-ambient-butterfly')).toHaveCount(2)
        await expect(source.locator('.k12-ambient-firefly')).toHaveCount(18)
        await expect(
          source.locator('[data-k12-blackboard],.k12-blackboard,.k12-board'),
        ).toHaveCount(0)

        const comparison = await writeGlobalRouteEvidence(route.id, source, reference, browserName)
        expect(comparison.sourceFacts.viewport.devicePixelRatio).toBe(1)
        expect(comparison.referenceFacts.viewport.devicePixelRatio).toBe(1)
        expect(comparison.sourceFacts.sidebar?.rect.width).toBe(226)
        expect(comparison.referenceFacts.sidebar?.rect.width).toBe(226)
        evidence[route.id] = comparison
      }

      await writeFile(
        path.join(EVIDENCE_ROOT, `global-route-summary-${browserName}.json`),
        JSON.stringify(evidence, null, 2),
      )
    } finally {
      await Promise.all([sourceContext.close(), referenceContext.close()])
    }
  })

  for (const surface of ['tutor', 'records', 'insights'] as const) {
    test(`GLOBAL-019/READING-022/VIS-026: ${surface} light and dark paired evidence`, async ({
      browser,
      browserName,
    }) => {
      test.setTimeout(90_000)
      const contextOptions = {
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        reducedMotion: 'no-preference' as const,
      }
      const sourceContext = await browser.newContext({ ...contextOptions, baseURL: SOURCE_URL })
      const referenceContext = await browser.newContext(contextOptions)
      const source = await sourceContext.newPage()
      const reference = await referenceContext.newPage()

      try {
        await installSourceFixture(source, { k12TutorRecovery: surface === 'tutor' })
        for (const theme of ['light', 'dark'] as const) {
          await openSourceK12Surface(source, theme, surface)
          await openReferenceK12Surface(reference, theme, surface)
          const comparison = await writeK12SurfaceEvidence(
            surface,
            theme,
            source,
            reference,
            browserName,
          )
          expect(comparison.sourceFacts.viewport.devicePixelRatio).toBe(1)
          expect(comparison.referenceFacts.viewport.devicePixelRatio).toBe(1)
          expect(comparison.sourceFacts.sidebar?.rect.width).toBe(226)
          expect(comparison.referenceFacts.sidebar?.rect.width).toBe(226)
          expect(comparison.sourceFacts.chatSidebar?.rect.width).toBe(256)
          expect(comparison.sourceFacts.scene?.backgroundImage).not.toBe('none')
          expect(comparison.sourceFacts.butterflies).toBe(2)
          expect(comparison.sourceFacts.fireflies).toBe(18)
          expect(comparison.sourceFacts.blackboardOverlayNodes).toBe(0)
          if (surface === 'tutor') {
            // RED for BUG-20260801-012 / VIS-026: equal wrapper counts, a
            // TaskShell count and a locked composer do not prove that the
            // paired viewport shows the same business state. The captured
            // reference is anchored at the P52 TaskShell while Desktop is
            // scrolled to the tail of a different message sequence.
            expect(comparison.stateEquivalence.comparable).toBe(false)
            expect(comparison.stateEquivalence.differences).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ field: 'messageSequence' }),
                expect.objectContaining({ field: 'visibleScrollAnchor' }),
              ]),
            )
          } else {
            // The authoritative prototype retains an active task while its
            // archive/insight panel is open. Current Desktop deliberately
            // restores that task into the tutor panel, so these screenshots
            // remain diagnostic-only until an approved equivalent fixture is
            // available; see VIS-026 rather than masking the drift.
            expect(comparison.stateEquivalence.comparable).toBe(false)
          }

          if (surface === 'records') {
            expect(comparison.sourceFacts.records?.rect.width).toBe(1024)
          }
          if (surface === 'insights') {
            expect(comparison.sourceFacts.insights?.rect.width).toBe(1024)
            expect(comparison.sourceFacts.priority?.rect.x).toBe(
              comparison.sourceFacts.tiles?.rect.x,
            )
            expect(comparison.sourceFacts.priority?.rect.width).toBe(
              comparison.sourceFacts.tiles?.rect.width,
            )
          }
        }
      } finally {
        await Promise.all([sourceContext.close(), referenceContext.close()])
      }
    })
  }

  for (const viewport of [
    { width: 1280, height: 820 },
    { width: 900, height: 600 },
  ]) {
    test(`VIS-026/REDUCED-024: responsive paired evidence ${viewport.width}x${viewport.height}`, async ({
      browser,
      browserName,
    }) => {
      const contextOptions = {
        viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        reducedMotion: 'no-preference' as const,
      }
      const sourceContext = await browser.newContext({ ...contextOptions, baseURL: SOURCE_URL })
      const referenceContext = await browser.newContext(contextOptions)
      const source = await sourceContext.newPage()
      const reference = await referenceContext.newPage()
      try {
        await installSourceFixture(source)
        await source.setViewportSize(viewport)
        await reference.setViewportSize(viewport)
        await openSourceK12Surface(source, 'light', 'insights')
        await openReferenceK12Surface(reference, 'light', 'insights')
        const comparison = await writeResponsiveEvidence(viewport, source, reference, browserName)
        expect(comparison.sourceFacts.viewport).toMatchObject({ ...viewport, devicePixelRatio: 1 })
        expect(comparison.referenceFacts.viewport).toMatchObject({
          ...viewport,
          devicePixelRatio: 1,
        })
        expect(comparison.responsiveFacts.documentWidth).toBeLessThanOrEqual(
          comparison.responsiveFacts.viewportWidth,
        )
        expect(comparison.sourceFacts.insights?.rect.width).toBeLessThanOrEqual(1024)
        expect(comparison.sourceFacts.chatSidebar?.rect.width).toBe(
          viewport.width <= 1040 ? 220 : 256,
        )
        expect(comparison.responsiveFacts.fireflyLayerDisplay).toBe(
          viewport.width <= 1040 ? 'none' : 'block',
        )
      } finally {
        await Promise.all([sourceContext.close(), referenceContext.close()])
      }
    })
  }

  test('A11Y-025: no serious or critical violations on logs, settings and K12 tutor', async ({
    browserName,
    page,
  }) => {
    test.setTimeout(120_000)
    await installSourceFixture(page)
    const evidence: Record<string, unknown> = {}
    const newSeriousOrCritical: Array<{
      state: string
      id: string
      impact: string | null
      target: string
    }> = []

    for (const state of [
      { name: 'logs', url: '/logs', include: '.hc-logs-page' },
      { name: 'settings', url: '/settings', include: '.hc-settings' },
      {
        name: 'tutor',
        url: `/chat?role=mingming&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
        include: '.hc-chat',
      },
    ]) {
      if (state.name === 'tutor') await openSourceK12Surface(page, 'light', 'tutor')
      else await page.goto(state.url)
      if (state.name === 'settings') {
        await page.getByRole('tab', { name: '系统设置', exact: true }).click()
        await expect(page.getByRole('radiogroup', { name: 'K12 外观', exact: true })).toBeVisible()
      } else if (state.name === 'tutor') {
        await expect(page.locator('.k12enh-seg')).toBeVisible()
      } else {
        await expect(page.locator('.hc-logs-page')).toBeVisible()
      }
      await expect(page.locator(state.include)).toBeVisible({ timeout: 30_000 })
      const k12Analysis = await new AxeBuilder({ page })
        .include(state.include)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()

      await page.evaluate(() =>
        localStorage.setItem(
          'hc-k12-appearance-v1',
          JSON.stringify({ version: 1, preference: 'default', introSeen: true }),
        ),
      )
      await page.reload()
      if (state.name === 'settings') {
        await page.getByRole('tab', { name: '系统设置', exact: true }).click()
      }
      await expect(page.locator(state.include)).toBeVisible({ timeout: 30_000 })
      const genericAnalysis = await new AxeBuilder({ page })
        .include(state.include)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      evidence[state.name] = { k12: k12Analysis, generic: genericAnalysis }

      const genericSignatures = new Set(
        genericAnalysis.violations.flatMap((violation) =>
          violation.nodes.map(
            (node) => `${violation.id}\u0000${node.target.map(String).join('\u0001')}`,
          ),
        ),
      )
      for (const violation of k12Analysis.violations) {
        if (violation.impact !== 'serious' && violation.impact !== 'critical') continue
        for (const node of violation.nodes) {
          const target = node.target.map(String).join(' > ')
          const signature = `${violation.id}\u0000${node.target.map(String).join('\u0001')}`
          if (genericSignatures.has(signature)) continue
          newSeriousOrCritical.push({
            state: state.name,
            id: violation.id,
            impact: violation.impact,
            target,
          })
        }
      }

      await page.evaluate(() =>
        localStorage.setItem(
          'hc-k12-appearance-v1',
          JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
        ),
      )
    }

    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      path.join(EVIDENCE_ROOT, `axe-${browserName}-logs-settings-tutor.json`),
      JSON.stringify({ newSeriousOrCritical, analyses: evidence }, null, 2),
    )
    expect(newSeriousOrCritical).toEqual([])
    await expect(page.locator('[data-testid="k12-global-presentation"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    await expect(page.locator('[data-testid="k12-global-presentation"]')).toHaveCSS(
      'pointer-events',
      'none',
    )
  })

  test('A11Y-025: 200 percent WebKit text scaling keeps core settings reachable', async ({
    browserName,
    page,
  }) => {
    await installSourceFixture(page)
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto('/settings')
    const systemTab = page.getByRole('tab', { name: '系统设置', exact: true })
    await systemTab.focus()
    await page.keyboard.press('Enter')
    const scalingSetup = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll<HTMLElement>(
          '.hc-sidebar, .hc-sidebar *, .hc-settings, .hc-settings *',
        ),
      ]
      const scalable = nodes
        .map((node) => ({ node, size: Number.parseFloat(getComputedStyle(node).fontSize) }))
        .filter(({ node, size }) => node.textContent?.trim() && Number.isFinite(size) && size > 0)
      const systemTabNode = document.querySelector<HTMLElement>('[data-testid="segmented-system"]')
      const beforeSystemTabFontSize = systemTabNode
        ? Number.parseFloat(getComputedStyle(systemTabNode).fontSize)
        : null
      for (const { node, size } of scalable) node.style.fontSize = `${size * 2}px`
      return {
        scaledNodes: scalable.length,
        beforeSystemTabFontSize,
        afterSystemTabFontSize: systemTabNode
          ? Number.parseFloat(getComputedStyle(systemTabNode).fontSize)
          : null,
      }
    })

    const k12Group = page.getByRole('radiogroup', { name: 'K12 外观', exact: true })
    await expect(k12Group).toBeVisible()
    await k12Group.scrollIntoViewIfNeeded()
    await expect(k12Group.getByRole('radio', { name: /K12 专属皮肤/ })).toBeVisible()
    await expect(k12Group.getByRole('radio', { name: /通用外观/ })).toBeVisible()
    const scalingFacts = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      activeElementRole: document.activeElement?.getAttribute('role'),
    }))
    expect(scalingSetup.scaledNodes).toBeGreaterThan(0)
    expect(scalingSetup.afterSystemTabFontSize).toBe(
      (scalingSetup.beforeSystemTabFontSize ?? 0) * 2,
    )
    expect(scalingFacts.documentWidth).toBeLessThanOrEqual(scalingFacts.viewportWidth)

    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await page.screenshot({
      path: path.join(EVIDENCE_ROOT, `implementation-settings-text-200-${browserName}.png`),
      animations: 'disabled',
    })
    await writeFile(
      path.join(EVIDENCE_ROOT, `text-scaling-200-${browserName}.json`),
      JSON.stringify({ scalingSetup, scalingFacts }, null, 2),
    )
  })

  test('MOTION-027: butterflies and all fireflies move; Reduce Motion is stationary', async ({
    browserName,
    page,
  }) => {
    await installSourceFixture(page)
    await page.goto('/logs')
    await expect(page.locator('.hc-logs-page')).toBeVisible()

    const butterfly = page.locator('.k12-ambient-butterfly').first()
    await expect(butterfly).toHaveCSS('animation-name', /^k12ButterflyDriftOne(?:-|$)/)
    const butterflyBefore = await butterfly.evaluate((node) => ({
      transform: getComputedStyle(node).transform,
      rect: node.getBoundingClientRect().toJSON(),
    }))
    await page.waitForTimeout(650)
    const butterflyAfter = await butterfly.evaluate((node) => ({
      transform: getComputedStyle(node).transform,
      rect: node.getBoundingClientRect().toJSON(),
    }))
    expect(butterflyAfter.transform).not.toBe(butterflyBefore.transform)
    expect(displacement(butterflyBefore.rect, butterflyAfter.rect)).toBeGreaterThan(1)

    await page.evaluate(() => localStorage.setItem('hc-theme', 'dark'))
    await page.reload()
    const fireflies = page.locator('.k12-ambient-firefly')
    await expect(fireflies).toHaveCount(18)
    await expect(fireflies.first()).toHaveCSS('animation-name', /^k12FireflyDrift(?:-|$)/)
    await page.waitForTimeout(4000)
    const fireflyBefore = await fireflies.evaluateAll((nodes) =>
      nodes.map((node) => ({
        animationName: getComputedStyle(node).animationName,
        transform: getComputedStyle(node).transform,
        rect: node.getBoundingClientRect().toJSON(),
      })),
    )
    await page.waitForTimeout(650)
    const fireflyAfter = await fireflies.evaluateAll((nodes) =>
      nodes.map((node) => ({
        animationName: getComputedStyle(node).animationName,
        transform: getComputedStyle(node).transform,
        rect: node.getBoundingClientRect().toJSON(),
      })),
    )
    const fireflyMotion = fireflyBefore.map((before, index) => ({
      index,
      animationName: before.animationName,
      transformChanged: before.transform !== fireflyAfter[index]!.transform,
      displacement: displacement(before.rect, fireflyAfter[index]!.rect),
      beforeTranslation: transformTranslation(before.transform),
      afterTranslation: transformTranslation(fireflyAfter[index]!.transform),
    }))
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      path.join(EVIDENCE_ROOT, `motion-${browserName}-facts.json`),
      JSON.stringify(
        { butterflyBefore, butterflyAfter, fireflyBefore, fireflyAfter, fireflyMotion },
        null,
        2,
      ),
    )
    expect(
      fireflyMotion.every(
        (motion) =>
          motion.animationName.startsWith('k12FireflyDrift') &&
          motion.transformChanged &&
          motion.displacement > 0,
      ),
    ).toBe(true)
    const maximumFireflyDisplacement = Math.max(
      ...fireflyMotion.map((motion) => motion.displacement),
    )
    expect(maximumFireflyDisplacement).toBeGreaterThanOrEqual(2)
    const maximumFireflyTranslationMagnitude = Math.max(
      ...fireflyMotion.flatMap((motion) => [
        motion.beforeTranslation.magnitude,
        motion.afterTranslation.magnitude,
      ]),
    )
    expect(maximumFireflyTranslationMagnitude).toBeLessThanOrEqual(6)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    const reducedFirefly = page.locator('.k12-ambient-firefly').first()
    await expect(reducedFirefly).toHaveCSS('animation-name', 'none')
    const reducedBefore = await reducedFirefly.boundingBox()
    await page.waitForTimeout(650)
    const reducedAfter = await reducedFirefly.boundingBox()
    expect(reducedBefore).toEqual(reducedAfter)
  })

  test('ASSET-018: failed scene asset preserves a readable solid fallback and navigation', async ({
    browserName,
    page,
  }) => {
    const failedAssets: string[] = []
    page.on('requestfailed', (request) => {
      if (request.url().includes('k12-content-light.png')) failedAssets.push(request.url())
    })
    await page.route(/k12-content-light\.png(?:\?.*)?$/, (route) => route.abort('failed'))
    await installSourceFixture(page)
    await page.goto('/logs')
    await expect(page.locator('.hc-logs-page')).toBeVisible()
    await expect(page.getByText('engine started · listening on :16060')).toBeVisible()
    await expect(page.locator('.k12-global-presentation__main-scene')).toHaveCSS(
      'background-color',
      'rgb(255, 253, 246)',
    )
    await expect.poll(() => failedAssets.length).toBeGreaterThan(0)
    expect(
      await page
        .locator('img')
        .evaluateAll(
          (images) => images.filter((image) => !image.complete || image.naturalWidth === 0).length,
        ),
    ).toBe(0)

    const settingsNav = page.locator('[data-nav-id="settings"]')
    await settingsNav.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.locator('.hc-settings')).toBeVisible()

    await mkdir(EVIDENCE_ROOT, { recursive: true })
    const screenshotPath = path.join(
      EVIDENCE_ROOT,
      `implementation-light-asset-fallback-2048x924-${browserName}.png`,
    )
    await page.screenshot({ path: screenshotPath, animations: 'disabled' })
    await writeFile(
      path.join(EVIDENCE_ROOT, `asset-fallback-${browserName}.json`),
      JSON.stringify(
        {
          failedAssets,
          background: await page
            .locator('.k12-global-presentation__main-scene')
            .evaluate((node) => getComputedStyle(node).background),
          route: new URL(page.url()).pathname,
          brokenImages: 0,
        },
        null,
        2,
      ),
    )
  })

  test('PERF-030: generic loads no scene bitmap and each K12 theme loads one signed pair', async ({
    browserName,
    page,
  }) => {
    const requestedSceneAssets: string[] = []
    page.on('request', (request) => {
      if (/k12-(?:scene|content)-(?:light|dark)/.test(request.url())) {
        requestedSceneAssets.push(request.url())
      }
    })
    await installSourceFixture(page, { freshK12Entry: true })
    await page.goto('/logs')
    await expect(page.locator('.hc-logs-page')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const genericAssets = [...requestedSceneAssets]
    expect(genericAssets).toEqual([])

    await page.evaluate(() =>
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
      ),
    )
    await page.reload()
    await expect(page.locator('.k12-global-presentation__main-scene')).toHaveCSS(
      'background-image',
      /k12-content-light\.png/,
    )
    await page.waitForLoadState('networkidle')
    const lightAssets = requestedSceneAssets.filter((name) => /-(?:scene|content)-light/.test(name))
    expect(new Set(lightAssets).size).toBe(2)
    const lightMainBox = await page.locator('.hc-app__content').boundingBox()

    await page.evaluate(() => localStorage.setItem('hc-theme', 'dark'))
    await page.reload()
    await expect(page.locator('.k12-global-presentation__main-scene')).toHaveCSS(
      'background-image',
      /k12-content-dark\.png/,
    )
    await page.waitForLoadState('networkidle')
    const darkAssets = requestedSceneAssets.filter((name) => /-(?:scene|content)-dark/.test(name))
    expect(new Set(darkAssets).size).toBe(2)
    const darkMainBox = await page.locator('.hc-app__content').boundingBox()
    expect(darkMainBox).toEqual(lightMainBox)

    await mkdir(EVIDENCE_ROOT, { recursive: true })
    await writeFile(
      path.join(EVIDENCE_ROOT, `runtime-assets-${browserName}.json`),
      JSON.stringify(
        { genericAssets, lightAssets, darkAssets, lightMainBox, darkMainBox },
        null,
        2,
      ),
    )
  })

  test('SET-018/STATE-015: compact settings, persistence and theme orthogonality', async ({
    browser,
    browserName,
  }) => {
    test.setTimeout(180_000)
    const contextOptions = {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: 'no-preference' as const,
    }
    const sourceContext = await browser.newContext({ ...contextOptions, baseURL: SOURCE_URL })
    const referenceContext = await browser.newContext(contextOptions)
    const page = await sourceContext.newPage()
    const reference = await referenceContext.newPage()

    try {
      await installSourceFixture(page)
      await page.goto('/settings')
      await expect(page.locator('.hc-settings')).toBeVisible()

      for (const tab of ['LLM 服务商', '自动化权限', '系统设置']) {
        const tabButton = page.getByRole('tab', { name: tab, exact: true })
        await tabButton.focus()
        await page.keyboard.press('Enter')
        await expect(tabButton).toHaveAttribute('aria-selected', 'true')
      }

      const themeGroup = page.getByRole('radiogroup', { name: '外观', exact: true })
      await expect(themeGroup).toBeVisible()
      expect((await themeGroup.boundingBox())?.height).toBe(44)

      const k12Group = page.getByRole('radiogroup', { name: 'K12 外观', exact: true })
      await expect(k12Group).toBeVisible()
      const k12Card = k12Group.getByRole('radio', { name: /K12 专属皮肤/ })
      const genericCard = k12Group.getByRole('radio', { name: /通用外观/ })
      expect((await k12Card.boundingBox())?.height).toBe(60)
      expect((await genericCard.boundingBox())?.height).toBe(60)

      await installReferenceSettingsFixture(reference, 'light')
      const lightComparison = await writeSettingsEvidence('light', page, reference, browserName)
      expect(lightComparison.sourceFacts.viewport.devicePixelRatio).toBe(1)
      expect(lightComparison.referenceFacts.viewport.devicePixelRatio).toBe(1)
      expect(lightComparison.sourceFacts.themeGroup?.rect.height).toBe(44)
      expect(lightComparison.referenceFacts.themeGroup?.rect.height).toBe(44)
      expect(lightComparison.sourceFacts.k12Card?.rect.height).toBe(60)
      expect(lightComparison.referenceFacts.k12Card?.rect.height).toBe(60)
      // RED/Green closure for BUG-20260801-012: the captured source and
      // prototype have different visible settings configuration summaries.
      // Geometry is still useful evidence, but cannot be labeled comparable.
      expect(lightComparison.stateEquivalence.comparable).toBe(false)
      expect(lightComparison.stateEquivalence.differences).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'visibleConfigurationHash' })]),
      )

      await themeGroup.getByRole('radio', { name: '浅色', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await expect(themeGroup.getByRole('radio', { name: '深色', exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await k12Card.focus()
      await page.keyboard.press('ArrowRight')
      await expect(genericCard).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'default')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.reload()
      await page.getByRole('tab', { name: '系统设置', exact: true }).click()
      await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'default')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      const reloadedGenericCard = page
        .getByRole('radiogroup', { name: 'K12 外观', exact: true })
        .getByRole('radio', { name: /通用外观/ })
      await reloadedGenericCard.focus()
      await page.keyboard.press('ArrowLeft')
      await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'k12')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

      await installReferenceSettingsFixture(reference, 'dark')
      const comparison = await writeSettingsEvidence('dark', page, reference, browserName)
      expect(comparison.sourceFacts.viewport.devicePixelRatio).toBe(1)
      expect(comparison.referenceFacts.viewport.devicePixelRatio).toBe(1)
      expect(comparison.sourceFacts.themeGroup?.rect.height).toBe(44)
      expect(comparison.referenceFacts.themeGroup?.rect.height).toBe(44)
      expect(comparison.sourceFacts.k12Card?.rect.height).toBe(60)
      expect(comparison.referenceFacts.k12Card?.rect.height).toBe(60)
      expect(comparison.sourceFacts.genericCard?.rect.height).toBe(60)
      expect(comparison.referenceFacts.genericCard?.rect.height).toBe(60)
      expect(comparison.stateEquivalence.comparable).toBe(false)
      expect(comparison.stateEquivalence.differences).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'visibleConfigurationHash' })]),
      )
    } finally {
      await Promise.all([sourceContext.close(), referenceContext.close()])
    }
  })

  test('STATE-016/LAYOUT-022: first-entry action and shared responsive session width', async ({
    page,
  }) => {
    await installSourceFixture(page, { freshK12Entry: true })
    await page.goto(
      '/chat?role=mingming&roleTitle=%E5%B0%8F%E6%98%8E%E7%9A%84%E8%BE%85%E5%AF%BC%E5%8A%A9%E6%89%8B',
    )
    await expect(page.locator('.hc-chat__sidebar')).toBeVisible()
    expect((await page.locator('.hc-chat__sidebar').boundingBox())?.width).toBe(256)
    await expect(
      page.getByText('已启用 K12 专属皮肤，已应用到全部页面；已显示完整学习场景'),
    ).toBeVisible()
    const useGenericAppearance = page.getByRole('button', {
      name: '使用通用外观',
      exact: true,
    })
    await useGenericAppearance.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('body')).toHaveAttribute('data-k12-skin-active', 'default')
    await expect(page).toHaveURL(/\/chat/)

    await page.setViewportSize({ width: 1040, height: 924 })
    await expect(page.locator('.hc-chat__sidebar')).toHaveCSS('width', '220px')
    expect((await page.locator('.hc-chat__sidebar').boundingBox())?.width).toBe(220)
  })
})
