import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:15151'
const AGENT = 'k12-fidelity-ming'
const SESSION = 'k12-records-matrix-session'
const EVIDENCE_ROOT = path.resolve(
  process.env.HEX_UI_EVIDENCE_ROOT?.trim() || 'test-results/branch-ui-fidelity/evidence',
)
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/k12_visual_pixel_diff.swift')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const GEOMETRY_TOLERANCE = 1
const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const STATE_FILTER = process.env.HEX_UI_STATE_FILTER?.trim()
const TARGET_ONLY = process.env.HEX_UI_TARGET_ONLY?.trim() === '1'
let activeImplementationFixtureState = ''

type Side = 'reference' | 'implementation'

interface Target {
  name: string
  selector: string
  all?: boolean
  required?: boolean
  ignoreText?: boolean
  ignoreBusinessGeometryFields?: Array<'x' | 'y' | 'width' | 'height'>
}

interface StateDefinition {
  name: string
  fixture: string
  viewport?: { width: number; height: number }
  fullPagePixelComparable?: boolean
  fullPagePixelReason?: string
  openReference(page: Page): Promise<string[]>
  openImplementation(page: Page): Promise<string[]>
  referenceTargets: Target[]
  implementationTargets: Target[]
  comparisonTargets?: string[]
  pixelComparisonTargets?: string[]
  horizontalOverflowTargets?: string[]
  allowedReferenceHorizontalOverflowTargets?: string[]
  absentTargets?: string[]
  horizontalScrollResetTargets?: string[]
  containmentTargets?: string[]
  clipTargets?: string[]
  exactTargetTexts?: Record<string, string[]>
  disabledTargets?: string[]
  scrollSequence?: boolean
  referencePixelMaskSelectors?: string[]
  implementationPixelMaskSelectors?: string[]
}

interface CapturedTarget {
  tag: string
  id: string
  className: string
  visible: boolean
  text: string
  attributes: {
    title: string | null
    expectedScrollTop: string | null
    disabled: boolean
    ariaSelected: string | null
    ariaPressed: string | null
    dataReviewState: string | null
  }
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  metrics: {
    clientWidth: number
    scrollWidth: number
    clientHeight: number
    scrollHeight: number
    scrollLeft: number
    scrollTop: number
    textClipped: boolean
  }
  style: Record<string, string>
  containment: {
    containerSelector: string | null
    contained: boolean | null
    containerRect: {
      x: number
      y: number
      width: number
      height: number
    } | null
  }
}

interface TargetEvidence {
  targets: Record<
    string,
    {
      selector: string
      ignoreText: boolean
      ignoreBusinessGeometryFields: Array<'x' | 'y' | 'width' | 'height'>
      matches: CapturedTarget[]
    }
  >
  requiredMissing: string[]
}

interface PixelDiffEvidence {
  changed_pixel_ratio: number
  changed_pixels: number
  total_pixels: number
  changed_bbox: number[] | null
}

interface ScrollSequenceTransition {
  targetIndex: number
  injected: { scrollLeft: number; scrollTop: number }
  before: RecordsObjectSnapshot
  after: RecordsObjectSnapshot
  violations: string[]
}

interface RecordsObjectSnapshot {
  activeTabIndices: number[]
  activePanelIndices: number[]
  activeTab: ScrollLayoutSnapshot | null
  activePanel: ScrollLayoutSnapshot | null
  content: {
    rect: { x: number; y: number; width: number; height: number }
    style: Record<string, string>
    scrollLeft: number
    scrollTop: number
  }
  tabDataDigest: string
  mistakeFilterDigest: string
  mistakeDataDigest: string
}

interface ScrollLayoutSnapshot {
  rect: { x: number; y: number; width: number; height: number }
  style: Record<string, string>
}

interface ScrollSequenceEvidence {
  transitions: ScrollSequenceTransition[]
  violations: string[]
}

const scrollSequenceEvidence = new WeakMap<Page, ScrollSequenceEvidence>()

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

function practiceGeneration(recordID: string, state = activeImplementationFixtureState) {
  if (state === 'practice-set-pending' && recordID === 'mistake-apple') {
    return {
      state: 'pending',
      source_mistake_id: recordID,
      source_mistake_summary: '苹果和梨的价钱（P52·3）',
    }
  }
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
    return { state: 're_add', source_mistake_id: recordID }
  }
  return { state: 'available', source_mistake_id: recordID }
}

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
    delivery_status: 'not_sent',
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
    delivery_status: 'not_sent',
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

function practiceSetsForState(state = activeImplementationFixtureState) {
  if (state !== 'practice-set-pending') return practiceSets
  return practiceSets.map((practiceSet) =>
    practiceSet.source_kind === 'basket' ? { ...practiceSet, items: [] } : practiceSet,
  )
}

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
    display_kind: '语文·习作',
    preview_variant: 'writing',
    display_evidence: ['切题：校园春景', '结构：三段', '表达：有一处可提升'],
    content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
    row_version: 1,
    created_at: 1_784_115_343,
    latest_generation_at: 1_784_115_343,
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
    display_kind: '美术·水彩',
    preview_variant: 'default',
    display_evidence: ['构图：主体偏右', '色彩：冷暖有层次', '线条：边缘清楚'],
    row_version: 1,
    created_at: 1_784_203_929,
    latest_generation_at: 1_784_203_929,
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
    display_kind: '美术·线描',
    preview_variant: 'line',
    display_evidence: ['原图：已保存', '年级：五年级'],
    row_version: 1,
    created_at: 1_784_248_938,
    latest_generation_at: null,
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
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          const healthyEngineStyle = document.createElement('style')
          healthyEngineStyle.textContent = '.hc-engine-banner { display: none !important; }'
          document.head.append(healthyEngineStyle)
        },
        { once: true },
      )
    },
    { agent: AGENT, session: SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'k12-records-matrix' }),
  )
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
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
    const generationMatch = apiPath.match(/^\/api\/k12\/mistakes\/([^/]+)\/practice-generation$/)
    if (generationMatch && method === 'GET') {
      return json(route, practiceGeneration(decodeURIComponent(generationMatch[1])))
    }
    if (apiPath === '/api/k12/mistakes') return json(route, { items: mistakes, total: 11 })
    if (apiPath === '/api/k12/review-queue') return json(route, { items: mistakes.slice(0, 6) })
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
      const subject = requestURL.searchParams.get('subject')
      return json(route, {
        items: subject ? accumulation.filter((item) => item.subject === subject) : accumulation,
      })
    }
    if (apiPath === '/api/k12/practice-sets' && method === 'GET') {
      return json(route, { items: practiceSetsForState() })
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

const PRACTICE_HEADER_VISUAL_FIXTURE = {
  title: '待打印',
  count: '2 道',
  meta: '从错题、本周该练或积累明确加入 · 重复加入自动去重',
  hint: '系统打印成功或发送批次创建后才固化；取消系统打印不会清空待打印',
}

async function normalizePracticeHeaderVisualFixture(page: Page, side: Side): Promise<string[]> {
  return page.evaluate(
    ({ currentSide, fixture }) => {
      const selectors =
        currentSide === 'reference'
          ? {
              title: '.practice-basket .practice-detail__head h3',
              count: '#practiceBasketCount',
              meta: '#practiceBasketMeta',
              hint: '.practice-basket .practice-detail__head p:nth-of-type(2)',
            }
          : {
              title: '[data-testid="ps-basket"] .k12ps__btitle',
              count: '[data-testid="ps-basket-count"]',
              meta: '[data-testid="ps-basket"] .k12ps__bmeta',
              hint: '[data-testid="ps-basket"] .k12ps__bhint',
            }
      const nodes = Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => [
          name,
          document.querySelector<HTMLElement>(selector),
        ]),
      ) as Record<keyof typeof selectors, HTMLElement | null>
      const issues = Object.entries(nodes).flatMap(([name, node]) =>
        node ? [] : [`blocked: ${currentSide} practice header ${name} is missing`],
      )
      const titleText = nodes.title
        ? [...nodes.title.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
        : null
      if (!titleText) {
        issues.push(`blocked: ${currentSide} practice header title text node is missing`)
      } else {
        titleText.nodeValue = `${fixture.title} `
      }
      if (nodes.count) nodes.count.textContent = fixture.count
      if (nodes.meta) nodes.meta.textContent = fixture.meta
      if (nodes.hint) nodes.hint.textContent = fixture.hint
      return issues
    },
    { currentSide: side, fixture: PRACTICE_HEADER_VISUAL_FIXTURE },
  )
}

async function seedSharedContentScroll(
  page: Page,
  selector: string,
  side: Side,
  requested = { scrollLeft: 96, scrollTop: 120 },
) {
  const result = await page.evaluate(
    ({ contentSelector, currentSide, desiredScrollLeft, desiredScrollTop }) => {
      const content = document.querySelector<HTMLElement>(contentSelector)
      if (!content) return { issue: `blocked: ${currentSide} shared records content is missing` }

      const styleID = 'branch-ui-records-scroll-range'
      if (!document.getElementById(styleID)) {
        const style = document.createElement('style')
        style.id = styleID
        style.textContent = `
          [data-branch-ui-scroll-range="true"]::after {
            content: "";
            display: block;
            width: calc(100% + 256px);
            height: 900px;
            visibility: hidden;
            pointer-events: none;
          }
        `
        document.head.append(style)
      }
      content.dataset.branchUiScrollRange = 'true'
      content.scrollTop = desiredScrollTop
      content.scrollLeft = desiredScrollLeft
      content.dataset.branchUiExpectedScrollTop = String(content.scrollTop)
      return {
        issue: '',
        scrollLeft: content.scrollLeft,
        scrollTop: content.scrollTop,
        scrollWidth: content.scrollWidth,
        clientWidth: content.clientWidth,
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
      }
    },
    {
      contentSelector: selector,
      currentSide: side,
      desiredScrollLeft: requested.scrollLeft,
      desiredScrollTop: requested.scrollTop,
    },
  )
  if (result.issue) return result.issue
  if (result.scrollLeft <= 0 || result.scrollTop <= 0) {
    return (
      `blocked: ${side} controlled records scroll range was not established ` +
      `(left=${result.scrollLeft}, top=${result.scrollTop}, ` +
      `width=${result.clientWidth}/${result.scrollWidth}, ` +
      `height=${result.clientHeight}/${result.scrollHeight})`
    )
  }
  return ''
}

