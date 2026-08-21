import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { BRANCH_UI_FIDELITY_SURFACES } from './branch-ui-fidelity-manifest'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL =
  process.env.HEX_UI_SOURCE_URL?.trim() ||
  process.env.HEX_UI_IMPLEMENTATION_URL?.trim() ||
  'http://127.0.0.1:16061'
const RUN_ROOT = '/tmp/hexclaw-shared-components-playwright'
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const VIEWPORT = { width: 1440, height: 900 }
const NOW = '2026-07-29T08:20:00.000Z'
const CHAT_SESSION = 'shared-components-chat-session'
const K12_AGENT = 'k12-shared-components-ming'

type Mapping = 'COMPARABLE' | 'BLOCKED'
type StateStatus = 'RED' | 'BLOCKED/RED'
type Action =
  | 'engine-banner'
  | 'message-text'
  | 'message-edit'
  | 'actions-assistant'
  | 'actions-user'
  | 'actions-more'
  | 'tool-result'
  | 'message-context-menu'
  | 'session-menu-click'
  | 'session-menu-context'
  | 'weekly-textbook'
  | 'weekly-textbook-invalid'
  | 'weekly-arithmetic'
  | 'weekly-arithmetic-invalid'
  | 'voice-composer'

interface GeometryTarget {
  name: string
  selector: string
  all?: boolean
}

interface MatrixState {
  id: string
  manifestId: string
  action: Action
  referenceReady: string
  sourceReady: string
  referenceCapture: string
  sourceCapture: string
  referenceTargets: GeometryTarget[]
  sourceTargets: GeometryTarget[]
  mapping: Mapping
  mappingReason: string
}

interface OpenEvidence {
  ok: boolean
  error: string | null
  readySelector: string
  readyCount: number
  url: string
}

