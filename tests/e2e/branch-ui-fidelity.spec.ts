import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const REQUESTED_SURFACE = process.env.HEX_UI_SURFACE?.trim()
const REQUESTED_INTERACTION = process.env.HEX_UI_INTERACTION?.trim()
const AGENT = 'k12-fidelity-ming'
const SESSION = 'k12-fidelity-session'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const EVIDENCE_ROOT = path.resolve(
  process.env.HEX_UI_EVIDENCE_ROOT?.trim() || 'test-results/branch-ui-fidelity/evidence',
)
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')

type SurfaceName = 'k12-weekly-current' | 'k12-mistakes' | 'k12-works'

interface GeometryTarget {
  name: string
  selector: string
  all?: boolean
}

interface Surface {
  name: SurfaceName
  openReference(page: Page): Promise<void>
  openImplementation(page: Page): Promise<void>
  referenceGeometry: GeometryTarget[]
  implementationGeometry: GeometryTarget[]
  screenshotClip?: { x: number; y: number; width: number; height: number }
  normalizeContentBackground?: boolean
}

interface ShellLayerCandidate {
  name: string
  selector: string
  pseudo?: '::before' | '::after'
}

const referenceShellLayers: ShellLayerCandidate[] = [
  { name: 'prototype-texture', selector: '.app', pseudo: '::after' },
  { name: 'prototype-glow', selector: '.mn-glow' },
]

