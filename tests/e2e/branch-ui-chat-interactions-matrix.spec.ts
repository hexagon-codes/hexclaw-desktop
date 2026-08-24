import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL =
  process.env.HEX_UI_SOURCE_URL?.trim() ||
  process.env.HEX_UI_IMPLEMENTATION_URL?.trim() ||
  'http://127.0.0.1:16061'
const RUN_ROOT = '/tmp/hexclaw-chat-interactions-playwright'
const EVIDENCE_ROOT = path.join(RUN_ROOT, 'evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const NOW = '2026-07-29T06:10:00.000Z'
const CHAT_SESSION = 'chat-interactions-matrix'

type Mapping = 'COMPARABLE' | 'NOT_COMPARABLE' | 'BLOCKED'
type PixelStatus = 'PASS' | 'RED'
type ResultStatus = 'PASS' | 'RED' | 'NOT_COMPARABLE/RED' | 'BLOCKED/RED'
type ReferenceAction =
  | 'workspace-artifacts'
  | 'thinking-live'
  | 'thinking-failed'
  | 'thinking-cancelled'
  | 'approval-pending'
  | 'approval-responded'
  | 'session-search'
  | 'export-menu'
  | 'image-preview'
  | 'template-skills'
  | 'template-prompts'
type SourceAction = ReferenceAction

type RegenerateOutcome = 'completed' | 'cancelled' | 'failed'

interface RegenerateCallEvidence {
  outcome: RegenerateOutcome
  text: string
  attachmentCount: number
  attachmentIds: string[]
}

interface GeometryTarget {
  name: string
  selector: string
  all?: boolean
}

interface MatrixState {
  id: string
  referenceAction: ReferenceAction
  sourceAction: SourceAction
  referenceReady: string
  sourceReady: string
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
  declaredMapping: Mapping
  effectiveMapping: Mapping
  mappingReason: string
  status: ResultStatus
  pixelStatus: PixelStatus
  changedPixelRatio: number
  referenceOpen: OpenEvidence
  sourceOpen: OpenEvidence
  evidenceDir: string
}

const referenceChatTargets = (extras: GeometryTarget[]): GeometryTarget[] => [
  { name: 'chat-root', selector: '.screen[data-pane="chat"] .chat' },
  { name: 'sessions', selector: '.screen[data-pane="chat"] .chat-sessions' },
  { name: 'toolbar', selector: '.screen[data-pane="chat"] .chat-top' },
  { name: 'thread', selector: '.screen[data-pane="chat"] .chat-thread' },
  ...extras,
]

const sourceChatTargets = (extras: GeometryTarget[]): GeometryTarget[] => [
  { name: 'chat-root', selector: '.hc-chat' },
  { name: 'sessions', selector: '.hc-chat__sidebar' },
  { name: 'toolbar', selector: '.hc-chat__toolbar' },
  { name: 'thread', selector: '.hc-chat__thread' },
  ...extras,
]

const states: MatrixState[] = [
  {
    id: 'chat.workspace-mode',
    referenceAction: 'workspace-artifacts',
    sourceAction: 'workspace-artifacts',
    referenceReady: '#artifactsPanel.on',
    sourceReady: '.hc-chat[data-workspace-mode="artifacts"] .hc-artifacts',
    referenceTargets: referenceChatTargets([
      { name: 'artifacts-panel', selector: '#artifactsPanel.on' },
      { name: 'artifact-items', selector: '#artifactsPanel .artifact-item', all: true },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'artifacts-panel', selector: '.hc-artifacts' },
      { name: 'artifact-items', selector: '.hc-artifacts__item', all: true },
    ]),
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'Fixture mismatch: the prototype owns named persisted artifacts (solve_math.py and math-steps.html), while the source public session boundary only reconstructs generic “python/html snippet” artifacts from message code blocks. Both real states are captured, but they are not an equivalent-fixture pixel oracle.',
  },
  {
    id: 'chat.thinking-live',
    referenceAction: 'thinking-live',
    sourceAction: 'thinking-live',
    referenceReady:
      '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="running"]',
    sourceReady: '.hc-thinking[data-thinking-state="running"]',
    referenceTargets: referenceChatTargets([
      {
        name: 'thinking-running',
        selector:
          '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="running"]',
      },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'thinking-running', selector: '.hc-thinking[data-thinking-state="running"]' },
    ]),
    mapping: 'BLOCKED',
    mappingReason:
      'The authoritative prototype has CSS for running thinking but no reachable approved running instance or public state setter. Its only addressable ThinkingProgress fixtures are completed.',
  },
  {
    id: 'chat.thinking-failed',
    referenceAction: 'thinking-failed',
    sourceAction: 'thinking-failed',
    referenceReady:
      '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="failed"]',
    sourceReady: '.hc-thinking[data-thinking-state="failed"]',
    referenceTargets: referenceChatTargets([
      {
        name: 'thinking-failed',
        selector:
          '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="failed"]',
      },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'thinking-failed', selector: '.hc-thinking[data-thinking-state="failed"]' },
    ]),
    mapping: 'BLOCKED',
    mappingReason:
      'No approved failed-thinking instance or state transition is reachable in the authoritative prototype. A completed fixture must not be substituted.',
  },
  {
    id: 'chat.thinking-cancelled',
    referenceAction: 'thinking-cancelled',
    sourceAction: 'thinking-cancelled',
    referenceReady:
      '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="cancelled"]',
    sourceReady: '.hc-thinking[data-thinking-state="cancelled"]',
    referenceTargets: referenceChatTargets([
      {
        name: 'thinking-cancelled',
        selector:
          '.screen[data-pane="chat"] [data-component="ThinkingProgress"][data-thinking-state="cancelled"]',
      },
    ]),
    sourceTargets: sourceChatTargets([
      {
        name: 'thinking-cancelled',
        selector: '.hc-thinking[data-thinking-state="cancelled"]',
      },
    ]),
    mapping: 'BLOCKED',
    mappingReason:
      'No approved cancelled-thinking instance or state transition is reachable in the authoritative prototype. A completed fixture must not be substituted.',
  },
  {
    id: 'chat.tool-approval-pending',
    referenceAction: 'approval-pending',
    sourceAction: 'approval-pending',
    referenceReady: '.approval-card[data-approval-state="pending"]',
    sourceReady: '.hc-approval:not(.hc-approval--responded)',
    referenceTargets: referenceChatTargets([
      { name: 'approval-card', selector: '.approval-card[data-approval-state="pending"]' },
      { name: 'approval-actions', selector: '.approval-card .approval-actions' },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'approval-card', selector: '.hc-approval:not(.hc-approval--responded)' },
      { name: 'approval-actions', selector: '.hc-approval__actions' },
    ]),
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'The approval payload and 27-second countdown intent match, but the authoritative prototype carries a larger persisted conversation/session fixture while the source leg uses the minimal public-boundary session fixture. The full-page captures are therefore useful drift evidence, not an equivalent-fixture pixel oracle.',
  },
  {
    id: 'chat.tool-approval-responded',
    referenceAction: 'approval-responded',
    sourceAction: 'approval-responded',
    referenceReady: '.approval-card[data-approval-state="awaiting_ack"]',
    sourceReady: '.hc-approval.hc-approval--responded',
    referenceTargets: referenceChatTargets([
      {
        name: 'approval-awaiting-ack',
        selector: '.approval-card[data-approval-state="awaiting_ack"]',
      },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'approval-responded', selector: '.hc-approval.hc-approval--responded' },
    ]),
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'State-contract mismatch: the prototype keeps a disabled card in awaiting_ack until a correlated backend acknowledgement; the source card immediately projects local responded before transport acknowledgement.',
  },
  {
    id: 'chat.session-search',
    referenceAction: 'session-search',
    sourceAction: 'session-search',
    referenceReady: '#prototypeSessionSearch',
    sourceReady: '.hc-sessions__search [data-search-control]',
    referenceTargets: referenceChatTargets([
      { name: 'search', selector: '#prototypeSessionSearch' },
      {
        name: 'visible-results',
        selector: '#prototypeSessionList .cs-item:not([hidden])',
        all: true,
      },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'search', selector: '.hc-sessions__search [data-search-control]' },
      { name: 'visible-results', selector: '.hc-sessions__item', all: true },
    ]),
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'Both legs search for “小数乘法” and project the same “小数乘法讲解” result, but the prototype and source conversation/session fixtures outside that result differ. A full-page pixel comparison must remain NOT_COMPARABLE until the surrounding fixture is frozen identically or the approved oracle is explicitly scoped to the sidebar.',
  },
  {
    id: 'chat.export-menu',
    referenceAction: 'export-menu',
    sourceAction: 'export-menu',
    referenceReady: 'body > .menu[role="menu"]',
    sourceReady: '.hc-export-menu',
    referenceTargets: referenceChatTargets([
      { name: 'export-menu', selector: 'body > .menu[role="menu"]' },
      { name: 'export-items', selector: 'body > .menu[role="menu"] button', all: true },
    ]),
    sourceTargets: sourceChatTargets([
      { name: 'export-menu', selector: '.hc-export-menu' },
      { name: 'export-items', selector: '.hc-export-menu__item', all: true },
    ]),
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'State-contract mismatch: the prototype menu includes three “即将上线” scope/PDF/share entries, while the source approved menu contains only executable Markdown and JSON exports.',
  },
  {
    id: 'chat.image-preview',
    referenceAction: 'image-preview',
    sourceAction: 'image-preview',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.hc-img-preview__backdrop',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay.on' },
      { name: 'preview-dialog', selector: '#overlayCard .modal' },
      { name: 'preview-placeholder', selector: '#overlayCard .preview-img' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: '.hc-img-preview__backdrop' },
      { name: 'preview-image', selector: '.hc-img-preview__img' },
      { name: 'close', selector: '.hc-img-preview__close' },
    ],
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'Fixture mismatch: the prototype owns a generated-artifact metadata dialog for math-steps.png, while the source public message boundary previews an injected image itself and has no equivalent persisted artifact-title/metadata fixture.',
  },
  {
    id: 'chat.template-popup-skills',
    referenceAction: 'template-skills',
    sourceAction: 'template-skills',
    referenceReady: '#overlay.on #overlayCard .prompt-list',
    sourceReady: '.tpl-popup',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay.on' },
      { name: 'dialog', selector: '#overlayCard .modal' },
      { name: 'items', selector: '#overlayCard .prompt-item', all: true },
    ],
    sourceTargets: [
      { name: 'popup', selector: '.tpl-popup' },
      { name: 'items', selector: '.tpl-popup__item', all: true },
      { name: 'actions', selector: '.tpl-popup__skill-actions' },
    ],
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'State-contract mismatch despite matching item names: the prototype opens a centered modal with overlay, title, close control, and search field; the source opens an inline composer popup with creation/upload actions. Matching three Skill labels does not make these different interaction surfaces pixel-comparable.',
  },
  {
    id: 'chat.template-popup-prompts',
    referenceAction: 'template-prompts',
    sourceAction: 'template-prompts',
    referenceReady: '#overlay.on #overlayCard .prompt-list',
    sourceReady: '.tpl-popup',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay.on' },
      { name: 'dialog', selector: '#overlayCard .modal' },
      { name: 'items', selector: '#overlayCard .prompt-item', all: true },
    ],
    sourceTargets: [
      { name: 'popup', selector: '.tpl-popup' },
      { name: 'items', selector: '.tpl-popup__item', all: true },
    ],
    mapping: 'NOT_COMPARABLE',
    mappingReason:
      'State-contract mismatch despite matching item names: the prototype opens a centered modal with overlay, title, close control, and search field; the source opens an inline composer popup. Matching three Prompt labels does not make these different interaction surfaces pixel-comparable.',
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
            capabilities: ['text', 'vision', 'tools', 'reasoning'],
          },
        ],
      },
    ],
  },
}

