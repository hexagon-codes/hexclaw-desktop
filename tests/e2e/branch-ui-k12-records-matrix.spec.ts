import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const AGENT = 'k12-fidelity-ming'
const SESSION = 'k12-records-matrix-session'
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-fidelity/evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001

type Side = 'reference' | 'implementation'

interface Target {
  name: string
  selector: string
  all?: boolean
  required?: boolean
}

interface StateDefinition {
  name: string
  fixture: string
  openReference(page: Page): Promise<string[]>
  openImplementation(page: Page): Promise<string[]>
  referenceTargets: Target[]
  implementationTargets: Target[]
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function weeklyItem(
  itemID: string,
  position: number,
  sourceRef: string,
  prompt: string,
  evidence: string,
) {
  return {
    item_id: itemID,
    position,
    plan_section: 'due_review',
    source_kind: 'mistake',
    generation_method: 'original',
    source_ref: sourceRef,
    verification: { status: 'verified', evidence_refs: [evidence] },
    prompt_markdown: prompt,
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
        weeklyItem(
          'weekly-item-1',
          1,
          'mistake-apple',
          '苹果每千克 4.2 元，买 3 千克共多少钱？',
          '小数乘法错题 · 连续错 2 次',
        ),
        weeklyItem(
          'weekly-item-2',
          2,
          'mistake-equation',
          '解方程：2x + 15 = 43。',
          '简易方程错题 · 移项符号错',
        ),
        weeklyItem('weekly-item-3', 3, 'mistake-believe', '默写单词：believe。', 'Unit 4 听写错题'),
        weeklyItem(
          'weekly-item-4',
          4,
          'mistake-poem',
          '补全诗句：梅＿＿逊雪三分白。',
          '古诗默写错题',
        ),
        weeklyItem(
          'weekly-item-5',
          5,
          'mistake-fraction',
          '8 的 1/4 的 4/5 是多少？',
          '分数乘法错题',
        ),
        weeklyItem('weekly-item-6', 6, 'mistake-decimal', '口算：4 ÷ 0.5。', '小数除法错题'),
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

const mistakes = [
  {
    record_id: 'mistake-apple',
    question: '苹果和梨的价钱',
    knowledge_point: '小数乘法',
    error_cause: '连续错 2 次',
    status: 'reviewing',
    review_state: 'scheduled',
    version: 1,
    due_at: 1785081600,
    subject: '数学',
    review_kind: 'verify',
  },
  {
    record_id: 'mistake-believe',
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
]

const accumulation = [
  {
    record_id: 'accum-poem',
    subject: '语文',
    entry_type: '好词好句',
    content: '梅须逊雪三分白，雪却输梅一段香。',
    source: '课堂笔记',
    version: 1,
    created_at: 1784995200,
  },
  {
    record_id: 'accum-english',
    subject: '英语',
    entry_type: '词句',
    content: 'Practice makes perfect.',
    source: 'Unit 4',
    version: 1,
    created_at: 1784908800,
  },
]

const practiceSets = [
  {
    record_id: 'practice-basket',
    title: '待打印篮',
    source_kind: 'basket',
    status: 'draft',
    status_label: '草稿',
    publishable: true,
    delivery_status: '',
    return_assets: [],
    items: [
      {
        item_id: 'practice-item-1',
        subject: '数学',
        added_via: 'weekly',
        question_markdown: '苹果每千克 4.2 元，买 3 千克共多少钱？',
        expected_answer_markdown: '12.6 元',
        verification_status: 'verified',
        verification_evidence: '原题与答案已校验',
      },
      {
        item_id: 'practice-item-2',
        subject: '英语',
        added_via: 'weekly',
        question_markdown: '默写单词：believe。',
        expected_answer_markdown: 'believe',
        verification_status: 'verified',
        verification_evidence: '原词已校验',
      },
    ],
  },
  {
    record_id: 'practice-history-1',
    title: '7月20日–7月26日练习卷',
    source_kind: 'weekly',
    status: 'graded',
    status_label: '已批改',
    publishable: true,
    question_artifact_id: 'artifact-question-1',
    answer_artifact_id: 'artifact-answer-1',
    paper_no: 'P-2630-01',
    finalized_at: 1785081600,
    finalized_via: 'print',
    delivery_status: '',
    return_assets: [],
    items: [
      {
        item_id: 'history-item-1',
        subject: '数学',
        added_via: 'weekly',
        question_markdown: '解方程：2x + 15 = 43。',
        expected_answer_markdown: 'x = 14',
        verification_status: 'verified',
        verification_evidence: '答案已校验',
        paper_seq: 1,
        returned: true,
        result_correct: true,
        result_evidence: 'system_verified',
      },
    ],
  },
]

function creativeFeedback(id: string, type: 'writing' | 'art', evidence: string[]) {
  return {
    feedback_id: id,
    feedback_type: type,
    evidence_refs: evidence.map((_, index) => `evidence-${id}-${index + 1}`),
    visible_evidence: evidence,
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
    display_name: '《春天的校园》',
    content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-WRITING-20260715-001',
      status: 'succeeded',
      feedback: creativeFeedback('feedback-writing', 'writing', [
        '切题：校园春景',
        '结构：三段',
        '表达：有一处可提升',
      ]),
    },
  },
  {
    work_id: 'ART-20260716-001',
    work_type: 'art',
    display_name: '《雨后的校园》',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260716-001',
      status: 'succeeded',
      feedback: creativeFeedback('feedback-art', 'art', [
        '构图：主体偏右',
        '色彩：冷暖有层次',
        '线条：边缘清楚',
      ]),
    },
  },
  {
    work_id: 'ART-20260717-002',
    work_type: 'art',
    display_name: '《桌上的水杯》',
    row_version: 1,
    initial_feedback: {
      generation_id: 'REVIEW-ART-20260717-002',
      status: 'failed',
      failure_message: '点评生成失败',
    },
  },
]

const k12WebhookBinding = {
  binding_id: 'binding-homework-hook',
  name: 'homework-hook',
  agent_id: AGENT,
  learner_id: 'learner-fidelity-ming',
  scope: 'direct',
  allowed_events: [
    'k12.submission.requested.v1',
    'k12.practice_return.requested.v1',
    'k12.workflow_run.requested.v1',
  ],
  allowed_workflows: ['weekly@v1'],
  has_secret: true,
  secret_version: 2,
  status: 'enabled',
  created_by: 'desktop-user',
  rotated_at: '2026-07-28T08:00:00+08:00',
  created_at: '2026-07-20T08:00:00+08:00',
  updated_at: '2026-07-28T08:00:00+08:00',
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
    json(route, { models: [], version: 'k12-records-matrix' }),
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
    if (apiPath === '/api/k12/mistakes') return json(route, { items: mistakes })
    if (apiPath === '/api/k12/review-queue') return json(route, { items: mistakes })
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
      const subject = requestURL.searchParams.get('subject')
      return json(route, {
        items: subject ? accumulation.filter((item) => item.subject === subject) : accumulation,
      })
    }
    if (apiPath === '/api/k12/practice-sets' && method === 'GET') {
      return json(route, { items: practiceSets })
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: creativeWorks })
    }
    if (apiPath === '/api/k12/insight-report') {
      return json(route, {
        grade_term: '五年级下',
        trend: { total: 11, mastered: 5, reviewing: 6, retried: 7, archived: 0 },
        weak_top3: [
          { knowledge_point: '小数乘法', count: 4, share: 0.36, subject: '数学' },
          { knowledge_point: '简易方程', count: 3, share: 0.27, subject: '数学' },
          { knowledge_point: 'Unit 4 拼写', count: 2, share: 0.18, subject: '英语' },
        ],
        consecutive_fail_kps: ['简易方程'],
        month_new_mistakes: 11,
        review_completion_rate: 0.72,
        week_pending: 6,
        practice_pending: 2,
        suggestion: '优先复习小数乘法，再完成练习集。',
      })
    }
    if (apiPath === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath === '/api/v1/webhooks' && method === 'GET') {
      if (requestURL.searchParams.get('binding_name')) {
        return json(route, { receipts: [], total: 0 })
      }
      if (requestURL.searchParams.get('agent_id')) {
        return json(route, { k12_bindings: [k12WebhookBinding], total: 1 })
      }
      return json(route, { webhooks: [], total: 0 })
    }
    if (
      apiPath === '/api/v1/cron/jobs' ||
      apiPath === '/api/v1/tasks' ||
      apiPath === '/api/v1/autonomy/summary'
    ) {
      return json(route, { jobs: [], tasks: [], total: 0 })
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
  const issues: string[] = []
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  const invoked = await page.evaluate((recordsTab) => {
    const api = window as typeof window & {
      goRecords?: (learner: string, tab: number) => void
      k12BookTab?: (tab: number) => void
    }
    if (!api.goRecords || !api.k12BookTab) return false
    api.goRecords('ming', recordsTab)
    api.k12BookTab(recordsTab)
    return true
  }, tab)
  if (!invoked) issues.push('blocked: prototype goRecords/k12BookTab API is missing')
  if (
    !(await page
      .locator('#k12ViewRecords')
      .isVisible()
      .catch(() => false))
  ) {
    issues.push('blocked: prototype #k12ViewRecords is not visible')
  }
  return issues
}