const implementationShellLayers: ShellLayerCandidate[] = [
  { name: 'global-texture', selector: '.hc-app', pseudo: '::after' },
  { name: 'layout-texture', selector: '.hc-app__body', pseudo: '::after' },
  { name: 'global-glow', selector: '.hc-app__content', pseudo: '::before' },
  { name: 'layout-glow', selector: '.hc-app__glow' },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function verifiedWeeklyItem(
  itemID: string,
  position: number,
  sourceRef: string,
  prompt: string,
  evidence: string,
  details: {
    subject?: string
    knowledge_point?: string
    mastery_status?: string
  } = {},
) {
  return {
    item_id: itemID,
    position,
    plan_section: 'due_review',
    source_kind: 'mistake',
    generation_method: 'original',
    source_ref: sourceRef,
    verification: {
      status: 'verified',
      evidence_refs: [evidence],
    },
    prompt_markdown: prompt,
    ...details,
  }
}

const weeklyPlan = {
  plan_id: 'weekly-2026-30',
  agent: AGENT,
  revision: 11,
  iso_week_year: 2026,
  iso_week_number: 30,
  timezone: 'Asia/Shanghai',
  week_start: '2026-07-20T00:00:00+08:00',
  week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20',
  local_end_date: '2026-07-26',
  status: 'draft',
  settings_revision: 7,
  curriculum_progress_revision: 4,
  tracks: [
    {
      plan_section: 'due_review',
      status: 'ready',
      arithmetic_batch: null,
      items: [
        verifiedWeeklyItem(
          'weekly-item-1',
          1,
          'mistake-apple',
          '苹果和梨的价钱',
          '小数乘法错题 · 连续错 2 次',
          { subject: '数学', knowledge_point: '小数乘法', mastery_status: 'new' },
        ),
        verifiedWeeklyItem(
          'weekly-item-2',
          2,
          'mistake-equation',
          '解方程 2x+15=43',
          '简易方程错题 · 移项符号错',
          { subject: '数学', knowledge_point: '简易方程' },
        ),
        verifiedWeeklyItem(
          'weekly-item-3',
          3,
          'mistake-believe',
          'believe —— 拼成 belive（少 e）',
          'Unit 4 听写错题',
          { subject: '英语', knowledge_point: '错词' },
        ),
        verifiedWeeklyItem(
          'weekly-item-4',
          4,
          'mistake-poem',
          '「梅须逊雪三分白」漏「须」字',
          '古诗默写错题',
          { subject: '语文', knowledge_point: '默写' },
        ),
        verifiedWeeklyItem(
          'weekly-item-5',
          5,
          'mistake-fraction',
          '小灯泡没有形成闭合回路',
          '科学作业 · 闭合回路错题',
          { subject: '科学', knowledge_point: '简单电路', mastery_status: 'new' },
        ),
        verifiedWeeklyItem(
          'weekly-item-6',
          6,
          'mistake-decimal',
          '重复执行积木少循环 1 次',
          '信息科技作业 · 循环次数错题',
          { subject: '信息科技', knowledge_point: '图形化编程', mastery_status: 'retried' },
        ),
      ],
    },
    {
      plan_section: 'textbook_consolidation',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
    {
      plan_section: 'arithmetic_warmup',
      status: 'ready',
      arithmetic_batch: null,
      items: [],
    },
  ],
  manual_track_recommendations: {
    textbook_consolidation: {
      availability: 'available',
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
  created_at: '2026-07-20T00:00:00+08:00',
  updated_at: '2026-07-20T00:00:00+08:00',
}

function feedback(id: string, type: 'writing' | 'art', visibleEvidence: string[]) {
  return {
    feedback_id: id,
    feedback_type: type,
    evidence_refs: visibleEvidence.map((_, index) => `evidence-${id}-${index + 1}`),
    visible_evidence: visibleEvidence,
    affirmation: '这次作品已经保存了清楚、可见的优点。',
    parent_guidance: '可以请孩子说说自己最满意的部分。',
    next_step: '下一次只尝试改进一个小地方。',
    source_snapshot: {
      source: 'ai',
      method_ref: 'k12-creative-feedback-v1',
      capability: 'creative-work-feedback',
    },
  }
}

const creativeWorks = [
  {
    work_id: 'WRITING-20260715-001',
    work_type: 'writing',
    display_kind: '语文·习作',
    preview_variant: 'writing',
    display_evidence: ['切题：校园春景', '结构：三段', '表达：有一处可提升'],
    display_name: '《春天的校园》',
    content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
    created_at: Date.parse('2026-07-15T19:35:43+08:00') / 1000,
    latest_generation_at: Date.parse('2026-07-15T19:35:43+08:00') / 1000,
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-WRITING-20260715-001',
      status: 'succeeded',
      feedback: feedback('feedback-writing', 'writing', [
        '切题：校园春景',
        '结构：三段',
        '表达：有一处可提升',
      ]),
    },
  },
  {
    work_id: 'ART-20260716-001',
    work_type: 'art',
    display_kind: '美术·水彩',
    preview_variant: 'default',
    display_evidence: ['构图：主体偏右', '色彩：冷暖有层次', '线条：边缘清楚'],
    display_name: '《雨后的校园》',
    created_at: Date.parse('2026-07-16T20:12:09+08:00') / 1000,
    latest_generation_at: Date.parse('2026-07-16T20:12:09+08:00') / 1000,
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260716-001',
      status: 'succeeded',
      feedback: feedback('feedback-art-watercolor', 'art', [
        '构图：主体偏右',
        '色彩：冷暖有层次',
        '线条：边缘清楚',
      ]),
    },
  },
  {
    work_id: 'ART-20260717-002',
    work_type: 'art',
    display_kind: '美术·线描',
    preview_variant: 'line',
    display_evidence: ['原图：已保存', '年级：五年级'],
    display_name: '《桌上的水杯》',
    created_at: Date.parse('2026-07-17T08:42:18+08:00') / 1000,
    latest_generation_at: null,
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260717-002',
      status: 'failed',
      failure_message: '点评生成失败',
    },
  },
]

const visualMistakes = [
  {
    record_id: 'mistake-apple',
    question: '苹果和梨的价钱（P52·3）',
    knowledge_point: '小数乘法',
    error_cause: '连续错 2 次 · 计算失误',
    status: 'new',
    review_state: 'scheduled',
    subject: '数学',
    created_at: Date.parse('2026-07-16T08:00:00+08:00') / 1000,
    entry_source: 'photo',
    version: 1,
  },
  {
    record_id: 'mistake-bulb',
    question: '小灯泡没有形成闭合回路',
    knowledge_point: '简单电路',
    error_cause: '实验图判断错误',
    status: 'new',
    review_state: 'scheduled',
    subject: '科学',
    created_at: Date.parse('2026-07-15T08:00:00+08:00') / 1000,
    entry_source: 'photo',
    version: 1,
  },
  {
    record_id: 'mistake-decimal',
    question: '重复执行积木少循环 1 次',
    knowledge_point: '图形化编程',
    error_cause: '运行结果已复核 · 到期可再练',
    status: 'retried',
    review_state: 'retried',
    subject: '信息科技',
    created_at: Date.parse('2026-07-13T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
  {
    record_id: 'mistake-equation',
    question: '解方程 2x + 15 = 43',
    knowledge_point: '简易方程',
    error_cause: '复练 1 次 · 仍需巩固',
    status: 'retried',
    review_state: 'retried',
    subject: '数学',
    created_at: Date.parse('2026-07-12T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
  {
    record_id: 'mistake-believe',
    question: 'believe —— 拼成 belive（少 e）',
    knowledge_point: '错词',
    error_cause: '本轮已跳过 · 系统证据不足',
    status: 'new',
    review_state: 'scheduled',
    subject: '英语',
    created_at: Date.parse('2026-07-09T08:00:00+08:00') / 1000,
    entry_source: 'writing_confirmed',
    version: 1,
  },
  {
    record_id: 'mistake-poem',
    question: '「梅须逊雪三分白」漏「须」字',
    knowledge_point: '默写',
    error_cause: '上次生成任务未完成',
    status: 'new',
    review_state: 'scheduled',
    subject: '语文',
    created_at: Date.parse('2026-07-08T08:00:00+08:00') / 1000,
    entry_source: 'manual',
    version: 1,
  },
  {
    record_id: 'mistake-position',
    question: '用数对表示位置',
    knowledge_point: '位置',
    error_cause: '两次独立复练正确',
    status: 'mastered',
    review_state: 'mastered',
    subject: '数学',
    created_at: Date.parse('2026-06-21T08:00:00+08:00') / 1000,
    entry_source: 'verified',
    version: 1,
  },
]

const visualAccumulations = Array.from({ length: 3 }, (_, index) => ({
  record_id: `accum-${index + 1}`,
  subject: index === 0 ? '语文' : index === 1 ? '英语' : '数学',
  entry_type: '好词好句',
  content: '学习记录',
  source: '家长记录',
  created_at: '2026-07-20T00:00:00+08:00',
  version: 1,
}))

function practiceGeneration(recordID: string) {
  if (recordID === 'mistake-apple') {
    return {
      state: 'joined',
      source_mistake_id: recordID,
      practice_set_id: 'practice-set-visual',
      practice_item_id: 'practice-item-apple',
      item: {
        question_markdown: '苹果和梨的价钱 · 变式题',
        verification_evidence: '小数乘法进位 · 确定性答案已校验',
        expected_answer_markdown: '已验证',
      },
    }
  }
  if (recordID === 'mistake-poem') {
    return {
      state: 'failed',
      source_mistake_id: recordID,
      failure_reason: '上次生成任务未完成',
    }
  }
  if (recordID === 'mistake-decimal') {
    return {
      state: 're_add',
      source_mistake_id: recordID,
    }
  }
  return { state: 'available', source_mistake_id: recordID }
}

async function installImplementationMocks(page: Page) {
  await page.addInitScript(
    ({ agent, session }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem('hc-theme', 'light')
    },
    { agent: AGENT, session: SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'fidelity-fixture' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const requestURL = new URL(request.url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

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
              'k12.learner_id': 'learner-fidelity-ming',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
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
            created_at: '2026-07-20T00:00:00+08:00',
            updated_at: '2026-07-20T00:00:00+08:00',
            message_count: 0,
          },
        ],
        total: 1,
      })
    }
    if (
      apiPath === `/api/v1/sessions/${SESSION}/messages` ||
      apiPath === `/api/v1/sessions/${SESSION}/artifacts`
    ) {
      return json(route, { messages: [], artifacts: [], total: 0 })
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
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, {
        progress: {
          progress_id: 'progress-fidelity',
          agent: AGENT,
          subject: 'math',
          revision: 4,
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
          confirmed_at: '2026-07-20T00:00:00+08:00',
          created_at: '2026-07-20T00:00:00+08:00',
          updated_at: '2026-07-20T00:00:00+08:00',
        },
      })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: AGENT,
        revision: 7,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: '2026-07-20T00:00:00+08:00',
        updated_at: '2026-07-20T00:00:00+08:00',
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: weeklyPlan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, {
        items: [
          {
            snapshot_id: 'snapshot-2026-29',
            plan_id: 'weekly-2026-29',
            artifact_id: 'artifact-2026-29',
            iso_week_year: 2026,
            iso_week_number: 29,
            timezone: 'Asia/Shanghai',
            local_start_date: '2026-07-13',
            local_end_date: '2026-07-19',
            item_count: 8,
            correct_count: 7,
            wrong_count: 1,
            archived_at: '2026-07-20T00:00:00+08:00',
          },
        ],
        next_cursor: null,
      })
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: creativeWorks })
    }
    if (apiPath === '/api/k12/practice-sets' && method === 'GET') {
      return json(route, { items: [{ status: 'draft', items: [{}] }] })
    }
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
      return json(route, { items: visualAccumulations })
    }
    const generationMatch = apiPath.match(/^\/api\/k12\/mistakes\/([^/]+)\/practice-generation$/)
    if (generationMatch && method === 'GET') {
      return json(route, practiceGeneration(decodeURIComponent(generationMatch[1])))
    }
    if (
      apiPath === '/api/k12/mistakes' ||
      apiPath === '/api/k12/review-queue' ||
      apiPath === '/api/k12/accumulation' ||
      apiPath === '/api/k12/accumulations' ||
      apiPath === '/api/k12/practice-sets'
    ) {
      return json(route, {
        items: apiPath === '/api/k12/mistakes' ? visualMistakes : visualMistakes.slice(0, 6),
        ...(apiPath === '/api/k12/mistakes' ? { total: 11 } : {}),
      })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        trend: { total: 6, mastered: 2, reviewing: 3, retried: 1, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
        suggestion: '',
      })
    }
    if (apiPath === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
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
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function openReferenceRecords(page: Page, tab: number) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate((recordsTab) => {
    const api = window as typeof window & {
      goRecords?: (learner: string, tab: number) => void
      k12BookTab?: (tab: number) => void
    }
    api.goRecords?.('ming', recordsTab)
    api.k12BookTab?.(recordsTab)
  }, tab)
  await expect(page.locator('#k12ViewRecords')).toBeVisible()
}