const fixtureSkills = [
  {
    name: 'translate-polish',
    display_name: '翻译润色',
    description: '/translate · 中英互译与润色',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['writing'],
    enabled: true,
  },
  {
    name: 'web-fetch',
    display_name: '网页抓取',
    description: '读取 URL 并提取正文',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['research'],
    enabled: true,
  },
  {
    name: 'sql-analyst',
    display_name: 'SQL 分析师',
    description: '连接数据源并解释结果',
    version: '1.0.0',
    author: 'hexclaw',
    triggers: [],
    tags: ['data'],
    enabled: true,
  },
]

const fixturePrompts = [
  {
    id: 'pr-translate',
    type: 'command',
    title: '翻译润色',
    body_md: '命令 · /translate',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '命令',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'pr-minutes',
    type: 'command',
    title: '会议纪要',
    body_md: '命令 · /minutes',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '命令',
    enabled: true,
    updated_at: NOW,
  },
  {
    id: 'pr-review',
    type: 'prompt',
    title: '每日复盘',
    body_md: '片段 · 插入到输入框',
    args_json: '{}',
    tool_scope: '',
    model: '',
    category: '片段',
    enabled: true,
    updated_at: NOW,
  },
]

const previewImage =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#eef6ff"/><text x="512" y="350" text-anchor="middle" font-family="sans-serif" font-size="54" fill="#315b7d">数学讲解步骤图</text><text x="512" y="430" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#1677ff">2.8 × 3.85 = 10.78</text></svg>',
  ).toString('base64')

