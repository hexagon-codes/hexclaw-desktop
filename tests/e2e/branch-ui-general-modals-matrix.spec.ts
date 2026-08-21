import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
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
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-general-modals/evidence')
const NOTIFICATION_EVIDENCE_ROOT = path.resolve(
  process.env.HEX_NOTIFICATION_EVIDENCE_ROOT?.trim() ||
    '../hexclaw-docs/test/evidence/bug-20260820-notifications/same-state',
)
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const NOW = '2026-07-29T06:20:00.000Z'
const NOTIFICATION_NOW = new Date('2026-08-21T00:20:00+08:00')

// 通知面板的原型是跨午夜夹具：27 分钟前属于“更早”，其余两条属于“今天”。
// 实现侧恢复同一持久快照，避免测试数据顺序、相对时间和分组伪造视觉漂移。
const notificationFixture = [
  {
    id: 'notif-knowledge-degraded',
    kind: 'system',
    level: 'warning',
    title: '知识库降级检索',
    body: 'Embedding 未配置，已回退到基础检索。点击查看日志详情。',
    timestamp: new Date('2026-08-21T00:19:00+08:00').getTime(),
    read: false,
    route: '/logs',
  },
  {
    id: 'notif-daily-report-failed',
    kind: 'automation',
    level: 'warning',
    title: '日报任务执行失败',
    body: '已记录失败原因，可进入自动化查看重试与恢复状态。',
    timestamp: new Date('2026-08-21T00:12:00+08:00').getTime(),
    read: false,
    route: '/automation',
  },
  {
    id: 'notif-skill-update',
    kind: 'system',
    level: 'info',
    title: 'Skill 市场有更新',
    body: '网页抓取 Skill 发布新版本，增加正文提取策略。',
    timestamp: new Date('2026-08-20T23:53:00+08:00').getTime(),
    read: true,
    route: '/integration',
  },
] as const

type Mapping = 'COMPARABLE' | 'BLOCKED'
type ResultStatus = 'PASS' | 'RED' | 'BLOCKED/RED'

interface GeometryTarget {
  name: string
  selector: string
}