async function recordsObjectSnapshot(page: Page, side: Side): Promise<RecordsObjectSnapshot> {
  return page.evaluate((currentSide) => {
    const contentSelector =
      currentSide === 'reference' ? '#k12ViewRecords > .content' : '.k12rec__body'
    const tabSelector =
      currentSide === 'reference'
        ? '#k12BookTabs > [role="tab"]'
        : '.k12rec__tabs .k12-book-tabs > [role="tab"]'
    const panelSelectors =
      currentSide === 'reference'
        ? Array.from({ length: 5 }, (_, index) => `#k12BookPanel${index}`)
        : [
            '[data-testid="week-section"]',
            '[data-testid="mistakes-section"]',
            '[data-testid="practicesets-section"]',
            '[data-testid="accum-prototype"]',
            '[data-testid="works-section"]',
          ]
    const content = document.querySelector<HTMLElement>(contentSelector)
    if (!content) throw new Error(`${currentSide} shared records content is missing`)
    const contentRect = content.getBoundingClientRect()
    const contentStyle = getComputedStyle(content)
    const isVisible = (node: Element | null) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const normalizedText = (node: Element) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    const layoutSnapshot = (node: HTMLElement | null) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
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
          padding: style.padding,
          margin: style.margin,
          gap: style.gap,
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderTopWidth: style.borderTopWidth,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          borderLeftWidth: style.borderLeftWidth,
          borderRadius: style.borderRadius,
          flex: style.flex,
          alignItems: style.alignItems,
          alignSelf: style.alignSelf,
          justifyContent: style.justifyContent,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          whiteSpace: style.whiteSpace,
        },
      }
    }
    const tabs = [...document.querySelectorAll<HTMLElement>(tabSelector)]
    const activeTabIndices = tabs.flatMap((tab, index) =>
      tab.getAttribute('aria-selected') === 'true' ? [index] : [],
    )
    const activePanelIndices = panelSelectors.flatMap((selector, index) =>
      isVisible(document.querySelector(selector)) ? [index] : [],
    )
    const activeTab =
      activeTabIndices.length === 1 ? layoutSnapshot(tabs[activeTabIndices[0]!] ?? null) : null
    const activePanel =
      activePanelIndices.length === 1
        ? layoutSnapshot(
            document.querySelector<HTMLElement>(panelSelectors[activePanelIndices[0]!]!),
          )
        : null
    const tabDataDigest = JSON.stringify(
      tabs.map((tab) => ({
        text: normalizedText(tab),
        controls: tab.getAttribute('aria-controls'),
      })),
    )
    const mistakeFilterSelector =
      currentSide === 'reference'
        ? '#k12BookPanel1 .k12-secondary-tabs [aria-pressed]'
        : '.k12rec__filter-stack [aria-pressed]'
    const mistakeRowSelector =
      currentSide === 'reference'
        ? '#k12MistakeList .resource-row[data-learner-id="ming"]'
        : '.k12mistakes .rl-row'
    const mistakeFilterDigest = JSON.stringify(
      [...document.querySelectorAll<HTMLElement>(mistakeFilterSelector)].map((item) => ({
        text: normalizedText(item),
        pressed: item.getAttribute('aria-pressed'),
      })),
    )
    const mistakeDataDigest = JSON.stringify(
      [...document.querySelectorAll<HTMLElement>(mistakeRowSelector)].map((item) => ({
        id:
          item.dataset.mistakeKey ??
          item.dataset.recordId ??
          item.getAttribute('data-record-id') ??
          '',
        status: item.dataset.status ?? item.getAttribute('data-record-status') ?? '',
        text: normalizedText(item),
      })),
    )
    return {
      activeTabIndices,
      activePanelIndices,
      activeTab,
      activePanel,
      content: {
        rect: {
          x: Number(contentRect.x.toFixed(2)),
          y: Number(contentRect.y.toFixed(2)),
          width: Number(contentRect.width.toFixed(2)),
          height: Number(contentRect.height.toFixed(2)),
        },
        style: {
          display: contentStyle.display,
          position: contentStyle.position,
          boxSizing: contentStyle.boxSizing,
          overflowX: contentStyle.overflowX,
          overflowY: contentStyle.overflowY,
          padding: contentStyle.padding,
        },
        scrollLeft: Number(content.scrollLeft.toFixed(2)),
        scrollTop: Number(content.scrollTop.toFixed(2)),
      },
      tabDataDigest,
      mistakeFilterDigest,
      mistakeDataDigest,
    }
  }, side)
}

