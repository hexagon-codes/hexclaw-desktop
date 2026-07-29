import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = process.env.HEX_UI_SOURCE_URL?.trim() || 'http://127.0.0.1:16061'
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-general-remaining/evidence')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const NOW = '2026-07-29T06:20:00.000Z'

type Comparison = 'COMPARABLE' | 'NOT_COMPARABLE'
type ResultStatus = 'PASS' | 'RED' | 'NOT_COMPARABLE'

interface GeometryTarget {
  name: string
  selector: string
}

interface Surface {
  id: string
  manifestId: string
  route: string
  referenceOpen: string | null
  sourceOpen: string
  referenceReady: string
  sourceReady: string
  referenceTargets: GeometryTarget[]
  sourceTargets: GeometryTarget[]
  comparison: Comparison
  comparisonReason: string
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

const surfaces: Surface[] = [
  {
    id: 'agents-templates-default',
    manifestId: 'agents.templates',
    route: '/agents',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"agents\"]')?.click(); seg('ag',1)",
    sourceOpen: 'agents-templates',
    referenceReady: '.screen[data-pane="agents"] [data-sub="ag1"].on',
    sourceReady: '.hc-agents__content',
    referenceTargets: [
      { name: 'page', selector: '.screen[data-pane="agents"] [data-sub="ag1"]' },
      { name: 'grid', selector: '.screen[data-pane="agents"] [data-sub="ag1"] .tpl-grid' },
    ],
    sourceTargets: [
      { name: 'page', selector: '.hc-agents__content' },
      { name: 'grid', selector: '.hc-agents__content' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the default Agent template-library state.',
  },
  {
    id: 'agents-skill-picker-expanded',
    manifestId: 'agents.create-editor-modal',
    route: '/agents',
    referenceOpen:
      "newAgent(); agentForm('blank'); [...document.querySelectorAll('#overlayCard details')].find(x=>x.textContent.includes('挂载 Skill'))?.setAttribute('open','')",
    sourceOpen: 'agents-skill-picker',
    referenceReady: '#overlay.on #overlayCard .skillchips',
    sourceReady: '[data-testid="agent-skill-filter"]',
    referenceTargets: [
      { name: 'dialog', selector: '#overlayCard .modal' },
      { name: 'skill-picker', selector: '#overlayCard .skillchips' },
    ],
    sourceTargets: [
      { name: 'dialog', selector: '[data-testid="agent-create-only"]' },
      {
        name: 'skill-picker',
        selector: '[data-testid="agent-skill-filter"]',
      },
    ],
    comparison: 'COMPARABLE',
    comparisonReason:
      'Both legs expose the expanded mounted-Skill selector in the blank Agent editor.',
  },
  {
    id: 'agents-soul-structured-default',
    manifestId: 'agents.soul-structured-editor',
    route: '/agents',
    referenceOpen: "newAgent(); agentForm('blank'); openSoulFocus()",
    sourceOpen: 'agents-soul-structured',
    referenceReady: '.soulfocus',
    sourceReady: '[data-testid="soul-editor-overlay"]',
    referenceTargets: [{ name: 'dialog', selector: '.soulfocus' }],
    sourceTargets: [
      { name: 'overlay', selector: '[data-testid="soul-editor-overlay"]' },
      { name: 'dialog', selector: '[data-testid="soul-editor-overlay"] > div' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose focused structured SOUL editing from a blank Agent editor.',
  },
  {
    id: 'knowledge-semantic-index-ready',
    manifestId: 'knowledge.semantic-index',
    route: '/knowledge',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"knowledge\"]')?.click(); seg('kn',1)",
    sourceOpen: 'knowledge-semantic-index',
    referenceReady: '.screen[data-pane="knowledge"] [data-sub="kn1"].on',
    sourceReady: '[data-testid="kb-semantic-index-card"]',
    referenceTargets: [
      { name: 'memory-page', selector: '.screen[data-pane="knowledge"] [data-sub="kn1"]' },
    ],
    sourceTargets: [
      { name: 'semantic-index-card', selector: '[data-testid="kb-semantic-index-card"]' },
    ],
    comparison: 'NOT_COMPARABLE',
    comparisonReason:
      'Manifest oracle is acceptance-only: the prototype memory page has no independently static semantic-index ready lifecycle state.',
  },
  {
    id: 'automation-permission-approval',
    manifestId: 'automation.permission-approval-modal',
    route: '/automation',
    referenceOpen: 'permApprovalDemo()',
    sourceOpen: 'automation-permission-approval',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="permission-approval-modal"]',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '#overlayCard .modal' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: '.hc-modal-overlay' },
      { name: 'dialog', selector: '[data-testid="permission-approval-modal"]' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason:
      'Both legs expose the default scheduled-task preflight approval decision state.',
  },
  {
    id: 'automation-permission-blocked',
    manifestId: 'automation.permission-blocked-modal',
    route: '/automation',
    referenceOpen: 'permBlockedDemo()',
    sourceOpen: 'automation-permission-blocked',
    referenceReady: '#overlay.on .blocked-perm',
    sourceReady: '[data-testid="permission-blocked-modal"]',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '.blocked-perm' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: '.hc-modal-overlay' },
      { name: 'dialog', selector: '[data-testid="permission-blocked-modal"]' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose a scheduled task blocked on a publish permission decision.',
  },
  {
    id: 'logs-history-results',
    manifestId: 'logs.history',
    route: '/logs',
    referenceOpen:
      'document.querySelector(\'.sb-item[data-screen="logs"]\')?.click(); showHistoryLogs()',
    sourceOpen: 'logs-history',
    referenceReady: '#histbar.on',
    sourceReady: '.hc-logs__histbar',
    referenceTargets: [
      { name: 'page', selector: '.screen[data-pane="logs"]' },
      { name: 'history-bar', selector: '#histbar' },
    ],
    sourceTargets: [
      { name: 'page', selector: '.hc-logs-page' },
      { name: 'history-bar', selector: '.hc-logs__histbar' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose history mode with a deterministic one-row result.',
  },
  {
    id: 'logs-detail-first-row',
    manifestId: 'logs.detail',
    route: '/logs',
    referenceOpen:
      'document.querySelector(\'.sb-item[data-screen="logs"]\')?.click(); openLogDetail(document.querySelector(\'.screen[data-pane="logs"] .logrow\'))',
    sourceOpen: 'logs-detail',
    referenceReady: '#logdrawer.on',
    sourceReady: '.hc-logs__drawer',
    referenceTargets: [
      { name: 'drawer', selector: '#logdrawer' },
      { name: 'selected-row', selector: '.screen[data-pane="logs"] .logrow.sel' },
    ],
    sourceTargets: [
      { name: 'drawer', selector: '.hc-logs__drawer' },
      { name: 'selected-row', selector: '.hc-logs__row--selected' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the first frozen log row and its detail drawer.',
  },
  {
    id: 'integration-skill-preview-installed',
    manifestId: 'integration.skill-preview-modal',
    route: '/integration',
    referenceOpen: "skillPreviewDemo('翻译润色','installed')",
    sourceOpen: 'skill-preview',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.skill-preview__panel',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '#overlayCard .modal' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0:has(.skill-preview__panel)' },
      { name: 'dialog', selector: '.skill-preview__panel' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason:
      'Both legs expose the installed “翻译润色” Skill preview from deterministic content.',
  },
  {
    id: 'settings-model-manager-openai',
    manifestId: 'settings.model-manager-modal',
    route: '/settings',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"settings\"]')?.click(); document.querySelector('[data-provider-catalog-manage]')?.click()",
    sourceOpen: 'settings-model-manager',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.mm-modal',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '#overlayCard .modal' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: '.mm-overlay' },
      { name: 'dialog', selector: '.mm-modal' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose OpenAI provider model catalog management.',
  },
  {
    id: 'settings-custom-model-openai',
    manifestId: 'settings.custom-model-modal',
    route: '/settings',
    referenceOpen:
      'document.querySelector(\'.sb-item[data-screen="settings"]\')?.click(); document.querySelector(\'[title="添加自定义模型"]\')?.click()',
    sourceOpen: 'settings-custom-model',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="custom-model-dialog"]',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '#overlayCard .modal' },
    ],
    sourceTargets: [
      {
        name: 'overlay',
        selector: 'body > .fixed.inset-0:has([data-testid="custom-model-dialog"])',
      },
      { name: 'dialog', selector: '[data-testid="custom-model-dialog"]' },
    ],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the custom-model form for the expanded OpenAI provider.',
  },
  {
    id: 'settings-automation-default',
    manifestId: 'settings.automation',
    route: '/settings',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"settings\"]')?.click(); [...document.querySelectorAll('.screen[data-pane=\"settings\"] .tbar .seg button')].find(b=>b.textContent.trim()==='自动化权限')?.click()",
    sourceOpen: 'settings-automation',
    referenceReady: '.screen[data-pane="settings"].on',
    sourceReady: '.hc-settings__section--automation',
    referenceTargets: [{ name: 'page', selector: '.screen[data-pane="settings"]' }],
    sourceTargets: [{ name: 'page', selector: '.hc-settings__section--automation' }],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the default automation-permissions settings section.',
  },
  {
    id: 'settings-system-default',
    manifestId: 'settings.system',
    route: '/settings',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"settings\"]')?.click(); [...document.querySelectorAll('.screen[data-pane=\"settings\"] .tbar .seg button')].find(b=>b.textContent.trim()==='系统设置')?.click()",
    sourceOpen: 'settings-system',
    referenceReady: '.screen[data-pane="settings"].on',
    sourceReady: '.hc-settings__form--system',
    referenceTargets: [{ name: 'page', selector: '.screen[data-pane="settings"]' }],
    sourceTargets: [{ name: 'page', selector: '.hc-settings__form--system' }],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the default system-settings section.',
  },
  {
    id: 'settings-about-entry',
    manifestId: 'settings.about-entry',
    route: '/settings',
    referenceOpen:
      "document.querySelector('.sb-item[data-screen=\"settings\"]')?.click(); [...document.querySelectorAll('.screen[data-pane=\"settings\"] .tbar .seg button')].find(b=>b.textContent.trim()==='系统设置')?.click()",
    sourceOpen: 'settings-about-entry',
    referenceReady: '.screen[data-pane="settings"].on',
    sourceReady: '.hc-settings__about',
    referenceTargets: [{ name: 'about-entry', selector: '.screen[data-pane="settings"]' }],
    sourceTargets: [
      { name: 'about-entry', selector: '.hc-settings__about' },
      { name: 'learn-more', selector: '.hc-settings__about-link' },
    ],
    comparison: 'NOT_COMPARABLE',
    comparisonReason:
      'Manifest oracle is acceptance-only: browser evidence cannot prove reuse of the same native About window identity.',
  },
  {
    id: 'welcome-provider-step',
    manifestId: 'welcome.window',
    route: '/welcome',
    referenceOpen: 'openWelcome()',
    sourceOpen: 'welcome',
    referenceReady: '#blankRoute.on',
    sourceReady: '.hc-welcome__logo',
    referenceTargets: [{ name: 'page', selector: '#blankRoute' }],
    sourceTargets: [{ name: 'page', selector: '.hc-welcome' }],
    comparison: 'COMPARABLE',
    comparisonReason: 'Both legs expose the initial provider-selection onboarding step.',
  },
]

const fixtureModels = [
  { id: 'gpt-4.1', name: 'gpt-4.1', capabilities: ['text', 'tools'] },
  { id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text', 'vision'] },
  { id: 'o3', name: 'o3', capabilities: ['text', 'thinking'] },
]
const fixtureSkills = [
  {
    name: 'translate-polish',
    display_name: '翻译润色',
    description: '专业翻译和文本润色',
    version: '1.0.0',
    author: 'hexclaw',
    tags: ['writing'],
    enabled: true,
  },
]
const blockedTask = {
  task_ref: 'cron:job-permission',
  kind: 'cron',
  name: '发布周报',
  enabled: true,
  status: 'active',
  needs_decision: ['publish'],
  all_clear: false,
  last_block: {
    id: 'decision-blocked',
    at: NOW,
    source: 'cron',
    task_ref: 'cron:job-permission',
    tool: 'publish_message',
    capability: 'publish',
    profile: 'function_first',
    decision: 'pending',
    via: 'matrix',
    reason: '发布操作需要人工授权',
  },
}
const preflight = {
  source: 'cron',
  profile: 'function_first',
  capabilities: [
    { category: 'read', tools: ['search'], state: 'auto' },
    { category: 'publish', tools: ['publish_message'], state: 'approval' },
  ],
  estimated: ['read', 'publish'],
  needs_decision: ['publish'],
  all_clear: false,
  basis: 'heuristic',
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
    default: 'openai/gpt-4o',
    defaultModel: 'gpt-4o',
    defaultProviderId: 'openai',
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: false },
    providers: [
      {
        id: 'openai',
        providerInstanceId: 'provider-openai',
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        apiKey: 'fixture-redacted',
        baseUrl: 'https://api.openai.com/v1',
        selectedModelId: 'gpt-4o',
        models: fixtureModels,
      },
    ],
  },
}
const backendLLMConfig = {
  default: 'openai',
  providers: {
    openai: {
      provider_instance_id: 'provider-openai',
      display_name: 'OpenAI',
      type: 'openai',
      enabled: true,
      api_key: 'fixture-redacted',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      models: fixtureModels.map((model) => model.id),
      model_specs: fixtureModels.map((model) => ({
        id: model.id,
        name: model.name,
        capabilities: model.capabilities,
      })),
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: false, similarity: 0.9, ttl: '1h', max_entries: 1000 },
}
const runtimeConfig = {
  server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
  llm: {
    default: 'openai',
    providers: {
      openai: {
        model: 'gpt-4o',
        base_url: 'https://api.openai.com/v1',
        has_key: true,
      },
    },
  },
  knowledge: { enabled: true },
  mcp: { enabled: true },
  cron: { enabled: true },
  webhook: { enabled: true },
  canvas: { enabled: true },
  voice: { enabled: true },
  sandbox: { network_enabled: true, allowed_paths: [] },
  security: sourceConfig.security,
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function runtimeFixture(apiPath: string, method: string): unknown {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return runtimeConfig
  if (apiPath === '/api/v1/config/llm') return backendLLMConfig
  if (apiPath === '/api/v1/config/llm/models') {
    return {
      models: fixtureModels.map((model) => ({
        id: model.id,
        name: model.name,
        input_modalities: model.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
        supports_tools: model.capabilities.includes('tools'),
      })),
    }
  }
  if (apiPath === '/api/v1/ollama/status') {
    return { running: false, associated: false, models: [], model_count: 0 }
  }
  if (apiPath === '/api/v1/assistant/soul') {
    return {
      system_prompt: '你是小蟹，一个本地优先的通用助理。',
      is_custom: true,
      default_prompt: '你是小蟹。',
    }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return {
      agents: [
        {
          name: 'daily-report',
          display_name: '日报分析师',
          description: 'cron 日报专用 · 简洁理性',
          provider: 'openai',
          model: 'gpt-4o',
          metadata: { avatar: '📊' },
        },
      ],
      total: 1,
      default: 'daily-report',
    }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') {
    return {
      roles: [
        {
          name: 'content-writer',
          display_name: '内容创作者',
          description: '擅长写作、改写与内容策划',
          category: '创作',
          icon: '✍️',
        },
        {
          name: 'data-analyst',
          display_name: '数据分析师',
          description: '分析数据并输出洞察',
          category: '效率',
          icon: '📊',
        },
      ],
      total: 2,
    }
  }
  if (apiPath === '/api/v1/skills') {
    return { dir: '/tmp/hexclaw-skills', skills: fixtureSkills, total: fixtureSkills.length }
  }
  if (apiPath === '/api/v1/skills/translate-polish/content') {
    return {
      content:
        '---\nname: translate-polish\ndisplay_name: 翻译润色\ndescription: 专业翻译和文本润色\n---\n\n# 翻译润色\n\n保留专有名词与代码。',
    }
  }
  if (apiPath === '/api/v1/clawhub/search') return { skills: [], total: 0 }
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
    return { enabled: true, configured: true, local: false, ready: true, pulling: false }
  }
  if (apiPath === '/api/v1/knowledge/corpora/default/embedding-policy') {
    const profile = {
      profile_id: 'cloud-bge',
      model_name: 'BAAI/bge-m3',
      provider_id: 'siliconflow',
      provider_name: 'SiliconFlow',
      location: 'cloud',
      capability: 'embedding',
      dimension: 1024,
      availability: 'connected',
      display_order: 1,
    }
    return {
      policy_version: 1,
      selection: { kind: 'auto' },
      active_revision: { revision_id: 'revision-ready', state: 'ready', profile },
      desired_revision: null,
      indexing_activity: {
        state: 'idle',
        processing_documents: 0,
        chunks_done: null,
        chunks_total: null,
      },
      available_profiles: [profile],
      recommendation: {
        profile_id: 'cloud-bge',
        reason_code: 'cloud_configured',
        reason_text: '已配置云端向量模型',
      },
      catalog_version: 1,
    }
  }
  if (apiPath === '/api/v1/cron/jobs' || apiPath === '/api/v1/cronjob') {
    return {
      jobs: [
        {
          id: 'job-permission',
          name: '发布周报',
          type: 'cron',
          schedule: '@daily',
          user_id: 'desktop-user',
          status: 'active',
          last_run_at: '',
          next_run_at: '2026-07-30T09:00:00+08:00',
          run_count: 0,
          created_at: NOW,
          source_prompt: '整理并发布周报',
          prompt: '整理并发布周报',
        },
      ],
      total: 1,
    }
  }
  if (apiPath === '/api/v1/autonomy/preflight') return preflight
  if (apiPath === '/api/v1/autonomy/summary') {
    return {
      profile: 'function_first',
      counts: { tasks: 1, ready: 0, pending: 1, grants: 0 },
      pending: [blockedTask],
      tasks: [blockedTask],
    }
  }
  if (apiPath === '/api/v1/autonomy/profile') {
    return {
      profile: 'function_first',
      profiles: ['function_first', 'balanced', 'strict', 'full_access'],
      matrix: {
        profile: 'function_first',
        categories: ['read', 'write', 'publish'],
        rows: [
          {
            source: 'cron',
            cells: [
              { category: 'read', state: 'auto' },
              { category: 'write', state: 'approval' },
              { category: 'publish', state: 'approval' },
            ],
          },
        ],
      },
    }
  }
  if (apiPath === '/api/v1/autonomy/decisions') {
    return { decisions: [blockedTask.last_block], total: 1 }
  }
  if (apiPath === '/api/v1/autonomy/grants') return { grants: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/platforms/instances/health') return { instances: [] }
  if (apiPath === '/api/v1/connectors') return { connectors: [] }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/logs') {
    return {
      logs: [
        {
          id: 'log-1',
          timestamp: '2026-07-29T12:48:02+08:00',
          level: 'info',
          source: 'sidecar',
          message: 'engine started · listening on :16060',
          trace_id: 'boot-16060',
          domain: 'runtime',
        },
      ],
      total: 1,
    }
  }
  if (apiPath === '/api/v1/logs/stats') {
    return {
      total: 1,
      by_level: { debug: 0, info: 1, warn: 0, error: 0 },
      by_source: { sidecar: 1 },
      requests_per_minute: 0,
    }
  }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page) {
  await page.addInitScript((config) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
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
        if (command === 'get_system_info') {
          return { os: 'macOS', arch: 'arm64', version: '15.5', engine_version: '0.5.0-beta' }
        }
        if (command === 'get_autostart_status' || command === 'is_autostart_enabled') return false
        if (command === 'proxy_api_request') {
          const apiPath = String(args.path ?? '')
          const response = await fetch(`/_hexclaw${apiPath}`, {
            method: String(args.method ?? 'GET'),
            body: typeof args.body === 'string' ? args.body : undefined,
            headers: { 'content-type': 'application/json' },
          })
          if (!response.ok) throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
          return response.text()
        }
        return null
      },
    }
    desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => unregisterCallback(id),
    }
  }, sourceConfig)
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'general-remaining-matrix' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function clickText(page: Page, selector: string, text: string) {
  const locator = page.locator(selector).filter({ hasText: text }).first()
  await locator.waitFor({ state: 'visible', timeout: 4_000 })
  await locator.click({ timeout: 4_000 })
}

async function openReference(page: Page, surface: Surface): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 12_000 })
    if (surface.referenceOpen) {
      await page.evaluate((script) => new Function(script)(), surface.referenceOpen)
    }
    await page.locator(surface.referenceReady).first().waitFor({ state: 'visible', timeout: 4_000 })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return {
    ok: error === null,
    error,
    readySelector: surface.referenceReady,
    readyCount: await page.locator(surface.referenceReady).count(),
    url: page.url(),
  }
}

async function openSourceAction(page: Page, action: string) {
  if (action === 'agents-templates') {
    await clickText(page, 'button', '模板库')
  } else if (action === 'agents-skill-picker') {
    await clickText(page, 'button', '新建智能体')
    await page.getByTestId('start-blank').click()
    await page.getByTestId('agent-add-adv-toggle').click()
  } else if (action === 'agents-soul-structured') {
    const createButton = page.locator('button').filter({ hasText: '新建智能体' }).first()
    await createButton.waitFor({ state: 'visible', timeout: 12_000 })
    await createButton.click({ timeout: 12_000, noWaitAfter: true })
    await page.getByTestId('start-blank').click({ timeout: 12_000, noWaitAfter: true })
    await page.getByTestId('agent-soul-focus-add').click({ timeout: 12_000, noWaitAfter: true })
  } else if (action === 'knowledge-semantic-index') {
    await page.getByTestId('kb-semantic-index-header').click()
  } else if (action === 'automation-permission-approval') {
    await clickText(page, 'button', '新建任务')
    const modal = page.locator('.hc-modal-overlay .hc-modal')
    await modal.locator('input').nth(0).fill('发布周报')
    await modal.locator('input').nth(1).fill('@daily')
    await modal.locator('textarea').first().fill('整理并发布周报')
    await clickText(modal, 'button', '创建')
  } else if (action === 'automation-permission-blocked') {
    await page.getByTestId('perm-badge').first().click()
  } else if (action === 'logs-history') {
    await page.getByTitle('搜索全部历史').click()
  } else if (action === 'logs-detail') {
    await page.getByTitle('搜索全部历史').click()
    await page.locator('.hc-logs__row').first().click()
  } else if (action === 'skill-preview') {
    const button = page
      .locator('.hc-capability-installed-track button')
      .filter({ hasText: /翻译润色|translate-polish/ })
      .first()
    await button.click({ timeout: 4_000 })
  } else if (action === 'settings-model-manager') {
    await page.locator('.hc-provider__card-head').first().click()
    await clickText(page, 'button', '管理模型')
  } else if (action === 'settings-custom-model') {
    await page.locator('.hc-provider__card-head').first().click()
    await clickText(page, 'button', '自定义')
  } else if (action === 'settings-automation') {
    await clickText(page, 'button', '自动化权限')
  } else if (action === 'settings-system' || action === 'settings-about-entry') {
    await clickText(page, 'button', '系统设置')
  } else if (action !== 'welcome') {
    throw new Error(`unknown source opener: ${action}`)
  }
}

async function openSource(page: Page, surface: Surface): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await installSourceFixture(page)
    await page.goto(`${SOURCE_URL}${surface.route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 12_000,
    })
    const initialReadySelector = surface.sourceOpen === 'welcome' ? surface.sourceReady : '.hc-app'
    await page.locator(initialReadySelector).first().waitFor({ state: 'visible', timeout: 8_000 })
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    await page.waitForTimeout(300)
    await openSourceAction(page, surface.sourceOpen)
    await page.locator(surface.sourceReady).first().waitFor({ state: 'visible', timeout: 4_000 })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return {
    ok: error === null,
    error,
    readySelector: surface.sourceReady,
    readyCount: await page.locator(surface.sourceReady).count(),
    url: page.url(),
  }
}

async function freezeVisuals(page: Page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}',
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
  })
}

async function captureGeometry(page: Page, targets: GeometryTarget[]) {
  return page.evaluate((items) => {
    const styleKeys = [
      'display',
      'visibility',
      'position',
      'zIndex',
      'width',
      'height',
      'padding',
      'margin',
      'gap',
      'background',
      'backgroundColor',
      'border',
      'borderRadius',
      'boxShadow',
      'backdropFilter',
      'color',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'overflow',
      'opacity',
    ] as const
    return items.map((target) => {
      const element = document.querySelector<HTMLElement>(target.selector)
      if (!element) return { ...target, found: false }
      const rect = element.getBoundingClientRect()
      const computed = getComputedStyle(element)
      return {
        ...target,
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
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      }
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

async function exerciseSurface(browser: Browser, surface: Surface, testInfo: TestInfo) {
  const evidenceDir = path.join(EVIDENCE_ROOT, testInfo.project.name, surface.id)
  await mkdir(evidenceDir, { recursive: true })
  const referencePath = path.join(evidenceDir, 'reference.png')
  const sourcePath = path.join(evidenceDir, 'current-source.png')
  const diffPath = path.join(evidenceDir, 'pixel-diff.png')
  const geometryPath = path.join(evidenceDir, 'geometry-style.json')
  const resultPath = path.join(evidenceDir, 'result.json')

  const { context, referencePage, sourcePage } = await useEvidencePages(browser)
  try {
    const referenceOpen = await openReference(referencePage, surface)
    const sourceOpen = await openSource(sourcePage, surface)
    await freezeVisuals(referencePage)
    await freezeVisuals(sourcePage)
    await referencePage.screenshot({ path: referencePath, animations: 'disabled' })
    await sourcePage.screenshot({ path: sourcePath, animations: 'disabled' })
    const pixelDiff = await runPixelDiff(referencePath, sourcePath, diffPath)
    const referenceGeometry = await captureGeometry(referencePage, surface.referenceTargets)
    const sourceGeometry = await captureGeometry(sourcePage, surface.sourceTargets)
    const effectiveComparison: Comparison =
      surface.comparison === 'COMPARABLE' && referenceOpen.ok && sourceOpen.ok
        ? 'COMPARABLE'
        : 'NOT_COMPARABLE'
    const status: ResultStatus =
      effectiveComparison === 'NOT_COMPARABLE'
        ? 'NOT_COMPARABLE'
        : pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PASS'
          : 'RED'
    const effectiveReason =
      effectiveComparison === 'NOT_COMPARABLE' && surface.comparison === 'COMPARABLE'
        ? `Equivalent state could not be opened: reference=${referenceOpen.error ?? 'ok'}; source=${sourceOpen.error ?? 'ok'}`
        : surface.comparisonReason
    const result = {
      id: surface.id,
      manifestId: surface.manifestId,
      status,
      comparison: {
        declared: surface.comparison,
        effective: effectiveComparison,
        reason: effectiveReason,
      },
      environment: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        referenceURL: REFERENCE_URL,
        sourceURL: SOURCE_URL,
      },
      open: { reference: referenceOpen, currentSource: sourceOpen },
      pixelDiff,
      acceptance: {
        threshold: PIXEL_THRESHOLD,
        maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
        pixelStatus: pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO ? 'PASS' : 'RED',
        installedApplicationThirdLeg: 'NOT_RUN',
      },
      evidence: {
        referenceScreenshot: referencePath,
        currentSourceScreenshot: sourcePath,
        pixelDiff: diffPath,
        geometryStyle: geometryPath,
        result: resultPath,
      },
    }
    await writeFile(
      geometryPath,
      JSON.stringify({ reference: referenceGeometry, currentSource: sourceGeometry }, null, 2),
    )
    await writeFile(resultPath, JSON.stringify(result, null, 2))
    for (const [name, filePath] of [
      ['reference', referencePath],
      ['current-source', sourcePath],
      ['pixel-diff', diffPath],
    ] as const) {
      await testInfo.attach(`${surface.id}-${name}`, {
        body: await readFile(filePath),
        contentType: 'image/png',
      })
    }
    await testInfo.attach(`${surface.id}-result`, {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    expect(
      status,
      `${surface.id}: ${status}; changed=${(pixelDiff.changed_pixel_ratio * 100).toFixed(4)}%; comparison=${effectiveComparison}; reason=${effectiveReason}`,
    ).toBe('PASS')
  } finally {
    await context.close()
  }
}

test.describe('remaining general-page prototype/source visual matrix', () => {
  for (const surface of surfaces) {
    test(`${surface.id} emits isolated visual evidence`, async ({ browser }, testInfo) => {
      await exerciseSurface(browser, surface, testInfo)
    })
  }
})