interface Surface {
  id: string
  route: string
  referenceOpen: string | null
  sourceOpen: string
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

const modalTargets = (selector: string): GeometryTarget[] => [
  {
    name: 'overlay',
    selector: `${selector}:has(${selector === '#overlay' ? '#overlayCard' : '*'})`,
  },
  { name: 'dialog', selector },
]

const surfaces: Surface[] = [
  {
    id: 'shell-notification-drawer',
    route: '/chat',
    referenceOpen: 'toggleNotif(true)',
    sourceOpen: 'notification',
    referenceReady: '#notifPanel.on',
    sourceReady: '.hc-notifpanel',
    referenceTargets: [
      { name: 'drawer', selector: '#notifPanel' },
      { name: 'backdrop', selector: '#notifBackdrop' },
      { name: 'header', selector: '#notifPanel .notif-head' },
      { name: 'header-mark-all-icon', selector: '#notifPanel .notif-actions > :nth-child(1) svg' },
      { name: 'header-trash-icon', selector: '#notifPanel .notif-actions > :nth-child(2) svg' },
      { name: 'header-close-icon', selector: '#notifPanel .notif-actions > :nth-child(3) svg' },
      { name: 'today-group', selector: '#notifPanel .notif-list > :nth-child(1)' },
      { name: 'knowledge-item', selector: '#notifPanel .notif-list > :nth-child(2)' },
      { name: 'knowledge-icon', selector: '#notifPanel .notif-list > :nth-child(2) .notif-ic' },
      { name: 'knowledge-title', selector: '#notifPanel .notif-list > :nth-child(2) b' },
      { name: 'knowledge-time', selector: '#notifPanel .notif-list > :nth-child(2) time' },
      {
        name: 'knowledge-chevron',
        selector: '#notifPanel .notif-list > :nth-child(2) .notif-chevron',
      },
      { name: 'daily-item', selector: '#notifPanel .notif-list > :nth-child(3)' },
      { name: 'daily-icon', selector: '#notifPanel .notif-list > :nth-child(3) .notif-ic' },
      { name: 'daily-time', selector: '#notifPanel .notif-list > :nth-child(3) time' },
      { name: 'earlier-group', selector: '#notifPanel .notif-list > :nth-child(4)' },
      { name: 'skill-item', selector: '#notifPanel .notif-list > :nth-child(5)' },
      { name: 'skill-icon', selector: '#notifPanel .notif-list > :nth-child(5) .notif-ic' },
      { name: 'skill-title', selector: '#notifPanel .notif-list > :nth-child(5) b' },
      { name: 'skill-time', selector: '#notifPanel .notif-list > :nth-child(5) time' },
    ],
    sourceTargets: [
      { name: 'drawer', selector: '.hc-notifpanel' },
      { name: 'backdrop', selector: '.hc-notifpanel__backdrop' },
      { name: 'header', selector: '.hc-notifpanel__head' },
      { name: 'header-mark-all-icon', selector: '.hc-notifpanel__actions > :nth-child(1) svg' },
      { name: 'header-trash-icon', selector: '.hc-notifpanel__actions > :nth-child(2) svg' },
      { name: 'header-close-icon', selector: '.hc-notifpanel__actions > :nth-child(3) svg' },
      { name: 'today-group', selector: '.hc-notifpanel__group:nth-of-type(1)' },
      { name: 'knowledge-item', selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(1)' },
      {
        name: 'knowledge-icon',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(1) .hc-notifpanel__iconwrap',
      },
      {
        name: 'knowledge-title',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(1) .hc-notifpanel__itemtitle',
      },
      {
        name: 'knowledge-time',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(1) .hc-notifpanel__time',
      },
      {
        name: 'knowledge-chevron',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(1) .hc-notifpanel__chevron',
      },
      { name: 'daily-item', selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(2)' },
      {
        name: 'daily-icon',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(2) .hc-notifpanel__iconwrap',
      },
      {
        name: 'daily-time',
        selector: '.hc-notifpanel__list:nth-of-type(1) > :nth-child(2) .hc-notifpanel__time',
      },
      { name: 'earlier-group', selector: '.hc-notifpanel__group:nth-of-type(2)' },
      { name: 'skill-item', selector: '.hc-notifpanel__list:nth-of-type(2) > :nth-child(1)' },
      {
        name: 'skill-icon',
        selector: '.hc-notifpanel__list:nth-of-type(2) > :nth-child(1) .hc-notifpanel__iconwrap',
      },
      {
        name: 'skill-title',
        selector: '.hc-notifpanel__list:nth-of-type(2) > :nth-child(1) .hc-notifpanel__itemtitle',
      },
      {
        name: 'skill-time',
        selector: '.hc-notifpanel__list:nth-of-type(2) > :nth-child(1) .hc-notifpanel__time',
      },
    ],
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs use the same frozen three-item notification snapshot, cross-midnight clock, order, groups, levels, kinds and read states.',
  },
  {
    id: 'shell-command-palette-default',
    route: '/chat',
    referenceOpen: 'openCmdk()',
    sourceOpen: 'command-palette',
    referenceReady: '#overlay.on #cmdkIn',
    sourceReady: '.hc-cmd',
    referenceTargets: [
      { name: 'overlay', selector: '#overlay' },
      { name: 'dialog', selector: '#overlayCard .modal' },
      { name: 'search', selector: '#cmdkIn' },
    ],
    sourceTargets: [
      { name: 'overlay', selector: '.hc-cmd-overlay' },
      { name: 'dialog', selector: '.hc-cmd' },
      { name: 'search', selector: '.hc-cmd input' },
    ],
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs expose the default navigation/action command palette at the same shell state.',
  },
  {
    id: 'agents-create-choice',
    route: '/agents',
    referenceOpen: 'newAgent()',
    sourceOpen: 'agent-create-choice',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="start-blank"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: 'body > .fixed.inset-0 > div' },
      { name: 'blank-entry', selector: '[data-testid="start-blank"]' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the approved two-entry create start state.',
  },
  {
    id: 'agents-create-editor-basic',
    route: '/agents',
    referenceOpen: "newAgent(); agentForm('blank')",
    sourceOpen: 'agent-create-editor',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="agent-create-only"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'dialog', selector: '[data-testid="agent-create-only"]' },
      { name: 'advanced-toggle', selector: '[data-testid="agent-add-adv-toggle"]' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the blank-agent basic editor.',
  },
  {
    id: 'agents-edit-editor-advanced',
    route: '/agents',
    referenceOpen:
      "agentForm('blank'); document.querySelector('#overlayCard details.agfold')?.setAttribute('open','')",
    sourceOpen: 'agent-edit-advanced',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="agent-adv-toggle"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'dialog', selector: '[data-testid="agent-adv-toggle"]' },
      { name: 'skill-picker', selector: '[data-testid="agent-skill-count"]' },
    ],
    mapping: 'BLOCKED',
    mappingReason:
      'The prototype agentForm blank-create editor is the only generic fixture-addressable editor. Source edit needs an existing agent. Structural evidence is collected, but create and edit semantics are not conflated.',
  },
  {
    id: 'agents-soul-editor',
    route: '/agents',
    referenceOpen: "openSoulEditor('小蟹 · 默认助理')",
    sourceOpen: 'agent-soul',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: 'body > .fixed.inset-0 textarea',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'dialog', selector: 'body > .fixed.inset-0 .max-w-lg' },
      { name: 'textarea', selector: 'body > .fixed.inset-0 textarea' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the generic default-assistant SOUL editor.',
  },
  {
    id: 'agents-skill-picker-expanded',
    route: '/agents',
    referenceOpen:
      "newAgent(); agentForm('blank'); [...document.querySelectorAll('#overlayCard details')].find(x=>x.textContent.includes('挂载 Skill'))?.setAttribute('open','')",
    sourceOpen: 'agent-create-skill-picker',
    referenceReady: '#overlay.on #overlayCard .skillchips',
    sourceReady: '[data-testid="agent-skill-count"]',
    referenceTargets: [
      { name: 'dialog', selector: '#overlayCard .modal' },
      { name: 'skill-picker', selector: '#overlayCard .skillchips' },
    ],
    sourceTargets: [
      { name: 'dialog', selector: '[data-testid="agent-create-only"]' },
      { name: 'skill-picker', selector: '[data-testid="agent-skill-count"]' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the generic Agent mounted-Skill selector within the editor.',
  },
  {
    id: 'agents-profile-dialog',
    route: '/agents',
    referenceOpen: null,
    sourceOpen: 'unsupported-general-agent-profile',
    referenceReady: '[data-general-agent-profile-dialog]',
    sourceReady: '[data-testid="general-agent-profile-dialog"]',
    referenceTargets: [{ name: 'missing-dialog', selector: '[data-general-agent-profile-dialog]' }],
    sourceTargets: [
      { name: 'missing-dialog', selector: '[data-testid="general-agent-profile-dialog"]' },
    ],
    mapping: 'BLOCKED',
    mappingReason:
      'No reachable non-K12 Agent profile dialog exists in the prototype or current source. K12 profile is out of this non-K12 matrix and must not be substituted.',
  },
  {
    id: 'agents-capability-dialog',
    route: '/agents',
    referenceOpen: null,
    sourceOpen: 'unsupported-general-agent-capability',
    referenceReady: '[data-general-agent-capability-dialog]',
    sourceReady: '[data-testid="general-agent-capability-dialog"]',
    referenceTargets: [
      { name: 'missing-dialog', selector: '[data-general-agent-capability-dialog]' },
    ],
    sourceTargets: [
      { name: 'missing-dialog', selector: '[data-testid="general-agent-capability-dialog"]' },
    ],
    mapping: 'BLOCKED',
    mappingReason:
      'No reachable non-K12 Agent capability dialog exists in either leg. K12 subject capabilities are intentionally excluded.',
  },
  {
    id: 'knowledge-add-document',
    route: '/knowledge',
    referenceOpen: 'addDoc()',
    sourceOpen: 'knowledge-add',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="knowledge-add-document-modal"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'dialog', selector: '[data-testid="knowledge-add-document-modal"]' },
      {
        name: 'drop-zone',
        selector:
          '[data-testid="knowledge-add-document-modal"] .knowledge-add-document-modal__drop',
      },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the add/upload document form.',
  },
  {
    id: 'knowledge-document-detail',
    route: '/knowledge',
    referenceOpen: 'openDocDetail()',
    sourceOpen: 'knowledge-detail',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: 'body > .fixed.inset-0 .max-w-3xl',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: 'body > .fixed.inset-0 .max-w-3xl' },
    ],
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs use the same named fixture document and expose its detail/content state.',
  },
  {
    id: 'automation-task-editor',
    route: '/automation',
    referenceOpen: 'newTask()',
    sourceOpen: 'automation-task',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.hc-modal-overlay .hc-modal',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: '.hc-modal-overlay' },
      { name: 'dialog', selector: '.hc-modal-overlay .hc-modal' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the scheduled-task create editor.',
  },
  {
    id: 'automation-webhook-editor',
    route: '/automation/webhooks',
    referenceOpen: 'addWebhook()',
    sourceOpen: 'automation-webhook',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.webhook-modal__body',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: '.webhook-modal__body' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the generic Webhook create form.',
  },
  {
    id: 'automation-workflow-step-editor',
    route: '/automation/workflows',
    referenceOpen: null,
    sourceOpen: 'automation-workflow-step',
    referenceReady: '#overlay.on .wfp-modal',
    sourceReady: '.wfp-modal',
    referenceTargets: [{ name: 'missing-dialog', selector: '#overlay.on .wfp-modal' }],
    sourceTargets: [
      { name: 'overlay', selector: '.wfp-modal-overlay' },
      { name: 'dialog', selector: '.wfp-modal' },
    ],
    mapping: 'BLOCKED',
    mappingReason:
      'Prototype workflow “编辑” buttons have no handler and no addressable step-editor modal. Source is captured, but no authoritative reference state exists.',
  },
  {
    id: 'connections-channel-picker',
    route: '/channels',
    referenceOpen: "openAddConnection('channel')",
    sourceOpen: 'channel-picker',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.hc-im-overlay .hc-im-modal',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: '.hc-im-overlay' },
      { name: 'dialog', selector: '.hc-im-modal' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the channel/account platform picker.',
  },
  {
    id: 'connections-connector-picker',
    route: '/channels',
    referenceOpen: "openAddConnection('connector')",
    sourceOpen: 'connector-picker',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.hc-im-overlay .hc-im-modal',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: '.hc-im-overlay' },
      { name: 'dialog', selector: '.hc-im-modal' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the data-connector picker.',
  },
  {
    id: 'integration-skill-install-modal',
    route: '/integration',
    referenceOpen: 'installSkill()',
    sourceOpen: 'skill-install',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: 'body > .fixed.inset-0',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: 'body > .fixed.inset-0 > div.relative' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the Skill file/URL install dialog.',
  },
  {
    id: 'integration-skill-ai-create',
    route: '/integration',
    referenceOpen: null,
    sourceOpen: 'skill-ai-create',
    referenceReady: '[data-skill-ai-create-dialog]',
    sourceReady: 'textarea',
    referenceTargets: [{ name: 'missing-dialog', selector: '[data-skill-ai-create-dialog]' }],
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: 'body > .fixed.inset-0 textarea' },
    ],
    mapping: 'BLOCKED',
    mappingReason:
      'The prototype install dialog only describes a deep link into conversational creation and has no independently addressable AI-create dialog.',
  },
  {
    id: 'integration-skill-preview',
    route: '/integration',
    referenceOpen: "skillPreviewDemo('翻译润色','installed')",
    sourceOpen: 'skill-preview',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.skill-preview__panel',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: '.skill-preview__overlay' },
      { name: 'dialog', selector: '.skill-preview__panel' },
    ],
    mapping: 'COMPARABLE',
    mappingReason:
      'Both legs expose the installed “翻译润色” Skill preview using a deterministic content fixture.',
  },
  {
    id: 'integration-prompt-editor',
    route: '/integration/prompts',
    referenceOpen: 'newPrompt()',
    sourceOpen: 'prompt-editor',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="prompt-editor-dialog"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: '[data-testid="prompt-editor-dialog"]' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose a blank Prompt create editor.',
  },
  {
    id: 'settings-model-manager',
    route: '/settings',
    referenceOpen:
      "document.querySelector('[data-provider-catalog-manage]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))",
    sourceOpen: 'settings-model-manager',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '.mm-modal',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: '.mm-overlay' },
      { name: 'dialog', selector: '.mm-modal' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose OpenAI provider model catalog management.',
  },
  {
    id: 'settings-custom-model',
    route: '/settings',
    referenceOpen: 'openCustomProviderModel()',
    sourceOpen: 'settings-custom-model',
    referenceReady: '#overlay.on #overlayCard .modal',
    sourceReady: '[data-testid="custom-model-dialog"]',
    referenceTargets: modalTargets('#overlayCard .modal'),
    sourceTargets: [
      { name: 'overlay', selector: 'body > .fixed.inset-0' },
      { name: 'dialog', selector: '[data-testid="custom-model-dialog"]' },
    ],
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the custom model form for a configured provider.',
  },
  {
    id: 'logs-detail-drawer',
    route: '/logs',
    referenceOpen: 'openLogDetail(document.querySelector(\'.screen[data-pane="logs"] .logrow\'))',
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
    mapping: 'COMPARABLE',
    mappingReason: 'Both legs expose the same frozen first log entry and detail drawer.',
  },
]