interface PixelDiff {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

interface MatrixResult {
  id: string
  manifestId: string
  declaredMapping: Mapping
  effectiveMapping: Mapping
  mappingReason: string
  status: StateStatus
  pixelStatus: 'PASS' | 'RED'
  changedPixelRatio: number
  referenceOpen: OpenEvidence
  sourceOpen: OpenEvidence
  installedApplicationThirdLeg: 'NOT_RUN'
  evidenceDir: string
}

const componentTargets = (root: string): GeometryTarget[] => [
  { name: 'root', selector: root },
  { name: 'buttons', selector: `${root} button`, all: true },
  { name: 'inputs', selector: `${root} input`, all: true },
]

const states: MatrixState[] = [
  {
    id: 'shell.engine-banner.stopped',
    manifestId: 'shell.engine-banner',
    action: 'engine-banner',
    referenceReady: '#engineBanner.on',
    sourceReady: '.hc-engine-banner',
    referenceCapture: '#engineBanner.on',
    sourceCapture: '.hc-engine-banner',
    referenceTargets: componentTargets('#engineBanner.on'),
    sourceTargets: componentTargets('.hc-engine-banner'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs expose the same stopped-engine alert with title, description, View logs, Reconnect, and Start setup actions.',
  },
  {
    id: 'chat.message-text.math-display',
    manifestId: 'chat.message-text',
    action: 'message-text',
    referenceReady: '.bubble.user[data-message-display-source]',
    sourceReady: '.hc-msg--user [data-testid="msg-text"]',
    referenceCapture: '.bubble.user[data-message-display-source]',
    sourceCapture: '.hc-msg--user .hc-msg__bubble--user',
    referenceTargets: componentTargets('.bubble.user[data-message-display-source]'),
    sourceTargets: componentTargets('.hc-msg--user .hc-msg__bubble--user'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs render the same approved road-distance user message and the same two inline TeX fractions.',
  },
  {
    id: 'chat.message-text.inline-editor',
    manifestId: 'chat.message-text',
    action: 'message-edit',
    referenceReady: '.message-edit-card:not([hidden]) .message-edit-surface',
    sourceReady: '.hc-msg__edit-card .hc-msg__text--editable',
    referenceCapture: '.message-edit-card:not([hidden])',
    sourceCapture: '.hc-msg__edit-card',
    referenceTargets: componentTargets('.message-edit-card:not([hidden])'),
    sourceTargets: componentTargets('.hc-msg__edit-card'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs enter the approved inline editor for the same canonical TeX message with clear, cancel, and send actions.',
  },
  {
    id: 'chat.message-actions.assistant',
    manifestId: 'chat.message-actions',
    action: 'actions-assistant',
    referenceReady: '.msg-actions--assistant',
    sourceReady: '.hc-msg-actions--assistant',
    referenceCapture: '.msg-actions--assistant',
    sourceCapture: '.hc-msg-actions--assistant',
    referenceTargets: componentTargets('.msg-actions--assistant'),
    sourceTargets: componentTargets('.hc-msg-actions--assistant'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both action rows expose assistant feedback, copy, speak, retry, and more on the same completed response.',
  },
  {
    id: 'chat.message-actions.user',
    manifestId: 'chat.message-actions',
    action: 'actions-user',
    referenceReady: '.msg-actions--user',
    sourceReady: '.hc-msg-actions--user',
    referenceCapture: '.msg-actions--user',
    sourceCapture: '.hc-msg-actions--user',
    referenceTargets: componentTargets('.msg-actions--user'),
    sourceTargets: componentTargets('.hc-msg-actions--user'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both action rows expose copy, edit, and more for the same approved user message.',
  },
  {
    id: 'chat.message-actions.more-menu',
    manifestId: 'chat.message-actions',
    action: 'actions-more',
    referenceReady: '.msg-actions--assistant .msg-more.open .msg-more-menu',
    sourceReady: '.hc-msg-actions--assistant .hc-msg-actions__more-menu',
    referenceCapture: '.msg-actions--assistant .msg-more.open .msg-more-menu',
    sourceCapture: '.hc-msg-actions--assistant .hc-msg-actions__more-menu',
    referenceTargets: componentTargets('.msg-actions--assistant .msg-more.open .msg-more-menu'),
    sourceTargets: componentTargets('.hc-msg-actions--assistant .hc-msg-actions__more-menu'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both menus expose Create branch and destructive Delete from the assistant action row.',
  },
  {
    id: 'chat.tool-call-card.result',
    manifestId: 'chat.tool-call-card',
    action: 'tool-result',
    referenceReady: '.tool-card[data-render-producer="tool"]',
    sourceReady: '.hc-tool',
    referenceCapture: '.tool-card[data-render-producer="tool"]',
    sourceCapture: '.hc-tool',
    referenceTargets: componentTargets('.tool-card[data-render-producer="tool"]'),
    sourceTargets: componentTargets('.hc-tool'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both cards show calculator.evaluate and the equivalent expression/result payload for 10.78.',
  },
  {
    id: 'chat.message-context-menu.right-click',
    manifestId: 'chat.message-context-menu',
    action: 'message-context-menu',
    referenceReady: '.msg-actions--assistant .msg-more.open .msg-more-menu',
    sourceReady: '.hc-ctx:not(.hc-ctx--session)',
    referenceCapture: '.msg-actions--assistant .msg-more.open .msg-more-menu',
    sourceCapture: '.hc-ctx:not(.hc-ctx--session)',
    referenceTargets: componentTargets('.msg-actions--assistant .msg-more.open .msg-more-menu'),
    sourceTargets: componentTargets('.hc-ctx:not(.hc-ctx--session)'),
    mapping: 'BLOCKED',
    mappingReason:
      'The prototype has only the approved action-row More menu; it has no generic right-click message ContextMenu. The captured menus are intentionally not treated as equivalent.',
  },
  {
    id: 'chat.session-context-menu.action-button',
    manifestId: 'chat.session-context-menu',
    action: 'session-menu-click',
    referenceReady: '#prototypeSessionMenu.on',
    sourceReady: '.hc-ctx.hc-ctx--session',
    referenceCapture: '#prototypeSessionMenu.on',
    sourceCapture: '.hc-ctx.hc-ctx--session',
    referenceTargets: componentTargets('#prototypeSessionMenu.on'),
    sourceTargets: componentTargets('.hc-ctx.hc-ctx--session'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs open the session menu from the row action button for the same unpinned session state.',
  },
  {
    id: 'chat.session-context-menu.right-click',
    manifestId: 'chat.session-context-menu',
    action: 'session-menu-context',
    referenceReady: '#prototypeSessionMenu.on',
    sourceReady: '.hc-ctx.hc-ctx--session',
    referenceCapture: '#prototypeSessionMenu.on',
    sourceCapture: '.hc-ctx.hc-ctx--session',
    referenceTargets: componentTargets('#prototypeSessionMenu.on'),
    sourceTargets: componentTargets('.hc-ctx.hc-ctx--session'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs route right-click on the same unpinned session row into the shared session-menu state machine.',
  },
  {
    id: 'k12.weekly-manual.textbook-default',
    manifestId: 'k12.weekly-manual-question-count',
    action: 'weekly-textbook',
    referenceReady: '.k12-manual-count-control[data-manual-track="textbook_consolidation"]',
    sourceReady: '[data-testid="manual-count-textbook_consolidation"]',
    referenceCapture: '.k12-manual-count-control[data-manual-track="textbook_consolidation"]',
    sourceCapture: '[data-testid="manual-count-textbook_consolidation"]',
    referenceTargets: componentTargets(
      '.k12-manual-count-control[data-manual-track="textbook_consolidation"]',
    ),
    sourceTargets: componentTargets('[data-testid="manual-count-textbook_consolidation"]'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs render the textbook-consolidation manual count at 5 with the same 1–10 boundary.',
  },
  {
    id: 'k12.weekly-manual.textbook-invalid',
    manifestId: 'k12.weekly-manual-question-count',
    action: 'weekly-textbook-invalid',
    referenceReady:
      '.k12-manual-count-control[data-manual-track="textbook_consolidation"] input[aria-invalid="true"]',
    sourceReady: '[data-testid="manual-count-textbook_consolidation"] input[aria-invalid="true"]',
    referenceCapture: '.k12-manual-count-control[data-manual-track="textbook_consolidation"]',
    sourceCapture: '[data-testid="manual-count-textbook_consolidation"]',
    referenceTargets: componentTargets(
      '.k12-manual-count-control[data-manual-track="textbook_consolidation"]',
    ),
    sourceTargets: componentTargets('[data-testid="manual-count-textbook_consolidation"]'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs validate the same out-of-range textbook count 0 against the 1–10 boundary.',
  },
  {
    id: 'k12.weekly-manual.arithmetic-default',
    manifestId: 'k12.weekly-manual-question-count',
    action: 'weekly-arithmetic',
    referenceReady: '.k12-manual-count-control[data-manual-track="arithmetic_warmup"]',
    sourceReady: '[data-testid="manual-count-arithmetic_warmup"]',
    referenceCapture: '.k12-manual-count-control[data-manual-track="arithmetic_warmup"]',
    sourceCapture: '[data-testid="manual-count-arithmetic_warmup"]',
    referenceTargets: componentTargets(
      '.k12-manual-count-control[data-manual-track="arithmetic_warmup"]',
    ),
    sourceTargets: componentTargets('[data-testid="manual-count-arithmetic_warmup"]'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs render the arithmetic-warmup manual count at 10 with the same 1–20 boundary.',
  },
  {
    id: 'k12.weekly-manual.arithmetic-invalid',
    manifestId: 'k12.weekly-manual-question-count',
    action: 'weekly-arithmetic-invalid',
    referenceReady:
      '.k12-manual-count-control[data-manual-track="arithmetic_warmup"] input[aria-invalid="true"]',
    sourceReady: '[data-testid="manual-count-arithmetic_warmup"] input[aria-invalid="true"]',
    referenceCapture: '.k12-manual-count-control[data-manual-track="arithmetic_warmup"]',
    sourceCapture: '[data-testid="manual-count-arithmetic_warmup"]',
    referenceTargets: componentTargets(
      '.k12-manual-count-control[data-manual-track="arithmetic_warmup"]',
    ),
    sourceTargets: componentTargets('[data-testid="manual-count-arithmetic_warmup"]'),
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs validate the same out-of-range arithmetic count 0 against the 1–20 boundary.',
  },
  {
    id: 'chat.voice-composer.prototype-non-equivalent',
    manifestId: 'chat.voice-composer',
    action: 'voice-composer',
    referenceReady: '.screen[data-pane="chat"] button[title^="语音听写"]',
    sourceReady: '.hc-voicechat',
    referenceCapture: '.screen[data-pane="chat"] button[title^="语音听写"]',
    sourceCapture: '.hc-voicechat',
    referenceTargets: componentTargets('.screen[data-pane="chat"] button[title^="语音听写"]'),
    sourceTargets: componentTargets('.hc-voicechat'),
    mapping: 'BLOCKED',
    mappingReason:
      'The prototype exposes a single dictation button/toast, while source renders a persistent model-aware full-duplex voice composer. The two surfaces are not equivalent, and installed microphone/provider evidence is absent.',
  },
]

const manifestIds = new Set(BRANCH_UI_FIDELITY_SURFACES.map((surface) => surface.id))
for (const state of states) {
  if (!manifestIds.has(state.manifestId)) {
    throw new Error(
      `matrix state ${state.id} references missing manifest surface ${state.manifestId}`,
    )
  }
}

const sourceConfig = {
  general: {
    language: 'zh-CN',
    log_level: 'info',
    data_dir: '',
    auto_start: false,
    defaultAgentRole: '',
    welcomeCompleted: true,
  },
  knowledge: { enabled: true },
  notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
  memory: { enabled: true },
  sandbox: { network_enabled: true },
  security: {
    gateway_enabled: true,
    injection_detection: true,
    pii_filter: false,
    content_filter: true,
    rate_limit_rpm: 60,
  },
  mcp: { default_protocol: 'stdio' },
  llm: {
    default: 'openai/gpt-5.6-sol',
    defaultModel: 'gpt-5.6-sol',
    defaultProviderId: 'openai',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'fixture-redacted',
        baseUrl: 'https://api.openai.com/v1',
        models: [
          {
            id: 'gpt-5.6-sol',
            name: 'gpt-5.6-sol',
            capabilities: ['text', 'vision', 'tools', 'reasoning', 'audio'],
          },
        ],
      },
    ],
  },
}

const userMessage =
  '修路队修一条公路，第一天修了 $2\\frac{3}{4}$ 千米，第二天比第一天多修了 $1\\frac{1}{2}$ 千米。第二天修了多少千米?'

const sourceMessages = [
  {
    id: 'user-road-distance',
    role: 'user',
    content: userMessage,
    timestamp: NOW,
    created_at: NOW,
  },
  {
    id: 'assistant-calculator-result',
    role: 'assistant',
    content:
      '解题步骤：\n\n1. 先算减法：$3.6 - 0.8 = 2.8$\n2. 再算加法：$1.8 + 2.05 = 3.85$\n3. 最后相乘：$2.8 \\times 3.85 = 10.78$\n\n✅ 最终积是 **10.78**。',
    timestamp: NOW,
    created_at: NOW,
    tool_calls: [
      {
        id: 'tool-calculator-evaluate',
        name: 'calculator.evaluate',
        arguments: '{"expression":"(3.6 - 0.8) * (1.8 + 2.05)"}',
        result: '{"expression":"(3.6 - 0.8) * (1.8 + 2.05)","result":10.78}',
        status: 'success',
        duration_ms: 1234,
      },
    ],
    metadata: {
      provider: 'openai',
      model: 'gpt-5.6-sol',
    },
  },
]

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
  plan_id: 'weekly-shared-components-2026-30',
  agent: K12_AGENT,
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
          'weekly-shared-item-1',
          1,
          'mistake-decimal',
          '苹果每千克 4.2 元，买 3 千克共多少钱？',
          '小数乘法错题',
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function isWeeklyAction(action: Action) {
  return action.startsWith('weekly-')
}

function runtimeFixture(apiPath: string, method: string, requestURL: URL, action: Action): unknown {
  const k12 = isWeeklyAction(action)
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceConfig
  if (apiPath === '/api/v1/config/llm') return sourceConfig.llm
  if (apiPath === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    if (!k12) return { agents: [], total: 0, default: '' }
    return {
      agents: [
        {
          name: K12_AGENT,
          display_name: '小明的辅导助手',
          description: '五年级下 · 各学科教材独立绑定',
          provider: 'openai',
          model: 'gpt-5.6-sol',
          metadata: {
            scenario: 'k12-tutor',
            avatar: '🎓',
            'k12.child_name': '小明',
            'k12.learner_id': 'learner-shared-components-ming',
            'k12.grade_term': '五年级下',
            'k12.textbook_edition': '人教版',
            'k12.textbook_edition.math': '人教版',
          },
        },
      ],
      total: 1,
      default: K12_AGENT,
    }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/skills') return { skills: [], items: [], total: 0 }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: CHAT_SESSION,
          title: k12 ? '小明的辅导助手' : '小数乘法讲解',
          user_id: 'desktop-user',
          agent_name: k12 ? K12_AGENT : undefined,
          created_at: NOW,
          updated_at: NOW,
          message_count: k12 ? 0 : sourceMessages.length,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/messages` && method === 'GET') {
    return { messages: k12 ? [] : sourceMessages, total: k12 ? 0 : sourceMessages.length }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/branches`) {
    return { branches: [], total: 0 }
  }
  if (apiPath === '/api/v1/messages/search') {
    return { results: [], total: 0, query: requestURL.searchParams.get('q') ?? '' }
  }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/images/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/videos/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/voicechat/status') {
    return action === 'voice-composer'
      ? { available: true, models: ['gpt-5.6-sol'] }
      : { available: false, models: [] }
  }
  if (apiPath === '/api/k12/view-descriptor') {
    return {
      header_tabs: ['辅导', '学习档案', '学情'],
      message_badges: [],
      composer_placeholder: '拍照或输入题目',
      composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
      record_collections: [],
      side_panels: [],
      actions: [],
      i18n_keys: [],
      schema_version: 1,
    }
  }
  if (apiPath === '/api/k12/curriculum-progress') {
    return {
      progress: {
        progress_id: 'progress-shared-components',
        agent: K12_AGENT,
        subject: 'math',
        revision: 4,
        textbook_binding_id: 'pep-5b',
        textbook_manifest_id: 'manifest-pep-5b',
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
    }
  }
  if (apiPath === '/api/k12/textbook-binding-options') return { items: [] }
  if (apiPath === '/api/k12/weekly-practice/settings') {
    return {
      agent: K12_AGENT,
      revision: 7,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
      created_at: NOW,
      updated_at: NOW,
    }
  }
  if (apiPath === '/api/k12/weekly-practice/plans/current') return { plan: weeklyPlan }
  if (apiPath === '/api/k12/weekly-practice/plans' && method === 'POST') {
    return { plan: weeklyPlan, replayed: false }
  }
  if (apiPath === '/api/k12/weekly-practice/plans/history') {
    return { items: [], next_cursor: null }
  }
  if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue') {
    return { items: [] }
  }
  if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') {
    return { items: [] }
  }
  if (apiPath === '/api/k12/practice-sets') return { items: [] }
  if (apiPath === '/api/k12/creative-works') return { items: [] }
  if (apiPath === '/api/k12/insight-report') {
    return {
      grade_term: '五年级下',
      trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
      weak_top3: [],
      consecutive_fail_kps: [],
      month_new_mistakes: 0,
      review_completion_rate: 0,
      week_pending: 0,
      practice_pending: 0,
      suggestion: '',
    }
  }
  if (apiPath === '/api/k12/study-time') {
    return { days: [], total_records: 0, total_minutes: 0, note: '' }
  }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page, action: Action) {
  await page.addInitScript(
    ({ config, session, agent, k12 }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('app_config', JSON.stringify(config))
      if (k12) {
        // K12 视觉状态固定为已完成首次引导，避免产品一次性提示遮挡验收状态。
        localStorage.setItem(
          'hc-k12-appearance-v1',
          JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
        )
        localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      }

      const callbacks = new Map<number, (payload: unknown) => unknown>()
      let nextCallbackID = 1
      const desktopWindow = window as typeof window & {
        __TAURI_INTERNALS__?: Record<string, unknown>
        __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
      }
      const unregisterCallback = (id: number) => callbacks.delete(id)
      const transformCallback = (callback?: (payload: unknown) => unknown, once = false) => {
        const id = nextCallbackID++
        callbacks.set(id, (payload) => {
          if (once) unregisterCallback(id)
          return callback?.(payload)
        })
        return id
      }
      desktopWindow.__TAURI_INTERNALS__ = {
        callbacks,
        transformCallback,
        unregisterCallback,
        runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'check_engine_health') return true
          if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
          if (
            command === 'plugin:event|unlisten' ||
            command === 'plugin:event|emit' ||
            command === 'plugin:clipboard-manager|write_text'
          ) {
            return null
          }
          if (command === 'proxy_api_request') {
            const apiPath = String(args.path ?? '')
            const response = await fetch(`/_hexclaw${apiPath}`, {
              method: String(args.method ?? 'GET'),
              body: typeof args.body === 'string' ? args.body : undefined,
              headers: { 'content-type': 'application/json' },
            })
            if (!response.ok) {
              throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
            }
            return response.text()
          }
          return null
        },
      }
      desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, id: number) => unregisterCallback(id),
      }
    },
    {
      config: sourceConfig,
      session: CHAT_SESSION,
      agent: K12_AGENT,
      k12: isWeeklyAction(action),
    },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'shared-components-matrix' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    if (apiPath.includes('/assets/') && route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#dbeafe"/></svg>',
      })
    }
    return json(route, runtimeFixture(apiPath, route.request().method(), requestURL, action))
  })
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
  })
  // EngineBanner uses a 200 ms Vue enter transition. Capture only after that
  // transition has settled; otherwise Playwright's animations:'disabled' can
  // freeze the entering node at its transparent frame.
  await page.waitForTimeout(320)
}

