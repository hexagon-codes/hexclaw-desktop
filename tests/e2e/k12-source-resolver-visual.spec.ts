import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL =
  process.env.HEX_SOURCE_RESOLVER_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL =
  process.env.HEX_SOURCE_RESOLVER_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT =
  process.env.HEX_SOURCE_RESOLVER_EVIDENCE_ROOT?.trim() ||
  path.resolve('tmp/k12-source-resolver-visual-evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PROTOTYPE_PATH = '/Users/guoyanjun/work/hexclaw-docs/prototype/app.html'
const SOURCE_ASSET_PATH =
  '/Users/guoyanjun/work/hexclaw-docs/prototype/assets/k12-source-pageasset-problem-group-3.png'
// Re-pinned after directly re-verifying the current authoritative resolver DOM, CSS,
// interaction handlers, and immutable source-asset digest.
const EXPECTED_PROTOTYPE_SHA256 = '6e53af59df9af6bed7161453fefa78a8af08ea1f675ef4ecccc5297c7b619000'
const EXPECTED_SOURCE_ASSET_SHA256 =
  '717e72254e151e53e51ea61b9523800eb1746776c699aca3e19950a3b3e51c3b'
const SOURCE_ASSET_FILE = 'k12-source-pageasset-problem-group-3.png'
const PAGE_ASSET_ID = `asset://k12-source-visual/${SOURCE_ASSET_FILE}`
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const BBOX_TOLERANCE_PX = 0.5

const AGENT = 'k12-source-resolver-ming'
const SESSION = 'k12-source-resolver-session'
const MESSAGE = 'k12-source-resolver-message'
const DISPATCH = 'k12-source-resolver-dispatch'
// The public wire projection carries parent_problem_id but not dependency_group_id,
// so the current renderer deterministically derives this group identity.
const IMPLEMENTATION_GROUP_ID = 'parent:problem-3-parent'
const FIXED_NOW_MS = Date.parse('2026-08-03T19:32:42+08:00')
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000)
const NOW = new Date(FIXED_NOW_MS).toISOString()

type ResolverState = 'region' | 'retake'

interface PixelDiffReport {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: [number, number, number, number] | null
}

interface CriticalNodeDefinition {
  key: string
  selector: string
}

interface CriticalNodeSnapshot {
  count: number
  nodes: Array<{
    tag: string
    text: string
    rect: { x: number; y: number; width: number; height: number }
    style: Record<string, string>
    attributes: Record<string, string | null>
  }>
}

const STYLE_FIELDS = [
  'display',
  'position',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'backgroundColor',
  'backgroundImage',
  'color',
  'border',
  'borderRadius',
  'boxShadow',
  'padding',
  'margin',
  'gap',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'overflowX',
  'overflowY',
  'cursor',
  'touchAction',
  'outline',
] as const

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
})

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function recognizedQuestion(
  problemId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    problem_id: problemId,
    problem_kind: 'standalone',
    question: '',
    raw_transcription: '',
    canonical_markdown: '',
    canonical_valid: true,
    canonical_version: 1,
    knowledge_points: [],
    answer_state: 'present',
    student_answer: '',
    answer_canonical_valid: true,
    confirmation_required: false,
    confirmed_version: 1,
    ...fields,
  }
}

const sourceFacts = {
  page_asset_id: PAGE_ASSET_ID,
  source_width: 430,
  source_height: 520,
  source_region: { x: 18, y: 324, width: 394, height: 126 },
}