function sourceMessagesFor(action: SourceAction) {
  if (
    action === 'thinking-live' ||
    action === 'thinking-failed' ||
    action === 'thinking-cancelled'
  ) {
    const thinkingState =
      action === 'thinking-live' ? 'running' : action === 'thinking-failed' ? 'failed' : 'cancelled'
    return [
      {
        id: `user-${thinkingState}`,
        role: 'user',
        content: '请先分析，再解释这道小数乘法题。',
        timestamp: NOW,
        created_at: NOW,
      },
      {
        id: `assistant-${thinkingState}`,
        role: 'assistant',
        content: thinkingState === 'running' ? '正在整理计算步骤…' : '本轮未生成最终答案。',
        reasoning: '先把两个括号分别计算，再进行小数乘法。',
        timestamp: NOW,
        created_at: NOW,
        metadata: {
          thinking_state: thinkingState,
          thinking_duration: 12,
          reasoning_visibility: 'visible',
          reasoning_disclosure: {
            visibility: 'visible',
            source: 'fixture',
            dialect: 'summary',
            provider: 'openai',
            model: 'gpt-5.6-sol',
          },
          runtime_events: [],
        },
      },
    ]
  }

  if (action === 'workspace-artifacts') {
    return [
      {
        id: 'user-artifacts',
        role: 'user',
        content: '把计算过程做成 Python 和 HTML 产物。',
        timestamp: NOW,
        created_at: NOW,
      },
      {
        id: 'assistant-artifacts',
        role: 'assistant',
        content:
          '已生成两个产物。\\n\\n```python\\ndef solve():\\n    left = 3.6 - 0.8\\n    right = 1.8 + 2.05\\n    return round(left * right, 2)\\n\\nprint(solve())  # 10.78\\n```\\n\\n```html\\n<strong>2.8 × 3.85 = 10.78</strong>\\n```',
        timestamp: NOW,
        created_at: NOW,
      },
    ]
  }

  if (action === 'image-preview') {
    return [
      {
        id: 'user-image',
        role: 'user',
        content: '请放大查看这张数学讲解步骤图。',
        timestamp: NOW,
        created_at: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'math-steps.png',
              mime: 'image/svg+xml',
              data: previewImage,
            },
          ],
        },
      },
      {
        id: 'assistant-image',
        role: 'assistant',
        content: '图片中的最终结果是 10.78。',
        timestamp: NOW,
        created_at: NOW,
      },
    ]
  }

  return [
    {
      id: 'user-math',
      role: 'user',
      content: '请解释 2.8 × 3.85。',
      timestamp: NOW,
      created_at: NOW,
    },
    {
      id: 'assistant-math',
      role: 'assistant',
      content: '把小数按整数相乘，再补回三位小数，最终结果是 **10.78**。',
      timestamp: NOW,
      created_at: NOW,
      metadata: {
        provider: 'openai',
        model: 'gpt-5.6-sol',
      },
    },
  ]
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(
  apiPath: string,
  method: string,
  requestURL: URL,
  action: SourceAction,
): unknown {
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
    return { agents: [], total: 0, default: '' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/sessions' && method === 'GET') {
    return {
      sessions: [
        {
          id: CHAT_SESSION,
          title: '小数乘法讲解',
          user_id: 'desktop-user',
          created_at: NOW,
          updated_at: NOW,
          message_count: 2,
        },
      ],
      total: 1,
    }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/messages` && method === 'GET') {
    const messages = sourceMessagesFor(action)
    return { messages, total: messages.length }
  }
  if (apiPath === `/api/v1/sessions/${CHAT_SESSION}/branches`) {
    return { branches: [], total: 0 }
  }
  if (apiPath === '/api/v1/messages/search') {
    const query = requestURL.searchParams.get('q') ?? ''
    return {
      results: [
        {
          message: {
            id: 'search-message',
            session_id: CHAT_SESSION,
            role: 'assistant',
            content: '小数乘法讲解：最终结果是 10.78。',
            timestamp: NOW,
            created_at: NOW,
          },
          session_title: '小数乘法讲解',
          rank: 1,
        },
      ],
      total: 1,
      query,
    }
  }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/skills') {
    return {
      dir: '/tmp/hexclaw-chat-interactions-skills',
      skills: fixtureSkills,
      total: fixtureSkills.length,
    }
  }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: fixturePrompts, total: fixturePrompts.length }
  }
  if (apiPath === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/images/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/videos/status') return { available: false, models: [] }
  if (apiPath === '/api/v1/voicechat/status') return { available: false, models: [] }
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page, action: SourceAction) {
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
    { config: sourceConfig, session: CHAT_SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'chat-interactions-matrix' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method(), requestURL, action))
  })
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
  })
  await page.waitForTimeout(180)
}

async function ensureNormalPrototypeChat(page: Page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
  await page.locator('.screen[data-pane="chat"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.evaluate(() => {
    const host = window as typeof window & {
      openNormalChat?: () => void
      applyChatWorkspaceMode?: (mode: string) => void
    }
    host.openNormalChat?.()
    host.applyChatWorkspaceMode?.('sessions')
  })
  await settle(page)
}

async function openReference(page: Page, state: MatrixState): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await ensureNormalPrototypeChat(page)
    switch (state.referenceAction) {
      case 'workspace-artifacts':
        await page.evaluate(() => {
          const host = window as typeof window & { toggleSidePanel?: (kind: string) => void }
          host.toggleSidePanel?.('artifacts')
        })
        break
      case 'approval-responded':
        await page
          .locator('.approval-card[data-approval-state="pending"] .btn-primary')
          .click({ timeout: 3_000 })
        break
      case 'session-search':
        await page.locator('#prototypeSessionSearch').fill('小数乘法')
        break
      case 'export-menu':
        await page.locator('.screen[data-pane="chat"] button[title="导出"]').click()
        break
      case 'image-preview':
        await page.evaluate(() => {
          const host = window as typeof window & { openImagePreview?: () => void }
          host.openImagePreview?.()
        })
        break
      case 'template-skills':
      case 'template-prompts':
        await page.evaluate(
          (scope) => {
            const host = window as typeof window & {
              openTemplatePopup?: (value: 'skills' | 'prompts') => void
            }
            host.openTemplatePopup?.(scope)
          },
          state.referenceAction === 'template-skills' ? 'skills' : 'prompts',
        )
        break
      case 'thinking-live':
      case 'thinking-failed':
      case 'thinking-cancelled':
      case 'approval-pending':
        break
    }
    const ready = page.locator(state.referenceReady).first()
    if ((await ready.count()) === 0) {
      throw new Error(`authoritative prototype target is not reachable: ${state.referenceReady}`)
    }
    await ready.waitFor({ state: 'visible', timeout: 3_000 })
    await ready.scrollIntoViewIfNeeded().catch(() => undefined)
    await settle(page)
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

async function injectApproval(page: Page) {
  await page.waitForTimeout(250)
  await page.evaluate(
    async ({ session, now }) => {
      const dynamicImport = new Function('path', 'return import(path)') as (
        modulePath: string,
      ) => Promise<{
        hexclawWS: { handleMessage: (data: string) => void }
      }>
      const module = await dynamicImport('/src/api/websocket.ts')
      module.hexclawWS.handleMessage(
        JSON.stringify({
          type: 'tool_approval_request',
          content: '敏感操作：写入本地文件 `~/Desktop/report.md`。需要用户允许后继续。',
          request_id: 'approval-filesystem-write-001',
          owner_id: 'chat-interactions-matrix',
          invocation_id: 'invoke-filesystem-write-001',
          session_id: session,
          tool_name: 'filesystem.write_file',
          arguments: { path: '~/Desktop/report.md', content: '# report' },
          arguments_digest: 'fixture-arguments-digest',
          security_scope_digest: 'fixture-security-scope',
          deadline_at: new Date(now + 27_000).toISOString(),
          metadata: { risk: 'sensitive' },
        }),
      )
    },
    { session: CHAT_SESSION, now: Date.now() },
  )
}

async function injectOwnedApproval(page: Page) {
  await injectApproval(page)
  await page.evaluate(async () => {
    const dynamicImport = new Function('path', 'return import(path)') as (
      modulePath: string,
    ) => Promise<{
      useChatStore: () => {
        respondApproval: (...args: unknown[]) => Promise<never>
      }
    }>
    const module = await dynamicImport('/src/stores/chat.ts')
    // The card arrived through the real WebSocket callback above. Supply only
    // the absent test-boundary owner transport and keep its acknowledgement
    // pending, so the component remains in its local responded projection.
    module.useChatStore().respondApproval = () => new Promise<never>(() => undefined)
  })
}

async function openSource(page: Page, state: MatrixState): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await installSourceFixture(page, state.sourceAction)
    await page.goto(`${SOURCE_URL}/chat`, {
      waitUntil: 'domcontentloaded',
      timeout: 12_000,
    })
    await page.locator('.hc-chat').waitFor({ state: 'visible', timeout: 8_000 })
    await page.locator('.hc-msg').first().waitFor({ state: 'visible', timeout: 8_000 })

    switch (state.sourceAction) {
      case 'workspace-artifacts':
        await page.locator('.hc-chat__toolbar button[title="产物"]').click()
        break
      case 'approval-pending':
        await injectApproval(page)
        break
      case 'approval-responded':
        await injectOwnedApproval(page)
        await page.locator('.hc-approval__btn--approve').click({ timeout: 3_000 })
        break
      case 'session-search':
        await page.locator('.hc-sessions__search [data-search-control]').fill('小数乘法')
        await page.locator('.hc-sessions__searching').waitFor({ state: 'hidden', timeout: 3_000 })
        break
      case 'export-menu':
        await page.locator('.hc-chat__toolbar button[title="下载"]').click()
        break
      case 'image-preview':
        await page.locator('.hc-msg__attachment-img').first().click()
        break
      case 'template-skills': {
        const trigger = page.locator('.hc-composer__tool[title*="调用 Skill"]')
        await expect(trigger).toBeEnabled()
        await trigger.click()
        break
      }
      case 'template-prompts':
        await page.locator('.hc-composer__tool[title*="调用 Prompt"]').click()
        break
      case 'thinking-live':
      case 'thinking-failed':
      case 'thinking-cancelled':
        break
    }

    const ready = page.locator(state.sourceReady).first()
    if ((await ready.count()) === 0) {
      throw new Error(`current-source target is not reachable: ${state.sourceReady}`)
    }
    await ready.waitFor({ state: 'visible', timeout: 3_000 })
    await ready.scrollIntoViewIfNeeded().catch(() => undefined)
    await settle(page)
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

async function openSourceFixture(page: Page, action: SourceAction = 'image-preview') {
  await installSourceFixture(page, action)
  await page.goto(`${SOURCE_URL}/chat`, {
    waitUntil: 'domcontentloaded',
    timeout: 12_000,
  })
  await page.locator('.hc-chat').waitFor({ state: 'visible', timeout: 8_000 })
  await page.locator('.hc-msg').first().waitFor({ state: 'visible', timeout: 8_000 })
}

async function replaceSourceMessages(page: Page, messages: unknown[]) {
  await page.evaluate(async (nextMessages) => {
    const dynamicImport = new Function('path', 'return import(path)') as (
      modulePath: string,
    ) => Promise<{ useChatStore: () => unknown }>
    const module = await dynamicImport('/src/stores/chat.ts')
    const store = module.useChatStore() as { messages: unknown[] }
    store.messages.splice(0, store.messages.length, ...nextMessages)
  }, messages)
}

async function installRegenerateStreamFixture(page: Page, outcomes: RegenerateOutcome[]) {
  await page.evaluate(async (fixtureOutcomes) => {
    type FixtureAttachment = {
      type: string
      name: string
      mime: string
      data: string
      attachmentId?: string
    }
    type FixtureMessage = {
      id: string
      role: 'user' | 'assistant'
      content: string
      timestamp: string
      metadata?: Record<string, unknown>
    }
    type FixtureStream = Record<string, unknown>
    type FixtureStore = {
      currentSessionId: string | null
      messages: FixtureMessage[]
      activeStreams: Record<string, FixtureStream>
      streaming: boolean
      streamingSessionId: string | null
      sending: boolean
      sendMessage: (
        text: string,
        attachments?: FixtureAttachment[],
      ) => Promise<FixtureMessage | null>
      stopStreaming: () => void
    }
    type FixtureState = {
      calls: RegenerateCallEvidence[]
      outcomes: RegenerateOutcome[]
      pendingCancel: (() => void) | null
    }

    const dynamicImport = new Function('path', 'return import(path)') as (
      modulePath: string,
    ) => Promise<{ useChatStore: () => unknown }>
    const module = await dynamicImport('/src/stores/chat.ts')
    const store = module.useChatStore() as FixtureStore
    const host = window as typeof window & { __HC_REGENERATE_FIXTURE__?: FixtureState }
    const fixture: FixtureState = {
      calls: [],
      outcomes: [...fixtureOutcomes],
      pendingCancel: null,
    }
    host.__HC_REGENERATE_FIXTURE__ = fixture

    store.stopStreaming = () => {
      const cancel = fixture.pendingCancel
      fixture.pendingCancel = null
      cancel?.()
    }

    store.sendMessage = async (text, attachments = []) => {
      const callIndex = fixture.calls.length
      const outcome = fixture.outcomes[callIndex] ?? 'failed'
      fixture.calls.push({
        outcome,
        text,
        attachmentCount: attachments.length,
        attachmentIds: attachments.map((attachment) => attachment.attachmentId ?? ''),
      })

      const sessionId = store.currentSessionId || 'chat-interactions-matrix'
      const requestId = `browser-regenerate-${callIndex + 1}`
      const assistantId = `${requestId}:assistant`
      store.messages.push({
        id: requestId,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        metadata: attachments.length > 0 ? { attachments } : undefined,
      })
      store.activeStreams = {
        ...store.activeStreams,
        [sessionId]: {
          sessionId,
          requestId,
          assistantMessageId: assistantId,
          assistantMessageAliases: [],
          lastSequence: 0,
          runtimeEvents: [],
          acceptedRuntimeFrames: {},
          thinkingEnabled: false,
          startedAt: Date.now(),
          state: 'running',
          visibility: 'not_exposed',
          rawContent: '',
          content: '',
          explicitReasoning: '',
          reasoning: '',
          reasoningStartTime: 0,
          reasoningEndTime: 0,
        },
      }
      store.streaming = true
      store.streamingSessionId = sessionId
      // 流已被接受，发送握手结束；此时输入区必须暴露可点击的停止动作。
      store.sending = false

      return await new Promise<FixtureMessage>((resolve) => {
        const finish = () => {
          const content =
            outcome === 'completed'
              ? `浏览器重试完成 #${callIndex + 1}`
              : outcome === 'cancelled'
                ? `浏览器重试已取消 #${callIndex + 1}`
                : `浏览器重试失败 #${callIndex + 1}`
          const assistant: FixtureMessage = {
            id: assistantId,
            role: 'assistant',
            content,
            timestamp: new Date().toISOString(),
            metadata: {
              provider: 'openai',
              model: 'gpt-5.6-sol',
              thinking_state: outcome,
            },
          }
          store.messages.push(assistant)
          const remainingStreams = { ...store.activeStreams }
          delete remainingStreams[sessionId]
          store.activeStreams = remainingStreams
          store.streaming = false
          store.streamingSessionId = null
          store.sending = false
          resolve(assistant)
        }

        if (outcome === 'cancelled') fixture.pendingCancel = finish
        else window.setTimeout(finish, 90)
      })
    }
  }, outcomes)
}

