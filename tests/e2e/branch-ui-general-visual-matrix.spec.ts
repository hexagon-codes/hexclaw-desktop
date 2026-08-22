import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL =
  process.env.HEX_UI_SOURCE_URL?.trim() ||
  process.env.HEX_UI_IMPLEMENTATION_URL?.trim() ||
  'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-general-routes-visual-matrix/evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const NOW = '2026-07-29T06:20:00.000Z'
const CHAT_SESSION = 'general-visual-matrix-chat'

type PrototypeSwitch =
  | { kind: 'segment'; set: 'kn' | 'au' | 'in'; index: number }
  | { kind: 'connection'; index: number }

type ComparisonStatus = 'COMPARABLE' | 'NOT_COMPARABLE'
type OverallStatus = 'PASS' | 'RED' | 'NOT_COMPARABLE/RED'

interface Anchor {
  label: string
  variants: string[]
}

interface GeometryTarget {
  name: string
  selector: string
  all?: boolean
}

interface Surface {
  id: string
  route: string
  prototypePane:
    | 'chat'
    | 'agents'
    | 'knowledge'
    | 'automation'
    | 'channels'
    | 'integration'
    | 'logs'
    | 'settings'
  prototypeSwitch?: PrototypeSwitch
  referenceReady: string
  sourceReady: string
  referenceTargets: GeometryTarget[]
  sourceTargets: GeometryTarget[]
  anchors: Anchor[]
  fixtureComparison: {
    status: ComparisonStatus
    reason: string
  }
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface GeometryEvidence {
  name: string
  selector: string
  index: number
  found: boolean
  rect?: Rect
  text?: string
  style?: Record<string, string>
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

interface SurfaceResult {
  id: string
  route: string
  stateStatus: ComparisonStatus
  pixelStatus: 'PASS' | 'RED'
  overallStatus: OverallStatus
  changedPixelRatio: number
  evidence: string
}

const refTargets = (
  pane: Surface['prototypePane'],
  contentExtra: GeometryTarget[] = [],
): GeometryTarget[] => [
  { name: 'page-root', selector: `.screen[data-pane="${pane}"]` },
  { name: 'toolbar', selector: `.screen[data-pane="${pane}"] > .tbar` },
  { name: 'content', selector: `.screen[data-pane="${pane}"] > .content` },
  ...contentExtra,
]

const sourceTargets = (
  contentSelector: string,
  extras: GeometryTarget[] = [],
): GeometryTarget[] => [
  { name: 'page-root', selector: '.hc-app__view > :first-child' },
  { name: 'toolbar', selector: '.hc-toolbar' },
  { name: 'content', selector: contentSelector },
  ...extras,
]

const surfaces: Surface[] = [
  {
    id: 'chat-completed-thinking-markdown',
    route: '/chat',
    prototypePane: 'chat',
    referenceReady: '.screen[data-pane="chat"] .chat-thread .msg.bot',
    sourceReady: '.hc-chat__thread .hc-msg--assistant',
    referenceTargets: [
      { name: 'page-root', selector: '.screen[data-pane="chat"] .chat' },
      { name: 'session-sidebar', selector: '.screen[data-pane="chat"] .chat-sessions' },
      { name: 'toolbar', selector: '.screen[data-pane="chat"] .chat-top' },
      { name: 'thread', selector: '.screen[data-pane="chat"] .chat-thread' },
      {
        name: 'thinking',
        selector: '.screen[data-pane="chat"] [data-component="ThinkingProgress"]',
      },
      { name: 'assistant-message', selector: '.screen[data-pane="chat"] .msg.bot' },
      { name: 'composer', selector: '.screen[data-pane="chat"] .composer' },
    ],
    sourceTargets: [
      { name: 'page-root', selector: '.hc-chat' },
      { name: 'session-sidebar', selector: '.hc-chat__sidebar' },
      { name: 'toolbar', selector: '.hc-chat__toolbar' },
      { name: 'thread', selector: '.hc-chat__thread' },
      { name: 'thinking', selector: '[data-component="ThinkingProgress"]' },
      { name: 'assistant-message', selector: '.hc-msg--assistant' },
      { name: 'composer', selector: '.hc-chat__input-wrap' },
    ],
    anchors: [
      { label: 'new-session', variants: ['新建会话'] },
      { label: 'thinking-complete', variants: ['思考了'] },
      { label: 'math-answer', variants: ['10.78'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'The recent completed-thinking + Markdown/LaTeX message is fixed on both legs, but the prototype has a larger static session roster, source badges and source tags that are not supplied by the API fixture. Full-page pixels therefore cannot be called an equivalent-state oracle.',
    },
  },
  {
    id: 'agents-mine',
    route: '/agents',
    prototypePane: 'agents',
    referenceReady: '.screen[data-pane="agents"] .agent-cards',
    sourceReady: '.hc-agents__content .hc-cxcards',
    referenceTargets: refTargets('agents', [
      { name: 'default-card', selector: '.screen[data-pane="agents"] .cxcard.hero' },
      { name: 'agent-cards', selector: '.screen[data-pane="agents"] .agent-card', all: true },
    ]),
    sourceTargets: sourceTargets('.hc-agents__content', [
      { name: 'default-card', selector: '.hc-agents__content .hc-cxcard--hero' },
      { name: 'agent-cards', selector: '.hc-agents__content .hc-cxcard--dedicated', all: true },
    ]),
    anchors: [
      { label: 'mine-tab', variants: ['我的智能体'] },
      { label: 'default-assistant', variants: ['小蟹 · 默认助理'] },
      { label: 'daily-agent', variants: ['日报分析师'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Agent names and card semantics are fixed, but K12 card extensions and channel/task binding facts require additional domain endpoints. The roster is only partially equivalent.',
    },
  },
  {
    id: 'knowledge-documents',
    route: '/knowledge',
    prototypePane: 'knowledge',
    prototypeSwitch: { kind: 'segment', set: 'kn', index: 0 },
    referenceReady: '.screen[data-pane="knowledge"] [data-sub="kn0"].on',
    sourceReady: '.hc-page-shell__content [data-testid="knowledge-doc-card"]',
    referenceTargets: refTargets('knowledge', [
      { name: 'subview', selector: '[data-pane="knowledge"] [data-sub="kn0"]' },
      { name: 'document-rows', selector: '[data-pane="knowledge"] .resource-row', all: true },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'document-cards', selector: '[data-testid="knowledge-doc-card"]', all: true },
    ]),
    anchors: [
      { label: 'documents-tab', variants: ['文档'] },
      { label: 'large-pdf', variants: ['义务教育教科书·数学五年级下册.pdf'] },
      { label: 'notes-pdf', variants: ['课堂笔记.pdf'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'The same four document identities and processing categories are fixed, but prototype OCR/VLM failure copy carries frozen-provider evidence not expressible by the current list DTO.',
    },
  },
  {
    id: 'knowledge-memory',
    route: '/knowledge/memory',
    prototypePane: 'knowledge',
    prototypeSwitch: { kind: 'segment', set: 'kn', index: 1 },
    referenceReady: '.screen[data-pane="knowledge"] [data-sub="kn1"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('knowledge', [
      { name: 'subview', selector: '[data-pane="knowledge"] [data-sub="kn1"]' },
      {
        name: 'memory-cards',
        selector: '[data-pane="knowledge"] [data-sub="kn1"] .cxcard',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'memory-cards', selector: '.hc-memory-card', all: true },
      { name: 'memory-settings', selector: '.hc-memory-settings' },
    ]),
    anchors: [
      { label: 'memory-tab', variants: ['长期记忆', '记忆'] },
      { label: 'language-preference', variants: ['用户偏好使用简体中文'] },
      { label: 'math-preference', variants: ['数学讲解偏好低龄化'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Two memory entries and summary text are fixed, but archive/profile projections differ between the static prototype and the current memory endpoints.',
    },
  },
  {
    id: 'automation-tasks',
    route: '/automation',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 0 },
    referenceReady: '.screen[data-pane="automation"] [data-sub="au0"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('automation', [
      {
        name: 'task-cards',
        selector: '[data-pane="automation"] [data-sub="au0"] .task-card',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'task-cards', selector: '.hc-task-card', all: true },
    ]),
    anchors: [
      { label: 'tasks-tab', variants: ['定时任务'] },
      { label: 'daily-report', variants: ['每日飞书日报'] },
      { label: 'github-triage', variants: ['GitHub Issue 分拣'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Task identities and schedules are fixed, but current compiled JobSpec/run-history fields do not have a one-to-one static prototype fixture.',
    },
  },
  {
    id: 'automation-webhooks',
    route: '/automation/webhooks',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 1 },
    referenceReady: '.screen[data-pane="automation"] [data-sub="au1"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('automation', [
      {
        name: 'webhook-cards',
        selector: '[data-pane="automation"] [data-sub="au1"] .cxcard',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'webhook-cards', selector: '.hc-webhook-card', all: true },
    ]),
    anchors: [
      { label: 'webhook-tab', variants: ['Webhooks', 'Webhook'] },
      { label: 'github-webhook', variants: ['GitHub Push 触发器'] },
      { label: 'generic-webhook', variants: ['Generic JSON 触发器'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Generic webhook records are fixed, but the prototype also contains a K12 binding whose event contract is currently contradictory and is intentionally not fabricated here.',
    },
  },
  {
    id: 'automation-workflows',
    route: '/automation/workflows',
    prototypePane: 'automation',
    prototypeSwitch: { kind: 'segment', set: 'au', index: 2 },
    referenceReady: '.screen[data-pane="automation"] [data-sub="au2"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('automation', [
      { name: 'workflow-surface', selector: '[data-pane="automation"] [data-sub="au2"]' },
      {
        name: 'workflow-nodes',
        selector: '[data-pane="automation"] [data-sub="au2"] .wf-node',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'workflow-cards', selector: '.hc-workflow-card', all: true },
    ]),
    anchors: [{ label: 'workflows-tab', variants: ['工作流'] }],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'The prototype shows an open workflow editor while the route fixture opens the current workflow list. These are different addressable states and must not be treated as a full-page comparison.',
    },
  },
  {
    id: 'channels-accounts',
    route: '/channels',
    prototypePane: 'channels',
    prototypeSwitch: { kind: 'connection', index: 0 },
    referenceReady: '.screen[data-pane="channels"] .cxview[data-cx="0"].on',
    sourceReady: '.hc-conn-panel .hc-cxcard',
    referenceTargets: refTargets('channels', [
      { name: 'connection-view', selector: '[data-pane="channels"] .cxview[data-cx="0"]' },
      {
        name: 'channel-cards',
        selector: '[data-pane="channels"] .cxview[data-cx="0"] .cxcard',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-conn-panel', [
      { name: 'channel-cards', selector: '.hc-conn-panel .hc-cxcard', all: true },
    ]),
    anchors: [
      { label: 'accounts-tab', variants: ['通道与账号'] },
      { label: 'feishu', variants: ['飞书 · 日报机器人'] },
      { label: 'dingtalk', variants: ['钉钉 · 我的辅导机器人'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'The same two account identities are fixed, but private-conversation routing rows and agent bindings require separate fixtures. Card count alone is not whole-page equivalence.',
    },
  },
  {
    id: 'channels-connectors',
    route: '/channels',
    prototypePane: 'channels',
    prototypeSwitch: { kind: 'connection', index: 1 },
    referenceReady: '.screen[data-pane="channels"] > .content',
    sourceReady: '.hc-conn-panel',
    referenceTargets: refTargets('channels', [
      { name: 'connector-view', selector: '[data-pane="channels"] .cxview[data-cx="1"]' },
      { name: 'connector-cards', selector: '#connectorList .cxcard', all: true },
    ]),
    sourceTargets: sourceTargets('.hc-conn-panel', [
      { name: 'connector-cards', selector: '.hc-conn-card', all: true },
      { name: 'empty-state', selector: '.hc-empty-state' },
    ]),
    anchors: [{ label: 'connectors-tab', variants: ['数据连接器'] }],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Prototype connector instances are generated from its private in-page JavaScript store; the source uses a persisted composable store. No shared serialized fixture contract exists.',
    },
  },
  {
    id: 'integration-skills',
    route: '/integration',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 0 },
    referenceReady: '.screen[data-pane="integration"] [data-sub="in0"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('integration', [
      {
        name: 'installed-cards',
        selector: '[data-pane="integration"] [data-sub="in0"] .capability-installed-row',
        all: true,
      },
      {
        name: 'market-cards',
        selector: '[data-pane="integration"] [data-sub="in0"] .market-card',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'installed-cards', selector: '.hc-skill-card', all: true },
      { name: 'market-cards', selector: '.hc-market-card', all: true },
    ]),
    anchors: [
      { label: 'skills-tab', variants: ['Skills'] },
      { label: 'installed', variants: ['已安装'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Installed and marketplace entries are deterministic, but the static prototype and live ClawHub DTO use different sample catalogs.',
    },
  },
  {
    id: 'integration-mcp',
    route: '/integration/mcp',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 1 },
    referenceReady: '.screen[data-pane="integration"] [data-sub="in1"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('integration', [
      {
        name: 'server-rows',
        selector: '[data-pane="integration"] [data-sub="in1"] .mcp-row',
        all: true,
      },
      {
        name: 'market-cards',
        selector: '[data-pane="integration"] [data-sub="in1"] .market-card',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'server-cards', selector: '.hc-mcp-card', all: true },
      { name: 'market-cards', selector: '.hc-market-card', all: true },
    ]),
    anchors: [
      { label: 'mcp-tab', variants: ['MCP'] },
      { label: 'filesystem', variants: ['filesystem'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'The filesystem server is fixed, but prototype tool-test rows and marketplace catalog are not the same endpoint projection as the source fixture.',
    },
  },
  {
    id: 'integration-prompts',
    route: '/integration/prompts',
    prototypePane: 'integration',
    prototypeSwitch: { kind: 'segment', set: 'in', index: 2 },
    referenceReady: '.screen[data-pane="integration"] [data-sub="in2"].on',
    sourceReady: '.hc-page-shell__content',
    referenceTargets: refTargets('integration', [
      {
        name: 'prompt-cards',
        selector: '[data-pane="integration"] [data-sub="in2"] .prompt-card',
        all: true,
      },
    ]),
    sourceTargets: sourceTargets('.hc-page-shell__content', [
      { name: 'prompt-cards', selector: '.hc-prompt-card', all: true },
    ]),
    anchors: [
      { label: 'prompts-tab', variants: ['Prompt 库'] },
      { label: 'translation', variants: ['翻译润色'] },
      { label: 'minutes', variants: ['会议纪要'] },
    ],
    fixtureComparison: {
      status: 'COMPARABLE',
      reason:
        'The same three prompt identities, types and ordering are supplied on both legs; full-page pixel comparison is an applicable RED/PASS oracle.',
    },
  },
  {
    id: 'logs-live',
    route: '/logs',
    prototypePane: 'logs',
    referenceReady: '.screen[data-pane="logs"] .logrows .logrow',
    sourceReady: '.hc-logs__stream',
    referenceTargets: refTargets('logs', [
      { name: 'log-stream', selector: '[data-pane="logs"] .logrows' },
      { name: 'log-rows', selector: '[data-pane="logs"] .logrow', all: true },
      { name: 'statusbar', selector: '[data-pane="logs"] .logfoot' },
    ]),
    sourceTargets: sourceTargets('.hc-logs__stream', [
      { name: 'log-rows', selector: '.hc-logs__row', all: true },
      { name: 'statusbar', selector: '.hc-logs__statusbar' },
    ]),
    anchors: [
      { label: 'logs-search', variants: ['搜索日志'] },
      { label: 'engine-started', variants: ['engine started'] },
      { label: 'knowledge-warning', variants: ['embedding 未配置'] },
    ],
    fixtureComparison: {
      status: 'COMPARABLE',
      reason:
        'The same four log entries, levels, sources, messages and ordering are supplied on both legs; timestamps are frozen.',
    },
  },
  {
    id: 'settings-llm',
    route: '/settings',
    prototypePane: 'settings',
    referenceReady: '.screen[data-pane="settings"] .content',
    sourceReady: '.hc-settings__content .hc-settings__section',
    referenceTargets: refTargets('settings', [
      { name: 'settings-section', selector: '[data-pane="settings"] .content > div' },
      { name: 'provider-cards', selector: '[data-pane="settings"] .prov-card', all: true },
    ]),
    sourceTargets: sourceTargets('.hc-settings__content', [
      { name: 'settings-section', selector: '.hc-settings__section' },
      { name: 'provider-cards', selector: '.hc-provider', all: true },
    ]),
    anchors: [
      { label: 'default-behavior', variants: ['默认行为'] },
      { label: 'providers', variants: ['服务商'] },
      { label: 'openai', variants: ['OpenAI'] },
    ],
    fixtureComparison: {
      status: 'NOT_COMPARABLE',
      reason:
        'Provider identities and model catalogs are deterministic, but secret fields, catalog freshness and persisted capability probes are intentionally not forged.',
    },
  },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

const agents = [
  {
    name: 'daily-report',
    display_name: '日报分析师',
    description: 'cron 日报专用 · 简洁理性',
    provider: 'openai',
    model: 'gpt-4o',
    metadata: { avatar: '📊' },
  },
  {
    name: 'email-assistant',
    display_name: '邮件助理',
    description: '收发邮件 · 正式礼貌',
    provider: '',
    model: '',
    metadata: { avatar: '✉️' },
  },
  {
    name: 'k12-ming',
    display_name: '小明的辅导助手 · 五年级',
    description: '五年级上 · 数学教材与当前进度 · 按年级边界讲解',
    provider: '',
    model: '',
    metadata: {
      scenario: 'k12-tutor',
      avatar: '🎓',
      'k12.child_name': '小明',
      'k12.grade_term': '五年级上',
    },
  },
  {
    name: 'k12-hong',
    display_name: '小红的辅导助手 · 三年级',
    description: '三年级上 · 数学教材与当前进度 · 独立档案与学习记录',
    provider: '',
    model: '',
    metadata: {
      scenario: 'k12-tutor',
      avatar: '🎓',
      'k12.child_name': '小红',
      'k12.grade_term': '三年级上',
    },
  },
]

const knowledgeDocuments = [
  {
    id: 'kb-doc-math-grade5-002',
    title: '义务教育教科书·数学五年级下册.pdf',
    chunk_count: 120,
    created_at: NOW,
    status: 'failed',
    vector_index_state: 'failed',
    error_message: '7 页需要 OCR/VLM',
  },
  {
    id: 'kb-class-notes',
    title: '课堂笔记.pdf',
    chunk_count: 12,
    created_at: NOW,
    status: 'indexed',
    vector_index_state: 'ready',
  },
  {
    id: 'kb-product-faq',
    title: '产品 FAQ.md',
    chunk_count: 8,
    created_at: NOW,
    status: 'indexed',
    vector_index_state: 'ready',
  },
  {
    id: 'kb-whiteboard',
    title: '白板流程图.png',
    chunk_count: 1,
    created_at: NOW,
    status: 'processing',
    vector_index_state: 'building',
  },
]

const cronJobs = [
  {
    id: 'job-daily-report',
    name: '每日飞书日报',
    type: 'cron',
    schedule: '0 9 * * *',
    user_id: 'desktop-user',
    status: 'active',
    last_run_at: '2026-07-29T01:00:00.000Z',
    next_run_at: '2026-07-30T01:00:00.000Z',
    run_count: 18,
    created_at: NOW,
    source_prompt: '汇总昨日产品指标、异常告警和待办，发送到已绑定的飞书私聊。',
    deliver: ['fixture-feishu'],
    spec: {
      runtime: 'agent',
      script: '',
      deps: [],
      timeout_s: 300,
      compiled: {
        model: '',
        at: '0001-01-01T00:00:00Z',
        tokens_in: 0,
        tokens_out: 0,
        hash: '',
      },
    },
  },
  {
    id: 'job-github-triage',
    name: 'GitHub Issue 分拣',
    type: 'cron',
    schedule: '0 */2 * * *',
    user_id: 'desktop-user',
    status: 'active',
    last_run_at: '2026-07-29T04:00:00.000Z',
    next_run_at: '2026-07-29T06:00:00.000Z',
    run_count: 6,
    created_at: NOW,
    source_prompt: '每两小时读取新增 Issue，打标签并生成 Slack / 飞书摘要。',
    deliver: ['chat'],
    spec: {
      runtime: 'agent',
      script: '',
      deps: [],
      timeout_s: 300,
      compiled: {
        model: '',
        at: '0001-01-01T00:00:00Z',
        tokens_in: 0,
        tokens_out: 0,
        hash: '',
      },
    },
  },
]

const prompts = [
  {
    id: 'prompt-translate',
    type: 'command',
    title: '翻译润色',
    body_md: '把以下内容翻译为地道、通顺的中文：\\n\\n$ARGUMENTS',
    args_json: '[]',
    tool_scope: '',
    model: '',
    category: '写作',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'prompt-minutes',
    type: 'command',
    title: '会议纪要',
    body_md: '把下面的讨论整理成结构化会议纪要：\\n\\n$ARGUMENTS',
    args_json: '[]',
    tool_scope: '',
    model: '',
    category: '办公',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'prompt-review',
    type: 'prompt',
    title: '每日复盘',
    body_md: '用三段做每日复盘。',
    args_json: '[]',
    tool_scope: '',
    model: '',
    category: '知识库检索',
    enabled: true,
    updated_at: NOW,
  },
]

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
    default: 'openai/gpt-4o',
    defaultModel: 'gpt-4o',
    defaultProviderId: 'openai',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'sk-fixture-redacted',
        baseUrl: 'https://api.openai.com/v1',
        models: [
          { id: 'gpt-4.1', name: 'gpt-4.1', capabilities: ['text', 'tools'] },
          { id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text', 'vision'] },
          { id: 'o3', name: 'o3', capabilities: ['text', 'reasoning'] },
        ],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'deepseek',
        enabled: true,
        apiKey: 'sk-fixture-redacted',
        baseUrl: 'https://api.deepseek.com/v1',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', capabilities: ['text'] },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner (R1)',
            capabilities: ['text', 'reasoning'],
          },
        ],
      },
    ],
  },
}