async function runRecordsObjectScrollSequence(page: Page, side: Side) {
  const contentSelector = side === 'reference' ? '#k12ViewRecords > .content' : '.k12rec__body'
  const tabSelector =
    side === 'reference'
      ? '#k12BookTabs > [role="tab"]'
      : '.k12rec__tabs .k12-book-tabs > [role="tab"]'
  const panelSelectors =
    side === 'reference'
      ? Array.from({ length: 5 }, (_, index) => `#k12BookPanel${index}`)
      : [
          '[data-testid="week-section"]',
          '[data-testid="mistakes-section"]',
          '[data-testid="practicesets-section"]',
          '[data-testid="accum-prototype"]',
          '[data-testid="works-section"]',
        ]
  const initial = await recordsObjectSnapshot(page, side)
  const transitions: ScrollSequenceTransition[] = []
  const violations: string[] = []

  for (const targetIndex of [0, 1, 2, 3, 4]) {
    const injected = {
      scrollLeft: 96 + targetIndex * 7,
      scrollTop: 120 + targetIndex * 11,
    }
    const seedIssue = await seedSharedContentScroll(page, contentSelector, side, injected)
    if (seedIssue) violations.push(seedIssue)
    const before = await recordsObjectSnapshot(page, side)
    const targetTab = page.locator(tabSelector).nth(targetIndex)
    if ((await targetTab.count()) !== 1) {
      violations.push(`${side}: object tab ${targetIndex} is missing`)
      continue
    }
    await targetTab.click()
    await page.locator(panelSelectors[targetIndex]!).waitFor({ state: 'visible', timeout: 15_000 })
    if (side === 'implementation' && targetIndex === 1) {
      await page
        .locator('.k12mistakes .rl-row')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const after = await recordsObjectSnapshot(page, side)
    const transitionViolations: string[] = []
    if (
      before.content.scrollLeft !== injected.scrollLeft ||
      before.content.scrollTop !== injected.scrollTop
    ) {
      transitionViolations.push(
        `injected scroll mismatch: expected ${injected.scrollLeft}/${injected.scrollTop}, got ${before.content.scrollLeft}/${before.content.scrollTop}`,
      )
    }
    if (after.content.scrollLeft !== 0 || after.content.scrollTop !== injected.scrollTop) {
      transitionViolations.push(
        `scroll reset mismatch: expected 0/${injected.scrollTop}, got ${after.content.scrollLeft}/${after.content.scrollTop}`,
      )
    }
    if (JSON.stringify(after.activeTabIndices) !== JSON.stringify([targetIndex])) {
      transitionViolations.push(
        `active tab mismatch: expected ${targetIndex}, got ${after.activeTabIndices.join(',')}`,
      )
    }
    if (JSON.stringify(after.activePanelIndices) !== JSON.stringify([targetIndex])) {
      transitionViolations.push(
        `active panel mismatch: expected ${targetIndex}, got ${after.activePanelIndices.join(',')}`,
      )
    }
    if (
      JSON.stringify(after.content.rect) !== JSON.stringify(initial.content.rect) ||
      JSON.stringify(after.content.style) !== JSON.stringify(initial.content.style)
    ) {
      transitionViolations.push('shared content bbox/style changed while switching objects')
    }
    if (after.tabDataDigest !== initial.tabDataDigest) {
      transitionViolations.push('object tab data changed while switching objects')
    }
    if (
      targetIndex === 1 &&
      (after.mistakeFilterDigest !== initial.mistakeFilterDigest ||
        after.mistakeDataDigest !== initial.mistakeDataDigest)
    ) {
      transitionViolations.push('mistake filter/data/state changed after leaving and returning')
    }
    transitions.push({ targetIndex, injected, before, after, violations: transitionViolations })
    violations.push(
      ...transitionViolations.map((violation) => `${side}: tab ${targetIndex}: ${violation}`),
    )
  }

  const evidence = { transitions, violations }
  scrollSequenceEvidence.set(page, evidence)
  return evidence
}

function compareScrollSequenceEvidence(
  reference: ScrollSequenceEvidence | null,
  implementation: ScrollSequenceEvidence | null,
) {
  const differences: Array<{
    transition: number | null
    field: string
    reference: unknown
    implementation: unknown
    delta?: number
  }> = []
  const add = (
    transition: number | null,
    field: string,
    referenceValue: unknown,
    implementationValue: unknown,
    delta?: number,
  ) => {
    differences.push({
      transition,
      field,
      reference: referenceValue,
      implementation: implementationValue,
      ...(delta === undefined ? {} : { delta: Number(delta.toFixed(2)) }),
    })
  }
  if (!reference || !implementation) {
    add(null, 'evidence', Boolean(reference), Boolean(implementation))
    return { equal: false, differences }
  }
  if (reference.transitions.length !== implementation.transitions.length) {
    add(null, 'transitionCount', reference.transitions.length, implementation.transitions.length)
  }
  const count = Math.min(reference.transitions.length, implementation.transitions.length)
  for (let index = 0; index < count; index += 1) {
    const referenceTransition = reference.transitions[index]!
    const implementationTransition = implementation.transitions[index]!
    if (referenceTransition.targetIndex !== implementationTransition.targetIndex) {
      add(
        index,
        'targetIndex',
        referenceTransition.targetIndex,
        implementationTransition.targetIndex,
      )
    }
    if (
      JSON.stringify(referenceTransition.injected) !==
      JSON.stringify(implementationTransition.injected)
    ) {
      add(index, 'injected', referenceTransition.injected, implementationTransition.injected)
    }
    for (const [name, includeHeight] of [
      // 对象正文高度随题目/点评等业务数据变化；只比较不受业务内容影响的横向几何与起点。
      ['activePanel', false],
    ] as const) {
      const referenceLayout = referenceTransition.after[name]
      const implementationLayout = implementationTransition.after[name]
      if (!referenceLayout || !implementationLayout) {
        if (Boolean(referenceLayout) !== Boolean(implementationLayout)) {
          add(index, `${name}.present`, Boolean(referenceLayout), Boolean(implementationLayout))
        }
        continue
      }
      const rectFields = includeHeight
        ? (['x', 'y', 'width', 'height'] as const)
        : (['x', 'y', 'width'] as const)
      for (const field of rectFields) {
        const delta = Math.abs(referenceLayout.rect[field] - implementationLayout.rect[field])
        if (delta > GEOMETRY_TOLERANCE) {
          add(
            index,
            `${name}.rect.${field}`,
            referenceLayout.rect[field],
            implementationLayout.rect[field],
            delta,
          )
        }
      }
      const styleKeys = new Set([
        ...Object.keys(referenceLayout.style),
        ...Object.keys(implementationLayout.style),
      ])
      for (const styleKey of styleKeys) {
        if (referenceLayout.style[styleKey] !== implementationLayout.style[styleKey]) {
          add(
            index,
            `${name}.style.${styleKey}`,
            referenceLayout.style[styleKey],
            implementationLayout.style[styleKey],
          )
        }
      }
    }
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const referenceValue = referenceTransition.after.content.rect[field]
      const implementationValue = implementationTransition.after.content.rect[field]
      const delta = Math.abs(referenceValue - implementationValue)
      if (delta > GEOMETRY_TOLERANCE) {
        add(index, `content.rect.${field}`, referenceValue, implementationValue, delta)
      }
    }
    const contentStyleKeys = new Set([
      ...Object.keys(referenceTransition.after.content.style),
      ...Object.keys(implementationTransition.after.content.style),
    ])
    for (const styleKey of contentStyleKeys) {
      if (
        referenceTransition.after.content.style[styleKey] !==
        implementationTransition.after.content.style[styleKey]
      ) {
        add(
          index,
          `content.style.${styleKey}`,
          referenceTransition.after.content.style[styleKey],
          implementationTransition.after.content.style[styleKey],
        )
      }
    }
  }
  return { equal: differences.length === 0, differences }
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
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话、对象计数和题目正文属于业务夹具差异；保留全页差异图，仅判定周练目标几何、样式与溢出。',
    openReference: async (page) => openReferenceRecords(page, 0),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-week'),
    referenceTargets: [
      ...weeklyTargets.referenceTargets,
      { name: 'period-tabs', selector: '#k12BookPanel0 .k12-week-view-tabs', required: true },
      {
        name: 'period-tab-buttons',
        selector: '#k12BookPanel0 .k12-week-view-tabs > button',
        all: true,
        required: true,
      },
      {
        name: 'progress',
        selector: '#k12BookPanel0 .rc-week-progress',
        required: true,
        ignoreText: true,
      },
      {
        name: 'hero',
        selector: '#k12BookPanel0 .rc-week-hero',
        required: true,
        ignoreText: true,
      },
      {
        name: 'weekly-items',
        selector: '#k12BookPanel0 .rc-week-hero .resource-row',
        all: true,
        required: true,
        ignoreText: true,
      },
    ],
    implementationTargets: [
      ...weeklyTargets.implementationTargets,
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs', required: true },
      {
        name: 'period-tab-buttons',
        selector: '.weekly-toolbar .k12-book-tabs > button',
        all: true,
        required: true,
      },
      { name: 'progress', selector: '.weekly-progress', required: true, ignoreText: true },
      { name: 'hero', selector: '.weekly-hero', required: true, ignoreText: true },
      { name: 'weekly-tracks', selector: '.weekly-track', all: true, required: true },
      {
        name: 'weekly-items',
        selector: '.weekly-item',
        all: true,
        required: true,
        ignoreText: true,
      },
    ],
    comparisonTargets: ['period-tab-buttons', 'progress', 'hero', 'weekly-items'],
    pixelComparisonTargets: ['period-tab-buttons', 'progress'],
    horizontalOverflowTargets: ['hero', 'weekly-items'],
    allowedReferenceHorizontalOverflowTargets: ['hero', 'weekly-items'],
  },
  {
    name: 'weekly-history',
    fixture: '小明 / 2026-W29 archived / 8 道 7 对 1 错 / history',
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话、对象计数和历史卷正文属于业务夹具差异；保留全页差异图，仅判定历史列表目标几何、样式与溢出。',
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
        name: 'period-tab-buttons',
        selector: '#k12BookPanel0 .k12-week-view-tabs > button',
        all: true,
        required: true,
      },
      {
        name: 'history-panel',
        selector: '#k12BookPanel0 [data-week-view-panel="history"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'history-cards',
        selector: '#k12BookPanel0 .k12-week-history-card',
        all: true,
        required: true,
        ignoreText: true,
      },
    ],
    implementationTargets: [
      ...weeklyTargets.implementationTargets,
      { name: 'period-tabs', selector: '.weekly-toolbar .k12-book-tabs', required: true },
      {
        name: 'period-tab-buttons',
        selector: '.weekly-toolbar .k12-book-tabs > button',
        all: true,
        required: true,
      },
      {
        name: 'history-panel',
        selector: '.weekly-history',
        required: true,
        ignoreText: true,
      },
      {
        name: 'history-cards',
        selector: '.weekly-history .weekly-history__card',
        all: true,
        required: true,
        ignoreText: true,
      },
    ],
    comparisonTargets: ['period-tab-buttons', 'history-panel', 'history-cards'],
    pixelComparisonTargets: ['period-tab-buttons'],
    horizontalOverflowTargets: ['history-panel', 'history-cards'],
  },
  {
    name: 'mistakes',
    fixture: '小明 / 全学科 + 全状态 / 与原型相同的 7 条代表性错题及动作状态',
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话与对象计数属于业务夹具差异；保留全页差异图，仅判定错题行、动作、几何、样式与溢出。',
    openReference: async (page) => openReferenceRecords(page, 1),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-mistakes'),
    referenceTargets: [
      ...mistakeTargets.referenceTargets,
      {
        name: 'mistake-rows',
        selector: '#k12MistakeList .resource-row',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'mistake-actions',
        selector: '#k12MistakeList .resource-row > button',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      ...mistakeTargets.implementationTargets,
      {
        name: 'mistake-rows',
        selector: '.k12mistakes .rl-row',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'mistake-actions',
        selector: '.k12mistakes .rl-row > button',
        all: true,
        required: true,
      },
    ],
    comparisonTargets: ['mistake-rows', 'mistake-actions'],
    horizontalOverflowTargets: ['mistake-rows', 'mistake-actions'],
    containmentTargets: ['mistake-actions'],
  },
  {
    name: 'mistakes-narrow',
    fixture: '小明 / 全部错题 / 1024×900 窄屏换行与行动作无横向溢出',
    viewport: { width: 1024, height: 900 },
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话与计数属于业务夹具差异；保留全页差异图，仅判定错题目标几何、样式与溢出。',
    openReference: async (page) => openReferenceRecords(page, 1),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-mistakes'),
    referenceTargets: [
      ...mistakeTargets.referenceTargets,
      { name: 'object-summary', selector: '#k12BookPanel1 .rc-object-summary', required: true },
      { name: 'filter-stack', selector: '#k12BookPanel1 .k12-secondary-tabs', required: true },
      {
        name: 'filter-labels',
        selector: '#k12BookPanel1 .k12-secondary-tabs__label',
        all: true,
        required: true,
      },
      {
        name: 'filter-buttons',
        selector: '#k12BookPanel1 .k12-secondary-tabs__row .source-tag',
        all: true,
        required: true,
      },
      { name: 'archive-note', selector: '#k12BookPanel1 .rc-archnote', required: true },
      {
        name: 'content-container',
        selector: '#k12ViewRecords > .content',
        required: true,
      },
      {
        name: 'mistake-rows',
        selector: '#k12MistakeList .resource-row',
        all: true,
        required: true,
      },
      {
        name: 'mistake-question',
        selector: '#k12MistakeList .resource-row > b',
        all: true,
        required: true,
      },
      {
        name: 'mistake-description',
        selector: '#k12MistakeList .resource-row > .sp',
        all: true,
        required: true,
      },
      {
        name: 'mistake-actions',
        selector: '#k12MistakeList .resource-row > button',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      ...mistakeTargets.implementationTargets,
      { name: 'object-summary', selector: '.k12rec__object-summary', required: true },
      { name: 'filter-stack', selector: '.k12rec__filter-stack', required: true },
      {
        name: 'filter-labels',
        selector: '.k12rec__filter-label',
        all: true,
        required: true,
      },
      {
        name: 'filter-buttons',
        selector: '.k12rec__filter',
        all: true,
        required: true,
      },
      { name: 'archive-note', selector: '.k12rec__archive-note', required: true },
      { name: 'content-container', selector: '.k12rec__body', required: true },
      {
        name: 'mistake-rows',
        selector: '.k12mistakes .rl-row',
        all: true,
        required: true,
      },
      {
        name: 'mistake-question',
        selector: '.k12mistakes .rl-row > .rl-title',
        all: true,
        required: true,
      },
      {
        name: 'mistake-description',
        selector: '.k12mistakes .rl-row > .rl-meta',
        all: true,
        required: true,
      },
      {
        name: 'mistake-actions',
        selector: '.k12mistakes .rl-row > button',
        all: true,
        required: true,
      },
    ],
    comparisonTargets: [
      'object-summary',
      'filter-stack',
      'filter-labels',
      'filter-buttons',
      'mistake-rows',
      'mistake-question',
      'mistake-description',
      'mistake-actions',
    ],
    horizontalOverflowTargets: ['content-container', 'mistake-rows'],
    containmentTargets: ['mistake-question', 'mistake-description', 'mistake-actions'],
    clipTargets: ['mistake-rows'],
  },
  {
    name: 'week-after-mistakes-horizontal-scroll',
    fixture: '小明 / 1024×900 / 五对象逐一切换 / 每次 scrollLeft 归零且 scrollTop 保持',
    viewport: { width: 1024, height: 900 },
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '会话与对象正文属于业务夹具差异；保留全页差异图，仅判定五对象滚动、激活态、容器和数据状态不变量。',
    openReference: async (page) => {
      return openReferenceRecords(page, 1)
    },
    openImplementation: async (page) => {
      const issues = await openImplementationRecords(page, 'subtab-mistakes')
      const mistakeRowsReady = await page
        .locator('.k12mistakes .rl-row')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      if (!mistakeRowsReady) {
        issues.push('blocked: implementation mistake rows did not stabilize before tab sequence')
      }
      await Promise.all(
        [
          'subtab-week',
          'subtab-mistakes',
          'subtab-practicesets',
          'subtab-accumulation',
          'subtab-works',
        ].map((testId) =>
          expect(page.getByTestId(testId)).toHaveAttribute('aria-label', /\s\d+$/, {
            timeout: 15_000,
          }),
        ),
      )
      return issues
    },
    referenceTargets: [
      ...worksTargets.referenceTargets,
      {
        name: 'content-container',
        selector: '#k12ViewRecords > .content',
        required: true,
        ignoreText: true,
      },
      {
        name: 'active-object-tab',
        selector: '#k12BookTabs > [role="tab"][aria-selected="true"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'active-panel',
        selector: '#k12BookPanel4',
        required: true,
        ignoreText: true,
      },
      {
        name: 'scroll-pixel-card',
        selector: '#k12CreativeWorkList .creative-work-card:first-child',
        required: true,
        ignoreText: true,
      },
    ],
    implementationTargets: [
      ...worksTargets.implementationTargets,
      {
        name: 'content-container',
        selector: '.k12rec__body',
        required: true,
        ignoreText: true,
      },
      {
        name: 'active-object-tab',
        selector: '.k12rec__tabs .k12-book-tabs > [role="tab"][aria-selected="true"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'active-panel',
        selector: '[data-testid="works-section"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'scroll-pixel-card',
        selector: '.k12cw__card:first-child',
        required: true,
        ignoreText: true,
      },
    ],
    comparisonTargets: ['content-container', 'active-object-tab', 'active-panel'],
    // 激活面板在保留 scrollTop 时会进入固定页头下方；裁剪可见作品卡，避免页头叠层污染目标像素。
    pixelComparisonTargets: ['scroll-pixel-card'],
    horizontalScrollResetTargets: ['content-container'],
    scrollSequence: true,
  },
  {
    name: 'practice-sets',
    fixture: '小明 / 待打印篮 2 题 + 已批改历史卷 1 题',
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话、对象计数和题目正文属于业务夹具差异；保留全页差异图，仅判定待打印与历史列表目标几何、样式与溢出。',
    openReference: async (page) => {
      const issues = await openReferenceRecords(page, 2)
      issues.push(...(await normalizePracticeHeaderVisualFixture(page, 'reference')))
      return issues
    },
    openImplementation: async (page) => {
      const issues = await openImplementationRecords(page, 'subtab-practicesets')
      issues.push(...(await normalizePracticeHeaderVisualFixture(page, 'implementation')))
      return issues
    },
    referenceTargets: [
      ...practiceTargets.referenceTargets,
      {
        name: 'practice-basket-head',
        selector: '.practice-basket .practice-detail__head',
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-actions',
        selector: '.practice-basket .practice-detail__actions',
        required: true,
      },
      {
        name: 'practice-item-first',
        selector: '#practiceBasketItems [data-learner-id="ming"] .practice-question',
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-items-all',
        selector: '#practiceBasketItems [data-learner-id="ming"] .practice-question',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-history',
        selector: '#k12BookPanel2 .practice-history',
        required: true,
        ignoreText: true,
        ignoreBusinessGeometryFields: ['y', 'height'],
      },
      {
        name: 'practice-history-card',
        selector: '#practiceHistoryList .practice-set-card[data-learner-id="ming"]',
        required: true,
        ignoreText: true,
        ignoreBusinessGeometryFields: ['y', 'height'],
      },
    ],
    implementationTargets: [
      ...practiceTargets.implementationTargets,
      {
        name: 'practice-basket-head',
        selector: '[data-testid="ps-basket"] .k12ps__bhead',
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-actions',
        selector: '[data-testid="ps-basket"] .k12ps__bactions',
        required: true,
      },
      {
        name: 'practice-item-first',
        selector: '[data-testid="ps-basket"] .k12ps__groups .k12ps__item',
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-items-all',
        selector: '[data-testid="ps-basket"] .k12ps__groups .k12ps__item',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'practice-history',
        selector: '[data-testid="ps-history"]',
        required: true,
        ignoreText: true,
        ignoreBusinessGeometryFields: ['y', 'height'],
      },
      {
        name: 'practice-history-card',
        selector: '[data-testid="ps-history"] .k12ps__hcard',
        required: true,
        ignoreText: true,
        ignoreBusinessGeometryFields: ['y', 'height'],
      },
    ],
    comparisonTargets: [
      'practice-basket-head',
      'practice-actions',
      'practice-item-first',
      'practice-history',
      'practice-history-card',
    ],
    pixelComparisonTargets: ['practice-actions'],
    horizontalOverflowTargets: [
      'practice-basket-head',
      'practice-items-all',
      'practice-history',
      'practice-history-card',
    ],
  },
  {
    name: 'practice-set-pending',
    fixture: '小明 / 错题练习生成 pending / 练习集显示占位且不显示空态',
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话与题目正文属于业务夹具差异；保留全页差异图，仅判定占位结构和样式。',
    openReference: async (page) => {
      const issues = await openReferenceRecords(page, 2)
      const prepared = await page.evaluate(() => {
        const api = window as typeof window & {
          currentK12Runtime?: () => { counts: { practices: number } }
          renderPracticeBasket?: () => void
        }
        if (!api.currentK12Runtime || !api.renderPracticeBasket) return false
        api.currentK12Runtime().counts.practices = 0
        const currentGroup = document.querySelector('#practiceBasketItems [data-learner-id="ming"]')
        currentGroup
          ?.querySelectorAll('.practice-question:not([data-practice-pending]), .practice-group')
          .forEach((node) => node.remove())
        api.renderPracticeBasket()
        return true
      })
      if (!prepared) issues.push('blocked: prototype pending basket runtime API is missing')
      const invoked = await page.evaluate(() => {
        const api = window as typeof window & {
          addBasketPendingItem?: (sourceKey: string, source: string) => void
        }
        if (!api.addBasketPendingItem) return false
        api.addBasketPendingItem('mistake-apple', '苹果和梨的价钱（P52·3）')
        return true
      })
      if (!invoked) issues.push('blocked: prototype addBasketPendingItem API is missing')
      return issues
    },
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-practicesets'),
    referenceTargets: [
      ...practiceTargets.referenceTargets,
      { name: 'basket-shell', selector: '.practice-basket', required: true, ignoreText: true },
      {
        name: 'basket-head',
        selector: '.practice-basket .practice-detail__head',
        required: true,
        ignoreText: true,
      },
      {
        name: 'basket-actions',
        selector: '.practice-basket .practice-detail__actions',
        required: true,
        ignoreText: true,
      },
      {
        name: 'basket-title',
        selector: '.practice-basket .practice-detail__head h3',
        required: true,
      },
      { name: 'basket-meta', selector: '#practiceBasketMeta', required: true },
      {
        name: 'basket-hint',
        selector: '.practice-basket .practice-detail__head p:nth-of-type(2)',
        required: true,
      },
      {
        name: 'pending-placeholder',
        selector: '#practiceBasketItems [data-practice-pending]',
        all: true,
        required: true,
      },
      {
        name: 'pending-seq',
        selector: '#practiceBasketItems [data-practice-pending] > i',
        all: true,
        required: true,
      },
      {
        name: 'pending-question',
        selector: '#practiceBasketItems [data-practice-pending] > div > b',
        all: true,
        required: true,
      },
      {
        name: 'pending-meta',
        selector: '#practiceBasketItems [data-practice-pending] > div > small',
        all: true,
        required: true,
      },
      { name: 'basket-empty', selector: '#practiceBasketEmpty' },
      { name: 'basket-count', selector: '#practiceBasketCount', required: true },
      { name: 'basket-print', selector: '#practicePrintButton', required: true },
      { name: 'basket-send', selector: '#practiceSendBasketButton', required: true },
      {
        name: 'practice-formal-question',
        selector:
          '#practiceBasketItems [data-learner-id="ming"] .practice-question:not([data-practice-pending])',
        all: true,
      },
      {
        name: 'practice-item-action',
        selector:
          '#practiceBasketItems [data-learner-id="ming"] .practice-question:not([data-practice-pending]) > span',
        all: true,
      },
    ],
    implementationTargets: [
      ...practiceTargets.implementationTargets,
      {
        name: 'basket-shell',
        selector: '[data-testid="ps-basket"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'basket-head',
        selector: '[data-testid="ps-basket"] .k12ps__bhead',
        required: true,
        ignoreText: true,
      },
      {
        name: 'basket-actions',
        selector: '[data-testid="ps-basket"] .k12ps__bactions',
        required: true,
        ignoreText: true,
      },
      {
        name: 'basket-title',
        selector: '[data-testid="ps-basket"] .k12ps__btitle',
        required: true,
      },
      { name: 'basket-meta', selector: '[data-testid="ps-basket"] .k12ps__bmeta', required: true },
      { name: 'basket-hint', selector: '[data-testid="ps-basket"] .k12ps__bhint', required: true },
      {
        name: 'pending-placeholder',
        selector: '[data-testid="practice-generation-placeholder"]',
        all: true,
        required: true,
      },
      {
        name: 'pending-seq',
        selector: '[data-testid="practice-generation-placeholder"] > .k12ps__seq',
        all: true,
        required: true,
      },
      {
        name: 'pending-question',
        selector: '[data-testid="practice-generation-placeholder"] .k12ps__q',
        all: true,
        required: true,
      },
      {
        name: 'pending-meta',
        selector: '[data-testid="practice-generation-placeholder"] .k12ps__qmeta',
        all: true,
        required: true,
      },
      { name: 'basket-empty', selector: '[data-testid="ps-basket-empty"]' },
      { name: 'basket-count', selector: '[data-testid="ps-basket-count"]', required: true },
      { name: 'basket-print', selector: '[data-testid="ps-finalize-print"]', required: true },
      { name: 'basket-send', selector: '[data-testid="ps-finalize-send"]', required: true },
      {
        name: 'practice-formal-question',
        selector: '[data-testid="ps-basket"] .k12ps__groups .k12ps__item',
        all: true,
      },
      {
        name: 'practice-item-action',
        selector: '[data-testid="ps-basket"] .k12ps__groups .k12ps__item-actions',
        all: true,
      },
    ],
    comparisonTargets: [
      'basket-head',
      'basket-actions',
      'basket-title',
      'basket-meta',
      'basket-hint',
      'pending-placeholder',
      'pending-seq',
      'pending-question',
      'pending-meta',
      'basket-count',
    ],
    absentTargets: ['basket-empty', 'practice-formal-question', 'practice-item-action'],
    exactTargetTexts: { 'basket-count': ['0 道'] },
    disabledTargets: ['basket-print', 'basket-send'],
    horizontalOverflowTargets: ['basket-head', 'basket-actions', 'pending-placeholder'],
  },
  {
    name: 'accumulation',
    fixture: '小明 / 全部 / 语文与英语积累各 1 条',
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话、对象计数和积累正文属于业务夹具差异；保留全页差异图，仅判定积累行、动作、几何、样式与溢出。',
    openReference: async (page) => openReferenceRecords(page, 3),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-accumulation'),
    referenceTargets: [
      ...accumulationTargets.referenceTargets,
      {
        name: 'accumulation-add-button',
        selector: '#k12BookToolbar .rc-3',
        required: true,
      },
      {
        name: 'accumulation-row-first',
        selector: '#k12AccumulationList .resource-row[data-learner-id="ming"]',
        required: true,
        ignoreText: true,
      },
      {
        name: 'accumulation-rows-all',
        selector: '#k12AccumulationList .resource-row[data-learner-id="ming"]',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'accumulation-actions',
        selector: '#k12AccumulationList .resource-row[data-learner-id="ming"]:first-child > button',
        all: true,
        required: true,
      },
    ],
    implementationTargets: [
      ...accumulationTargets.implementationTargets,
      {
        name: 'accumulation-add-button',
        selector: '[data-testid="accum-add-open"]',
        required: true,
      },
      {
        name: 'accumulation-row-first',
        selector: '.k12accum__row',
        required: true,
        ignoreText: true,
      },
      {
        name: 'accumulation-rows-all',
        selector: '.k12accum__row',
        all: true,
        required: true,
        ignoreText: true,
      },
      {
        name: 'accumulation-actions',
        selector: '.k12accum__row:first-child > button',
        all: true,
        required: true,
      },
    ],
    comparisonTargets: [
      'accumulation-add-button',
      'accumulation-row-first',
      'accumulation-actions',
    ],
    pixelComparisonTargets: ['accumulation-add-button'],
    horizontalOverflowTargets: ['accumulation-rows-all', 'accumulation-actions'],
  },
  {
    name: 'works',
    fixture: '小明 / 作品 3 条 / 写作成功 + 美术成功 + 美术失败',
    viewport: { width: 1226, height: 900 },
    fullPagePixelComparable: false,
    fullPagePixelReason:
      '侧栏会话、作品标题与点评正文属于业务夹具差异；保留全页差异图，仅判定作品目标几何和样式。',
    openReference: async (page) => openReferenceRecords(page, 4),
    openImplementation: async (page) => openImplementationRecords(page, 'subtab-works'),
    referenceTargets: [
      ...worksTargets.referenceTargets,
      {
        name: 'description',
        selector: '#k12BookPanel4 .practice-overview__copy > p',
        required: true,
      },
      { name: 'overview', selector: '#k12BookPanel4 .practice-overview', required: true },
      { name: 'kpis', selector: '#k12BookPanel4 .practice-kpis', required: true },
      {
        name: 'kpi',
        selector: '#k12BookPanel4 .practice-kpi',
        all: true,
        required: true,
      },
      { name: 'add-button', selector: '#k12BookToolbar .rc-4', required: true },
      {
        name: 'card',
        selector: '#k12CreativeWorkList .creative-work-card',
        all: true,
        required: true,
      },
      {
        name: 'card-preview',
        selector: '#k12CreativeWorkList .creative-work-preview',
        all: true,
        required: true,
      },
      {
        name: 'card-top',
        selector: '#k12CreativeWorkList .creative-work-copy > div:first-child',
        all: true,
        required: true,
      },
      {
        name: 'card-footer',
        selector: '.creative-work-card__foot',
        all: true,
        required: true,
      },
      { name: 'card-time', selector: '.creative-work-card__time', all: true, required: true },
      { name: 'card-action', selector: '.creative-work-card__action', all: true, required: true },
    ],
    implementationTargets: [
      ...worksTargets.implementationTargets,
      { name: 'description', selector: '.k12cw__desc', required: true },
      { name: 'overview', selector: '.k12cw__overview', required: true },
      { name: 'kpis', selector: '.k12cw__kpis', required: true },
      { name: 'kpi', selector: '.k12cw__kpi', all: true, required: true },
      { name: 'add-button', selector: '[data-testid="cw-add-open"]', required: true },
      { name: 'card', selector: '.k12cw__card', all: true, required: true },
      {
        name: 'card-preview',
        selector: '.k12cw__preview',
        all: true,
        required: true,
      },
      { name: 'card-top', selector: '.k12cw__head', all: true, required: true },
      {
        name: 'card-footer',
        selector: '.k12cw__foot',
        all: true,
        required: true,
      },
      { name: 'card-time', selector: '.k12cw__time', all: true, required: true },
      { name: 'card-action', selector: '.k12cw__detail-toggle', all: true, required: true },
    ],
    comparisonTargets: [
      'description',
      'overview',
      'kpis',
      'kpi',
      'add-button',
      'card',
      'card-preview',
      'card-top',
      'card-footer',
      'card-time',
      'card-action',
    ],
    // 学习档案其他对象的计数是动态业务数据；全页截图保留原值，只在作品目标像素裁剪中屏蔽计数文本。
    referencePixelMaskSelectors: ['#k12BookTabs .k12-tab-count'],
    implementationPixelMaskSelectors: ['.k12rec__tabs .k12-tab-count'],
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

async function targetEvidence(page: Page, targets: Target[]): Promise<TargetEvidence> {
  const result: TargetEvidence['targets'] = {}
  const requiredMissing: string[] = []
  for (const target of targets) {
    const value = await page.locator(target.selector).evaluateAll(
      (elements, options: { all: boolean }) => {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext('2d', { willReadFrequently: true })
        const canonicalColor = (value: string) => {
          if (!context) return value
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = value
          context.fillRect(0, 0, 1, 1)
          const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
          return `rgba(${red}, ${green}, ${blue}, ${Number((alpha / 255).toFixed(4))})`
        }
        const selected = options.all ? elements : elements.slice(0, 1)
        return selected
          .map((element) => {
            const node = element as HTMLElement
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            const containmentSelector = [
              '.resource-row',
              '.rl-row',
              '.practice-question',
              '.k12ps__item',
              '.creative-work-card',
              '.k12cw__card',
            ].find((selector) => node.closest(selector))
            const containmentNode = containmentSelector
              ? node.closest<HTMLElement>(containmentSelector)
              : null
            const containmentRect = containmentNode?.getBoundingClientRect() ?? null
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
              attributes: {
                title: node.getAttribute('title'),
                expectedScrollTop: node.getAttribute('data-branch-ui-expected-scroll-top'),
                disabled: node.hasAttribute('disabled'),
                ariaSelected: node.getAttribute('aria-selected'),
                ariaPressed: node.getAttribute('aria-pressed'),
                dataReviewState: node.getAttribute('data-review-state'),
              },
              rect: {
                x: Number(rect.x.toFixed(2)),
                y: Number(rect.y.toFixed(2)),
                width: Number(rect.width.toFixed(2)),
                height: Number(rect.height.toFixed(2)),
              },
              metrics: {
                clientWidth: node.clientWidth,
                scrollWidth: node.scrollWidth,
                clientHeight: node.clientHeight,
                scrollHeight: node.scrollHeight,
                scrollLeft: Number(node.scrollLeft.toFixed(2)),
                scrollTop: Number(node.scrollTop.toFixed(2)),
                textClipped: node.scrollWidth > node.clientWidth,
              },
              style: {
                display: style.display,
                position: style.position,
                top: style.top,
                right: style.right,
                bottom: style.bottom,
                left: style.left,
                boxSizing: style.boxSizing,
                backgroundColor: canonicalColor(style.backgroundColor),
                backgroundImage: style.backgroundImage,
                color: canonicalColor(style.color),
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
                alignItems: style.alignItems,
                alignSelf: style.alignSelf,
                justifyContent: style.justifyContent,
                flex: style.flex,
                flexBasis: style.flexBasis,
                flexGrow: style.flexGrow,
                flexShrink: style.flexShrink,
                flexWrap: style.flexWrap,
                order: style.order,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                overflow: style.overflow,
                overflowClipMargin: style.overflowClipMargin,
                whiteSpace: style.whiteSpace,
                textOverflow: style.textOverflow,
              },
              containment: {
                containerSelector: containmentSelector ?? null,
                contained:
                  containmentRect === null
                    ? null
                    : rect.left >= containmentRect.left - 1 &&
                      rect.right <= containmentRect.right + 1 &&
                      rect.top >= containmentRect.top - 1 &&
                      rect.bottom <= containmentRect.bottom + 1,
                containerRect:
                  containmentRect === null
                    ? null
                    : {
                        x: Number(containmentRect.x.toFixed(2)),
                        y: Number(containmentRect.y.toFixed(2)),
                        width: Number(containmentRect.width.toFixed(2)),
                        height: Number(containmentRect.height.toFixed(2)),
                      },
              },
            }
          })
          .filter((item) => item.visible)
      },
      { all: target.all === true },
    )
    result[target.name] = {
      selector: target.selector,
      ignoreText: target.ignoreText === true,
      ignoreBusinessGeometryFields: target.ignoreBusinessGeometryFields ?? [],
      matches: value,
    }
    if (target.required && value.length === 0) requiredMissing.push(target.name)
  }
  return { targets: result, requiredMissing }
}

function compareTargetEvidence(
  reference: TargetEvidence,
  implementation: TargetEvidence,
  targetNames: string[],
) {
  const differences: Array<{
    target: string
    index: number | null
    field: string
    reference: unknown
    implementation: unknown
    delta?: number
  }> = []
  const add = (
    target: string,
    index: number | null,
    field: string,
    referenceValue: unknown,
    implementationValue: unknown,
    delta?: number,
  ) => {
    differences.push({
      target,
      index,
      field,
      reference: referenceValue,
      implementation: implementationValue,
      ...(delta === undefined ? {} : { delta: Number(delta.toFixed(2)) }),
    })
  }

  for (const target of targetNames) {
    const referenceTarget = reference.targets[target]
    const implementationTarget = implementation.targets[target]
    const referenceMatches = referenceTarget?.matches ?? []
    const implementationMatches = implementationTarget?.matches ?? []
    if (referenceTarget?.ignoreText !== implementationTarget?.ignoreText) {
      add(
        target,
        null,
        'config.ignoreText',
        referenceTarget?.ignoreText ?? false,
        implementationTarget?.ignoreText ?? false,
      )
    }
    const ignoreText =
      referenceTarget?.ignoreText === true && implementationTarget?.ignoreText === true
    const referenceIgnoredGeometry = referenceTarget?.ignoreBusinessGeometryFields ?? []
    const implementationIgnoredGeometry = implementationTarget?.ignoreBusinessGeometryFields ?? []
    if (referenceIgnoredGeometry.join(',') !== implementationIgnoredGeometry.join(',')) {
      add(
        target,
        null,
        'config.ignoreBusinessGeometryFields',
        referenceIgnoredGeometry,
        implementationIgnoredGeometry,
      )
    }
    const ignoredGeometryFields = new Set(
      referenceIgnoredGeometry.filter((field) => implementationIgnoredGeometry.includes(field)),
    )
    // ignoreText 用于业务数据可变的容器/列表：正文、条数及正文派生属性不参与 UI 对齐，
    // 仍逐项比较共同样本的几何、样式与交互属性，避免业务内容差异制造视觉假红。
    if (!ignoreText && referenceMatches.length !== implementationMatches.length) {
      add(target, null, 'count', referenceMatches.length, implementationMatches.length)
    }
    const pairCount = Math.min(referenceMatches.length, implementationMatches.length)
    for (let index = 0; index < pairCount; index += 1) {
      const referenceMatch = referenceMatches[index]!
      const implementationMatch = implementationMatches[index]!
      if (!ignoreText && referenceMatch.text !== implementationMatch.text) {
        add(target, index, 'text', referenceMatch.text, implementationMatch.text)
      }
      for (const attribute of [
        'title',
        'disabled',
        'ariaSelected',
        'ariaPressed',
        'dataReviewState',
      ] as const) {
        if (ignoreText && ['title', 'dataReviewState'].includes(attribute)) continue
        if (referenceMatch.attributes[attribute] !== implementationMatch.attributes[attribute]) {
          add(
            target,
            index,
            `attributes.${attribute}`,
            referenceMatch.attributes[attribute],
            implementationMatch.attributes[attribute],
          )
        }
      }
      if (
        !ignoreText &&
        referenceMatch.metrics.textClipped !== implementationMatch.metrics.textClipped
      ) {
        add(
          target,
          index,
          'metrics.textClipped',
          referenceMatch.metrics.textClipped,
          implementationMatch.metrics.textClipped,
        )
      }
      for (const field of ['x', 'y', 'width', 'height'] as const) {
        // 业务条数和可选回传资产会改变纵向位置与高度；只屏蔽目标明确声明的派生字段。
        if (ignoreText && ignoredGeometryFields.has(field)) continue
        const delta = Math.abs(referenceMatch.rect[field] - implementationMatch.rect[field])
        if (delta > GEOMETRY_TOLERANCE) {
          add(
            target,
            index,
            `rect.${field}`,
            referenceMatch.rect[field],
            implementationMatch.rect[field],
            delta,
          )
        }
      }
      const styleKeys = new Set([
        ...Object.keys(referenceMatch.style),
        ...Object.keys(implementationMatch.style),
      ])
      for (const styleKey of styleKeys) {
        // 行内自适应按钮没有剩余主轴空间时，normal 与 center 的像素结果等价；
        // 仍由同一目标裁剪的像素门禁锁定真实位置、尺寸和可见外观。
        const inertIntrinsicButtonJustification =
          target === 'mistake-actions' &&
          styleKey === 'justifyContent' &&
          referenceMatch.tag === 'button' &&
          implementationMatch.tag === 'button' &&
          new Set([referenceMatch.style[styleKey], implementationMatch.style[styleKey]]).size ===
            2 &&
          [referenceMatch.style[styleKey], implementationMatch.style[styleKey]].every((value) =>
            ['normal', 'center'].includes(value ?? ''),
          )
        if (inertIntrinsicButtonJustification) continue
        if (referenceMatch.style[styleKey] !== implementationMatch.style[styleKey]) {
          add(
            target,
            index,
            `style.${styleKey}`,
            referenceMatch.style[styleKey],
            implementationMatch.style[styleKey],
          )
        }
      }
    }
  }
  return {
    comparedTargets: targetNames,
    geometryTolerance: GEOMETRY_TOLERANCE,
    equal: differences.length === 0,
    differences,
  }
}

function horizontalOverflowViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) =>
    (evidence.targets[target]?.matches ?? []).flatMap((match, index) =>
      match.metrics.scrollWidth > match.metrics.clientWidth
        ? [
            {
              target,
              index,
              clientWidth: match.metrics.clientWidth,
              scrollWidth: match.metrics.scrollWidth,
            },
          ]
        : [],
    ),
  )
}

function containmentViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) =>
    (evidence.targets[target]?.matches ?? []).flatMap((match, index) =>
      match.containment.contained === true
        ? []
        : [
            {
              target,
              index,
              contained: match.containment.contained,
              childRect: match.rect,
              containerSelector: match.containment.containerSelector,
              containerRect: match.containment.containerRect,
            },
          ],
    ),
  )
}

function clipViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) =>
    (evidence.targets[target]?.matches ?? []).flatMap((match, index) =>
      match.style.overflowX === 'hidden' && match.style.overflowY === 'hidden'
        ? []
        : [
            {
              target,
              index,
              overflowX: match.style.overflowX,
              overflowY: match.style.overflowY,
            },
          ],
    ),
  )
}

function exactTargetTextViolations(
  evidence: TargetEvidence,
  exactTargetTexts: Record<string, string[]>,
) {
  return Object.entries(exactTargetTexts).flatMap(([target, expected]) => {
    const actual = (evidence.targets[target]?.matches ?? []).map((match) => match.text)
    return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ target, expected, actual }]
  })
}

function disabledTargetViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) => {
    const matches = evidence.targets[target]?.matches ?? []
    if (matches.length > 0 && matches.every((match) => match.attributes.disabled)) return []
    return [
      {
        target,
        count: matches.length,
        disabled: matches.map((match) => match.attributes.disabled),
      },
    ]
  })
}

function visibleAbsentTargetViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) =>
    (evidence.targets[target]?.matches ?? []).map((match, index) => ({
      target,
      index,
      text: match.text,
    })),
  )
}

function horizontalScrollResetViolations(evidence: TargetEvidence, targetNames: string[]) {
  return targetNames.flatMap((target) =>
    (evidence.targets[target]?.matches ?? []).flatMap((match, index) => {
      const expectedScrollTop = Number(match.attributes.expectedScrollTop)
      const missingExpectedScrollTop =
        match.attributes.expectedScrollTop === null || !Number.isFinite(expectedScrollTop)
      const scrollTopDelta = missingExpectedScrollTop
        ? null
        : Math.abs(match.metrics.scrollTop - expectedScrollTop)
      if (match.metrics.scrollLeft === 0 && scrollTopDelta !== null && scrollTopDelta <= 1)
        return []
      return [
        {
          target,
          index,
          expectedScrollLeft: 0,
          scrollLeft: match.metrics.scrollLeft,
          expectedScrollTop: missingExpectedScrollTop ? null : expectedScrollTop,
          scrollTop: match.metrics.scrollTop,
          scrollTopDelta,
        },
      ]
    }),
  )
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
  const viewport = state.viewport ?? DEFAULT_VIEWPORT
  activeImplementationFixtureState = state.name
  await Promise.all([
    referencePage.setViewportSize(viewport),
    implementationPage.setViewportSize(viewport),
  ])
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

  if (state.scrollSequence) {
    await Promise.all([
      runRecordsObjectScrollSequence(referencePage, 'reference').catch((error: unknown) => {
        referenceIssues.push(
          `blocked: reference five-object scroll sequence threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }),
      runRecordsObjectScrollSequence(implementationPage, 'implementation').catch(
        (error: unknown) => {
          implementationIssues.push(
            `blocked: implementation five-object scroll sequence threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        },
      ),
    ])
  }

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
  const targetDiffPath = path.join(outputDir, 'target-diff.json')
  const targetReferencePath = path.join(outputDir, 'target-reference.png')
  const targetImplementationPath = path.join(outputDir, 'target-implementation.png')
  const targetPixelDiffPath = path.join(outputDir, 'target-pixel-diff.png')
  const targetPixelReportPath = path.join(outputDir, 'target-pixel-report.json')
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

  const targetDiff = compareTargetEvidence(
    referenceTargets,
    implementationTargets,
    state.comparisonTargets ?? [],
  )
  const referenceHorizontalOverflow = horizontalOverflowViolations(
    referenceTargets,
    state.horizontalOverflowTargets ?? [],
  )
  const implementationHorizontalOverflow = horizontalOverflowViolations(
    implementationTargets,
    state.horizontalOverflowTargets ?? [],
  )
  const allowedReferenceHorizontalOverflowTargets = new Set(
    state.allowedReferenceHorizontalOverflowTargets ?? [],
  )
  const unexpectedReferenceHorizontalOverflow = referenceHorizontalOverflow.filter(
    ({ target }) => !allowedReferenceHorizontalOverflowTargets.has(target),
  )
  const referenceContainment = containmentViolations(
    referenceTargets,
    state.containmentTargets ?? [],
  )
  const implementationContainment = containmentViolations(
    implementationTargets,
    state.containmentTargets ?? [],
  )
  const referenceClip = clipViolations(referenceTargets, state.clipTargets ?? [])
  const implementationClip = clipViolations(implementationTargets, state.clipTargets ?? [])
  const referenceExactText = exactTargetTextViolations(
    referenceTargets,
    state.exactTargetTexts ?? {},
  )
  const implementationExactText = exactTargetTextViolations(
    implementationTargets,
    state.exactTargetTexts ?? {},
  )
  const referenceDisabled = disabledTargetViolations(referenceTargets, state.disabledTargets ?? [])
  const implementationDisabled = disabledTargetViolations(
    implementationTargets,
    state.disabledTargets ?? [],
  )
  const referenceUnexpectedVisible = visibleAbsentTargetViolations(
    referenceTargets,
    state.absentTargets ?? [],
  )
  const implementationUnexpectedVisible = visibleAbsentTargetViolations(
    implementationTargets,
    state.absentTargets ?? [],
  )
  const referenceHorizontalScrollReset = horizontalScrollResetViolations(
    referenceTargets,
    state.horizontalScrollResetTargets ?? [],
  )
  const implementationHorizontalScrollReset = horizontalScrollResetViolations(
    implementationTargets,
    state.horizontalScrollResetTargets ?? [],
  )
  const referenceScrollSequence = state.scrollSequence
    ? (scrollSequenceEvidence.get(referencePage) ?? null)
    : null
  const implementationScrollSequence = state.scrollSequence
    ? (scrollSequenceEvidence.get(implementationPage) ?? null)
    : null
  const scrollSequenceComparison = state.scrollSequence
    ? compareScrollSequenceEvidence(referenceScrollSequence, implementationScrollSequence)
    : { equal: true, differences: [] }
  const referenceScrollSequenceViolations = state.scrollSequence
    ? (referenceScrollSequence?.violations ?? ['reference scroll sequence evidence is missing'])
    : []
  const implementationScrollSequenceViolations = state.scrollSequence
    ? (implementationScrollSequence?.violations ?? [
        'implementation scroll sequence evidence is missing',
      ])
    : []
  const stateInvariantFailureCount =
    unexpectedReferenceHorizontalOverflow.length +
    implementationHorizontalOverflow.length +
    referenceContainment.length +
    implementationContainment.length +
    referenceClip.length +
    implementationClip.length +
    referenceExactText.length +
    implementationExactText.length +
    referenceDisabled.length +
    implementationDisabled.length +
    referenceUnexpectedVisible.length +
    implementationUnexpectedVisible.length +
    referenceHorizontalScrollReset.length +
    implementationHorizontalScrollReset.length +
    referenceScrollSequenceViolations.length +
    implementationScrollSequenceViolations.length +
    scrollSequenceComparison.differences.length

  const pixelComparisonTargetNames = state.pixelComparisonTargets ?? state.comparisonTargets ?? []
  const targetBounds = (
    evidence: typeof referenceTargets,
  ): { x: number; y: number; width: number; height: number } | null => {
    const matches = pixelComparisonTargetNames.flatMap(
      (name) => evidence.targets[name]?.matches.filter((match) => match.visible) ?? [],
    )
    if (matches.length === 0) return null
    const left = Math.min(...matches.map((match) => match.rect.x))
    const top = Math.min(...matches.map((match) => match.rect.y))
    const right = Math.max(...matches.map((match) => match.rect.x + match.rect.width))
    const bottom = Math.max(...matches.map((match) => match.rect.y + match.rect.height))
    return {
      x: Math.max(0, Math.floor(left) - 4),
      y: Math.max(0, Math.floor(top) - 4),
      width: Math.ceil(right) - Math.max(0, Math.floor(left) - 4) + 4,
      height: Math.ceil(bottom) - Math.max(0, Math.floor(top) - 4) + 4,
    }
  }
  const referenceTargetBounds = targetBounds(referenceTargets)
  const implementationTargetBounds = targetBounds(implementationTargets)
  const targetPixelRequired = pixelComparisonTargetNames.length > 0
  let targetPixelDiff: PixelDiffEvidence | null = null

  if (referenceTargetBounds && implementationTargetBounds) {
    // 比较区可能延伸到当前 viewport 底部；Playwright 会分别裁掉越界像素，导致两张图
    // 实际尺寸不同。使用双方都可见的公共高度，仍保留同一目标起点和同宽截图。
    const commonVisibleHeight = Math.min(
      viewport.height - referenceTargetBounds.y,
      viewport.height - implementationTargetBounds.y,
    )
    const cropSize = {
      width: Math.max(referenceTargetBounds.width, implementationTargetBounds.width),
      height: Math.min(
        Math.max(referenceTargetBounds.height, implementationTargetBounds.height),
        commonVisibleHeight,
      ),
    }
    await Promise.all([
      referencePage.screenshot({
        path: targetReferencePath,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        clip: { ...referenceTargetBounds, ...cropSize },
        mask: (state.referencePixelMaskSelectors ?? []).map((selector) =>
          referencePage.locator(selector),
        ),
      }),
      implementationPage.screenshot({
        path: targetImplementationPath,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        clip: { ...implementationTargetBounds, ...cropSize },
        mask: (state.implementationPixelMaskSelectors ?? []).map((selector) =>
          implementationPage.locator(selector),
        ),
      }),
    ])
    const { stdout: targetPixelStdout } = await execFileAsync('xcrun', [
      'swift',
      PIXEL_DIFF_TOOL,
      targetReferencePath,
      targetImplementationPath,
      targetPixelDiffPath,
      String(PIXEL_THRESHOLD),
    ])
    targetPixelDiff = JSON.parse(targetPixelStdout.trim()) as PixelDiffEvidence
    await writeFile(targetPixelReportPath, `${JSON.stringify(targetPixelDiff, null, 2)}\n`)
  }

  await Promise.all([
    writeFile(
      geometryPath,
      `${JSON.stringify(
        {
          state: state.name,
          fixture: state.fixture,
          viewport,
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
          stateInvariants: {
            horizontalOverflowTargets: state.horizontalOverflowTargets ?? [],
            allowedReferenceHorizontalOverflowTargets: [
              ...allowedReferenceHorizontalOverflowTargets,
            ],
            absentTargets: state.absentTargets ?? [],
            horizontalScrollResetTargets: state.horizontalScrollResetTargets ?? [],
            containmentTargets: state.containmentTargets ?? [],
            clipTargets: state.clipTargets ?? [],
            exactTargetTexts: state.exactTargetTexts ?? {},
            disabledTargets: state.disabledTargets ?? [],
            reference: {
              horizontalOverflow: referenceHorizontalOverflow,
              unexpectedHorizontalOverflow: unexpectedReferenceHorizontalOverflow,
              containment: referenceContainment,
              clip: referenceClip,
              exactText: referenceExactText,
              disabled: referenceDisabled,
              unexpectedVisible: referenceUnexpectedVisible,
              horizontalScrollReset: referenceHorizontalScrollReset,
              scrollSequence: referenceScrollSequence,
            },
            implementation: {
              horizontalOverflow: implementationHorizontalOverflow,
              containment: implementationContainment,
              clip: implementationClip,
              exactText: implementationExactText,
              disabled: implementationDisabled,
              unexpectedVisible: implementationUnexpectedVisible,
              horizontalScrollReset: implementationHorizontalScrollReset,
              scrollSequence: implementationScrollSequence,
            },
            scrollSequenceComparison,
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(targetDiffPath, `${JSON.stringify(targetDiff, null, 2)}\n`),
  ])

  const { stdout } = await execFileAsync('xcrun', [
    'swift',
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
  const fullPagePixelGateRequired = !TARGET_ONLY && state.fullPagePixelComparable !== false
  const fullPagePixelPass =
    !fullPagePixelGateRequired || diff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
  const status =
    referenceIssues.length > 0 || implementationIssues.length > 0
      ? 'blocked'
      : fullPagePixelPass &&
          targetDiff.equal &&
          (!targetPixelRequired ||
            (targetPixelDiff !== null &&
              targetPixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO)) &&
          stateInvariantFailureCount === 0
        ? 'pass'
        : 'red'
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        state: state.name,
        fixture: state.fixture,
        viewport,
        status,
        referenceURL: REFERENCE_URL,
        implementationURL: IMPLEMENTATION_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
        fullPagePixelComparable: state.fullPagePixelComparable !== false,
        fullPagePixelReason: state.fullPagePixelReason ?? '',
        fullPagePixelComparison: {
          required: fullPagePixelGateRequired,
          status: !fullPagePixelGateRequired
            ? 'not-required'
            : diff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
              ? 'pass'
              : 'red',
          maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
          result: diff,
        },
        referenceIssues,
        implementationIssues,
        targetComparison: {
          comparedTargets: state.comparisonTargets ?? [],
          equal: targetDiff.equal,
          differenceCount: targetDiff.differences.length,
          evidence: 'target-diff.json',
        },
        targetPixelComparison: {
          comparedTargets: pixelComparisonTargetNames,
          required: targetPixelRequired,
          status: !targetPixelRequired
            ? 'not-required'
            : targetPixelDiff === null
              ? 'missing'
              : targetPixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
                ? 'pass'
                : 'red',
          maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
          evidence: targetPixelDiff === null ? null : 'target-pixel-report.json',
          diffImage: targetPixelDiff === null ? null : 'target-pixel-diff.png',
          result: targetPixelDiff,
        },
        stateInvariants: {
          failureCount: stateInvariantFailureCount,
          referenceHorizontalOverflow,
          allowedReferenceHorizontalOverflowTargets: [...allowedReferenceHorizontalOverflowTargets],
          unexpectedReferenceHorizontalOverflow,
          implementationHorizontalOverflow,
          referenceContainment,
          implementationContainment,
          referenceClip,
          implementationClip,
          referenceExactText,
          implementationExactText,
          referenceDisabled,
          implementationDisabled,
          referenceUnexpectedVisible,
          implementationUnexpectedVisible,
          referenceHorizontalScrollReset,
          implementationHorizontalScrollReset,
          referenceScrollSequenceViolations,
          implementationScrollSequenceViolations,
          scrollSequenceComparison,
        },
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
  await testInfo.attach(`${state.name}-target-diff`, {
    body: await readFile(targetDiffPath),
    contentType: 'application/json',
  })
  if (targetPixelDiff !== null) {
    await Promise.all([
      testInfo.attach(`${state.name}-target-reference`, {
        body: await readFile(targetReferencePath),
        contentType: 'image/png',
      }),
      testInfo.attach(`${state.name}-target-implementation`, {
        body: await readFile(targetImplementationPath),
        contentType: 'image/png',
      }),
      testInfo.attach(`${state.name}-target-pixel-diff`, {
        body: await readFile(targetPixelDiffPath),
        contentType: 'image/png',
      }),
      testInfo.attach(`${state.name}-target-pixel-report`, {
        body: await readFile(targetPixelReportPath),
        contentType: 'application/json',
      }),
    ])
  }

  expect
    .soft(referenceIssues, `${state.name} reference is blocked; evidence=${geometryPath}`)
    .toEqual([])
  expect
    .soft(implementationIssues, `${state.name} implementation is blocked; evidence=${geometryPath}`)
    .toEqual([])
  expect
    .soft(targetDiff.differences, `${state.name} target mismatch; evidence=${targetDiffPath}`)
    .toEqual([])
  expect
    .soft(
      unexpectedReferenceHorizontalOverflow,
      `${state.name} reference has unexpected horizontal overflow; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationHorizontalOverflow,
      `${state.name} implementation has horizontal overflow; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceContainment,
      `${state.name} reference target escapes its row container; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationContainment,
      `${state.name} implementation target escapes its row container; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceClip,
      `${state.name} reference row does not clip overflow; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationClip,
      `${state.name} implementation row does not clip overflow; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceExactText,
      `${state.name} reference exact text mismatch; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationExactText,
      `${state.name} implementation exact text mismatch; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceDisabled,
      `${state.name} reference disabled-state mismatch; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationDisabled,
      `${state.name} implementation disabled-state mismatch; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceUnexpectedVisible,
      `${state.name} reference unexpectedly displays an absent-state target; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationUnexpectedVisible,
      `${state.name} implementation unexpectedly displays an absent-state target; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceHorizontalScrollReset,
      `${state.name} reference did not reset horizontal scroll while preserving vertical scroll; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationHorizontalScrollReset,
      `${state.name} implementation did not reset horizontal scroll while preserving vertical scroll; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      referenceScrollSequenceViolations,
      `${state.name} reference five-object scroll sequence failed; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      implementationScrollSequenceViolations,
      `${state.name} implementation five-object scroll sequence failed; evidence=${geometryPath}`,
    )
    .toEqual([])
  expect
    .soft(
      scrollSequenceComparison.differences,
      `${state.name} five-object active panel/content geometry drifted; evidence=${geometryPath}`,
    )
    .toEqual([])
  if (targetPixelRequired) {
    expect
      .soft(targetPixelDiff, `${state.name} target pixel report is missing; evidence=${outputDir}`)
      .not.toBeNull()
    if (targetPixelDiff !== null) {
      expect
        .soft(
          targetPixelDiff.changed_pixel_ratio,
          `${state.name} target changed ${targetPixelDiff.changed_pixels}/${targetPixelDiff.total_pixels} pixels; evidence=${outputDir}`,
        )
        .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
    }
  }
  if (fullPagePixelGateRequired) {
    expect
      .soft(
        diff.changed_pixel_ratio,
        `${state.name} changed ${diff.changed_pixels}/${diff.total_pixels} pixels; evidence=${outputDir}`,
      )
      .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
  }
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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    const [referencePage, implementationPage] = await Promise.all([
      context.newPage(),
      context.newPage(),
    ])
    await installImplementationMocks(implementationPage)
    try {
      const selectedStates = STATE_FILTER
        ? states.filter((state) => state.name === STATE_FILTER)
        : states
      if (selectedStates.length === 0) {
        throw new Error(`unknown HEX_UI_STATE_FILTER=${STATE_FILTER}`)
      }
      for (const state of selectedStates) {
        await captureState(referencePage, implementationPage, state, testInfo)
      }
    } finally {
      await context.close()
    }
  })
})