async function openReferenceWeekly(page: Page, action: Action) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.waitForFunction(
    () => typeof (window as typeof window & { goLogs?: unknown }).goLogs === 'function',
    undefined,
    { timeout: 8_000 },
  )
  const opened = await page.evaluate(() => {
    const host = window as typeof window & {
      goK12Learner?: (key: string) => void
      k12Tab?: (tab: string) => void
      k12BookTab?: (tab: number) => void
      switchK12WeeklyView?: (view: string) => void
    }
    if (!host.goK12Learner || !host.k12Tab || !host.k12BookTab) return false
    host.goK12Learner('ming')
    host.k12Tab('records')
    host.k12BookTab(0)
    host.switchK12WeeklyView?.('current')
    return true
  })
  if (!opened) throw new Error('authoritative prototype K12 weekly opener is missing')
  if (action.endsWith('-invalid')) {
    const track = action.includes('textbook') ? 'textbook_consolidation' : 'arithmetic_warmup'
    await page.locator(`.k12-manual-count-control[data-manual-track="${track}"] input`).fill('0')
  }
}

async function openReference(page: Page, state: MatrixState): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    if (isWeeklyAction(state.action)) {
      await openReferenceWeekly(page, state.action)
    } else {
      await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
      await page.locator('.screen[data-pane="chat"]').waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForFunction(
        () => typeof (window as typeof window & { goLogs?: unknown }).goLogs === 'function',
        undefined,
        { timeout: 8_000 },
      )
      await page.evaluate(() => {
        const host = window as typeof window & {
          openNormalChat?: () => void
          applyChatWorkspaceMode?: (mode: string) => void
        }
        host.openNormalChat?.()
        host.applyChatWorkspaceMode?.('sessions')
      })
      switch (state.action) {
        case 'engine-banner':
          await page.evaluate(() => {
            document.querySelector('#engineBanner')?.classList.add('on')
            document.querySelector('#sbFoot')?.classList.add('off')
          })
          break
        case 'message-edit':
          await page.locator('.bubble.user[data-message-display-source]').first().hover()
          await page.locator('.msg-actions--user button[aria-label="编辑"]').first().click()
          break
        case 'actions-assistant':
        case 'actions-more':
        case 'message-context-menu':
          await page.locator('.msg.bot:has(.tool-card)').first().hover()
          if (state.action === 'actions-more' || state.action === 'message-context-menu') {
            await page.locator('.msg-actions--assistant button[aria-label="更多"]').first().click()
          }
          break
        case 'actions-user':
          await page.locator('.bubble.user[data-message-display-source]').first().hover()
          break
        case 'session-menu-click': {
          const row = page.locator('.cs-item[data-session-id="decimal"]')
          await row.hover()
          await row.locator('.cs-more').click()
          break
        }
        case 'session-menu-context':
          await page.locator('.cs-item[data-session-id="decimal"]').click({ button: 'right' })
          break
        case 'message-text':
        case 'tool-result':
        case 'voice-composer':
          break
      }
    }
    const ready = page.locator(state.referenceReady).first()
    if ((await ready.count()) === 0) {
      throw new Error(`authoritative prototype target is not reachable: ${state.referenceReady}`)
    }
    await ready.waitFor({ state: 'visible', timeout: 4_000 })
    await ready.scrollIntoViewIfNeeded().catch(() => undefined)
    await settle(page)
    if ((await ready.count()) === 0 || !(await ready.isVisible())) {
      throw new Error(
        `authoritative prototype target did not remain visible after settle: ${state.referenceReady}`,
      )
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return {
    ok: error === null,
    error,
    readySelector: state.referenceReady,
    readyCount: await page.locator(state.referenceReady).count(),
    url: page.url(),
  }
}