const questions = [
  recognizedQuestion('problem-1', {
    source_number_path: ['一', '1'],
    display_label: '第 1 题（系统序号）',
    source_section_path: ['一'],
    source_section_label: '一、直接写得数',
    system_section_ordinal: 1,
    system_display_label: '第 1 题（系统序号）',
    question: '4 ÷ 0.5 = 8',
    raw_transcription: '4 ÷ 0.5 = 8',
    canonical_markdown: '4 \\div 0.5 = 8',
    knowledge_points: ['小数除法'],
    student_answer: '8',
  }),
  recognizedQuestion('problem-2', {
    source_number_path: ['一', '2'],
    display_label: '第 2 题（系统序号）',
    source_section_path: ['一'],
    source_section_label: '一、直接写得数',
    system_section_ordinal: 1,
    system_display_label: '第 2 题（系统序号）',
    question: '10 × 0.01 = 0.1',
    raw_transcription: '10 × 0.01 = 0.1',
    canonical_markdown: '10 \\times 0.01 = 0.1',
    knowledge_points: ['小数乘法'],
    student_answer: '0.1',
  }),
  recognizedQuestion('problem-3-parent', {
    problem_kind: 'compound_parent',
    source_number_path: ['三'],
    display_label: '公共题干',
    source_section_path: ['三'],
    source_section_label: '三',
    system_section_ordinal: 3,
    system_display_label: '第 3 题（系统序号）',
    ...sourceFacts,
    question: '苹果 3.8 元/千克，买 3 千克；梨买 2 千克，共 21.4 元',
    raw_transcription: '苹果 3.8 元/千克，买 3 千克；梨买 2 千克，共 21.4 元',
    canonical_markdown: '苹果 3.8 元/千克，买 3 千克；梨买 2 千克，共 21.4 元',
    answer_state: 'blank',
    student_answer: '',
  }),
  recognizedQuestion('problem-3-1', {
    problem_kind: 'subproblem',
    parent_problem_id: 'problem-3-parent',
    subproblem_no: '1',
    source_number_path: ['三', '1'],
    display_label: '三、1',
    system_section_ordinal: 3,
    ...sourceFacts,
    question: '列出求梨总价的算式',
    raw_transcription: '列出求梨总价的算式',
    canonical_markdown: '列出求梨总价的算式',
    knowledge_points: ['小数混合运算'],
    confirmation_required: true,
    confirmation_reasons: ['evidence_conflict'],
    confirmed_version: 0,
  }),
  recognizedQuestion('problem-3-2', {
    problem_kind: 'subproblem',
    parent_problem_id: 'problem-3-parent',
    subproblem_no: '2',
    source_number_path: ['三', '2'],
    display_label: '三、2',
    system_section_ordinal: 3,
    ...sourceFacts,
    question: '求梨每千克多少元',
    raw_transcription: '求梨每千克多少元',
    canonical_markdown: '求梨每千克多少元',
    knowledge_points: ['小数混合运算'],
    confirmation_required: true,
    confirmation_reasons: ['evidence_conflict'],
    confirmed_version: 0,
  }),
]

const problemProgress = [
  {
    problem_id: 'problem-1',
    status: 'correct',
    input_revision: 1,
    published_revision: 1,
    current_disposition: 'current',
  },
  {
    problem_id: 'problem-2',
    status: 'processing',
    input_revision: 1,
    published_revision: 0,
    current_disposition: 'current',
  },
  {
    problem_id: 'problem-3-1',
    status: 'awaiting_source',
    input_revision: 1,
    published_revision: 0,
    current_disposition: 'current',
  },
  {
    problem_id: 'problem-3-2',
    status: 'awaiting_source',
    input_revision: 1,
    published_revision: 0,
    current_disposition: 'current',
  },
]

const weeklyPlan = {
  plan_id: 'weekly-source-resolver-visual',
  agent: AGENT,
  revision: 1,
  iso_week_year: 2026,
  iso_week_number: 32,
  timezone: 'Asia/Shanghai',
  week_start: '2026-08-03T00:00:00+08:00',
  week_end: '2026-08-09T23:59:59+08:00',
  local_start_date: '2026-08-03',
  local_end_date: '2026-08-09',
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
  created_at: NOW,
  updated_at: NOW,
}