async function expectRegenerateActionBetweenCopyAndSpeak(page: Page) {
  const retry = page.getByTestId('chat-message-assistant').last().getByTestId('message-regenerate')
  await expect(retry).toBeVisible()
  const neighbors = await retry.evaluate((button) => ({
    previous: button.previousElementSibling?.getAttribute('aria-label') ?? '',
    next: button.nextElementSibling?.getAttribute('aria-label') ?? '',
  }))
  expect(neighbors).toEqual({ previous: '复制', next: '朗读' })
}

async function expectRegenerateTerminal(
  page: Page,
  expectedReply: string,
  expectedCallCount: number,
) {
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1)
  await expect(page.getByTestId('chat-message-assistant')).toContainText(expectedReply)
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1)
  await expect(
    page.getByTestId('chat-message-user').locator('.hc-msg__attachment-img'),
  ).toHaveCount(1)
  await expect(page.locator('.hc-composer__send--stop')).toHaveCount(0)
  await expect(page.getByTestId('chat-input')).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByTestId('chat-input')).not.toHaveAttribute('aria-disabled', 'true')
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = window as typeof window & {
            __HC_REGENERATE_FIXTURE__?: { calls: RegenerateCallEvidence[] }
          }
          return host.__HC_REGENERATE_FIXTURE__?.calls.length ?? 0
        }),
      { message: 'regenerate fixture should observe the expected browser click count' },
    )
    .toBe(expectedCallCount)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const dynamicImport = new Function('path', 'return import(path)') as (
          modulePath: string,
        ) => Promise<{ useChatStore: () => unknown }>
        const module = await dynamicImport('/src/stores/chat.ts')
        const store = module.useChatStore() as {
          isCurrentStreaming: boolean
          streaming: boolean
          activeStreams: Record<string, unknown>
        }
        return {
          isCurrentStreaming: store.isCurrentStreaming,
          streaming: store.streaming,
          activeStreamCount: Object.keys(store.activeStreams).length,
        }
      }),
    )
    .toEqual({ isCurrentStreaming: false, streaming: false, activeStreamCount: 0 })
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
            dataWorkspaceMode: element.dataset.workspaceMode ?? null,
            dataThinkingState: element.dataset.thinkingState ?? null,
            dataApprovalState: element.dataset.approvalState ?? null,
            ariaBusy: element.getAttribute('aria-busy'),
            ariaPressed: element.getAttribute('aria-pressed'),
            ariaExpanded: element.getAttribute('aria-expanded'),
          },
        }
      })
    })
  }, targets)
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
    viewport: { width: 1440, height: 900 },
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