async function openImplementationRecords(page: Page, tab: 'week' | 'mistakes' | 'works') {
  await page.goto(
    `${IMPLEMENTATION_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  const scenarioTabs = page.locator('.k12enh-seg')
  await expect(scenarioTabs.getByRole('tab', { name: '学习档案', exact: true })).toBeVisible()
  await scenarioTabs.getByRole('tab', { name: '学习档案', exact: true }).click()
  await expect(page.locator('.k12rec')).toBeVisible()
  if (tab === 'week') {
    await expect(page.getByTestId('week-section')).toBeVisible()
    await expect(page.locator('.weekly-hero')).toBeVisible()
    await expect(page.locator('[data-testid="subtab-week"] .k12-tab-count')).toHaveAttribute(
      'data-count',
      '6',
    )
    await expect(page.locator('[data-testid="subtab-mistakes"] .k12-tab-count')).toHaveAttribute(
      'data-count',
      '11',
    )
    await expect(
      page.locator('[data-testid="subtab-practicesets"] .k12-tab-count'),
    ).toHaveAttribute('data-count', '1')
    await expect(
      page.locator('[data-testid="subtab-accumulation"] .k12-tab-count'),
    ).toHaveAttribute('data-count', '3')
    await expect(page.locator('[data-testid="subtab-works"] .k12-tab-count')).toHaveAttribute(
      'data-count',
      '3',
    )
    await expect(page.locator('.weekly-progress')).toContainText('P45–62')
  } else if (tab === 'mistakes') {
    await page.getByTestId('subtab-mistakes').click()
    await expect(page.getByTestId('subtab-mistakes')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('mistakes-section')).toBeVisible()
    await expect(page.locator('.k12mistakes .rl-row')).toHaveCount(7)
  } else {
    await expect(page.locator('[data-testid="subtab-works"] .k12-tab-count')).toHaveAttribute(
      'data-count',
      '3',
    )
    await page.getByTestId('subtab-works').click()
    await expect(page.getByTestId('works-section')).toBeVisible()
    await expect(page.getByTestId('cw-list')).toBeVisible()
  }
}

const surfaces: Surface[] = [
  {
    name: 'k12-weekly-current',
    openReference: async (page) => {
      await openReferenceRecords(page, 0)
      await expect(page.locator('#k12BookPanel0')).toBeVisible()
    },
    openImplementation: async (page) => openImplementationRecords(page, 'week'),
    referenceGeometry: [
      { name: 'object-tabs', selector: '#k12BookTabs' },
      { name: 'records-scroll', selector: '#k12ViewRecords > .content' },
      { name: 'records-panel', selector: '#k12BookPanel0' },
      { name: 'period-tabs', selector: '#k12BookPanel0 .k12-week-view-tabs' },
      { name: 'period-toolbar', selector: '#k12BookPanel0 .k12-secondary-toolbar' },
      { name: 'progress', selector: '#k12BookPanel0 .rc-week-progress' },
      { name: 'progress-button', selector: '#k12BookPanel0 .rc-week-progress > .btn' },
      { name: 'hero', selector: '#k12BookPanel0 .rc-week-hero' },
      { name: 'hero-head', selector: '#k12BookPanel0 .rc-week-hero__head' },
      { name: 'hero-foot', selector: '#k12BookPanel0 .rc-week-hero__foot' },
      { name: 'tracks', selector: '#k12BookPanel0 .rc-week-plan__section', all: true },
      { name: 'track-heads', selector: '#k12BookPanel0 .rc-week-plan__section-head', all: true },
      { name: 'items', selector: '#k12BookPanel0 .rc-week-hero .resource-row', all: true },
      {
        name: 'item-origins',
        selector: '#k12BookPanel0 .resource-row .rc-practice-origin',
        all: true,
      },
      { name: 'item-buttons', selector: '#k12BookPanel0 .resource-row .btn', all: true },
      {
        name: 'item-pills',
        selector: '#k12BookPanel0 .resource-row .kpill, #k12BookPanel0 .resource-row .stpill',
        all: true,
      },
      { name: 'hero-meta', selector: '#k12BookPanel0 .rc-week-hero__meta' },
      {
        name: 'hero-meta-pills',
        selector: '#k12BookPanel0 .rc-week-hero__meta > .kpill',
        all: true,
      },
      { name: 'hero-trend', selector: '#k12BookPanel0 .rc-week-hero__head > .stpill' },
      {
        name: 'period-tab-buttons',
        selector: '#k12BookPanel0 .k12-week-view-tabs > button',
        all: true,
      },
      { name: 'toolbar-buttons', selector: '#k12ReviewAction .btn', all: true },
      {
        name: 'suppress-buttons',
        selector: '#k12BookPanel0 .rc-week-hero .week-suppress-action',
        all: true,
      },
      { name: 'manual-origins', selector: '#k12BookPanel0 .weekly-manual__origin', all: true },
      { name: 'manual-controls', selector: '#k12BookPanel0 .k12-manual-count-control', all: true },
    ],
    implementationGeometry: [
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs' },
      { name: 'records-scroll', selector: '.k12rec__body' },
      { name: 'chat-main', selector: '.hc-chat__main' },
      { name: 'records-owner', selector: '#k12-enh-view-records' },
      { name: 'records-root', selector: '.k12rec' },
      { name: 'records-panel', selector: '.k12rec__body > section[data-testid="week-section"]' },
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs' },
      { name: 'period-toolbar', selector: '.weekly-toolbar' },
      { name: 'progress', selector: '.weekly-progress' },
      { name: 'progress-button', selector: '.weekly-progress > .btn' },
      { name: 'hero', selector: '.weekly-hero' },
      { name: 'hero-head', selector: '.weekly-hero__head' },
      { name: 'hero-foot', selector: '.weekly-lifecycle' },
      { name: 'tracks', selector: '.weekly-track', all: true },
      { name: 'track-heads', selector: '.weekly-track__head', all: true },
      { name: 'items', selector: '.weekly-item', all: true },
      { name: 'item-origins', selector: '.weekly-item .weekly-item__origin', all: true },
      { name: 'item-buttons', selector: '.weekly-item .btn', all: true },
      { name: 'item-pills', selector: '.weekly-item .kpill, .weekly-item .stpill', all: true },
      { name: 'hero-meta', selector: '.weekly-hero__meta' },
      { name: 'hero-meta-pills', selector: '.weekly-hero__meta > .kpill', all: true },
      { name: 'hero-trend', selector: '.weekly-hero__head > .stpill' },
      {
        name: 'period-tab-buttons',
        selector: '.weekly-toolbar .k12-book-tabs > button',
        all: true,
      },
      { name: 'toolbar-buttons', selector: '.weekly-toolbar .btn', all: true },
      { name: 'suppress-buttons', selector: '.weekly-hero .week-suppress-action', all: true },
      { name: 'manual-origins', selector: '.weekly-manual__origin', all: true },
      { name: 'manual-controls', selector: '.k12-manual-count-control', all: true },
    ],
    screenshotClip: { x: 514, y: 156, width: 900, height: 744 },
    normalizeContentBackground: true,
  },
  {
    name: 'k12-mistakes',
    openReference: async (page) => {
      await openReferenceRecords(page, 1)
      await expect(page.locator('#k12BookPanel1')).toBeVisible()
    },
    openImplementation: async (page) => openImplementationRecords(page, 'mistakes'),
    referenceGeometry: [
      { name: 'object-tabs', selector: '#k12BookTabs' },
      { name: 'records-body', selector: '#k12BookPanel1' },
      { name: 'summary', selector: '#k12BookPanel1 .rc-object-summary' },
      { name: 'filters', selector: '#k12BookPanel1 .k12-secondary-tabs' },
      { name: 'filter-rows', selector: '#k12BookPanel1 .k12-secondary-tabs__row', all: true },
      {
        name: 'filter-buttons',
        selector: '#k12BookPanel1 .k12-secondary-tabs .source-tag',
        all: true,
      },
      { name: 'archive-note', selector: '#k12BookPanel1 .rc-archnote' },
      { name: 'rows', selector: '#k12MistakeList .resource-row', all: true },
      { name: 'row-titles', selector: '#k12MistakeList .resource-row > b', all: true },
      { name: 'row-chips', selector: '#k12MistakeList .resource-row .kpill', all: true },
      { name: 'row-meta', selector: '#k12MistakeList .resource-row .sp', all: true },
      { name: 'row-source', selector: '#k12MistakeList .resource-row .srctag', all: true },
      { name: 'row-status', selector: '#k12MistakeList .resource-row .stpill', all: true },
      { name: 'row-actions', selector: '#k12MistakeList .resource-row > .btn', all: true },
      { name: 'row-all-actions', selector: '#k12MistakeList .resource-row > button', all: true },
      { name: 'row-children', selector: '#k12MistakeList .resource-row > *', all: true },
    ],
    implementationGeometry: [
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs' },
      { name: 'records-body', selector: '.k12rec__body > section[data-testid="mistakes-section"]' },
      { name: 'summary', selector: '.k12rec__object-summary' },
      { name: 'filters', selector: '.k12rec__filter-stack' },
      { name: 'filter-rows', selector: '.k12rec__filter-stack .k12rec__filter-row', all: true },
      { name: 'filter-buttons', selector: '.k12rec__filter-stack .k12rec__filter', all: true },
      { name: 'archive-note', selector: '.k12rec__archive-note' },
      { name: 'rows', selector: '.k12mistakes .rl-row', all: true },
      { name: 'row-titles', selector: '.k12mistakes .rl-row > .rl-title', all: true },
      { name: 'row-chips', selector: '.k12mistakes .rl-row .rl-chip', all: true },
      { name: 'row-meta', selector: '.k12mistakes .rl-row .rl-meta', all: true },
      { name: 'row-source', selector: '.k12mistakes .rl-row .rl-source', all: true },
      { name: 'row-status', selector: '.k12mistakes .rl-row .rl-status', all: true },
      { name: 'row-actions', selector: '.k12mistakes .rl-row > .rl-btn', all: true },
      { name: 'row-all-actions', selector: '.k12mistakes .rl-row > button', all: true },
      { name: 'row-children', selector: '.k12mistakes .rl-row > *', all: true },
    ],
    screenshotClip: { x: 514, y: 156, width: 900, height: 744 },
    normalizeContentBackground: true,
  },
  {
    name: 'k12-works',
    openReference: async (page) => {
      await openReferenceRecords(page, 4)
      await expect(page.locator('#k12BookPanel4')).toBeVisible()
    },
    openImplementation: async (page) => openImplementationRecords(page, 'works'),
    referenceGeometry: [
      { name: 'object-tabs', selector: '#k12BookTabs' },
      { name: 'object-tabs-shell', selector: '#k12BookTabs' },
      { name: 'records-body', selector: '#k12BookPanel4' },
      { name: 'overview', selector: '#k12BookPanel4 .practice-overview' },
      { name: 'overview-kpis', selector: '#k12BookPanel4 .practice-kpi', all: true },
      { name: 'filters', selector: '#k12CreativeWorkFilters' },
      { name: 'filter-label', selector: '#k12CreativeWorkFilters .k12-secondary-tabs__label' },
      { name: 'filter-buttons', selector: '#k12CreativeWorkFilters button', all: true },
      { name: 'rules', selector: '#k12BookPanel4 .notice-accent' },
      { name: 'list', selector: '#k12CreativeWorkList' },
      { name: 'cards', selector: '#k12CreativeWorkList .creative-work-card', all: true },
      { name: 'previews', selector: '#k12CreativeWorkList .creative-work-preview', all: true },
      { name: 'titles', selector: '#k12CreativeWorkList .creative-work-copy h3', all: true },
      { name: 'evidence', selector: '#k12CreativeWorkList .creative-work-evidence', all: true },
      { name: 'times', selector: '#k12CreativeWorkList .creative-work-card__time', all: true },
      { name: 'actions', selector: '#k12CreativeWorkList .creative-work-card__action', all: true },
    ],
    implementationGeometry: [
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs' },
      { name: 'object-tabs-shell', selector: '.k12rec__tabs' },
      { name: 'records-body', selector: '.k12rec__body > section[data-testid="works-section"]' },
      { name: 'overview', selector: '.k12cw__overview' },
      { name: 'overview-kpis', selector: '.k12cw__overview .k12cw__kpi', all: true },
      { name: 'filters', selector: '.k12cw__filter' },
      { name: 'filter-label', selector: '.k12cw__filter-label' },
      { name: 'filter-buttons', selector: '.k12cw__filter button', all: true },
      { name: 'rules', selector: '.k12cw__rules' },
      { name: 'list', selector: '.k12cw__list' },
      { name: 'cards', selector: '.k12cw__card', all: true },
      { name: 'previews', selector: '.k12cw__preview', all: true },
      { name: 'titles', selector: '.k12cw__title', all: true },
      { name: 'evidence', selector: '.k12cw__evidence', all: true },
      { name: 'times', selector: '.k12cw__time', all: true },
      { name: 'actions', selector: '.k12cw__detail-toggle', all: true },
    ],
    screenshotClip: { x: 514, y: 156, width: 900, height: 744 },
    normalizeContentBackground: true,
  },
]

async function geometry(page: Page, targets: GeometryTarget[]) {
  const result: Record<string, unknown> = {}
  for (const target of targets) {
    result[target.name] = await page.locator(target.selector).evaluateAll(
      (elements, options: { all: boolean }) => {
        const selected = options.all ? elements : elements.slice(0, 1)
        return selected.map((element) => {
          const node = element as HTMLElement
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          const overflowDescendants = Array.from(node.querySelectorAll<HTMLElement>('*'))
            .map((descendant) => {
              const descendantRect = descendant.getBoundingClientRect()
              return {
                tag: descendant.tagName.toLowerCase(),
                className: descendant.className,
                testId: descendant.dataset.testid || '',
                right: Number(descendantRect.right.toFixed(2)),
                overflowRight: Number((descendantRect.right - rect.right).toFixed(2)),
              }
            })
            .filter((candidate) => candidate.overflowRight > 0)
            .sort((left, right) => right.overflowRight - left.overflowRight)
            .slice(0, 12)
          return {
            tag: node.tagName.toLowerCase(),
            className: node.className,
            text: node.innerText.replace(/\s+/g, ' ').trim().slice(0, 240),
            rect: {
              x: Number(rect.x.toFixed(2)),
              y: Number(rect.y.toFixed(2)),
              width: Number(rect.width.toFixed(2)),
              height: Number(rect.height.toFixed(2)),
            },
            scroll: {
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight,
              scrollLeft: node.scrollLeft,
              scrollTop: node.scrollTop,
            },
            overflowDescendants,
            style: {
              display: style.display,
              position: style.position,
              boxSizing: style.boxSizing,
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              borderColor: style.borderColor,
              color: style.color,
              borderTopWidth: style.borderTopWidth,
              borderRightWidth: style.borderRightWidth,
              borderBottomWidth: style.borderBottomWidth,
              borderLeftWidth: style.borderLeftWidth,
              borderRadius: style.borderRadius,
              boxShadow: style.boxShadow,
              padding: style.padding,
              margin: style.margin,
              gap: style.gap,
              gridTemplateColumns: style.gridTemplateColumns,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
            },
          }
        })
      },
      { all: target.all === true },
    )
  }
  return result
}

async function shellLayers(page: Page, candidates: ShellLayerCandidate[]) {
  return page.evaluate((layerCandidates) => {
    return layerCandidates.map((candidate) => {
      const element = document.querySelector(candidate.selector)
      if (!element) {
        return {
          ...candidate,
          found: false,
          active: false,
          kind: 'none',
        }
      }
      const style = getComputedStyle(element, candidate.pseudo)
      const backgroundImage = style.backgroundImage
      const kind = backgroundImage.includes('image/svg+xml')
        ? 'texture'
        : backgroundImage.includes('radial-gradient')
          ? 'glow'
          : 'none'
      const active =
        style.content !== 'none' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        backgroundImage !== 'none'
      return {
        ...candidate,
        found: true,
        active,
        kind,
        style: {
          content: style.content,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          backgroundColor: style.backgroundColor,
          backgroundImage,
          backgroundBlendMode: style.backgroundBlendMode,
          mixBlendMode: style.mixBlendMode,
          position: style.position,
          inset: style.inset,
          top: style.top,
          right: style.right,
          bottom: style.bottom,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
        },
      }
    })
  }, candidates)
}

async function normalizeContentBackground(page: Page) {
  await page.addStyleTag({
    content: `
      .k12-secondary-tabs,
      .k12cw__filter,
    .k12cw__rules,
      .k12cw__card,
      .notice-accent,
      .creative-work-card,
      .k12rec__filter-stack,
      #k12MistakeList .resource-row,
      .k12mistakes .rl-row,
      .rc-week-progress,
      .rc-week-hero,
      .rc-week-hero .resource-row {
        background-color: rgb(255, 254, 249) !important;
        background-image: none !important;
      }
    `,
  })
}

async function captureSurface(
  referencePage: Page,
  implementationPage: Page,
  surface: Surface,
  testInfo: TestInfo,
) {
  await surface.openReference(referencePage)
  await surface.openImplementation(implementationPage)
  if (REQUESTED_INTERACTION === 'weekly-review-menu') {
    expect(surface.name).toBe('k12-weekly-current')
    const referenceTrigger = referencePage.locator('#k12BookPanel0 .mistake-more-action').first()
    const implementationTrigger = implementationPage
      .locator('.weekly-hero .mistake-more__trigger')
      .first()
    await referenceTrigger.click()
    await implementationTrigger.click()
    await expect(referencePage.locator('.menu[role="menu"]')).toBeVisible()
    await expect(implementationPage.locator('.mistake-more__menu[role="menu"]')).toBeVisible()
  }
  await freezeVisualState(referencePage)
  await freezeVisualState(implementationPage)

  const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.name)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const implementationPath = path.join(outputDir, 'implementation.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry.json')
  const reportPath = path.join(outputDir, 'diff-report.json')

  const referenceTargets = [...surface.referenceGeometry]
  const implementationTargets = [...surface.implementationGeometry]
  if (REQUESTED_INTERACTION === 'weekly-review-menu') {
    referenceTargets.push({ name: 'review-menu', selector: '.menu[role="menu"]' })
    implementationTargets.push({
      name: 'review-menu',
      selector: '.mistake-more__menu[role="menu"]',
    })
  }
  const [referenceGeometry, implementationGeometry, referenceLayers, implementationLayers] =
    await Promise.all([
      geometry(referencePage, referenceTargets),
      geometry(implementationPage, implementationTargets),
      shellLayers(referencePage, referenceShellLayers),
      shellLayers(implementationPage, implementationShellLayers),
    ])

  if (surface.normalizeContentBackground) {
    await Promise.all([
      normalizeContentBackground(referencePage),
      normalizeContentBackground(implementationPage),
    ])
  }
  const screenshotOptions = {
    animations: 'disabled' as const,
    caret: 'hide' as const,
    scale: 'css' as const,
    ...(surface.screenshotClip ? { clip: surface.screenshotClip } : {}),
  }
  await referencePage.screenshot({ path: referencePath, ...screenshotOptions })
  await implementationPage.screenshot({ path: implementationPath, ...screenshotOptions })
  await writeFile(
    geometryPath,
    `${JSON.stringify(
      {
        surface: surface.name,
        viewport: referencePage.viewportSize(),
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        reference: referenceGeometry,
        implementation: implementationGeometry,
        shellLayers: {
          reference: referenceLayers,
          implementation: implementationLayers,
        },
      },
      null,
      2,
    )}\n`,
  )

  const { stdout } = await execFileAsync('python3', [
    PIXEL_DIFF_TOOL,
    referencePath,
    implementationPath,
    diffPath,
    String(PIXEL_THRESHOLD),
  ])
  const diffReport = JSON.parse(stdout.trim()) as {
    changed_pixel_ratio: number
    changed_pixels: number
    total_pixels: number
    changed_bbox: number[] | null
  }
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        surface: surface.name,
        referenceURL: REFERENCE_URL,
        implementationURL: IMPLEMENTATION_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
        ...diffReport,
      },
      null,
      2,
    )}\n`,
  )

  await testInfo.attach(`${surface.name}-reference`, {
    body: await readFile(referencePath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-implementation`, {
    body: await readFile(implementationPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-pixel-diff`, {
    body: await readFile(diffPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${surface.name}-geometry`, {
    body: await readFile(geometryPath),
    contentType: 'application/json',
  })

  expect
    .soft(
      diffReport.changed_pixel_ratio,
      `${surface.name} changed ${diffReport.changed_pixels}/${diffReport.total_pixels} pixels; ` +
        `evidence=${outputDir}`,
    )
    .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)

  const referenceTextureCount = referenceLayers.filter(
    (layer) => layer.active && layer.kind === 'texture',
  ).length
  const implementationTextureCount = implementationLayers.filter(
    (layer) => layer.active && layer.kind === 'texture',
  ).length
  const referenceGlowCount = referenceLayers.filter(
    (layer) => layer.active && layer.kind === 'glow',
  ).length
  const implementationGlowCount = implementationLayers.filter(
    (layer) => layer.active && layer.kind === 'glow',
  ).length

  expect
    .soft(
      implementationTextureCount,
      `${surface.name} shell texture exact-set differs from prototype; evidence=${geometryPath}`,
    )
    .toBe(referenceTextureCount)
  expect
    .soft(
      implementationGlowCount,
      `${surface.name} shell glow exact-set differs from prototype; evidence=${geometryPath}`,
    )
    .toBe(referenceGlowCount)
}

test.describe('feat/v0.5.0-k12-parent-tutor prototype screenshot fidelity', () => {
  test('K12 priority surfaces preserve paired screenshots, visible diff and geometry', async ({
    browser,
  }, testInfo) => {
    const referencePage = await browser.newPage()
    const implementationPage = await browser.newPage()
    await installImplementationMocks(implementationPage)
    try {
      const selectedSurfaces = REQUESTED_SURFACE
        ? surfaces.filter((surface) => surface.name === REQUESTED_SURFACE)
        : surfaces
      for (const surface of selectedSurfaces) {
        await captureSurface(referencePage, implementationPage, surface, testInfo)
      }
    } finally {
      await Promise.all([referencePage.close(), implementationPage.close()])
    }
  })
})