function dispatchFixture() {
  return {
    dispatch_id: DISPATCH,
    task_intent: 'completed_homework',
    status: 'routed',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    retryable: false,
    automatic_budget_seconds: 300,
    automatic_started_at: FIXED_NOW_SECONDS - 42,
    automatic_deadline_at: FIXED_NOW_SECONDS + 258,
    automatic_remaining_seconds: 258,
    operation_deadline_at: FIXED_NOW_SECONDS + 558,
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-source-resolver-visual' },
    target_projection: {
      kind: 'homework',
      stage: 'assessing',
      confirmation_state: 'confirmed',
      anchor_state: 'located',
      recognition: { subject: '数学', questions },
      progressive: {
        structure_version: 1,
        snapshot_revision: 8,
        problem_progress: problemProgress,
        coverage: {
          total: 4,
          published: 1,
          skipped: 0,
          awaiting: 3,
          failed: 0,
          status: 'in_progress',
          projection_revision: 8,
        },
      },
      final_artifact: null,
    },
    progress: { operation: 'homework', state: 'assessing' },
    version: 8,
    created_at: FIXED_NOW_SECONDS - 42,
    updated_at: FIXED_NOW_SECONDS,
  }
}

async function installImplementationFixture(page: Page) {
  const unexpectedRequests: string[] = []
  await page.addInitScript(
    ({ agent, session, message, dispatchId, fixedNow }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
      )
      localStorage.setItem(
        'hexclaw.k12.image-task-bindings.v2',
        JSON.stringify({
          version: 2,
          bindings: [
            {
              source_session_id: session,
              agent_id: agent,
              source_message_id: message,
              dispatch_id: dispatchId,
            },
          ],
        }),
      )
      Date.now = () => fixedNow

      // Browser evidence still exercises the HTTP Sidecar boundary. This
      // minimal Tauri bridge only satisfies desktop-only probes that otherwise
      // create fixture-induced update/connection error banners.
      const fixtureWindow = window as typeof window & {
        __TAURI_INTERNALS__?: Record<string, unknown>
      }
      const fixtureTauri = fixtureWindow.__TAURI_INTERNALS__ ?? {}
      fixtureTauri.invoke = async (command: string, args?: { path?: string }): Promise<unknown> => {
        if (command === 'check_engine_health') return true
        if (command === 'proxy_api_request') {
          if (args?.path === '/api/v1/platforms/instances') {
            return JSON.stringify({ instances: [] })
          }
          if (args?.path === '/api/v1/connections') {
            return JSON.stringify({ connections: [], total: 0 })
          }
          if (args?.path === '/health') return JSON.stringify({ status: 'healthy' })
          return JSON.stringify({})
        }
        if (command.startsWith('plugin:updater|')) return null
        return null
      }
      fixtureWindow.__TAURI_INTERNALS__ = fixtureTauri
    },
    {
      agent: AGENT,
      session: SESSION,
      message: MESSAGE,
      dispatchId: DISPATCH,
      fixedNow: FIXED_NOW_MS,
    },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'k12-source-resolver-visual' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/health' && method === 'GET') {
      return json(route, { status: 'ok' })
    }
    if (apiPath === `/api/k12/assets/${SOURCE_ASSET_FILE}` && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'image/png', path: SOURCE_ASSET_PATH })
    }
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
    if (
      (apiPath === '/api/v1/images/status' || apiPath === '/api/v1/videos/status') &&
      method === 'GET'
    ) {
      return json(route, { available: false, models: [] })
    }
    if (apiPath === '/api/v1/voicechat/status' && method === 'GET') {
      return json(route, { available: false, models: [] })
    }
    if (apiPath === '/api/v1/knowledge/documents' && method === 'GET') {
      return json(route, { documents: [], total: 0, limit: 50, offset: 0, sources: [] })
    }
    if (apiPath === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: AGENT,
            display_name: '小明的辅导助手',
            description: '五年级下 · 各学科教材独立绑定',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.learner_id': 'learner-source-resolver-visual',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
              'k12.textbook_edition.math': '人教版',
            },
          },
        ],
        total: 1,
        default: AGENT,
      })
    }
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: SESSION,
            title: '小明的辅导助手',
            agent_id: AGENT,
            created_at: NOW,
            updated_at: NOW,
            message_count: 1,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION}/messages` && method === 'GET') {
      return json(route, {
        messages: [
          {
            id: MESSAGE,
            role: 'user',
            content: '请处理这张作业图片',
            timestamp: NOW,
            created_at: NOW,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION}/artifacts` && method === 'GET') {
      return json(route, { artifacts: [], total: 0 })
    }
    if (apiPath === '/api/k12/view-descriptor' && method === 'GET') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath === '/api/k12/image-tasks/recoverable' && method === 'GET') {
      return json(route, {
        items: [
          {
            source_session: SESSION,
            source_message_id: MESSAGE,
            dispatch: dispatchFixture(),
          },
        ],
      })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}` && method === 'GET') {
      return json(route, { dispatch: dispatchFixture() })
    }
    if (apiPath === '/api/k12/insight-report' && method === 'GET') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
        suggestion: '',
      })
    }
    if (apiPath === '/api/k12/study-time' && method === 'GET') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, {
        progress: {
          progress_id: 'progress-source-resolver-visual',
          agent: AGENT,
          subject: 'math',
          revision: 1,
          textbook_binding_id: 'pep-5b',
          textbook_edition: '人教版',
          textbook_version: '2022',
          title: '义务教育教科书数学',
          volume: '五年级下册',
          unit_id: 'unit-4',
          unit_title: '第4单元「分数的意义和性质」',
          verified_page_from: 45,
          verified_page_to: 62,
          page_verification_status: 'verified',
          segment_refs: ['segment-45-62'],
          evidence_source: 'parent_confirmed',
          confirmed_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        },
      })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: AGENT,
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: NOW,
        updated_at: NOW,
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: weeklyPlan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: [] })
    }
    if (
      apiPath === '/api/k12/mistakes' ||
      apiPath === '/api/k12/review-queue' ||
      apiPath === '/api/k12/accumulation' ||
      apiPath === '/api/k12/accumulations' ||
      apiPath === '/api/k12/practice-sets'
    ) {
      return json(route, { items: [] })
    }

    unexpectedRequests.push(`${method} ${apiPath}${url.search}`)
    return json(route, { error: 'unexpected visual fixture request' }, 501)
  })
  return unexpectedRequests
}

async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function openReference(page: Page, state: ResolverState) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const api = window as typeof window & { goK12Learner?: (learner: string) => void }
    api.goK12Learner?.('ming')
  })
  const resolver = page.locator('#k12ThreadMing [data-source-issue-resolver]:visible').first()
  await expect(resolver).toBeVisible()
  await resolver
    .getByRole('button', { name: state === 'region' ? '重新选择区域' : '重新拍摄', exact: true })
    .click()
  const panel = resolver.locator(`[data-source-panel="${state}"]:not([hidden])`)
  await expect(panel).toBeVisible()
  if (state === 'region') {
    await expect(panel.locator('img')).toHaveJSProperty('complete', true)
    await expect(panel.locator('[data-source-region-selection]')).toBeFocused()
  }
  await panel.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await freezeVisualState(page)
  return { resolver, panel }
}

async function openImplementation(page: Page, state: ResolverState) {
  const unexpectedRequests = await installImplementationFixture(page)
  await page.goto(
    `${IMPLEMENTATION_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.locator('.k12enh-tabs')).toBeVisible()
  await page.waitForURL((url) => url.pathname === '/chat' && url.search === '', {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  })
  const group = page.locator(`[data-problem-group-id="${IMPLEMENTATION_GROUP_ID}"]`).first()
  await expect(group).toBeVisible()
  const resolver = group.locator('[data-source-issue-resolver]').first()
  await expect(resolver).toBeVisible()
  await resolver
    .getByRole('button', { name: state === 'region' ? '重新选择区域' : '重新拍摄', exact: true })
    .click()
  const panel = resolver.locator(`[data-source-panel="${state}"]`)
  await expect(panel).toBeVisible()
  if (state === 'region') {
    await expect(panel.locator('img')).toHaveJSProperty('complete', true)
    await expect(panel.locator('img')).toHaveJSProperty('naturalWidth', 430)
    await expect(panel.locator('img')).toHaveJSProperty('naturalHeight', 520)
    await expect(panel.locator('[data-source-region-selection]')).toBeFocused()
  }
  await panel.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await freezeVisualState(page)
  return { resolver, panel, unexpectedRequests }
}