async function openSourceWeekly(page: Page, action: Action) {
  await page.goto(
    `${SOURCE_URL}/chat?role=${K12_AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded', timeout: 12_000 },
  )
  await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 8_000 })
  await page.locator('.k12enh-seg').waitFor({ state: 'visible', timeout: 8_000 })
  await page.locator('.k12enh-seg').getByRole('tab', { name: '学习档案', exact: true }).click()
  await page.getByTestId('subtab-week').click()
  const track = action.includes('textbook') ? 'textbook_consolidation' : 'arithmetic_warmup'
  const control = page.getByTestId(`manual-count-${track}`)
  await control.waitFor({ state: 'visible', timeout: 8_000 })
  if (action.endsWith('-invalid')) await control.locator('input').fill('0')
}

async function openSource(page: Page, state: MatrixState): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await installSourceFixture(page, state.action)
    if (isWeeklyAction(state.action)) {
      await openSourceWeekly(page, state.action)
    } else {
      await page.goto(`${SOURCE_URL}/chat`, {
        waitUntil: 'domcontentloaded',
        timeout: 12_000,
      })
      await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 8_000 })
      await page.locator('.hc-chat').waitFor({ state: 'visible', timeout: 8_000 })
      if (state.action !== 'voice-composer') {
        await page.locator('.hc-msg').first().waitFor({ state: 'visible', timeout: 8_000 })
      }
      switch (state.action) {
        case 'engine-banner':
          await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 5_000 })
          await page.evaluate(async () => {
            const dynamicImport = new Function('path', 'return import(path)') as (
              modulePath: string,
            ) => Promise<{
              useAppStore: () => { sidecarStatus: string; stopHealthCheck: () => void }
            }>
            const module = await dynamicImport('/src/stores/app.ts')
            const appStore = module.useAppStore()
            appStore.stopHealthCheck()
            appStore.sidecarStatus = 'stopped'
          })
          break
        case 'message-edit':
          await page.locator('.hc-msg--user').hover()
          await page.locator('.hc-msg-actions--user button[aria-label*="编辑"]').first().click()
          break
        case 'actions-assistant':
        case 'actions-more':
          await page.locator('.hc-msg--assistant').hover()
          break
        case 'actions-user':
          await page.locator('.hc-msg--user').hover()
          break
        case 'tool-result':
          await page.locator('.hc-tool details').last().locator('summary').click()
          break
        case 'message-context-menu':
          await page.locator('.hc-msg--assistant').click({ button: 'right' })
          break
        case 'session-menu-click': {
          const row = page.locator(`.hc-sessions__item[data-session-id="${CHAT_SESSION}"]`)
          await row.hover()
          await row.locator('.hc-sessions__actions').click()
          break
        }
        case 'session-menu-context':
          await page
            .locator(`.hc-sessions__item[data-session-id="${CHAT_SESSION}"]`)
            .click({ button: 'right' })
          break
        case 'message-text':
        case 'voice-composer':
          break
      }
    }
    const ready = page.locator(state.sourceReady).first()
    if ((await ready.count()) === 0) {
      throw new Error(`current-source target is not reachable: ${state.sourceReady}`)
    }
    await ready.waitFor({ state: 'visible', timeout: 4_000 })
    await ready.scrollIntoViewIfNeeded().catch(() => undefined)
    await settle(page)
    if ((await ready.count()) === 0 || !(await ready.isVisible())) {
      throw new Error(
        `current-source target did not remain visible after settle: ${state.sourceReady}`,
      )
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return {
    ok: error === null,
    error,
    readySelector: state.sourceReady,
    readyCount: await page.locator(state.sourceReady).count(),
    url: page.url(),
  }
}

async function captureGeometry(page: Page, targets: GeometryTarget[]) {
  return page.evaluate((items) => {
    const styleKeys = [
      'display',
      'visibility',
      'position',
      'zIndex',
      'boxSizing',
      'width',
      'height',
      'padding',
      'margin',
      'gap',
      'gridTemplateColumns',
      'background',
      'backgroundColor',
      'backgroundImage',
      'border',
      'borderRadius',
      'boxShadow',
      'backdropFilter',
      'webkitBackdropFilter',
      'color',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'overflow',
      'overflowX',
      'overflowY',
      'opacity',
    ] as const
    return items.flatMap((target) => {
      const elements = target.all
        ? [...document.querySelectorAll<HTMLElement>(target.selector)]
        : [...document.querySelectorAll<HTMLElement>(target.selector)].slice(0, 1)
      if (elements.length === 0) return [{ ...target, index: 0, found: false }]
      return elements.map((element, index) => {
        const rect = element.getBoundingClientRect()
        const computed = getComputedStyle(element)
        return {
          ...target,
          index,
          found: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          style: Object.fromEntries(styleKeys.map((key) => [key, computed[key]])),
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 700),
          state: {
            disabled:
              element instanceof HTMLButtonElement || element instanceof HTMLInputElement
                ? element.disabled
                : null,
            ariaDisabled: element.getAttribute('aria-disabled'),
            ariaExpanded: element.getAttribute('aria-expanded'),
            ariaInvalid: element.getAttribute('aria-invalid'),
            role: element.getAttribute('role'),
          },
        }
      })
    })
  }, targets)
}

async function visibleBox(page: Page, selector: string) {
  const locator = page.locator(selector).first()
  if ((await locator.count()) === 0) return null
  return locator.boundingBox()
}

function alignedClip(
  box: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
) {
  const desiredX = box.x - 16
  const desiredY = box.y - 16
  return {
    x: Math.max(0, Math.min(desiredX, VIEWPORT.width - width)),
    y: Math.max(0, Math.min(desiredY, VIEWPORT.height - height)),
    width,
    height,
  }
}

async function captureAlignedPair(
  referencePage: Page,
  sourcePage: Page,
  state: MatrixState,
  referencePath: string,
  sourcePath: string,
) {
  const [referenceBox, sourceBox] = await Promise.all([
    visibleBox(referencePage, state.referenceCapture),
    visibleBox(sourcePage, state.sourceCapture),
  ])
  const animations = state.action === 'engine-banner' ? ('allow' as const) : ('disabled' as const)
  if (!referenceBox || !sourceBox) {
    const captureReference = () =>
      referencePage.screenshot({
        path: referencePath,
        animations,
        caret: 'hide',
        timeout: 15_000,
      })
    const captureSource = () =>
      sourcePage.screenshot({
        path: sourcePath,
        animations,
        caret: 'hide',
        timeout: 15_000,
      })
    if (state.action === 'engine-banner') {
      await captureSource()
      await captureReference()
    } else {
      await captureReference()
      await captureSource()
    }
    return {
      mode: 'full-viewport-fallback',
      referenceSelector: state.referenceCapture,
      sourceSelector: state.sourceCapture,
      referenceBox,
      sourceBox,
    }
  }
  const width = Math.min(
    VIEWPORT.width,
    Math.max(64, Math.ceil(Math.max(referenceBox.width, sourceBox.width) + 32)),
  )
  const height = Math.min(
    VIEWPORT.height,
    Math.max(64, Math.ceil(Math.max(referenceBox.height, sourceBox.height) + 32)),
  )
  const referenceClip = alignedClip(referenceBox, width, height)
  const sourceClip = alignedClip(sourceBox, width, height)
  const captureReference = () =>
    referencePage.screenshot({
      path: referencePath,
      animations,
      caret: 'hide',
      clip: referenceClip,
      timeout: 15_000,
    })
  const captureSource = () =>
    sourcePage.screenshot({
      path: sourcePath,
      animations,
      caret: 'hide',
      clip: sourceClip,
      timeout: 15_000,
    })
  // EngineBanner is transient in the real shell because a health poll can
  // update the store. Capture that source boundary first; the diagnostic run
  // proved that delaying it behind the large prototype screenshot can catch
  // the leave frame instead of the ready state.
  if (state.action === 'engine-banner') {
    await captureSource()
    await captureReference()
  } else {
    await captureReference()
    await captureSource()
  }
  return {
    mode: 'aligned-component-crop',
    referenceSelector: state.referenceCapture,
    sourceSelector: state.sourceCapture,
    referenceBox,
    sourceBox,
    referenceClip,
    sourceClip,
  }
}

async function runPixelDiff(reference: string, source: string, output: string) {
  const { stdout } = await execFileAsync('python3', [
    PIXEL_DIFF_TOOL,
    reference,
    source,
    output,
    String(PIXEL_THRESHOLD),
  ])
  return JSON.parse(stdout) as PixelDiff
}

async function useEvidencePages(browser: Browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  return {
    context,
    referencePage: await context.newPage(),
    sourcePage: await context.newPage(),
  }
}

async function exerciseState(browser: Browser, state: MatrixState, testInfo: TestInfo) {
  const evidenceDir = path.join(EVIDENCE_ROOT, testInfo.project.name, state.id)
  await mkdir(evidenceDir, { recursive: true })
  const referencePath = path.join(evidenceDir, 'reference.png')
  const sourcePath = path.join(evidenceDir, 'current-source.png')
  const diffPath = path.join(evidenceDir, 'pixel-diff.png')
  const geometryPath = path.join(evidenceDir, 'geometry-style.json')
  const resultPath = path.join(evidenceDir, 'status.json')

  const { context, referencePage, sourcePage } = await useEvidencePages(browser)
  try {
    const referenceOpen = await openReference(referencePage, state)
    const sourceOpen = await openSource(sourcePage, state)
    const capture = await captureAlignedPair(
      referencePage,
      sourcePage,
      state,
      referencePath,
      sourcePath,
    )
    const pixelDiff = await runPixelDiff(referencePath, sourcePath, diffPath)
    const [referenceGeometry, sourceGeometry] = await Promise.all([
      captureGeometry(referencePage, state.referenceTargets),
      captureGeometry(sourcePage, state.sourceTargets),
    ])
    await writeFile(
      geometryPath,
      JSON.stringify(
        {
          environment: {
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            colorScheme: 'light',
          },
          capture,
          reference: referenceGeometry,
          currentSource: sourceGeometry,
        },
        null,
        2,
      ),
    )

    const effectiveMapping: Mapping =
      state.mapping === 'BLOCKED' || !referenceOpen.ok || !sourceOpen.ok ? 'BLOCKED' : 'COMPARABLE'
    const pixelStatus = pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED'
    const installedApplicationThirdLeg = 'NOT_RUN' as const
    const status: StateStatus =
      effectiveMapping === 'BLOCKED' || pixelStatus === 'PASS' ? 'BLOCKED/RED' : 'RED'
    const result = {
      id: state.id,
      manifestId: state.manifestId,
      declaredMapping: state.mapping,
      effectiveMapping,
      mappingReason: state.mappingReason,
      status,
      pixelStatus,
      changedPixelRatio: pixelDiff.changed_pixel_ratio,
      referenceOpen,
      sourceOpen,
      installedApplicationThirdLeg,
      evidenceDir,
      environment: {
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        referenceURL: REFERENCE_URL,
        sourceURL: SOURCE_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      },
      capture,
      pixelDiff,
      evidence: {
        referenceScreenshot: referencePath,
        currentSourceScreenshot: sourcePath,
        pixelDiff: diffPath,
        geometryStyle: geometryPath,
        status: resultPath,
      },
    }
    await writeFile(resultPath, JSON.stringify(result, null, 2))

    for (const [name, file, contentType] of [
      ['reference', referencePath, 'image/png'],
      ['current-source', sourcePath, 'image/png'],
      ['pixel-diff', diffPath, 'image/png'],
      ['geometry-style', geometryPath, 'application/json'],
      ['status', resultPath, 'application/json'],
    ] as const) {
      await testInfo.attach(`${state.id}-${name}`, {
        body: await readFile(file),
        contentType,
      })
    }

    expect(
      status,
      `${state.id}: status=${status}; mapping=${effectiveMapping}; changed=${(
        pixelDiff.changed_pixel_ratio * 100
      ).toFixed(4)}%; reason=${state.mappingReason}; reference=${
        referenceOpen.error ?? 'ok'
      }; source=${sourceOpen.error ?? 'ok'}; installed=NOT_RUN`,
    ).toBe('PASS')
  } finally {
    await context.close()
  }
}

test.describe('feat/v0.5.0-k12-parent-tutor — shared components visual matrix', () => {
  test.afterAll(async () => {
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    const projectEvidenceRoot = path.join(EVIDENCE_ROOT, 'chromium')
    const entries = await readdir(projectEvidenceRoot, { withFileTypes: true }).catch(() => [])
    const results = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            try {
              return JSON.parse(
                await readFile(path.join(projectEvidenceRoot, entry.name, 'status.json'), 'utf8'),
              ) as MatrixResult
            } catch {
              return null
            }
          }),
      )
    )
      .filter((result): result is MatrixResult => result !== null)
      .sort(
        (left, right) =>
          states.findIndex((state) => state.id === left.id) -
          states.findIndex((state) => state.id === right.id),
      )
    const statusCounts = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1
      return counts
    }, {})
    const manifestCounts = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.manifestId] = (counts[result.manifestId] ?? 0) + 1
      return counts
    }, {})
    await writeFile(
      path.join(EVIDENCE_ROOT, 'matrix-summary.json'),
      JSON.stringify(
        {
          total: states.length,
          executed: results.length,
          statusCounts,
          manifestCounts,
          passRatio: `${results.filter((result) => result.status === ('PASS' as string)).length}/${states.length}`,
          installedApplicationThirdLeg: 'NOT_RUN',
          environment: {
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
          },
          results,
        },
        null,
        2,
      ),
    )
  })

  for (const state of states) {
    test(`${state.id} emits reference/current/diff/geometry/status evidence`, async ({
      browser,
    }, testInfo) => {
      await exerciseState(browser, state, testInfo)
    })
  }
})