const matrixResults: MatrixResult[] = []

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

    await referencePage.screenshot({
      path: referencePath,
      animations: 'disabled',
      caret: 'hide',
    })
    await sourcePage.screenshot({
      path: sourcePath,
      animations: 'disabled',
      caret: 'hide',
    })
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
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            colorScheme: 'light',
          },
          reference: referenceGeometry,
          currentSource: sourceGeometry,
        },
        null,
        2,
      ),
    )

    const effectiveMapping: Mapping =
      state.mapping === 'BLOCKED' || !referenceOpen.ok || !sourceOpen.ok ? 'BLOCKED' : state.mapping
    const pixelStatus: PixelStatus =
      pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED'
    // This independent browser runner never captures the mandatory installed
    // macOS third leg. Even a zero-diff two-leg comparison must therefore stay
    // blocked instead of being promoted to PASS.
    const installedApplicationThirdLeg = 'NOT_RUN' as const
    const status: ResultStatus =
      effectiveMapping === 'BLOCKED'
        ? 'BLOCKED/RED'
        : effectiveMapping === 'NOT_COMPARABLE'
          ? 'NOT_COMPARABLE/RED'
          : pixelStatus === 'PASS'
            ? 'BLOCKED/RED'
            : 'RED'
    const result: MatrixResult & {
      environment: Record<string, unknown>
      pixelDiff: PixelDiff
      evidence: Record<string, string>
      installedApplicationThirdLeg: 'NOT_RUN'
    } = {
      id: state.id,
      declaredMapping: state.mapping,
      effectiveMapping,
      mappingReason: state.mappingReason,
      status,
      pixelStatus,
      changedPixelRatio: pixelDiff.changed_pixel_ratio,
      referenceOpen,
      sourceOpen,
      evidenceDir,
      environment: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        referenceURL: REFERENCE_URL,
        sourceURL: SOURCE_URL,
        pixelThreshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      },
      pixelDiff,
      evidence: {
        referenceScreenshot: referencePath,
        currentSourceScreenshot: sourcePath,
        pixelDiff: diffPath,
        geometryStyle: geometryPath,
        status: resultPath,
      },
      installedApplicationThirdLeg,
    }
    await writeFile(resultPath, JSON.stringify(result, null, 2))
    matrixResults.push(result)

    await testInfo.attach(`${state.id}-reference`, {
      body: await readFile(referencePath),
      contentType: 'image/png',
    })
    await testInfo.attach(`${state.id}-current-source`, {
      body: await readFile(sourcePath),
      contentType: 'image/png',
    })
    await testInfo.attach(`${state.id}-pixel-diff`, {
      body: await readFile(diffPath),
      contentType: 'image/png',
    })
    await testInfo.attach(`${state.id}-geometry-style`, {
      body: await readFile(geometryPath),
      contentType: 'application/json',
    })
    await testInfo.attach(`${state.id}-status`, {
      body: await readFile(resultPath),
      contentType: 'application/json',
    })

    expect(
      status,
      `${state.id}: status=${status}; mapping=${effectiveMapping}; changed=${(
        pixelDiff.changed_pixel_ratio * 100
      ).toFixed(
        4,
      )}%; reason=${state.mappingReason}; reference=${referenceOpen.error ?? 'ok'}; source=${sourceOpen.error ?? 'ok'}`,
    ).toBe('PASS')
  } finally {
    await context.close()
  }
}