function criticalDefinitions(side: 'reference' | 'implementation', state: ResolverState) {
  const resolver =
    side === 'reference'
      ? '#k12ThreadMing [data-source-issue-resolver]:visible'
      : `[data-problem-group-id="${IMPLEMENTATION_GROUP_ID}"] [data-source-issue-resolver]`
  const panel =
    side === 'reference'
      ? `${resolver} [data-source-panel="${state}"]:not([hidden])`
      : `${resolver} [data-source-panel="${state}"]`
  const actionClass =
    side === 'reference' ? '.k12-source-issue-resolver__actions' : '.source-resolver__actions'
  const definitions: CriticalNodeDefinition[] = [
    { key: 'resolver', selector: resolver },
    { key: 'panel', selector: panel },
    { key: 'copy', selector: `${panel} > p` },
    { key: 'panel-actions', selector: `${panel} > ${actionClass}` },
    { key: 'cancel-button', selector: `${panel} > ${actionClass} > button:nth-child(1)` },
    { key: 'primary-button', selector: `${panel} > ${actionClass} > button:nth-child(2)` },
  ]
  if (state === 'region') {
    definitions.push(
      { key: 'region-editor', selector: `${panel} [data-source-region-editor]` },
      { key: 'region-stage', selector: `${panel} [data-source-region-stage]` },
      { key: 'source-image', selector: `${panel} [data-source-region-stage] > img` },
      { key: 'region-selection', selector: `${panel} [data-source-region-selection]` },
      { key: 'handle-nw', selector: `${panel} .k12-source-region-handle[data-handle="nw"]` },
      { key: 'handle-ne', selector: `${panel} .k12-source-region-handle[data-handle="ne"]` },
      { key: 'handle-sw', selector: `${panel} .k12-source-region-handle[data-handle="sw"]` },
      { key: 'handle-se', selector: `${panel} .k12-source-region-handle[data-handle="se"]` },
    )
  } else {
    definitions.push({ key: 'retake-input', selector: `${panel} input[type="file"]` })
  }
  return definitions
}