const fixtureAgents = [
  {
    name: 'daily-report',
    display_name: '日报分析师',
    description: 'cron 日报专用 · 简洁理性',
    provider: 'openai',
    model: 'gpt-4o',
    metadata: { avatar: '📊' },
  },
]

const fixtureDocuments = [
  {
    id: 'kb-class-notes',
    title: '课堂笔记.pdf',
    source: 'fixture',
    content: '课堂笔记固定内容：小数乘法与进位。',
    chunk_count: 12,
    created_at: NOW,
    status: 'indexed',
    vector_index_state: 'ready',
  },
]

const fixtureSkills = [
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
]

const fixtureModels = [
  { id: 'gpt-4.1', name: 'gpt-4.1', capabilities: ['text', 'tools'] },
  { id: 'gpt-4o', name: 'gpt-4o', capabilities: ['text', 'vision'] },
  { id: 'o3', name: 'o3', capabilities: ['text', 'reasoning'] },
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
        apiKey: 'fixture-redacted',
        baseUrl: 'https://api.openai.com/v1',
        models: fixtureModels,
      },
    ],
  },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function runtimeFixture(apiPath: string, method: string): unknown {
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return sourceConfig
  if (apiPath === '/api/v1/config/llm') return sourceConfig.llm
  if (apiPath === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return {
      system_prompt: '你是小蟹，一个本地优先的通用助理。',
      is_custom: true,
      default_prompt: '你是小蟹。',
    }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents: fixtureAgents, total: fixtureAgents.length, default: 'daily-report' }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/knowledge/documents') {
    return {
      documents: fixtureDocuments,
      total: fixtureDocuments.length,
      limit: 50,
      offset: 0,
      sources: [],
    }
  }
  if (apiPath === '/api/v1/knowledge/documents/kb-class-notes') {
    return fixtureDocuments[0]
  }
  if (apiPath === '/api/v1/knowledge/documents/kb-class-notes/content') {
    return { content: fixtureDocuments[0]!.content }
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
  if (apiPath === '/api/v1/cron/jobs') return { jobs: [], total: 0 }
  if (apiPath === '/api/v1/webhooks') return { webhooks: [], k12_bindings: [], total: 0 }
  if (apiPath === '/api/v1/autonomy/summary') {
    return { tasks: [], pending: [], decisions: [], grants: [] }
  }
  if (apiPath === '/api/v1/canvas/workflows') {
    return {
      workflows: [
        {
          id: 'workflow-daily',
          name: '每日飞书日报',
          nodes: [
            {
              id: 'input',
              type: 'input',
              label: '定时触发',
              x: 0,
              y: 0,
              config: { value: '{{input}}' },
            },
            {
              id: 'agent',
              type: 'agent',
              label: '日报分析师',
              x: 220,
              y: 0,
              config: { prompt: '总结昨日数据' },
            },
            { id: 'output', type: 'output', label: '完成', x: 440, y: 0, config: {} },
          ],
          edges: [
            { id: 'e1', from: 'input', to: 'agent' },
            { id: 'e2', from: 'agent', to: 'output' },
          ],
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    }
  }
  if (apiPath === '/api/v1/canvas/panels') return { panels: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/platforms/instances/health') return { instances: [] }
  if (apiPath === '/api/v1/connectors') return { connectors: [] }
  if (apiPath === '/api/v1/connections') return { connections: [], total: 0 }
  if (apiPath === '/api/v1/skills') {
    return { dir: '/tmp/hexclaw-skills', skills: fixtureSkills, total: fixtureSkills.length }
  }
  if (apiPath === '/api/v1/skills/translate-polish/content') {
    return {
      content:
        '---\nname: translate-polish\ndescription: 专业翻译和文本润色\n---\n\n# 翻译润色\n\n保留专有名词与代码。',
    }
  }
  if (apiPath === '/api/v1/clawhub/search') return { skills: [], total: 0 }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
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
  if (apiPath.startsWith('/api/k12/')) return { items: [] }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page) {
  await page.addInitScript(
    ({ config, notifications }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('app_config', JSON.stringify(config))
      localStorage.setItem(
        'hc-store-notifications',
        JSON.stringify({ v: 1, d: { items: notifications } }),
      )

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
            if (!response.ok)
              throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
            return response.text()
          }
          return null
        },
      }
      desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, id: number) => unregisterCallback(id),
      }
    },
    { config: sourceConfig, notifications: notificationFixture },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'general-modals-matrix' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    return json(route, runtimeFixture(apiPath, route.request().method()))
  })
}