async function openImplementationRecords(page: Page, testID: string) {
  const issues: string[] = []
  await page.goto(
    `${IMPLEMENTATION_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  const recordsTab = page.locator('.k12enh-seg').getByRole('tab', {
    name: '学习档案',
    exact: true,
  })
  const recordsTabReady = await recordsTab
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (recordsTabReady) {
    await recordsTab.click()
  } else {
    issues.push('blocked: implementation 学习档案 scenario tab is missing')
  }
  const objectTab = page.getByTestId(testID)
  const objectTabReady = await objectTab
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (objectTabReady) {
    await objectTab.click()
  } else {
    issues.push(`blocked: implementation object tab ${testID} is missing`)
  }
  const recordsReady = await page
    .locator('.k12rec')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!recordsReady) {
    issues.push('blocked: implementation .k12rec is not visible')
  }
  return issues
}

function recordsTargets(
  panel: number,
  implementationSection: string,
): Pick<StateDefinition, 'referenceTargets' | 'implementationTargets'> {
  return {
    referenceTargets: [
      { name: 'records-root', selector: '#k12ViewRecords', required: true },
      { name: 'object-tabs', selector: '#k12BookTabs', required: true },
      { name: 'active-panel', selector: `#k12BookPanel${panel}`, required: true },
      {
        name: 'visible-cards',
        selector: `#k12BookPanel${panel} .resource-row, #k12BookPanel${panel} .cxcard, #k12BookPanel${panel} .creative-work-card`,
        all: true,
      },
    ],
    implementationTargets: [
      { name: 'records-root', selector: '.k12rec', required: true },
      { name: 'object-tabs', selector: '.k12rec__tabs .k12-book-tabs', required: true },
      { name: 'active-panel', selector: implementationSection, required: true },
      {
        name: 'visible-cards',
        selector:
          `${implementationSection} .resource-row, ${implementationSection} article, ` +
          `${implementationSection} .rl-row, ${implementationSection} .k12cw__card`,
        all: true,
      },
    ],
  }
}