async function collectCriticalNodes(
  page: Page,
  definitions: CriticalNodeDefinition[],
): Promise<Record<string, CriticalNodeSnapshot>> {
  const output: Record<string, CriticalNodeSnapshot> = {}
  for (const definition of definitions) {
    const nodes = await page.locator(definition.selector).evaluateAll(
      (elements, styleFields) =>
        elements.map((node) => {
          const element = node as HTMLElement
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const computed: Record<string, string> = {}
          for (const field of styleFields) {
            computed[field] = style[field as keyof CSSStyleDeclaration] as string
          }
          return {
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
            rect: {
              x: Number(rect.x.toFixed(2)),
              y: Number(rect.y.toFixed(2)),
              width: Number(rect.width.toFixed(2)),
              height: Number(rect.height.toFixed(2)),
            },
            style: computed,
            attributes: {
              role: element.getAttribute('role'),
              ariaLabel: element.getAttribute('aria-label'),
              ariaBusy: element.getAttribute('aria-busy'),
              hidden: element.getAttribute('hidden'),
              disabled: element.getAttribute('disabled'),
              type: element.getAttribute('type'),
              accept: element.getAttribute('accept'),
              tabindex: element.getAttribute('tabindex'),
              pageAssetId: element.getAttribute('data-page-asset-id'),
              sourceWidth: element.getAttribute('data-source-width'),
              sourceHeight: element.getAttribute('data-source-height'),
              currentRegion: element.getAttribute('data-current-region'),
              sourceRegion: element.getAttribute('data-source-region'),
              handle: element.getAttribute('data-handle'),
              src: element.getAttribute('src'),
              alt: element.getAttribute('alt'),
            },
          }
        }),
      STYLE_FIELDS,
    )
    output[definition.key] = { count: nodes.length, nodes }
  }
  return output
}