async function clickFirst(page: Page, selector: string, name?: string) {
  const locator = name
    ? page.locator(selector).filter({ hasText: name }).first()
    : page.locator(selector).first()
  await locator.waitFor({ state: 'visible', timeout: 8_000 })
  await locator.click({ timeout: 8_000 })
}

async function openReference(page: Page, surface: Surface): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
    if (surface.referenceOpen) {
      await page.evaluate((script) => {
        const run = new Function(script)
        run()
      }, surface.referenceOpen)
    }
    await page.locator(surface.referenceReady).first().waitFor({ state: 'visible', timeout: 3_000 })
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
  if (action === 'notification') {
    await page.getByTestId('notif-bell').click({ timeout: 3_000 })
  } else if (action === 'command-palette') {
    await page.keyboard.press('Meta+k')
  } else if (action === 'agent-create-choice') {
    await clickFirst(page, 'button', '新建智能体')
  } else if (action === 'agent-create-editor') {
    await clickFirst(page, 'button', '新建智能体')
    await page.getByTestId('start-blank').click({ timeout: 3_000 })
  } else if (action === 'agent-create-skill-picker') {
    await clickFirst(page, 'button', '新建智能体')
    await page.getByTestId('start-blank').click({ timeout: 3_000 })
    await page.getByTestId('agent-add-adv-toggle').click({ timeout: 3_000 })
  } else if (action === 'agent-edit-advanced') {
    await clickFirst(page, '.hc-agent-card__footer button', '编辑')
    await page.getByTestId('agent-adv-toggle').click({ timeout: 3_000 })
  } else if (action === 'agent-soul') {
    await clickFirst(page, 'button', '编辑人设')
  } else if (action.startsWith('unsupported-general-agent-')) {
    throw new Error(
      `${action}: no non-K12 prototype/source entry exists; K12 dialogs are out of scope`,
    )
  } else if (action === 'knowledge-add') {
    await clickFirst(page, 'button', '添加文档')
  } else if (action === 'knowledge-detail') {
    await page.getByTestId('knowledge-doc-card').first().click()
  } else if (action === 'automation-task') {
    await clickFirst(page, 'button', '新建任务')
  } else if (action === 'automation-webhook') {
    await clickFirst(page, 'button', '新建 Webhook')
  } else if (action === 'automation-workflow-step') {
    await page.locator('.wf-node').first().locator('.wf-op').nth(2).click({ timeout: 3_000 })
  } else if (action === 'channel-picker') {
    await clickFirst(page, 'button', '添加')
  } else if (action === 'connector-picker') {
    const tabs = page.locator('.hc-segmented button')
    await tabs.filter({ hasText: '数据连接器' }).first().click()
    await clickFirst(page, 'button', '添加')
  } else if (action === 'skill-install') {
    // Route query opens the exact install dialog; no toolbar indirection needed.
  } else if (action === 'skill-ai-create') {
    // Route query opens the exact AI-create dialog; no private component access.
  } else if (action === 'skill-preview') {
    await clickFirst(page, '.hc-capability-installed-track button', 'translate-polish')
  } else if (action === 'prompt-editor') {
    await clickFirst(page, 'button', '新建 Prompt')
  } else if (action === 'settings-model-manager') {
    await page.locator('.hc-provider__card-head').first().click({ timeout: 3_000 })
    await clickFirst(page, 'button', '管理模型')
  } else if (action === 'settings-custom-model') {
    await page.locator('.hc-provider__card-head').first().click({ timeout: 3_000 })
    await clickFirst(page, 'button', '自定义')
  } else if (action === 'logs-detail') {
    await page.getByTitle('搜索全部历史').click({ timeout: 3_000 })
    await page.locator('.hc-logs__row').first().click({ timeout: 3_000 })
  } else {
    throw new Error(`unknown source opener: ${action}`)
  }
}