const weeklyTargets = recordsTargets(0, '[data-testid="week-section"]')
const mistakeTargets = recordsTargets(1, '[data-testid="mistakes-section"]')
const practiceTargets = recordsTargets(2, '[data-testid="practicesets-section"]')
const accumulationTargets = recordsTargets(3, '[data-testid="accum-prototype"]')
const worksTargets = recordsTargets(4, '[data-testid="works-section"]')

const states: StateDefinition[] = [
  {
    name: 'weekly-current',
    fixture: '小明 / 2026-W30 / 6 到期复习 + 2 个手动轨道建议 / current',
    openReference: async (page) => openReferenceRecords(page, 0),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-week'),
    referenceTargets: [
      ...weeklyTargets.referenceTargets,
      { name: 'period-tabs', selector: '#k12BookPanel0 .k12-week-view-tabs', required: true },
      { name: 'progress', selector: '#k12BookPanel0 .rc-week-progress', required: true },
      { name: 'hero', selector: '#k12BookPanel0 .rc-week-hero', required: true },
      {
        name: 'weekly-items',
        selector: '#k12BookPanel0 .rc-week-hero .resource-row',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      ...weeklyTargets.implementationTargets,
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs', required: true },
      { name: 'progress', selector: '.weekly-progress', required: true },
      { name: 'hero', selector: '.weekly-hero', required: true },
      { name: 'weekly-tracks', selector: '.weekly-track', all: true, required: true },
      { name: 'weekly-items', selector: '.weekly-item', all: true, required: true },
    ],
  },
  {
    name: 'weekly-history',
    fixture: '小明 / 2026-W29 archived / 8 道 7 对 1 错 / history',
    openReference: async (page) => {
      const issues = await openReferenceRecords(page, 0)
      const invoked = await page.evaluate(() => {
        const api = window as typeof window & {
          switchK12WeeklyView?: (view: string) => void
        }
        if (!api.switchK12WeeklyView) return false
        api.switchK12WeeklyView('history')
        return true
      })
      if (!invoked) issues.push('blocked: prototype switchK12WeeklyView API is missing')
      return issues
    },
    openImplementation: async (page) => {
      const issues = await openImplementationRecords(page, 'subtab-week')
      const historyTab = page
        .locator('.weekly-toolbar')
        .getByRole('tab', { name: '历史', exact: true })
      const historyReady = await historyTab
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      if (historyReady) {
        await historyTab.click()
      } else {
        issues.push('blocked: implementation weekly history tab is missing')
      }
      return issues
    },
    referenceTargets: [
      ...weeklyTargets.referenceTargets,
      { name: 'period-tabs', selector: '#k12BookPanel0 .k12-week-view-tabs', required: true },
      {
        name: 'history-panel',
        selector: '#k12BookPanel0 [data-week-view-panel="history"]',
        required: true,
      },
      {
        name: 'history-cards',
        selector: '#k12BookPanel0 .k12-week-history-card',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      ...weeklyTargets.implementationTargets,
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs', required: true },
      { name: 'history-panel', selector: '.weekly-history', required: true },
      {
        name: 'history-cards',
        selector: '.weekly-history .weekly-history__card',
        all: true,
        required: true,
      },
    ],
  },
  {
    name: 'mistakes',
    fixture: '小明 / 全学科 + 全状态 / 2 条代表性错题',
    openReference: async (page) => openReferenceRecords(page, 1),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-mistakes'),
    ...mistakeTargets,
  },
  {
    name: 'practice-sets',
    fixture: '小明 / 待打印篮 2 题 + 已批改历史卷 1 题',
    openReference: async (page) => openReferenceRecords(page, 2),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-practicesets'),
    ...practiceTargets,
  },
  {
    name: 'accumulation',
    fixture: '小明 / 全部 / 语文与英语积累各 1 条',
    openReference: async (page) => openReferenceRecords(page, 3),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-accumulation'),
    ...accumulationTargets,
  },
  {
    name: 'works',
    fixture: '小明 / 作品 3 条 / 写作成功 + 美术成功 + 美术失败',
    openReference: async (page) => openReferenceRecords(page, 4),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-works'),
    ...worksTargets,
  },
  {
    name: 'insights',
    fixture: '小明 / 五年级下 / 11 错题 + 6 待复习 + 2 待练习 + TOP3',
    openReference: async (page) => {
      const issues = await openReferenceRecords(page, 0)
      const invoked = await page.evaluate(() => {
        const api = window as typeof window & { k12Tab?: (tab: string) => void }
        if (!api.k12Tab) return false
        api.k12Tab('insights')
        return true
      })
      if (!invoked) issues.push('blocked: prototype k12Tab(insights) API is missing')
      return issues
    },
    openImplementation: async (page) => {
      const issues = await openImplementationRecords(page, 'subtab-week')
      const insightsTab = page
        .locator('.k12enh-seg')
        .getByRole('tab', { name: '学情', exact: true })
      const insightsReady = await insightsTab
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      if (insightsReady) {
        await insightsTab.click()
      } else {
        issues.push('blocked: implementation 学情 scenario tab is missing')
      }
      return issues
    },
    referenceTargets: [
      { name: 'insights-root', selector: '#k12BookPanel5', required: true },
      {
        name: 'tiles',
        selector: '#k12BookPanel5 .k12-priority-card, #k12BookPanel5 .k12-insight-action',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      { name: 'insights-root', selector: '[data-testid="insight-panel"]', required: true },
      {
        name: 'tiles',
        selector:
          '[data-testid="insight-panel"] .k12ins__tile, [data-testid="insight-panel"] .k12ins__action',
        all: true,
        required: true,
      },
    ],
  },
  {
    name: 'backup-restore',
    fixture: '小明 / 家庭学习档案 / 导出 + .hexbak 恢复入口',
    openReference: async (page) => {
      const issues = await openReferenceRecords(page, 1)
      const invoked = await page.evaluate(() => {
        const api = window as typeof window & { openBackup?: () => void }
        if (!api.openBackup) return false
        api.openBackup()
        return true
      })
      if (!invoked) issues.push('blocked: prototype openBackup API is missing')
      return issues
    },
    openImplementation: async (page) => {
      const issues = await openImplementationRecords(page, 'subtab-mistakes')
      const more = page.getByTestId('records-more-trigger')
      if (await more.isVisible().catch(() => false)) {
        await more.click()
        const backup = page.getByTestId('records-more-menu').getByRole('menuitem', { name: /备份/ })
        if (await backup.isVisible().catch(() => false)) {
          await backup.click()
        } else {
          issues.push('blocked: implementation 备份/恢复 menu item is missing')
        }
      } else {
        issues.push('blocked: implementation records overflow menu is missing')
      }
      return issues
    },
    referenceTargets: [
      { name: 'overlay', selector: '#overlay', required: true },
      { name: 'dialog', selector: '#overlay .modal', required: true },
      { name: 'dropzone', selector: '#overlay .hc-drop', required: true },
    ],
    implementationTargets: [
      { name: 'overlay', selector: '.k12bk-overlay', required: true },
      {
        name: 'dialog',
        selector: '[role="dialog"][aria-labelledby="k12-backup-title"]',
        required: true,
      },
      { name: 'dropzone', selector: '.k12bk__drop', required: true },
    ],
  },
  {
    name: 'webhook',
    fixture: '小明 / homework-hook / enabled / 3 requested.v1 events / Secret v2',
    openReference: async (page) => {
      const issues: string[] = []
      await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
      const invoked = await page.evaluate(() => {
        const api = window as typeof window & {
          showPane?: (pane: string) => void
          seg?: (group: string, index: number) => void
        }
        if (!api.showPane || !api.seg) return false
        api.showPane('automation')
        api.seg('au', 1)
        return true
      })
      if (!invoked) issues.push('blocked: prototype automation/webhook navigation API is missing')
      return issues
    },
    openImplementation: async (page) => {
      const issues: string[] = []
      await page.goto(`${IMPLEMENTATION_URL}/automation/webhooks`, {
        waitUntil: 'domcontentloaded',
      })
      const webhookReady = await page
        .getByTestId('k12-webhook-panel')
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      if (!webhookReady) {
        issues.push('blocked: implementation K12 webhook panel is missing')
      }
      return issues
    },
    referenceTargets: [
      { name: 'webhook-panel', selector: '[data-sub="au1"]', required: true },
      {
        name: 'k12-card',
        selector: '[data-sub="au1"] .k12-webhook-card',
        required: true,
      },
      {
        name: 'events',
        selector: '[data-sub="au1"] .k12-webhook-event',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      { name: 'webhook-panel', selector: '[data-testid="k12-webhook-panel"]', required: true },
      {
        name: 'k12-card',
        selector: '[data-testid="k12-webhook-row-homework-hook"]',
        required: true,
      },
      {
        name: 'events',
        selector: '[data-testid="k12-webhook-row-homework-hook"] .k12wh__event',
        all: true,
        required: true,
      },
    ],
  },
]

async function targetEvidence(page: Page, targets: Target[]) {
  const result: Record<string, unknown> = {}
  const requiredMissing: string[] = []
  for (const target of targets) {
    const value = await page.locator(target.selector).evaluateAll(
      (elements, options: { all: boolean }) => {
        const selected = options.all ? elements : elements.slice(0, 1)
        return selected
          .map((element) => {
            const node = element as HTMLElement
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            const visible =
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || '1') > 0 &&
              rect.width > 0 &&
              rect.height > 0
            return {
              tag: node.tagName.toLowerCase(),
              id: node.id,
              className: node.className,
              visible,
              text: node.innerText.replace(/\s+/g, ' ').trim().slice(0, 320),
              rect: {
                x: Number(rect.x.toFixed(2)),
                y: Number(rect.y.toFixed(2)),
                width: Number(rect.width.toFixed(2)),
                height: Number(rect.height.toFixed(2)),
              },
              style: {
                display: style.display,
                position: style.position,
                boxSizing: style.boxSizing,
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
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
          .filter((item) => item.visible)
      },
      { all: target.all === true },
    )
    result[target.name] = { selector: target.selector, matches: value }
    if (target.required && value.length === 0) requiredMissing.push(target.name)
  }
  return { targets: result, requiredMissing }
}

async function rootEvidence(page: Page, side: Side) {
  return page.evaluate((currentSide) => {
    const selectors =
      currentSide === 'reference'
        ? ['html', 'body', '.app', '.screen.on', '.content']
        : ['html', 'body', '#app', '.hc-app', '.hc-app__body', '.hc-app__content']
    return selectors.map((selector) => {
      const node = document.querySelector(selector) as HTMLElement | null
      if (!node) return { selector, found: false }
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        selector,
        found: true,
        rect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        style: {
          display: style.display,
          position: style.position,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        },
      }
    })
  }, side)
}

async function captureState(
  referencePage: Page,
  implementationPage: Page,
  state: StateDefinition,
  testInfo: TestInfo,
) {
  const referenceIssues = await state
    .openReference(referencePage)
    .catch((error: unknown) => [
      `blocked: reference navigation threw: ${error instanceof Error ? error.message : String(error)}`,
    ])
  const implementationIssues = await state
    .openImplementation(implementationPage)
    .catch((error: unknown) => [
      `blocked: implementation navigation threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ])

  await Promise.all([
    freezeVisualState(referencePage).catch((error: unknown) => {
      referenceIssues.push(
        `blocked: reference freeze threw: ${error instanceof Error ? error.message : String(error)}`,
      )
    }),
    freezeVisualState(implementationPage).catch((error: unknown) => {
      implementationIssues.push(
        `blocked: implementation freeze threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }),
  ])

  const outputDir = path.join(
    EVIDENCE_ROOT,
    testInfo.project.name,
    'k12-records-matrix',
    state.name,
  )
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const implementationPath = path.join(outputDir, 'implementation.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry-style.json')
  const reportPath = path.join(outputDir, 'diff-report.json')

  await referencePage.screenshot({
    path: referencePath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  })
  await implementationPage.screenshot({
    path: implementationPath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  })

  const [referenceTargets, implementationTargets, referenceRoots, implementationRoots] =
    await Promise.all([
      targetEvidence(referencePage, state.referenceTargets),
      targetEvidence(implementationPage, state.implementationTargets),
      rootEvidence(referencePage, 'reference'),
      rootEvidence(implementationPage, 'implementation'),
    ])

  referenceIssues.push(
    ...referenceTargets.requiredMissing.map(
      (name) => `blocked: required reference geometry target is missing: ${name}`,
    ),
  )
  implementationIssues.push(
    ...implementationTargets.requiredMissing.map(
      (name) => `blocked: required implementation geometry target is missing: ${name}`,
    ),
  )

  await writeFile(
    geometryPath,
    `${JSON.stringify(
      {
        state: state.name,
        fixture: state.fixture,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        colorScheme: 'light',
        reference: {
          url: referencePage.url(),
          issues: referenceIssues,
          roots: referenceRoots,
          ...referenceTargets,
        },
        implementation: {
          url: implementationPage.url(),
          issues: implementationIssues,
          roots: implementationRoots,
          ...implementationTargets,
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
  const diff = JSON.parse(stdout.trim()) as {
    changed_pixel_ratio: number
    changed_pixels: number
    total_pixels: number
    changed_bbox: number[] | null
  }
  const status =
    referenceIssues.length > 0 || implementationIssues.length > 0
      ? 'blocked'
      : diff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
        ? 'pass'
        : 'red'
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        state: state.name,
        fixture: state.fixture,
        status,
        referenceURL: REFERENCE_URL,
        implementationURL: IMPLEMENTATION_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
        referenceIssues,
        implementationIssues,
        ...diff,
      },
      null,
      2,
    )}\n`,
  )

  await testInfo.attach(`${state.name}-reference`, {
    body: await readFile(referencePath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${state.name}-implementation`, {
    body: await readFile(implementationPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${state.name}-pixel-diff`, {
    body: await readFile(diffPath),
    contentType: 'image/png',
  })
  await testInfo.attach(`${state.name}-geometry-style`, {
    body: await readFile(geometryPath),
    contentType: 'application/json',
  })

  expect
    .soft(referenceIssues, `${state.name} reference is blocked; evidence=${geometryPath}`)
    .toEqual([])
  expect
    .soft(implementationIssues, `${state.name} implementation is blocked; evidence=${geometryPath}`)
    .toEqual([])
  expect
    .soft(
      diff.changed_pixel_ratio,
      `${state.name} changed ${diff.changed_pixels}/${diff.total_pixels} pixels; evidence=${outputDir}`,
    )
    .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
}

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
})

test.describe('feat/v0.5.0-k12-parent-tutor learning-record visual matrix', () => {
  test('all authoritative records surfaces preserve screenshot triplets and geometry/style evidence', async ({
    browser,
  }, testInfo) => {
    const referencePage = await browser.newPage()
    const implementationPage = await browser.newPage()
    await installImplementationMocks(implementationPage)
    try {
      for (const state of states) {
        await captureState(referencePage, implementationPage, state, testInfo)
      }
    } finally {
      await Promise.all([referencePage.close(), implementationPage.close()])
    }
  })
})