async function collectSemanticFacts(page: Page, state: ResolverState, side: string) {
  const resolverSelector =
    side === 'reference'
      ? '#k12ThreadMing [data-source-issue-resolver]:visible'
      : `[data-problem-group-id="${IMPLEMENTATION_GROUP_ID}"] [data-source-issue-resolver]`
  return page
    .locator(resolverSelector)
    .first()
    .evaluate((resolver, requestedState) => {
      const panel = resolver.querySelector<HTMLElement>(`[data-source-panel="${requestedState}"]`)
      const normalize = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim()
      const buttons = panel
        ? [...panel.querySelectorAll<HTMLButtonElement>('button')].map((button) =>
            normalize(button.textContent),
          )
        : []
      const input = panel?.querySelector<HTMLInputElement>('input[type="file"]')
      const editor = panel?.querySelector<HTMLElement>('[data-source-region-editor]')
      const image = panel?.querySelector<HTMLImageElement>('[data-source-region-stage] > img')
      const selection = panel?.querySelector<HTMLElement>('[data-source-region-selection]')
      return {
        state: requestedState,
        panelVisible: !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none',
        panelText: normalize(panel?.innerText),
        buttons,
        activeElement: {
          tag: document.activeElement?.tagName.toLowerCase() ?? '',
          role: document.activeElement?.getAttribute('role') ?? '',
          ariaLabel: document.activeElement?.getAttribute('aria-label') ?? '',
        },
        region: editor
          ? {
              pageAssetId: editor.dataset.pageAssetId ?? '',
              sourceWidth: Number(editor.dataset.sourceWidth),
              sourceHeight: Number(editor.dataset.sourceHeight),
              currentRegion: JSON.parse(editor.dataset.currentRegion || '{}'),
              draftRegion: JSON.parse(selection?.dataset.sourceRegion || '{}'),
              image: {
                src: image?.getAttribute('src') ?? '',
                alt: image?.alt ?? '',
                complete: image?.complete ?? false,
                naturalWidth: image?.naturalWidth ?? 0,
                naturalHeight: image?.naturalHeight ?? 0,
              },
              handles: editor.querySelectorAll('.k12-source-region-handle').length,
            }
          : null,
        retake: input
          ? {
              type: input.type,
              accept: input.accept,
              hidden: input.hidden,
              disabled: input.disabled,
              files: input.files?.length ?? 0,
            }
          : null,
      }
    }, state)
}

function semanticComparison(
  state: ResolverState,
  reference: Awaited<ReturnType<typeof collectSemanticFacts>>,
  implementation: Awaited<ReturnType<typeof collectSemanticFacts>>,
) {
  const checks: Record<string, boolean> = {
    activeState: reference.state === implementation.state,
    panelVisible: reference.panelVisible && implementation.panelVisible,
    panelText: reference.panelText === implementation.panelText,
    buttonOrder: JSON.stringify(reference.buttons) === JSON.stringify(implementation.buttons),
    focus:
      reference.activeElement.role === implementation.activeElement.role &&
      reference.activeElement.ariaLabel === implementation.activeElement.ariaLabel,
  }
  if (state === 'region') {
    checks.sourceDimensions =
      reference.region?.sourceWidth === implementation.region?.sourceWidth &&
      reference.region?.sourceHeight === implementation.region?.sourceHeight
    checks.currentRegion =
      JSON.stringify(reference.region?.currentRegion) ===
      JSON.stringify(implementation.region?.currentRegion)
    checks.draftRegion =
      JSON.stringify(reference.region?.draftRegion) ===
      JSON.stringify(implementation.region?.draftRegion)
    checks.imageIntrinsicSize =
      reference.region?.image.naturalWidth === implementation.region?.image.naturalWidth &&
      reference.region?.image.naturalHeight === implementation.region?.image.naturalHeight
    checks.imageAlt = reference.region?.image.alt === implementation.region?.image.alt
    checks.handles = reference.region?.handles === 4 && implementation.region?.handles === 4
  } else {
    checks.fileInput =
      reference.retake?.type === implementation.retake?.type &&
      reference.retake?.accept === implementation.retake?.accept &&
      reference.retake?.hidden === implementation.retake?.hidden &&
      reference.retake?.disabled === implementation.retake?.disabled &&
      reference.retake?.files === implementation.retake?.files
  }
  return { checks, equivalent: Object.values(checks).every(Boolean) }
}