async function openSource(page: Page, surface: Surface): Promise<OpenEvidence> {
  let error: string | null = null
  try {
    await installSourceFixture(page)
    const route =
      surface.sourceOpen === 'skill-install'
        ? '/integration?action=skill-install'
        : surface.sourceOpen === 'skill-ai-create'
          ? '/integration?action=skill-create'
          : surface.route
    await page.goto(`${SOURCE_URL}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    })
    await page.locator('.hc-app').waitFor({ state: 'visible', timeout: 8_000 })
    await openSourceAction(page, surface.sourceOpen)
    const sourceReadyTimeout = surface.sourceOpen === 'skill-ai-create' ? 8_000 : 3_000
    await page
      .locator(surface.sourceReady)
      .first()
      .waitFor({ state: 'visible', timeout: sourceReadyTimeout })
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
      'webkitBackdropFilter',
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

async function captureNotificationVisibleState(page: Page, implementation: boolean) {
  return page.evaluate((isImplementation) => {
    const groupSelector = isImplementation ? '.hc-notifpanel__group' : '#notifPanel .notif-group'
    const itemSelector = isImplementation ? '.hc-notifpanel__item' : '#notifPanel .notif-item'
    const titleSelector = isImplementation ? '.hc-notifpanel__itemtitle' : '.notif-row b'
    const bodySelector = isImplementation ? '.hc-notifpanel__text' : '.notif-body'
    const timeSelector = isImplementation ? '.hc-notifpanel__time' : '.notif-row time'
    const unreadClass = isImplementation ? 'hc-notifpanel__item--unread' : 'unread'
    return {
      groups: [...document.querySelectorAll(groupSelector)].map((node) => node.textContent?.trim()),
      items: [...document.querySelectorAll<HTMLElement>(itemSelector)].map((item) => ({
        title: item.querySelector(titleSelector)?.textContent?.trim(),
        body: item.querySelector(bodySelector)?.textContent?.trim(),
        time: item.querySelector(timeSelector)?.textContent?.trim(),
        read: !item.classList.contains(unreadClass),
      })),
    }
  }, implementation)
}

async function captureNotificationPersistedState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('hc-store-notifications')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { v?: number; d?: { items?: unknown[] } }
    return { version: parsed.v, items: parsed.d?.items ?? [] }
  })
}

async function captureNotificationIconSignature(page: Page, implementation: boolean) {
  return page.evaluate((isImplementation) => {
    const itemSelector = isImplementation ? '.hc-notifpanel__item' : '#notifPanel .notif-item'
    const iconSelector = isImplementation ? '.hc-notifpanel__iconwrap svg' : '.notif-ic svg'
    const actionSelector = isImplementation
      ? '.hc-notifpanel__actions svg'
      : '#notifPanel .notif-actions svg'
    const signature = (svg: SVGElement) => ({
      viewBox: svg.getAttribute('viewBox'),
      paths: [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')),
      circles: [...svg.querySelectorAll('circle')].map((circle) => ({
        cx: circle.getAttribute('cx'),
        cy: circle.getAttribute('cy'),
        r: circle.getAttribute('r'),
      })),
      rects: [...svg.querySelectorAll('rect')].map((rect) => ({
        x: rect.getAttribute('x'),
        y: rect.getAttribute('y'),
        width: rect.getAttribute('width'),
        height: rect.getAttribute('height'),
        rx: rect.getAttribute('rx'),
      })),
    })
    return {
      items: [...document.querySelectorAll<HTMLElement>(itemSelector)].map((item) => {
        const svg = item.querySelector<SVGElement>(iconSelector)
        return svg ? signature(svg) : null
      }),
      actions: [...document.querySelectorAll<SVGElement>(actionSelector)].map(signature),
    }
  }, implementation)
}

async function commonPanelClip(referencePage: Page, sourcePage: Page) {
  const reference = await referencePage.locator('#notifPanel').boundingBox()
  const source = await sourcePage.locator('.hc-notifpanel').boundingBox()
  if (!reference || !source) throw new Error('notification panel bounding box unavailable')
  const x = Math.floor(Math.min(reference.x, source.x))
  const y = Math.floor(Math.min(reference.y, source.y))
  const right = Math.ceil(Math.max(reference.x + reference.width, source.x + source.width))
  const bottom = Math.ceil(Math.max(reference.y + reference.height, source.y + source.height))
  return { x, y, width: right - x, height: bottom - y }
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
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('pixel diff image decode failed'))
          img.src = `data:image/png;base64,${data}`
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
  const evidenceDir =
    surface.id === 'shell-notification-drawer'
      ? path.join(NOTIFICATION_EVIDENCE_ROOT, testInfo.project.name)
      : path.join(EVIDENCE_ROOT, testInfo.project.name, surface.id)
  await mkdir(evidenceDir, { recursive: true })
  const referencePath = path.join(evidenceDir, 'reference.png')
  const sourcePath = path.join(evidenceDir, 'current-source.png')
  const diffPath = path.join(evidenceDir, 'pixel-diff.png')

  const { context, referencePage, sourcePage } = await useEvidencePages(browser)
  try {
    if (surface.id === 'shell-notification-drawer') {
      await referencePage.clock.install({ time: NOTIFICATION_NOW })
      await sourcePage.clock.install({ time: NOTIFICATION_NOW })
    }
    const referenceOpen = await openReference(referencePage, surface)
    const sourceOpen = await openSource(sourcePage, surface)

    const notificationClip =
      surface.id === 'shell-notification-drawer'
        ? await commonPanelClip(referencePage, sourcePage)
        : undefined
    await referencePage.screenshot({
      path: referencePath,
      animations: 'disabled',
      clip: notificationClip,
    })
    await sourcePage.screenshot({
      path: sourcePath,
      animations: 'disabled',
      clip: notificationClip,
    })
    const pixelDiff = await runPixelDiff(referencePath, sourcePath, diffPath, referencePage)
    const referenceGeometry = await captureGeometry(referencePage, surface.referenceTargets)
    const sourceGeometry = await captureGeometry(sourcePage, surface.sourceTargets)
    const notificationState =
      surface.id === 'shell-notification-drawer'
        ? {
            fixedNow: NOTIFICATION_NOW.toISOString(),
            fixture: notificationFixture,
            reference: await captureNotificationVisibleState(referencePage, false),
            currentSource: await captureNotificationVisibleState(sourcePage, true),
            currentSourcePersisted: await captureNotificationPersistedState(sourcePage),
            icons: {
              reference: await captureNotificationIconSignature(referencePage, false),
              currentSource: await captureNotificationIconSignature(sourcePage, true),
            },
          }
        : undefined
    if (notificationState) {
      const expectedTitles = notificationFixture.map((item) => item.title)
      const expectedBodies = notificationFixture.map((item) => item.body)
      const expectedRead = notificationFixture.map((item) => item.read)
      expect(notificationState.reference.groups).toEqual(['今天', '更早'])
      expect(notificationState.currentSource.groups).toEqual(['今天', '更早'])
      expect(notificationState.reference.items.map((item) => item.title)).toEqual(expectedTitles)
      expect(notificationState.currentSource.items.map((item) => item.title)).toEqual(
        expectedTitles,
      )
      expect(notificationState.reference.items.map((item) => item.body)).toEqual(expectedBodies)
      expect(notificationState.currentSource.items.map((item) => item.body)).toEqual(expectedBodies)
      expect(notificationState.reference.items.map((item) => item.read)).toEqual(expectedRead)
      expect(notificationState.currentSource.items.map((item) => item.read)).toEqual(expectedRead)
      expect(notificationState.currentSource.items.map((item) => item.time)).toEqual(
        notificationState.reference.items.map((item) => item.time),
      )
      expect(notificationState.icons.currentSource.items).toEqual(
        notificationState.icons.reference.items,
      )
      expect(notificationState.currentSourcePersisted).toEqual({
        version: 1,
        items: notificationFixture,
      })
    }
    const effectiveMapping: Mapping =
      surface.mapping === 'COMPARABLE' && referenceOpen.ok && sourceOpen.ok
        ? 'COMPARABLE'
        : 'BLOCKED'
    const status: ResultStatus =
      effectiveMapping === 'BLOCKED'
        ? 'BLOCKED/RED'
        : pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PASS'
          : 'RED'
    const result = {
      id: surface.id,
      status,
      declaredMapping: surface.mapping,
      effectiveMapping,
      mappingReason: surface.mappingReason,
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
      state: notificationState,
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
      },
    }
    await writeFile(
      path.join(evidenceDir, 'geometry-style.json'),
      JSON.stringify({ reference: referenceGeometry, currentSource: sourceGeometry }, null, 2),
    )
    await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2))

    await testInfo.attach(`${surface.id}-result`, {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
    await testInfo.attach(`${surface.id}-reference`, {
      body: await readFile(referencePath),
      contentType: 'image/png',
    })
    await testInfo.attach(`${surface.id}-current-source`, {
      body: await readFile(sourcePath),
      contentType: 'image/png',
    })
    await testInfo.attach(`${surface.id}-pixel-diff`, {
      body: await readFile(diffPath),
      contentType: 'image/png',
    })

    expect(
      status,
      `${surface.id}: ${status}; changed=${(pixelDiff.changed_pixel_ratio * 100).toFixed(
        4,
      )}%; mapping=${effectiveMapping}; reason=${surface.mappingReason}; referenceOpen=${referenceOpen.error ?? 'ok'}; sourceOpen=${sourceOpen.error ?? 'ok'}`,
    ).toBe('PASS')
  } finally {
    await context.close()
  }
}

test.describe('feat/v0.5.0-k12-parent-tutor — non-K12 modal/drawer visual matrix', () => {
  for (const surface of surfaces) {
    test(`${surface.id} emits reference/current/diff/geometry evidence`, async ({
      browser,
    }, testInfo) => {
      await exerciseSurface(browser, surface, testInfo)
    })
  }
})