test.describe('feat/v0.5.0-k12-parent-tutor — Chat interaction visual matrix', () => {
  test.afterAll(async () => {
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    const projectEvidenceRoot = path.join(EVIDENCE_ROOT, 'chromium')
    const entries = await readdir(projectEvidenceRoot, { withFileTypes: true }).catch(() => [])
    const persistedResults = (
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
    const statusCounts = persistedResults.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1
      return counts
    }, {})
    await writeFile(
      path.join(EVIDENCE_ROOT, 'matrix-summary.json'),
      JSON.stringify(
        {
          total: states.length,
          executed: persistedResults.length,
          statusCounts,
          passRatio: `${persistedResults.filter((result) => result.status === 'PASS').length}/${states.length}`,
          environment: {
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
          },
          results: persistedResults,
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

test.describe('feat/v0.5.0-k12-parent-tutor — Chat browser true-click contracts', () => {
  test('browser-contract: K12 asset history only renders authenticated blob URLs and hides failed image actions', async ({
    page,
  }) => {
    await installSourceFixture(page, 'image-preview')

    let assetMode: 'success' | 'unauthorized' = 'success'
    const assetRequests: Array<{ resourceType: string; url: string; mode: string }> = []
    await page.route('**/_hexclaw/api/k12/assets/**', async (route) => {
      const request = route.request()
      assetRequests.push({
        resourceType: request.resourceType(),
        url: request.url(),
        mode: assetMode,
      })
      if (request.resourceType() === 'image' || assetMode === 'unauthorized') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unauthorized fixture' }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#1677ff"/></svg>',
        ),
      })
    })

    await page.goto(`${SOURCE_URL}/chat`, {
      waitUntil: 'domcontentloaded',
      timeout: 12_000,
    })
    await page.locator('.hc-chat').waitFor({ state: 'visible', timeout: 8_000 })
    await replaceSourceMessages(page, [
      {
        id: 'asset-history-user-success',
        role: 'user',
        content: '请点评这张历史作品。',
        timestamp: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'history-user.svg',
              mime: 'image/svg+xml',
              data: 'asset://k12-agent/history-user.svg',
            },
          ],
        },
      },
      {
        id: 'asset-history-assistant-success',
        role: 'assistant',
        content: '我已看到这张历史作品。',
        timestamp: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'history-assistant.svg',
              mime: 'image/svg+xml',
              data: 'asset://k12-agent/history-assistant.svg',
            },
          ],
        },
      },
    ])

    const authenticatedImages = page.locator('.hc-msg__attachment-img')
    await expect(authenticatedImages).toHaveCount(2)
    for (let index = 0; index < 2; index += 1) {
      await expect(authenticatedImages.nth(index)).toHaveAttribute('src', /^blob:/)
    }
    expect(assetRequests.filter((request) => request.resourceType === 'image')).toHaveLength(0)
    expect(assetRequests.filter((request) => request.resourceType === 'fetch')).toHaveLength(2)
    expect(assetRequests.every((request) => !request.url.startsWith('asset://'))).toBe(true)

    const openedAuthenticatedSrc = await authenticatedImages.first().getAttribute('src')
    expect(openedAuthenticatedSrc).toMatch(/^blob:/)
    await authenticatedImages.first().click()
    await expect(page.locator('.hc-img-preview__img')).toHaveAttribute(
      'src',
      openedAuthenticatedSrc!,
    )

    assetMode = 'unauthorized'
    await replaceSourceMessages(page, [
      {
        id: 'asset-history-user-failed',
        role: 'user',
        content: '请点评另一张历史作品。',
        timestamp: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'failed-user.svg',
              mime: 'image/svg+xml',
              data: 'asset://k12-agent/failed-user.svg',
            },
          ],
        },
      },
      {
        id: 'asset-history-assistant-failed',
        role: 'assistant',
        content: '这条历史图片当前不可读取。',
        timestamp: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'failed-assistant.svg',
              mime: 'image/svg+xml',
              data: 'asset://k12-agent/failed-assistant.svg',
            },
          ],
        },
      },
    ])

    await expect
      .poll(
        () =>
          assetRequests.filter(
            (request) => request.resourceType === 'fetch' && request.mode === 'unauthorized',
          ).length,
        { message: 'both failed assets must pass through the authenticated fetch boundary' },
      )
      .toBe(2)
    await expect(page.locator('.hc-msg__attachment-img')).toHaveCount(0)
    await expect(page.locator('.hc-msg__media-download')).toHaveCount(0)
    await expect(page.locator('.hc-img-preview__backdrop')).toHaveCount(0)
    await expect(page.locator(`[src="${openedAuthenticatedSrc}"]`)).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(async (src) => {
          try {
            await fetch(src)
            return true
          } catch {
            return false
          }
        }, openedAuthenticatedSrc!),
      )
      .toBe(false)
    expect(assetRequests.filter((request) => request.resourceType === 'image')).toHaveLength(0)

    const failedUser = page.getByTestId('chat-message-user')
    await failedUser.hover()
    await failedUser.locator('.hc-msg-actions--user button[title="编辑消息"]').click()
    await expect(failedUser.locator('.hc-msg__edit-card')).toBeVisible()
    await expect(failedUser.locator('.hc-msg__edit-att-img')).toHaveCount(0)
    await expect(page.locator('.hc-msg__media-download')).toHaveCount(0)
    await expect(page.locator('.hc-img-preview__backdrop')).toHaveCount(0)
  })

  test('browser-contract: ordinary regenerate replaces one round and releases every terminal state', async ({
    page,
  }) => {
    await openSourceFixture(page)
    await replaceSourceMessages(page, [
      {
        id: 'regenerate-original-user',
        role: 'user',
        content: '请解释 57+38，并保留原题图片。',
        timestamp: NOW,
        metadata: {
          attachments: [
            {
              type: 'image',
              name: 'math-question.svg',
              mime: 'image/svg+xml',
              data: previewImage,
              attachmentId: 'fixture-math-question-receipt',
            },
          ],
        },
      },
      {
        id: 'regenerate-original-assistant',
        role: 'assistant',
        content: '旧助手回复：57+38=95。',
        timestamp: NOW,
        metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
      },
    ])
    await installRegenerateStreamFixture(page, ['completed', 'failed', 'cancelled', 'failed'])

    await expectRegenerateActionBetweenCopyAndSpeak(page)
    await page.getByTestId('message-regenerate').click()
    await expectRegenerateTerminal(page, '浏览器重试完成 #1', 1)
    await expect(page.getByText('旧助手回复：57+38=95。')).toHaveCount(0)

    await page.getByTestId('message-regenerate').click()
    await expectRegenerateTerminal(page, '浏览器重试失败 #2', 2)
    await expectRegenerateActionBetweenCopyAndSpeak(page)

    await page.getByTestId('message-regenerate').click()
    const stop = page.locator('.hc-composer__send--stop')
    await expect(stop).toBeVisible()
    await expect(stop).toBeEnabled()
    await stop.click()
    await expectRegenerateTerminal(page, '浏览器重试已取消 #3', 3)

    await page.getByTestId('message-regenerate').click()
    await expectRegenerateTerminal(page, '浏览器重试失败 #4', 4)
    await expectRegenerateActionBetweenCopyAndSpeak(page)

    const callEvidence = await page.evaluate(() => {
      const host = window as typeof window & {
        __HC_REGENERATE_FIXTURE__?: { calls: RegenerateCallEvidence[] }
      }
      return host.__HC_REGENERATE_FIXTURE__?.calls ?? []
    })
    expect(callEvidence).toHaveLength(4)
    expect(callEvidence.map((call) => call.outcome)).toEqual([
      'completed',
      'failed',
      'cancelled',
      'failed',
    ])
    for (const call of callEvidence) {
      expect(call.text).toBe('请解释 57+38，并保留原题图片。')
      expect(call.attachmentCount).toBe(1)
      expect(call.attachmentIds).toEqual(['fixture-math-question-receipt'])
    }
    await expect(page.getByTestId('chat-message-user')).toHaveCount(1)
    await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1)
  })
})