function compareCriticalNodes(
  reference: Record<string, CriticalNodeSnapshot>,
  implementation: Record<string, CriticalNodeSnapshot>,
) {
  const differences: Array<Record<string, unknown>> = []
  for (const key of Object.keys(reference)) {
    const left = reference[key]
    const right = implementation[key]
    if (!right || left.count !== 1 || right.count !== 1) {
      differences.push({
        key,
        kind: 'count',
        reference: left.count,
        implementation: right?.count ?? 0,
      })
      continue
    }
    const leftNode = left.nodes[0]
    const rightNode = right.nodes[0]
    const rectDiff: Record<string, { reference: number; implementation: number; delta: number }> =
      {}
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const delta = Number((rightNode.rect[field] - leftNode.rect[field]).toFixed(2))
      if (Math.abs(delta) > BBOX_TOLERANCE_PX) {
        rectDiff[field] = {
          reference: leftNode.rect[field],
          implementation: rightNode.rect[field],
          delta,
        }
      }
    }
    if (Object.keys(rectDiff).length) differences.push({ key, kind: 'bbox', fields: rectDiff })
    const styleDiff: Record<string, { reference: string; implementation: string }> = {}
    for (const field of STYLE_FIELDS) {
      if (leftNode.style[field] !== rightNode.style[field]) {
        styleDiff[field] = {
          reference: leftNode.style[field],
          implementation: rightNode.style[field],
        }
      }
    }
    if (Object.keys(styleDiff).length)
      differences.push({ key, kind: 'computed-style', fields: styleDiff })
  }
  return {
    tolerancePx: BBOX_TOLERANCE_PX,
    comparedKeys: Object.keys(reference),
    differences,
    equivalent: differences.length === 0,
  }
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function captureState(browser: Browser, state: ResolverState, testInfo: TestInfo) {
  const project = testInfo.project.name || 'chromium'
  const outputDir = path.join(EVIDENCE_ROOT, project, state)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const implementationPath = path.join(outputDir, 'current.png')
  const diffPath = path.join(outputDir, 'diff.png')
  const geometryPath = path.join(outputDir, 'bbox-and-computed-styles.json')
  const semanticPath = path.join(outputDir, 'semantic-equivalence.json')
  const ratioPath = path.join(outputDir, 'pixel-diff.json')
  const statusPath = path.join(outputDir, 'status.json')

  const [prototypeSha, assetSha] = await Promise.all([
    sha256(PROTOTYPE_PATH),
    sha256(SOURCE_ASSET_PATH),
  ])
  expect(prototypeSha).toBe(EXPECTED_PROTOTYPE_SHA256)
  expect(assetSha).toBe(EXPECTED_SOURCE_ASSET_SHA256)

  const referencePage = await browser.newPage()
  const implementationPage = await browser.newPage()
  const referenceErrors: string[] = []
  const implementationErrors: string[] = []
  referencePage.on('pageerror', (error) => referenceErrors.push(error.message))
  implementationPage.on('pageerror', (error) => implementationErrors.push(error.message))

  let unexpectedRequests: string[] = []
  try {
    await openReference(referencePage, state)
    const implementation = await openImplementation(implementationPage, state)
    unexpectedRequests = implementation.unexpectedRequests

    const [referenceFacts, implementationFacts, referenceGeometry, implementationGeometry] =
      await Promise.all([
        collectSemanticFacts(referencePage, state, 'reference'),
        collectSemanticFacts(implementationPage, state, 'implementation'),
        collectCriticalNodes(referencePage, criticalDefinitions('reference', state)),
        collectCriticalNodes(implementationPage, criticalDefinitions('implementation', state)),
      ])
    const semantics = semanticComparison(state, referenceFacts, implementationFacts)
    const critical = compareCriticalNodes(referenceGeometry, implementationGeometry)

    await Promise.all([
      referencePage.screenshot({ path: referencePath, animations: 'disabled' }),
      implementationPage.screenshot({ path: implementationPath, animations: 'disabled' }),
    ])
    const { stdout } = await execFileAsync('python3', [
      PIXEL_DIFF_TOOL,
      referencePath,
      implementationPath,
      diffPath,
      String(PIXEL_THRESHOLD),
    ])
    const pixel = JSON.parse(stdout.trim()) as PixelDiffReport
    const viewport = {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    }
    const pageErrors = { reference: referenceErrors, implementation: implementationErrors }
    await writeFile(
      geometryPath,
      JSON.stringify(
        {
          viewport,
          reference: referenceGeometry,
          implementation: implementationGeometry,
          comparison: critical,
        },
        null,
        2,
      ),
    )
    await writeFile(
      semanticPath,
      JSON.stringify(
        {
          viewport,
          prototype: { path: PROTOTYPE_PATH, sha256: prototypeSha },
          sourceAsset: { path: SOURCE_ASSET_PATH, sha256: assetSha },
          reference: referenceFacts,
          implementation: implementationFacts,
          comparison: semantics,
          assetIdentityNote:
            'Reference and implementation use different PageAsset identity strings but serve the exact same immutable PNG bytes, proven by SHA-256.',
          unexpectedRequests,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await writeFile(
      ratioPath,
      JSON.stringify(
        {
          ...pixel,
          passThreshold: MAX_CHANGED_PIXEL_RATIO,
          pass: pixel.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO,
        },
        null,
        2,
      ),
    )

    const fixtureEquivalent =
      semantics.equivalent &&
      unexpectedRequests.length === 0 &&
      referenceErrors.length === 0 &&
      implementationErrors.length === 0
    const visualEquivalent =
      fixtureEquivalent &&
      critical.equivalent &&
      pixel.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
    const reasons: string[] = []
    if (!semantics.equivalent) reasons.push('interaction/content facts are not equivalent')
    if (unexpectedRequests.length)
      reasons.push('implementation fixture observed unexpected API requests')
    if (referenceErrors.length || implementationErrors.length)
      reasons.push('page runtime errors observed')
    if (!critical.equivalent) reasons.push('critical bounding boxes or computed styles differ')
    if (pixel.changed_pixel_ratio > MAX_CHANGED_PIXEL_RATIO) {
      reasons.push(
        `changed pixel ratio ${pixel.changed_pixel_ratio} exceeds ${MAX_CHANGED_PIXEL_RATIO}`,
      )
    }
    const status = {
      state,
      project,
      result: visualEquivalent ? 'PASS' : 'NOT_PASS',
      fixtureEquivalent,
      visualEquivalent,
      reasons,
      evidence: {
        reference: referencePath,
        implementation: implementationPath,
        diff: diffPath,
        bboxAndComputedStyles: geometryPath,
        semanticEquivalence: semanticPath,
        pixelDiff: ratioPath,
      },
    }
    await writeFile(statusPath, JSON.stringify(status, null, 2))

    expect(semantics.equivalent, JSON.stringify(semantics.checks, null, 2)).toBe(true)
    expect(
      unexpectedRequests,
      'fixture must explicitly handle every implementation API request',
    ).toEqual([])
    expect(referenceErrors, 'reference page must have no runtime errors').toEqual([])
    expect(implementationErrors, 'implementation page must have no runtime errors').toEqual([])
    expect(
      critical.equivalent,
      `critical bounding boxes/styles differ; inspect ${geometryPath}`,
    ).toBe(true)
    expect(
      pixel.changed_pixel_ratio,
      `pixel difference exceeds the frozen threshold; inspect ${ratioPath} and ${diffPath}`,
    ).toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
  } finally {
    await Promise.all([referencePage.close(), implementationPage.close()])
  }
}

for (const state of ['region', 'retake'] as const) {
  test(`${state}: authoritative prototype versus implementation`, async ({ browser }, testInfo) => {
    await captureState(browser, state, testInfo)
  })
}