function runtimeFixture(apiPath: string, method: string, requestURL: URL): unknown {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceConfig
  if (apiPath === '/api/v1/config/llm') return sourceConfig.llm
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, models: [] }
  }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents, total: agents.length, default: 'daily-report' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: CHAT_SESSION,
          title: '小数乘法讲解',
          created_at: NOW,
          updated_at: NOW,
          message_count: 2,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/messages` && method === 'GET') {
    return {
      messages: [
        {
          id: 'chat-user-math',
          role: 'user',
          content:
            '修路队修一条公路，第一天修了 $2\\\\frac{3}{4}$ 千米，第二天比第一天多修了 $1\\\\frac{1}{2}$ 千米。第二天修了多少千米？',
          timestamp: NOW,
          created_at: NOW,
        },
        {
          id: 'chat-assistant-math',
          role: 'assistant',
          content:
            '解题步骤：\\n\\n1. $3.6 - 0.8 = 2.8$\\n2. $1.8 + 2.05 = 3.85$\\n3. $2.8 \\\\times 3.85 = 10.78$\\n\\n✅ 最终积是 **10.78**',
          timestamp: NOW,
          created_at: NOW,
          metadata: {
            thinking_state: 'completed',
            thinking_duration: 100,
            reasoning_visibility: 'not_exposed',
          },
        },
      ],
      total: 2,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/branches`) {
    return { branches: [], total: 0 }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/artifacts`) {
    return { artifacts: [], total: 0 }
  }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/knowledge/documents') {
    return {
      documents: knowledgeDocuments,
      total: knowledgeDocuments.length,
      limit: 50,
      offset: 0,
      sources: [],
    }
  }
  if (apiPath === '/api/v1/knowledge/config') {
    return {
      rerank_enabled: false,
      rerank_model: '',
      query_expansion: false,
      contextual: false,
      min_score: 0.2,
      candidate_k: 50,
    }
  }
  if (apiPath === '/api/v1/knowledge/embedding-status') {
    return { enabled: true, configured: false, local: false, ready: false, pulling: false }
  }
  if (apiPath.includes('/embedding-policy')) {
    return { provider: '', model: '', status: 'not_configured' }
  }
  if (apiPath === '/api/v1/memory') {
    if (requestURL.searchParams.get('source') === 'reflect_profile') {
      return {
        entries: [],
        summary: '最近在检查知识库与 MCP 配置；数学讲解偏好低龄化，小数进位处易错。',
        capacity: { used: 2, max: 500, archived: 1 },
        total: 0,
        has_more: false,
      }
    }
    return {
      entries: [
        {
          id: 'memory-language',
          content: '除非用户明确要求英文，默认使用简体中文回复。',
          title: '用户偏好使用简体中文',
          type: 'preference',
          source: 'conversation',
          status: 'active',
          hit_count: 0,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: 'memory-math',
          content: '遇到小学数学题时优先给出分步解释和小数对齐提示。',
          title: '数学讲解偏好低龄化',
          type: 'fact',
          source: '课堂练习.pdf',
          status: 'active',
          hit_count: 3,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      summary: '最近在检查知识库与 MCP 配置；数学讲解偏好低龄化，小数进位处易错。',
      capacity: { used: 2, max: 500, archived: 1 },
      total: 2,
      has_more: false,
    }
  }
  if (apiPath === '/api/v1/config/memory') {
    return {
      enabled: true,
      auto_memory: 'inline',
      recall_min_score: 0.5,
      active_recall: true,
      profile: true,
      profile_interval_mins: 1440,
    }
  }
  if (apiPath === '/api/v1/cronjob' && method === 'POST') {
    return {
      action: 'list',
      jobs: cronJobs,
      total: cronJobs.length,
      quota: { used: cronJobs.length, limit: 100 },
    }
  }
  if (apiPath === '/api/v1/autonomy/summary') {
    return {
      profile: 'balanced',
      counts: { tasks: cronJobs.length, ready: cronJobs.length, pending: 0, grants: 0 },
      pending: [],
      tasks: [],
    }
  }
  if (apiPath === '/api/v1/webhooks') {
    return {
      webhooks: [
        {
          id: 'webhook-github',
          name: 'GitHub Push 触发器',
          type: 'github',
          has_secret: true,
          prompt: '分拣 GitHub Push',
          user_id: 'desktop-user',
          enabled: true,
          event_count: 12,
          last_event_at: NOW,
          created_at: NOW,
        },
        {
          id: 'webhook-generic',
          name: 'Generic JSON 触发器',
          type: 'generic',
          has_secret: true,
          prompt: '运行独立 Prompt',
          user_id: 'desktop-user',
          enabled: false,
          event_count: 0,
          created_at: NOW,
        },
      ],
      k12_bindings: [],
      total: 2,
    }
  }
  if (apiPath === '/api/v1/canvas/workflows') {
    return {
      workflows: [
        {
          id: 'workflow-daily-report',
          name: '每日飞书日报',
          description: '触发 → Agent → 飞书发送 → 输出',
          nodes: [
            { id: 'start', type: 'input', label: '定时触发', x: 0, y: 0 },
            { id: 'agent', type: 'agent', label: '日报分析师', x: 220, y: 0 },
            { id: 'tool', type: 'tool', label: '飞书 · 发送消息', x: 440, y: 0 },
            { id: 'output', type: 'output', label: '完成', x: 660, y: 0 },
          ],
          edges: [
            { id: 'e1', from: 'start', to: 'agent' },
            { id: 'e2', from: 'agent', to: 'tool' },
            { id: 'e3', from: 'tool', to: 'output' },
          ],
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    }
  }
  if (apiPath === '/api/v1/canvas/panels') return { panels: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') {
    return {
      instances: [
        {
          id: 'fixture-feishu',
          provider: 'feishu',
          type: 'feishu',
          name: '飞书 · 日报机器人',
          enabled: true,
          status: 'running',
          config: { app_id: 'cli_a1b2_fixture', app_secret: 'redacted' },
          created_at: NOW,
        },
        {
          id: 'fixture-dingtalk',
          provider: 'dingtalk',
          type: 'dingtalk',
          name: '钉钉 · 我的辅导机器人',
          enabled: true,
          status: 'running',
          config: {
            app_key: 'ding_kf8_fixture',
            app_secret: 'redacted',
            robot_code: 'fixture-robot',
          },
          created_at: NOW,
        },
      ],
    }
  }
  if (apiPath === '/api/v1/platforms/instances/health') {
    return {
      instances: [
        { name: '飞书 · 日报机器人', provider: 'feishu', status: 'running', enabled: true },
        { name: '钉钉 · 我的辅导机器人', provider: 'dingtalk', status: 'running', enabled: true },
      ],
    }
  }
  if (apiPath === '/api/v1/connectors') return { connectors: [] }
  if (apiPath === '/api/v1/skills') {
    return {
      dir: '/tmp/hexclaw-skills',
      skills: [
        {
          name: 'translate-polish',
          display_name: '翻译润色',
          description: '专业翻译和文本润色',
          version: '1.0.0',
          author: 'hexclaw',
          triggers: [],
          tags: ['writing'],
          enabled: true,
        },
        {
          name: 'web-fetch',
          display_name: '网页抓取',
          description: '读取网页并提取正文',
          version: '1.0.0',
          author: 'hexclaw',
          triggers: [],
          tags: ['research'],
          enabled: true,
        },
      ],
      total: 2,
    }
  }
  if (apiPath === '/api/v1/clawhub/search') {
    const type = requestURL.searchParams.get('type')
    if (type === 'mcp') {
      return {
        skills: [
          {
            name: 'github-mcp',
            display_name: 'GitHub MCP',
            description: '读取仓库、Issue 和 PR',
            author: 'modelcontextprotocol',
            version: '1.0.0',
            tags: ['coding'],
            category: 'coding',
            downloads: 2100,
          },
          {
            name: 'browser-mcp',
            display_name: 'Browser MCP',
            description: '网页自动化',
            author: 'modelcontextprotocol',
            version: '1.0.0',
            tags: ['browser'],
            category: 'automation',
            downloads: 1800,
          },
        ],
        total: 2,
      }
    }
    return {
      skills: [
        {
          name: 'sql-analyst',
          display_name: 'SQL 分析师',
          description: '根据自然语言生成查询、解释结果并发现异常。',
          author: 'hexclaw',
          version: '1.0.0',
          tags: ['data'],
          category: 'data',
          downloads: 2100,
          rating: 4.8,
        },
        {
          name: 'document-organizer',
          display_name: '文档整理',
          description: '把散乱材料整理成 Markdown 报告。',
          author: 'hexclaw',
          version: '1.0.0',
          tags: ['writing'],
          category: 'writing',
          downloads: 900,
          rating: 4.6,
        },
      ],
      total: 2,
    }
  }
  if (apiPath === '/api/v1/mcp/servers') return { servers: ['filesystem'], total: 1 }
  if (apiPath === '/api/v1/mcp/status') {
    return { statuses: { filesystem: 'connected' }, servers: [], total: 1 }
  }
  if (apiPath === '/api/v1/mcp/tools') {
    return {
      tools: [
        {
          name: 'filesystem.read_file',
          description: '读取允许目录内的文件内容',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: '绝对路径' } },
          },
        },
      ],
      total: 1,
    }
  }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts, total: prompts.length }
  }
  if (apiPath === '/api/v1/logs') return { logs, total: logs.length }
  if (apiPath === '/api/v1/logs/stats') {
    return {
      total: logs.length,
      by_level: { debug: 1, info: 2, warn: 1, error: 0 },
      by_source: { sidecar: 1, channels: 1, llm: 1, knowledge: 1 },
      requests_per_minute: 0,
    }
  }
  if (apiPath === '/api/k12/view-descriptor') {
    return {
      header_tabs: ['辅导', '学习档案', '学情'],
      message_badges: [],
      composer_placeholder: '',
      composer_chips: [],
      record_collections: [],
      side_panels: [],
      actions: [],
      i18n_keys: [],
      schema_version: 1,
    }
  }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page) {
  await page.addInitScript(
    ({ config, session }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('app_config', JSON.stringify(config))

      const callbacks = new Map<number, (payload: unknown) => unknown>()
      let nextCallbackID = 1
      const desktopWindow = window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
          transformCallback?: (callback?: (payload: unknown) => unknown, once?: boolean) => number
          unregisterCallback?: (id: number) => void
          runCallback?: (id: number, payload: unknown) => unknown
          callbacks?: Map<number, (payload: unknown) => unknown>
        }
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener?: (_event: string, id: number) => void
        }
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
        runCallback: (id, payload) => callbacks.get(id)?.(payload),
        invoke: async (command, args = {}) => {
          if (command === 'check_engine_health') return true
          if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
          if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null
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
        unregisterListener: (_event, id) => unregisterCallback(id),
      }
    },
    { config: sourceConfig, session: CHAT_SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'general-visual-matrix' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method(), requestURL))
  })
}

async function openReference(page: Page, surface: Surface) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ pane, paneSwitch }) => {
      const nav = document.querySelector<HTMLElement>(`.sb-item[data-screen="${pane}"]`)
      if (!nav) throw new Error(`prototype navigation pane is missing: ${pane}`)
      nav.click()
      if (!paneSwitch) return
      const api = window as typeof window & {
        seg?: (set: string, index: number) => void
        ctab?: (index: number) => void
      }
      if (paneSwitch.kind === 'segment') {
        if (!api.seg) throw new Error('prototype segment API is unavailable')
        api.seg(paneSwitch.set, paneSwitch.index)
      } else {
        if (!api.ctab) throw new Error('prototype connection API is unavailable')
        api.ctab(paneSwitch.index)
      }
    },
    { pane: surface.prototypePane, paneSwitch: surface.prototypeSwitch },
  )
  await expect(page.locator(`.screen[data-pane="${surface.prototypePane}"].on`)).toBeVisible()
  await expect(page.locator(surface.referenceReady).first()).toBeVisible()
}

async function openSource(page: Page, surface: Surface) {
  await page.goto(`${SOURCE_URL}${surface.route}`, { waitUntil: 'domcontentloaded' })
  await page
    .locator('#splash-screen')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined)
  if (surface.id === 'channels-connectors') {
    await page.getByTestId('segmented-connectors').click()
    await expect(page.getByTestId('segmented-connectors')).toHaveAttribute('aria-selected', 'true')
  }
  await expect(page.locator(surface.sourceReady).first()).toBeVisible()
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

async function geometrySnapshot(
  page: Page,
  targets: GeometryTarget[],
): Promise<GeometryEvidence[]> {
  return page.evaluate((definitions) => {
    const clean = (value: number) => Number(value.toFixed(2))
    const rectOf = (rect: DOMRect): Rect => ({
      x: clean(rect.x),
      y: clean(rect.y),
      width: clean(rect.width),
      height: clean(rect.height),
    })
    return definitions.flatMap((target) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(target.selector))
      if (nodes.length === 0) {
        return [
          {
            name: target.name,
            selector: target.selector,
            index: 0,
            found: false,
          },
        ]
      }
      return (target.all ? nodes : nodes.slice(0, 1)).map((node, index) => {
        const style = getComputedStyle(node)
        return {
          name: target.name,
          selector: target.selector,
          index,
          found: true,
          rect: rectOf(node.getBoundingClientRect()),
          text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          style: {
            display: style.display,
            position: style.position,
            overflow: style.overflow,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            color: style.color,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            border: style.border,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            padding: style.padding,
            margin: style.margin,
            gap: style.gap,
            gridTemplateColumns: style.gridTemplateColumns,
          },
        }
      })
    })
  }, targets)
}

async function visibleText(page: Page) {
  return page.locator('body').evaluate((body) => (body.innerText || '').replace(/\s+/g, ' ').trim())
}

function anchorEvidence(text: string, anchors: Anchor[]) {
  return anchors.map((anchor) => ({
    label: anchor.label,
    variants: anchor.variants,
    matched: anchor.variants.find((variant) => text.includes(variant)) ?? null,
  }))
}

async function attach(testInfo: TestInfo, name: string, filePath: string, contentType: string) {
  await testInfo.attach(name, {
    body: await readFile(filePath),
    contentType,
  })
}

async function runCanvasPixelDiff(
  page: Page,
  reference: string,
  source: string,
  output: string,
): Promise<PixelDiff> {
  const [referenceBytes, sourceBytes] = await Promise.all([readFile(reference), readFile(source)])
  const result = await page.evaluate(
    async ({ referenceData, sourceData, threshold }) => {
      const load = (data: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('pixel diff image decode failed'))
          image.src = `data:image/png;base64,${data}`
        })
      const [referenceImage, sourceImage] = await Promise.all([
        load(referenceData),
        load(sourceData),
      ])
      if (
        referenceImage.naturalWidth !== sourceImage.naturalWidth ||
        referenceImage.naturalHeight !== sourceImage.naturalHeight
      ) {
        throw new Error(
          `screenshot size mismatch: reference=${referenceImage.naturalWidth}x${referenceImage.naturalHeight}, implementation=${sourceImage.naturalWidth}x${sourceImage.naturalHeight}`,
        )
      }
      const canvas = document.createElement('canvas')
      canvas.width = referenceImage.naturalWidth
      canvas.height = referenceImage.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(referenceImage, 0, 0)
      const referencePixels = context.getImageData(0, 0, canvas.width, canvas.height)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(sourceImage, 0, 0)
      const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const visible = context.createImageData(canvas.width, canvas.height)
      let changedPixels = 0
      let minX = canvas.width
      let minY = canvas.height
      let maxX = -1
      let maxY = -1
      for (let offset = 0; offset < referencePixels.data.length; offset += 4) {
        const changed =
          Math.abs(referencePixels.data[offset]! - sourcePixels.data[offset]!) > threshold ||
          Math.abs(referencePixels.data[offset + 1]! - sourcePixels.data[offset + 1]!) >
            threshold ||
          Math.abs(referencePixels.data[offset + 2]! - sourcePixels.data[offset + 2]!) > threshold
        const pixel = offset / 4
        const x = pixel % canvas.width
        const y = Math.floor(pixel / canvas.width)
        if (changed) {
          changedPixels++
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visible.data.set([255, 35, 35, 255], offset)
        } else {
          const gray = Math.round(
            (referencePixels.data[offset]! * 0.299 +
              referencePixels.data[offset + 1]! * 0.587 +
              referencePixels.data[offset + 2]! * 0.114) *
              0.45,
          )
          visible.data.set([gray, gray, gray, 255], offset)
        }
      }
      context.putImageData(visible, 0, 0)
      return {
        width: canvas.width,
        height: canvas.height,
        threshold,
        changed_pixels: changedPixels,
        total_pixels: canvas.width * canvas.height,
        changed_pixel_ratio: changedPixels / (canvas.width * canvas.height),
        changed_bbox: changedPixels > 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
        diffBase64: canvas.toDataURL('image/png').split(',')[1]!,
      }
    },
    {
      referenceData: referenceBytes.toString('base64'),
      sourceData: sourceBytes.toString('base64'),
      threshold: PIXEL_THRESHOLD,
    },
  )
  await writeFile(output, Buffer.from(result.diffBase64, 'base64'))
  return {
    width: result.width,
    height: result.height,
    threshold: result.threshold,
    changed_pixels: result.changed_pixels,
    total_pixels: result.total_pixels,
    changed_pixel_ratio: result.changed_pixel_ratio,
    changed_bbox: result.changed_bbox,
  }
}

async function runPixelDiff(reference: string, source: string, output: string, page: Page) {
  try {
    const { stdout } = await execFileAsync('python3', [
      PIXEL_DIFF_TOOL,
      reference,
      source,
      output,
      String(PIXEL_THRESHOLD),
    ])
    return JSON.parse(stdout) as PixelDiff
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("No module named 'PIL'")) throw error
    return runCanvasPixelDiff(page, reference, source, output)
  }
}

async function captureSurface(
  referencePage: Page,
  sourcePage: Page,
  surface: Surface,
  testInfo: TestInfo,
): Promise<SurfaceResult> {
  await openReference(referencePage, surface)
  await openSource(sourcePage, surface)
  await Promise.all([freezeVisualState(referencePage), freezeVisualState(sourcePage)])

  const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.id)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const sourcePath = path.join(outputDir, 'current-source.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry-and-style.json')
  const reportPath = path.join(outputDir, 'comparison-report.json')

  await Promise.all([
    referencePage.screenshot({
      path: referencePath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
    sourcePage.screenshot({
      path: sourcePath,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    }),
  ])

  const diff = await runPixelDiff(referencePath, sourcePath, diffPath, referencePage)
  const [referenceGeometry, sourceGeometry, referenceText, sourceText] = await Promise.all([
    geometrySnapshot(referencePage, surface.referenceTargets),
    geometrySnapshot(sourcePage, surface.sourceTargets),
    visibleText(referencePage),
    visibleText(sourcePage),
  ])
  const referenceAnchors = anchorEvidence(referenceText, surface.anchors)
  const sourceAnchors = anchorEvidence(sourceText, surface.anchors)
  const missingAnchors = surface.anchors.flatMap((anchor, index) => {
    const missing: string[] = []
    if (!referenceAnchors[index]?.matched) missing.push(`reference:${anchor.label}`)
    if (!sourceAnchors[index]?.matched) missing.push(`current-source:${anchor.label}`)
    return missing
  })
  const stateStatus: ComparisonStatus =
    surface.fixtureComparison.status === 'COMPARABLE' && missingAnchors.length === 0
      ? 'COMPARABLE'
      : 'NOT_COMPARABLE'
  const pixelStatus = diff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED'
  const overallStatus: OverallStatus =
    stateStatus === 'NOT_COMPARABLE' ? 'NOT_COMPARABLE/RED' : pixelStatus === 'RED' ? 'RED' : 'PASS'

  await writeFile(
    geometryPath,
    `${JSON.stringify(
      {
        surface: surface.id,
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        colorScheme: 'light',
        reference: referenceGeometry,
        currentSource: sourceGeometry,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        surface: surface.id,
        route: surface.route,
        urls: {
          reference: referencePage.url(),
          currentSource: sourcePage.url(),
        },
        screenshots: {
          reference: referencePath,
          currentSource: sourcePath,
          pixelDiff: diffPath,
        },
        comparisonContract: {
          fullPageBackgroundOnlyPassForbidden: true,
          configuredFixtureStatus: surface.fixtureComparison.status,
          configuredFixtureReason: surface.fixtureComparison.reason,
          effectiveStateStatus: stateStatus,
          missingAnchors,
          rule: 'PASS requires an equivalent semantic state, all required anchors on both legs, and changed_pixel_ratio <= 0.001. A shared-shell/background match never upgrades a whole-page result.',
        },
        anchors: {
          reference: referenceAnchors,
          currentSource: sourceAnchors,
        },
        pixels: {
          ...diff,
          maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
          status: pixelStatus,
        },
        overallStatus,
        geometryEvidence: geometryPath,
      },
      null,
      2,
    )}\n`,
  )

  await Promise.all([
    attach(testInfo, `${surface.id}-reference`, referencePath, 'image/png'),
    attach(testInfo, `${surface.id}-current-source`, sourcePath, 'image/png'),
    attach(testInfo, `${surface.id}-pixel-diff`, diffPath, 'image/png'),
    attach(testInfo, `${surface.id}-geometry-style`, geometryPath, 'application/json'),
    attach(testInfo, `${surface.id}-comparison-report`, reportPath, 'application/json'),
  ])

  return {
    id: surface.id,
    route: surface.route,
    stateStatus,
    pixelStatus,
    overallStatus,
    changedPixelRatio: diff.changed_pixel_ratio,
    evidence: reportPath,
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

test.describe('non-K12 general routes — whole-page prototype/current-source matrix', () => {
  test('14 route/subpage states emit reference/current-source/diff and remain RED when not equivalent', async ({
    browser,
  }, testInfo) => {
    const results: SurfaceResult[] = []

    for (const surface of surfaces) {
      const referencePage = await browser.newPage()
      const sourcePage = await browser.newPage()
      await installSourceFixture(sourcePage)
      try {
        results.push(await captureSurface(referencePage, sourcePage, surface, testInfo))
      } catch (error) {
        const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.id)
        await mkdir(outputDir, { recursive: true })
        const errorPath = path.join(outputDir, 'capture-error.json')
        await writeFile(
          errorPath,
          `${JSON.stringify(
            {
              surface: surface.id,
              route: surface.route,
              status: 'NOT_COMPARABLE/RED',
              error: error instanceof Error ? error.stack || error.message : String(error),
            },
            null,
            2,
          )}\n`,
        )
        await attach(testInfo, `${surface.id}-capture-error`, errorPath, 'application/json')
        results.push({
          id: surface.id,
          route: surface.route,
          stateStatus: 'NOT_COMPARABLE',
          pixelStatus: 'RED',
          overallStatus: 'NOT_COMPARABLE/RED',
          changedPixelRatio: 1,
          evidence: errorPath,
        })
      } finally {
        await Promise.all([referencePage.close(), sourcePage.close()])
      }
    }

    const summaryPath = path.join(EVIDENCE_ROOT, testInfo.project.name, 'matrix-summary.json')
    await mkdir(path.dirname(summaryPath), { recursive: true })
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          referenceURL: REFERENCE_URL,
          sourceURL: SOURCE_URL,
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
          colorScheme: 'light',
          surfaceCount: surfaces.length,
          statusCounts: results.reduce<Record<string, number>>((counts, result) => {
            counts[result.overallStatus] = (counts[result.overallStatus] ?? 0) + 1
            return counts
          }, {}),
          results,
        },
        null,
        2,
      )}\n`,
    )
    await attach(testInfo, 'general-visual-matrix-summary', summaryPath, 'application/json')

    expect
      .soft(results, 'the manifest must cover exactly 14 non-K12 route/subpage states')
      .toHaveLength(14)
    expect
      .soft(
        results.filter((result) => result.overallStatus === 'PASS'),
        `whole-page fidelity RED; evidence=${summaryPath}`,
      )
      .toHaveLength(14)
  })
})
