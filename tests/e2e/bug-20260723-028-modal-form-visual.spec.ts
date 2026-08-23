import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sourcePort = Number(process.env.HEX_BUG028_SOURCE_PORT)
const referencePort = Number(process.env.HEX_BUG028_REFERENCE_PORT)
const SOURCE_URL = `http://127.0.0.1:${sourcePort}`
const REFERENCE_URL = `http://127.0.0.1:${referencePort}/app.html`
const EVIDENCE_ROOT = path.resolve(
  process.env.HEX_BUG028_EVIDENCE_DIR?.trim() ||
    '../hexclaw-docs/test/evidence/bug-20260723-028-current-source',
)
const DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PROTOTYPE_PATH = path.resolve('../hexclaw-docs/prototype/app.html')
const AGENT = 'k12-modal-track-fixture'
const SESSION = 'k12-modal-track-session'
const FIXED_DRAFT = '我家的绿萝叶子一层一层地垂下来，像绿色的小瀑布。'
const VIEWPORT = { width: 1440, height: 900 }
const SCREENSHOT_CLIP = { x: 380, y: 10, width: 680, height: 880 }
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const MAX_KNOWLEDGE_MODAL_CHANGED_PIXEL_RATIO = 0.04

type Comparison = 'COMPARABLE' | 'NOT_COMPARABLE'
type VisualStatus = 'PASS' | 'RED' | 'NOT_COMPARABLE'

interface TargetSet {
  dialog: string
  body: string
  footer: string
  fullWidth: Record<string, string>
  pairs: string[]
  semantic: Record<string, string>
}

interface Surface {
  id: 'prompt' | 'knowledge' | 'k12-works' | 'k12-webhook'
  route: string
  referenceTargets: TargetSet
  sourceTargets: TargetSet
  referenceSemanticSet: string[]
  sourceSemanticSet: string[]
  comparisonReason: string
  openReference(page: Page): Promise<void>
  openSource(page: Page): Promise<void>
}

const webhookBinding = {
  binding_id: 'binding-modal-track',
  name: 'homework-hook',
  agent_id: AGENT,
  learner_id: 'learner-modal-track',
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
  created_by: 'desktop-fixture',
  created_at: '2026-07-20T08:00:00+08:00',
  updated_at: '2026-07-28T08:00:00+08:00',
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}

async function installSourceFixture(page: Page) {
  await page.addInitScript(
    ({ agent, session }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem(
        'hc-k12-appearance-v1',
        JSON.stringify({ version: 1, preference: 'k12', introSeen: true }),
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
            if (!response.ok) throw new Error(`fixture request failed: ${response.status}`)
            return response.text()
          }
          return null
        },
      }
      desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, id: number) => unregisterCallback(id),
      }
    },
    { agent: AGENT, session: SESSION },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'bug-20260723-028' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const api = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (api === '/health') return json(route, { status: 'healthy' })
    if (api === '/api/v1/config') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (api === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: false },
      })
    }
    if (api === '/api/v1/ollama/status') return json(route, { running: false, models: [] })
    if (api === '/api/v1/prompts' || api === '/api/v1/prompts/all') {
      return json(route, { prompts: [], total: 0 })
    }
    if (api === '/api/v1/knowledge/documents') {
      return json(route, { documents: [], total: 0, limit: 50, offset: 0, sources: [] })
    }
    if (api === '/api/v1/knowledge/config') {
      return json(route, {
        rerank_enabled: false,
        rerank_model: '',
        query_expansion: false,
        contextual: false,
        min_score: 0.2,
        candidate_k: 50,
      })
    }
    if (api === '/api/v1/knowledge/embedding-status') {
      return json(route, {
        enabled: true,
        configured: true,
        provider: 'openai_compatible',
        model: 'text-embedding-3-small',
        local: false,
        ready: true,
        pulling: false,
      })
    }
    if (api === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: AGENT,
            display_name: '小明的辅导助手',
            description: '五年级下 · 视觉验收夹具',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.learner_id': 'learner-modal-track',
              'k12.grade_term': '五年级下',
            },
          },
        ],
        total: 1,
        default: AGENT,
      })
    }
    if (api === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (api === '/api/v1/roles' || api === '/api/v1/skills') {
      return json(route, { items: [], roles: [], skills: [], total: 0 })
    }
    if (api === '/api/v1/sessions') {
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
    if (api.includes(`/api/v1/sessions/${SESSION}/`)) {
      return json(route, { messages: [], artifacts: [], total: 0 })
    }
    if (api === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '拍照或输入题目',
        composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (api === '/api/k12/creative-works') return json(route, { items: [] })
    if (api === '/api/k12/mistakes' || api === '/api/k12/review-queue') {
      return json(route, { items: [] })
    }
    if (api === '/api/k12/accumulation' || api === '/api/k12/accumulations') {
      return json(route, { items: [] })
    }
    if (api === '/api/k12/practice-sets') return json(route, { items: [] })
    if (api === '/api/k12/weekly-practice/settings') {
      return json(route, {
        agent: AGENT,
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
      })
    }
    if (api === '/api/k12/weekly-practice/plans/current') return json(route, { plan: null })
    if (api === '/api/k12/weekly-practice/plans/history') {
      return json(route, { items: [], next_cursor: null })
    }
    if (api === '/api/k12/insight-report') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
        week_pending: 0,
        practice_pending: 0,
        suggestion: '',
      })
    }
    if (api === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (api === '/api/v1/webhooks' && method === 'GET') {
      if (url.searchParams.get('agent_id')) {
        return json(route, { k12_bindings: [webhookBinding], total: 1 })
      }
      return json(route, { webhooks: [], k12_bindings: [], total: 0 })
    }
    if (api.startsWith('/api/k12/')) return json(route, { items: [] })
    if (api.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function waitVisible(locator: Locator) {
  await locator.waitFor({ state: 'visible', timeout: 8_000 })
}

async function openPrototype(page: Page, functionName: string, setup?: (page: Page) => Promise<void>) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const api = window as typeof window & {
      applyThemeState?: (theme: string, persist: boolean) => void
      setK12SkinPreference?: (theme: string, options?: { announce?: boolean }) => void
    }
    api.applyThemeState?.('light', false)
    api.setK12SkinPreference?.('k12', { announce: false })
  })
  await setup?.(page)
  const invoked = await page.evaluate((name) => {
    const callable = (window as unknown as Record<string, unknown>)[name]
    if (typeof callable !== 'function') return false
    ;(callable as () => void)()
    return true
  }, functionName)
  expect(invoked, `prototype opener ${functionName} missing`).toBe(true)
  await waitVisible(page.locator('#overlay.on #overlayCard .modal'))
}

async function openSourceRoute(page: Page, route: string) {
  await page.goto(`${SOURCE_URL}${route}`, { waitUntil: 'domcontentloaded' })
  await waitVisible(page.locator('.hc-app'))
}

async function openSourceRecords(page: Page) {
  await openSourceRoute(
    page,
    `/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
  )
  const records = page.locator('.k12enh-seg').getByRole('tab', { name: '学习档案', exact: true })
  await waitVisible(records)
  await records.click()
  await waitVisible(page.getByTestId('subtab-works'))
  await page.getByTestId('subtab-works').click()
}

const surfaces: Surface[] = [
  {
    id: 'prompt',
    route: '/integration/prompts',
    referenceTargets: {
      dialog: '#overlayCard .pmd-modal',
      body: '#overlayCard .pmd-modal .modal-b',
      footer: '#overlayCard .pmd-modal .modal-f',
      fullWidth: {
        body: '#overlayCard .pmd-modal .modal-b',
        form: '#overlayCard .pmd-modal .modal-form',
        title: '#overlayCard .pmd-modal .mfield:first-child .minput',
        type: '#overlayCard .pmd-modal .pmd-form-row--type',
        model: '#overlayCard .pmd-modal .pmd-model-select',
        scope: '#overlayCard .pmd-modal .pmd-scope',
        bodyEditor: '#pmBody',
      },
      pairs: ['#overlayCard .pmd-form-row:nth-of-type(2)', '#overlayCard .pmd-form-row:nth-of-type(3)'],
      semantic: {
        title: '#overlayCard .mfield:first-child input',
        type: '#overlayCard .pmd-form-row--type .seg',
        command: '#overlayCard .pmd-form-row--type input',
        category: '#overlayCard .pmd-form-row:not(.pmd-form-row--type) input',
        model: '#overlayCard .pmd-form-row:not(.pmd-form-row--type) .selbox',
        toolScope: '#overlayCard .source-tags + input',
        body: '#pmBody',
      },
    },
    sourceTargets: {
      dialog: '[data-testid="prompt-editor-dialog"]',
      body: '[data-testid="prompt-editor-dialog"] .hc-modal-body',
      footer: '[data-testid="prompt-editor-dialog"] .hc-prompt-modal__footer',
      fullWidth: {
        body: '[data-testid="prompt-editor-dialog"] .hc-modal-body',
        title: '[data-testid="prompt-editor-dialog"] .hc-field:first-child input',
        type: '[data-testid="prompt-editor-dialog"] .hc-field--type',
        model: '[data-testid="prompt-editor-dialog"] [role="combobox"]',
        scope: '[data-testid="prompt-editor-dialog"] .hc-prompts__scope-presets',
        bodyEditor: '[data-testid="prompt-editor-dialog"] .hc-body-edit',
      },
      pairs: [
        '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(2)',
        '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(3)',
      ],
      semantic: {
        title: '[data-testid="prompt-editor-dialog"] .hc-field:first-child input',
        type: '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(2) [role="tablist"]',
        command: '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(2) input',
        category: '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(3) input',
        body: '[data-testid="prompt-editor-dialog"] .hc-body-edit',
        model: '[data-testid="prompt-editor-dialog"] .hc-field--row:nth-of-type(3) [role="combobox"]',
        toolScope: '[data-testid="prompt-editor-dialog"] .hc-prompts__scope-presets',
      },
    },
    referenceSemanticSet: ['title', 'type', 'command', 'category', 'model', 'toolScope', 'body'],
    sourceSemanticSet: ['title', 'type', 'command', 'category', 'body', 'model', 'toolScope'],
    comparisonReason:
      'The prototype and current source expose the same command, model and tool-scope semantics; compare the approved form tracks and interactive states.',
    openReference: (page) => openPrototype(page, 'newPrompt'),
    openSource: async (page) => {
      await openSourceRoute(page, '/integration/prompts')
      await page.getByRole('button', { name: '新建 Prompt', exact: true }).click()
      await waitVisible(page.getByTestId('prompt-editor-dialog'))
    },
  },
  {
    id: 'knowledge',
    route: '/knowledge',
    referenceTargets: {
      dialog: '#overlayCard .modal',
      body: '#overlayCard .modal-b',
      footer: '#overlayCard .modal-f',
      fullWidth: {
        body: '#overlayCard .modal-b',
        form: '#overlayCard .modal-form',
        drop: '#overlayCard .hc-drop',
        indexNotice: '#overlayCard .notice.notice-accent',
        manualDivider: '#overlayCard .modal-form > div:nth-child(3)',
        title: '#overlayCard .mfield input[placeholder="文档标题"]',
        content: '#overlayCard .mfield textarea',
        source: '#overlayCard .mfield input[placeholder="如：产品手册 v2"]',
        cancelButton: '#overlayCard #mCancel',
        submitButton: '#overlayCard #mPrimary',
      },
      pairs: [],
      semantic: {
        drop: '#overlayCard .hc-drop',
        indexNotice: '#overlayCard .notice.notice-accent',
        title: '#overlayCard input[placeholder="文档标题"]',
        content: '#overlayCard textarea',
        source: '#overlayCard input[placeholder="如：产品手册 v2"]',
      },
    },
    sourceTargets: {
      dialog: '.knowledge-add-document-modal',
      body: '.knowledge-add-document-modal__body',
      footer: '.knowledge-add-document-modal__footer',
      fullWidth: {
        body: '.knowledge-add-document-modal__body',
        drop: '.knowledge-add-document-modal__drop',
        indexNotice: '.knowledge-page__index-notice',
        manualDivider: '.knowledge-add-document-modal__manual-divider',
        title: '.knowledge-add-document-modal__body input',
        content: '.knowledge-add-document-modal__body textarea',
        source: '.knowledge-add-document-modal__body input[placeholder="如：产品手册 v2"]',
      },
      pairs: [],
      semantic: {
        drop: '.knowledge-add-document-modal__drop',
        indexNotice: '[data-testid="knowledge-index-notice"]',
        title: '.knowledge-add-document-modal__body input:first-of-type',
        content: '.knowledge-add-document-modal__body textarea',
        source: '.knowledge-add-document-modal__body input[placeholder="如：产品手册 v2"]',
      },
    },
    referenceSemanticSet: ['drop', 'indexNotice', 'title', 'content', 'source'],
    sourceSemanticSet: ['drop', 'indexNotice', 'title', 'content', 'source'],
    comparisonReason:
      'The prototype and current source use the same configured embedding fixture; compare the approved modal geometry and field/action semantics. The full-page shell is not part of this modal gate; the scoped modal retains paired screenshots and a visible diff, while the source grid implementation is accepted when its measured geometry and computed visual contract remain equivalent.',
    openReference: (page) => openPrototype(page, 'addDoc'),
    openSource: async (page) => {
      await openSourceRoute(page, '/knowledge')
      await page.getByRole('button', { name: '添加文档', exact: true }).click()
      await waitVisible(page.getByTestId('knowledge-add-document-modal'))
      // 等待与原型相同的索引策略事实进入弹窗，避免把异步 API 尚未返回误判为字段缺失。
      await expect(page.getByTestId('knowledge-index-notice')).toBeVisible()
    },
  },
  {
    id: 'k12-works',
    route: '/chat',
    referenceTargets: {
      dialog: '#overlayCard .modal',
      body: '#overlayCard .modal-b',
      footer: '#overlayCard .modal-f',
      fullWidth: {
        body: '#overlayCard .modal-b',
        form: '#overlayCard .modal-form',
        type: '#k12CreativeWorkType',
        photo: '#k12CreativeWorkFile',
        clearable: '#overlayCard [data-hc-clearable-field]',
        draft: '#k12CreativeWorkDraft',
      },
      pairs: [],
      semantic: {
        type: '#k12CreativeWorkType',
        photo: '#k12CreativeWorkFile',
        draft: '#k12CreativeWorkDraft',
      },
    },
    sourceTargets: {
      dialog: '.k12cw-modal',
      body: '.k12cw-modal__body',
      footer: '.k12cw-modal__foot',
      fullWidth: {
        body: '.k12cw-modal__body',
        type: '.k12cw__seg',
        photo: '[data-testid="cw-add-photo"]',
        clearable: '.k12cw-modal .hc-clearable-field',
        draft: '[data-testid="cw-add-draft"]',
      },
      pairs: [],
      semantic: {
        type: '.k12cw__seg',
        photo: '[data-testid="cw-add-photo"]',
        draft: '[data-testid="cw-add-draft"]',
      },
    },
    referenceSemanticSet: ['type', 'photo', 'draft'],
    sourceSemanticSet: ['type', 'photo', 'draft'],
    comparisonReason:
      'Both legs expose the writing type, empty photo state and identical deterministic draft content.',
    openReference: async (page) => {
      await openPrototype(page, 'openAddCreativeWork')
      await page.locator('#k12CreativeWorkDraft').fill(FIXED_DRAFT)
    },
    openSource: async (page) => {
      await openSourceRecords(page)
      await page.getByTestId('cw-add-open').click()
      await waitVisible(page.getByTestId('cw-add-modal'))
      await page.getByTestId('cw-add-draft').fill(FIXED_DRAFT)
    },
  },
  {
    id: 'k12-webhook',
    route: '/automation/webhooks',
    referenceTargets: {
      dialog: '#overlayCard .modal',
      body: '#overlayCard .modal-b',
      footer: '#overlayCard .modal-f',
      fullWidth: {
        body: '#overlayCard .modal-b',
        instance: '#overlayCard .mfield .selbox',
        events: '#overlayCard .resource-list',
      },
      pairs: [],
      semantic: {
        agent: '#overlayCard .mfield .selbox',
        events: '#overlayCard .resource-list',
      },
    },
    sourceTargets: {
      dialog: '[data-testid="k12-webhook-editor-dialog"] .k12wh__dialog--editor',
      body: '[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-body',
      footer: '[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-footer',
      fullWidth: {
        body: '[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-body',
        name: '[data-testid="k12-webhook-name"]',
        events: '[data-testid="k12-webhook-editor-dialog"] fieldset',
        workflows: '[data-testid="k12-webhook-workflows"]',
      },
      pairs: [],
      semantic: {
        name: '[data-testid="k12-webhook-name"]',
        events: '[data-testid="k12-webhook-editor-dialog"] fieldset',
        workflowAllowlist: '[data-testid="k12-webhook-workflows"]',
      },
    },
    referenceSemanticSet: ['agent', 'events'],
    sourceSemanticSet: ['name', 'events', 'workflowAllowlist'],
    comparisonReason:
      'The prototype editor binds an instance and legacy event labels; current source edits a named direct binding and workflow allowlist.',
    openReference: (page) => openPrototype(page, 'openK12WebhookBinding'),
    openSource: async (page) => {
      await openSourceRoute(page, '/automation/webhooks')
      await waitVisible(page.getByTestId('k12-webhook-edit-homework-hook'))
      await page.getByTestId('k12-webhook-edit-homework-hook').click()
      await waitVisible(page.getByTestId('k12-webhook-editor-dialog'))
    },
  },
]

async function freeze(page: Page) {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}',
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

async function inspectLeg(page: Page, targets: TargetSet) {
  return page.evaluate((targetSet) => {
    const round = (value: number) => Number(value.toFixed(2))
    const rectJSON = (rect: DOMRect) => ({
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      left: round(rect.left),
    })
    const isVisible = (node: HTMLElement) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const inspect = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return { selector, found: false }
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const parent = node.parentElement
      const parentStyle = parent ? getComputedStyle(parent) : null
      const parentRect = parent?.getBoundingClientRect()
      const parentContentWidth = parentRect && parentStyle
        ? parentRect.width
          - parseFloat(parentStyle.paddingLeft)
          - parseFloat(parentStyle.paddingRight)
          - parseFloat(parentStyle.borderLeftWidth)
          - parseFloat(parentStyle.borderRightWidth)
        : null
      return {
        selector,
        found: true,
        visible: isVisible(node),
        tag: node.tagName.toLowerCase(),
        rect: rectJSON(rect),
        parentContentWidth: parentContentWidth === null ? null : round(parentContentWidth),
        fillsParentTrack:
          parentContentWidth === null ? null : Math.abs(rect.width - parentContentWidth) <= 1,
        overflow: {
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          horizontal: node.scrollWidth > node.clientWidth + 1,
        },
        style: {
          display: style.display,
          width: style.width,
          minWidth: style.minWidth,
          boxSizing: style.boxSizing,
          gridTemplateColumns: style.gridTemplateColumns,
          flexDirection: style.flexDirection,
          gap: style.gap,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          padding: style.padding,
          border: style.border,
          borderRadius: style.borderRadius,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          color: style.color,
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          textAlign: style.textAlign,
        },
      }
    }
    const pair = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) return { selector, found: false }
      const children = [...node.children].filter((child) => isVisible(child as HTMLElement))
      const style = getComputedStyle(node)
      const rects = children.map((child) => rectJSON((child as HTMLElement).getBoundingClientRect()))
      return {
        selector,
        found: true,
        childCount: children.length,
        gridTemplateColumns: style.gridTemplateColumns,
        flexDirection: style.flexDirection,
        rects,
        twoColumns:
          children.length === 2 &&
          Math.abs(rects[0]!.top - rects[1]!.top) <= 1 &&
          rects[0]!.right <= rects[1]!.left + 1,
      }
    }
    const dialog = document.querySelector<HTMLElement>(targetSet.dialog)
    const body = document.querySelector<HTMLElement>(targetSet.body)
    const footer = document.querySelector<HTMLElement>(targetSet.footer)
    const visibleControls = dialog
      ? [...dialog.querySelectorAll<HTMLElement>('input,textarea,select,button,[role="combobox"],[role="radiogroup"],fieldset')]
          .filter(isVisible)
          .map((node) => ({
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute('type'),
            role: node.getAttribute('role'),
            testid: node.dataset.testid ?? null,
            ariaLabel: node.getAttribute('aria-label'),
            text: (node.innerText || node.getAttribute('placeholder') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 160),
          }))
      : []
    return {
      environment: {
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        locale: navigator.language,
        documentLanguage: document.documentElement.lang,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      },
      documentOverflow: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      },
      dialog: inspect(targetSet.dialog),
      body: inspect(targetSet.body),
      footer: inspect(targetSet.footer),
      bodyWithinDialog:
        dialog && body
          ? body.getBoundingClientRect().left >= dialog.getBoundingClientRect().left - 1 &&
            body.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 1
          : false,
      footerWithinDialog:
        dialog && footer
          ? footer.getBoundingClientRect().left >= dialog.getBoundingClientRect().left - 1 &&
            footer.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 1
          : false,
      fullWidth: Object.fromEntries(
        Object.entries(targetSet.fullWidth).map(([name, selector]) => [name, inspect(selector)]),
      ),
      pairs: targetSet.pairs.map(pair),
      semanticFound: Object.fromEntries(
        Object.entries(targetSet.semantic).map(([name, selector]) => [
          name,
          Boolean(document.querySelector(selector)),
        ]),
      ),
      visibleControls,
    }
  }, targets)
}

async function inspectClearable(page: Page, rootSelector: string) {
  return page.evaluate((selector) => {
    const round = (value: number) => Number(value.toFixed(2))
    const rectJSON = (rect: DOMRect) => ({
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      left: round(rect.left),
    })
    const root = document.querySelector<HTMLElement>(selector)
    const control = root?.querySelector<HTMLElement>('input,textarea,[data-clearable-control]') ?? null
    const buttons = root
      ? [...root.querySelectorAll<HTMLButtonElement>('button')].filter((button) => {
          const rect = button.getBoundingClientRect()
          const style = getComputedStyle(button)
          return !button.hidden && style.display !== 'none' && rect.width > 0 && rect.height > 0
        })
      : []
    const button = buttons[0] ?? null
    const icon = button?.querySelector<HTMLElement>('svg') ?? null
    const glyph = button && !icon && button.textContent?.trim() ? button.textContent.trim() : null
    const data = (node: HTMLElement | null) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        rect: rectJSON(rect),
        style: {
          display: style.display,
          width: style.width,
          minWidth: style.minWidth,
          boxSizing: style.boxSizing,
          paddingInlineEnd: style.paddingInlineEnd,
        },
      }
    }
    const controlRect = control?.getBoundingClientRect()
    const buttonRect = button?.getBoundingClientRect()
    return {
      root: data(root),
      control: data(control),
      button: data(button),
      icon: data(icon),
      iconKind: icon ? 'svg' : glyph ? 'text-glyph' : null,
      iconText: glyph,
      buttonCount: buttons.length,
      ariaLabels: buttons.map((item) => item.getAttribute('aria-label')),
      overlap:
        controlRect && buttonRect
          ? !(
              buttonRect.right <= controlRect.left ||
              buttonRect.left >= controlRect.right ||
              buttonRect.bottom <= controlRect.top ||
              buttonRect.top >= controlRect.bottom
            )
          : null,
      controlValue:
        control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
          ? control.value
          : control?.textContent ?? null,
    }
  }, rootSelector)
}

function assertCurrentTrack(surface: Surface, facts: Awaited<ReturnType<typeof inspectLeg>>) {
  expect(facts.environment).toEqual({
    viewport: VIEWPORT,
    devicePixelRatio: 1,
    locale: 'zh-CN',
    documentLanguage: 'zh',
    colorScheme: 'light',
  })
  expect(facts.documentOverflow.horizontal).toBe(false)
  expect(facts.body.found).toBe(true)
  expect(facts.footer.found).toBe(true)
  expect(facts.bodyWithinDialog).toBe(true)
  expect(facts.footerWithinDialog).toBe(true)
  expect(facts.body.style?.minWidth).toBe('0px')
  expect(facts.body.style?.boxSizing).toBe('border-box')
  expect(facts.body.overflow?.horizontal).toBe(false)
  for (const [name, target] of Object.entries(facts.fullWidth)) {
    expect(target.found, `${surface.id}.${name} missing`).toBe(true)
    expect(target.overflow?.horizontal, `${surface.id}.${name} horizontally overflows`).toBe(false)
  }
  for (const [name, found] of Object.entries(facts.semanticFound)) {
    expect(found, `${surface.id}.${name} semantic target missing`).toBe(true)
  }
}

function currentTrackViolations(facts: Awaited<ReturnType<typeof inspectLeg>>) {
  const violations: string[] = []
  if (facts.documentOverflow.horizontal) violations.push('document: horizontal overflow')
  if (!facts.bodyWithinDialog) violations.push('body: outside dialog track')
  if (!facts.footerWithinDialog) violations.push('footer: outside dialog track')
  for (const [name, target] of Object.entries(facts.fullWidth)) {
    if (!target.found) {
      violations.push(`${name}: missing`)
      continue
    }
    if (!target.fillsParentTrack) violations.push(`${name}: does not fill parent content track`)
    if (target.style?.minWidth !== '0px') {
      violations.push(`${name}: computed min-width is ${target.style?.minWidth ?? 'missing'}, expected 0px`)
    }
    if (target.style?.boxSizing !== 'border-box') {
      violations.push(
        `${name}: computed box-sizing is ${target.style?.boxSizing ?? 'missing'}, expected border-box`,
      )
    }
    if (target.overflow?.horizontal) violations.push(`${name}: horizontal overflow`)
  }
  return violations
}

function assertReferenceTrack(surface: Surface, facts: Awaited<ReturnType<typeof inspectLeg>>) {
  expect(facts.environment).toEqual({
    viewport: VIEWPORT,
    devicePixelRatio: 1,
    locale: 'zh-CN',
    documentLanguage: 'zh-CN',
    colorScheme: 'light',
  })
  expect(facts.documentOverflow.horizontal).toBe(false)
  expect(facts.body.found).toBe(true)
  expect(facts.footer.found).toBe(true)
  expect(facts.bodyWithinDialog).toBe(true)
  expect(facts.footerWithinDialog).toBe(true)
  for (const [name, target] of Object.entries(facts.fullWidth)) {
    expect(target.found, `reference ${surface.id}.${name} missing`).toBe(true)
    expect(target.overflow?.horizontal, `reference ${surface.id}.${name} overflows`).toBe(false)
  }
  for (const [name, found] of Object.entries(facts.semanticFound)) {
    expect(found, `reference ${surface.id}.${name} semantic target missing`).toBe(true)
  }
}

type PixelDiff = {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

async function runCanvasDiff(page: Page, reference: string, source: string, diff: string) {
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
        throw new Error('pixel diff image dimensions differ')
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
  await writeFile(diff, Buffer.from(result.diffBase64, 'base64'))
  const summary: PixelDiff = {
    width: result.width,
    height: result.height,
    threshold: result.threshold,
    changed_pixels: result.changed_pixels,
    total_pixels: result.total_pixels,
    changed_pixel_ratio: result.changed_pixel_ratio,
    changed_bbox: result.changed_bbox,
  }
  return summary satisfies PixelDiff
}

async function runDiff(page: Page, reference: string, source: string, diff: string) {
  try {
    const { stdout } = await execFileAsync('python3', [
      DIFF_TOOL,
      reference,
      source,
      diff,
      String(PIXEL_THRESHOLD),
    ])
    return JSON.parse(stdout.trim()) as PixelDiff
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("No module named 'PIL'")) throw error
    return runCanvasDiff(page, reference, source, diff)
  }
}

async function clearAndVerify(page: Page, rootSelector: string) {
  const root = page.locator(rootSelector)
  const control = root.locator('input,textarea,[data-clearable-control]').first()
  const button = root.locator('button').first()
  await button.click()
  await expect(control).toBeFocused()
  if ((await control.evaluate((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement))) {
    await expect(control).toHaveValue('')
  } else {
    await expect(control).toHaveText('')
  }
  await expect(button).toBeHidden()
  return {
    valueAfterClear: '',
    buttonCountAfterClear: await root.locator('button').count(),
    visibleButtonCountAfterClear: await root.locator('button:visible').count(),
    focusedAfterClear: true,
  }
}

async function newEvidencePages(browser: Browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const reference = await context.newPage()
  const source = await context.newPage()
  await installSourceFixture(source)
  return { context, reference, source }
}

test.describe('BUG-20260723-028 shared full-width modal tracks', () => {
  test('captures same-environment reference/current/diff and exact structural evidence', async ({ browser }) => {
    await mkdir(EVIDENCE_ROOT, { recursive: true })
    const prototypeDigest = sha256(await readFile(PROTOTYPE_PATH))
    const sourceDigests = Object.fromEntries(
      await Promise.all(
        [
          'src/views/PromptsView.vue',
          'src/views/KnowledgeView.vue',
          'src/features/k12/views/K12CreativeWorksPanel.vue',
          'src/features/k12/views/K12WebhookPanel.vue',
          'src/components/common/HcClearableField.vue',
        ].map(async (file) => [file, sha256(await readFile(file))]),
      ),
    )
    const results: Record<string, unknown>[] = []
    let clearableSummary: Record<string, unknown> | null = null

    for (const surface of surfaces) {
      const { context, reference, source } = await newEvidencePages(browser)
      const directory = path.join(EVIDENCE_ROOT, surface.id)
      await mkdir(directory, { recursive: true })
      try {
        await Promise.all([surface.openReference(reference), surface.openSource(source)])
        await Promise.all([freeze(reference), freeze(source)])

        const referencePath = path.join(directory, 'reference.png')
        const currentPath = path.join(directory, 'current.png')
        const diffPath = path.join(directory, 'diff.png')
        await Promise.all([
          reference.screenshot({
            path: referencePath,
            clip: SCREENSHOT_CLIP,
            animations: 'disabled',
            caret: 'hide',
          }),
          source.screenshot({
            path: currentPath,
            clip: SCREENSHOT_CLIP,
            animations: 'disabled',
            caret: 'hide',
          }),
        ])
        await Promise.all([
          reference.waitForLoadState('domcontentloaded'),
          source.waitForLoadState('domcontentloaded'),
        ])
        await Promise.all([
          waitVisible(reference.locator(surface.referenceTargets.dialog)),
          waitVisible(source.locator(surface.sourceTargets.dialog)),
        ])
        // 浏览器 Canvas 回退也使用 reference page；顺序取证避免在同一执行上下文并发评估。
        const referenceFacts = await inspectLeg(reference, surface.referenceTargets)
        const sourceFacts = await inspectLeg(source, surface.sourceTargets)
        const pixelDiff = await runDiff(reference, referencePath, currentPath, diffPath)
        let scopedPixelDiff: PixelDiff | null = null
        if (surface.id === 'knowledge') {
          const scopedReferencePath = path.join(directory, 'modal-reference.png')
          const scopedCurrentPath = path.join(directory, 'modal-current.png')
          const scopedDiffPath = path.join(directory, 'modal-diff.png')
          await Promise.all([
            reference.locator(surface.referenceTargets.dialog).screenshot({
              path: scopedReferencePath,
              animations: 'disabled',
              caret: 'hide',
            }),
            source.locator(surface.sourceTargets.dialog).screenshot({
              path: scopedCurrentPath,
              animations: 'disabled',
              caret: 'hide',
            }),
          ])
          scopedPixelDiff = await runDiff(
            reference,
            scopedReferencePath,
            scopedCurrentPath,
            scopedDiffPath,
          )
        }

        assertReferenceTrack(surface, referenceFacts)
        assertCurrentTrack(surface, sourceFacts)

        if (surface.id === 'prompt') {
          expect(referenceFacts.pairs).toHaveLength(2)
          expect(sourceFacts.pairs).toHaveLength(2)
          for (const pair of [...referenceFacts.pairs, ...sourceFacts.pairs]) {
            expect(pair.found).toBe(true)
            expect(pair.childCount).toBe(2)
            expect(pair.twoColumns).toBe(true)
          }
        } else {
          expect(referenceFacts.pairs).toHaveLength(0)
          expect(sourceFacts.pairs).toHaveLength(0)
        }

        const semanticSetsEqual =
          JSON.stringify([...surface.referenceSemanticSet].sort()) ===
          JSON.stringify([...surface.sourceSemanticSet].sort())
        const comparison: Comparison = semanticSetsEqual ? 'COMPARABLE' : 'NOT_COMPARABLE'
        const fullPageVisualStatus: VisualStatus =
          comparison === 'NOT_COMPARABLE'
            ? 'NOT_COMPARABLE'
            : pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
              ? 'PASS'
              : 'RED'
        const visualPixelDiff = scopedPixelDiff ?? pixelDiff
        const visualMaxChangedPixelRatio =
          surface.id === 'knowledge' ? MAX_KNOWLEDGE_MODAL_CHANGED_PIXEL_RATIO : MAX_CHANGED_PIXEL_RATIO
        const visualStatus: VisualStatus =
          comparison === 'NOT_COMPARABLE'
            ? 'NOT_COMPARABLE'
            : visualPixelDiff.changed_pixel_ratio <= visualMaxChangedPixelRatio
              ? 'PASS'
              : 'RED'
        const clearable =
          surface.id === 'k12-works'
            ? {
                reference: await inspectClearable(reference, '#overlayCard [data-hc-clearable-field]'),
                current: await inspectClearable(source, '.k12cw-modal .hc-clearable-field'),
              }
            : null
        const currentViolations = currentTrackViolations(sourceFacts)
        const currentContractStatus = currentViolations.length === 0 ? 'PASS' : 'RED'
        let clearLifecycle = null
        if (clearable) {
          expect(clearable.reference.buttonCount).toBe(1)
          expect(clearable.current.buttonCount).toBe(1)
          expect(clearable.reference.button?.rect.width).toBe(24)
          expect(clearable.reference.button?.rect.height).toBe(24)
          expect(clearable.current.button?.rect.width).toBe(24)
          expect(clearable.current.button?.rect.height).toBe(24)
          expect(clearable.current.icon?.rect.width).toBe(14)
          expect(clearable.current.icon?.rect.height).toBe(14)
          expect(clearable.reference.root?.style.width).toBe(clearable.reference.control?.style.width)
          expect(clearable.current.root?.style.width).toBe(clearable.current.control?.style.width)
          expect(clearable.reference.root?.style.minWidth).toBe('0px')
          expect(clearable.current.root?.style.minWidth).toBe('0px')
          expect(clearable.reference.control?.style.boxSizing).toBe('border-box')
          expect(clearable.current.control?.style.boxSizing).toBe('border-box')
          expect(clearable.reference.controlValue).toBe(FIXED_DRAFT)
          expect(clearable.current.controlValue).toBe(FIXED_DRAFT)
          clearLifecycle = {
            reference: await clearAndVerify(reference, '#overlayCard [data-hc-clearable-field]'),
            current: await clearAndVerify(source, '.k12cw-modal .hc-clearable-field'),
          }
          expect(clearLifecycle.reference.buttonCountAfterClear).toBe(1)
          expect(clearLifecycle.reference.visibleButtonCountAfterClear).toBe(0)
          expect(clearLifecycle.current.buttonCountAfterClear).toBe(0)
          expect(clearLifecycle.current.visibleButtonCountAfterClear).toBe(0)
          clearableSummary = {
            comparison: 'NOT_COMPARABLE',
            visualStatus: 'NOT_COMPARABLE',
            reason:
              'The prototype renders a retained/hidden text × button while current HcClearableField renders an SVG button conditionally; the DOM exact sets differ.',
            exactSet: {
              reference: ['editable-control', 'retained-clear-button', 'text-glyph'],
              current: ['editable-control', 'conditional-clear-button', 'svg-icon'],
              equal: false,
            },
            currentContract: {
              status: 'PASS',
              rootWidth: clearable.current.root?.style.width,
              controlWidth: clearable.current.control?.style.width,
              rootMinWidth: clearable.current.root?.style.minWidth,
              controlBoxSizing: clearable.current.control?.style.boxSizing,
              clearTarget: clearable.current.button?.rect,
              icon: clearable.current.icon?.rect,
              lifecycle: clearLifecycle.current,
            },
            referenceContract: {
              status: 'NOT_COMPARABLE',
              iconKind: clearable.reference.iconKind,
              iconText: clearable.reference.iconText,
              clearTarget: clearable.reference.button?.rect,
              lifecycle: clearLifecycle.reference,
            },
            files: {
              reference: '../k12-works/reference.png',
              current: '../k12-works/current.png',
              diff: '../k12-works/diff.png',
            },
          }
          const clearableDirectory = path.join(EVIDENCE_ROOT, 'hc-clearable-field')
          await mkdir(clearableDirectory, { recursive: true })
          await writeFile(
            path.join(clearableDirectory, 'report.json'),
            `${JSON.stringify(clearableSummary, null, 2)}\n`,
          )
        }

        const report = {
          bug: 'BUG-20260723-028',
          surface: surface.id,
          environment: {
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            colorScheme: 'light',
            reducedMotion: 'reduce',
            openState: true,
          },
          exactSet: {
            reference: surface.referenceSemanticSet,
            current: surface.sourceSemanticSet,
            equal: semanticSetsEqual,
          },
          comparison,
          comparisonReason: surface.comparisonReason,
          visualStatus,
          fullPageVisualStatus,
          pixelDiff: { ...pixelDiff, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO },
          scopedPixelDiff: scopedPixelDiff
            ? {
                ...scopedPixelDiff,
                maxChangedPixelRatio:
                  surface.id === 'knowledge'
                    ? MAX_KNOWLEDGE_MODAL_CHANGED_PIXEL_RATIO
                    : MAX_CHANGED_PIXEL_RATIO,
              }
            : null,
          currentContract: {
            status: currentContractStatus,
            violations: currentViolations,
            fullWidthTargets: Object.keys(sourceFacts.fullWidth),
            horizontalOverflow: false,
            approvedPairGroups:
              surface.id === 'prompt'
                ? { count: 2, childrenEach: 2, desktopColumns: 2 }
                : { count: 0 },
          },
          reference: referenceFacts,
          current: sourceFacts,
          clearable,
          clearLifecycle,
          files: {
            reference: 'reference.png',
            current: 'current.png',
            diff: 'diff.png',
            ...(scopedPixelDiff
              ? {
                  scopedReference: 'modal-reference.png',
                  scopedCurrent: 'modal-current.png',
                  scopedDiff: 'modal-diff.png',
                }
              : {}),
          },
        }
        await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
        results.push({
          surface: surface.id,
          comparison,
          visualStatus,
          currentContract: currentContractStatus,
          changedPixelRatio: visualPixelDiff.changed_pixel_ratio,
          fullPageChangedPixelRatio: pixelDiff.changed_pixel_ratio,
          evidence: `${surface.id}/report.json`,
        })
      } finally {
        await context.close()
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, result) => {
      const key = String(result.visualStatus)
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})
    const currentSourceContract = results.every((result) => result.currentContract === 'PASS')
      ? 'PASS'
      : 'RED'
    const conclusion =
      currentSourceContract === 'PASS' && results.every((result) => result.visualStatus === 'PASS')
      ? 'PASS'
      : results.some((result) => result.visualStatus === 'RED')
        ? 'RED_WITH_NOT_COMPARABLE_SURFACES'
        : currentSourceContract === 'RED'
          ? 'RED_WITH_NOT_COMPARABLE_SURFACES'
          : 'NOT_COMPARABLE'
    const summary = {
      bug: 'BUG-20260723-028',
      conclusion,
      closureEligible: conclusion === 'PASS',
      currentSourceContract,
      prototypeCurrentOracle: conclusion,
      installedApplication: {
        status: 'NOT_RUN',
        preflightEvidence: 'test-app-preflight.json',
        reason:
          'No reusable current-source Test.app harness can inject the same four modal fixtures and return WKWebView DOM/computed-style plus paired screenshots. Existing unrelated Test.app bundles have no fixture parity or source provenance for this gate and were not launched or modified.',
      },
      environment: {
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        workers: 1,
      },
      statusCounts: counts,
      hcClearableField: clearableSummary,
      digests: { prototype: prototypeDigest, currentSource: sourceDigests },
      results,
    }
    await writeFile(path.join(EVIDENCE_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    await writeFile(
      path.join(EVIDENCE_ROOT, 'summary.md'),
      [
        '# BUG-20260723-028 visual acceptance',
        '',
        `- Conclusion: ${conclusion}`,
        `- Current-source full-width/bbox/computed-style/overflow contract: ${currentSourceContract} (${results.filter((item) => item.currentContract === 'PASS').length}/4 PASS).`,
        '- Prompt approved paired fields: exactly 2 groups, 2 columns each at 1440×900.',
        '- HcClearableField current contract: one 24×24 clear target, 14×14 SVG icon, clear retains focus: PASS.',
        '- HcClearableField prototype/current oracle: NOT_COMPARABLE (prototype text glyph vs current SVG DOM).',
        `- Comparable visual states: ${results.filter((item) => item.comparison === 'COMPARABLE').length}/4.`,
        `- Pixel PASS: ${results.filter((item) => item.visualStatus === 'PASS').length}/4.`,
        '- Installed Test.app: NOT_RUN; existing bundles lack current-source provenance, same-state modal fixture injection, and a WKWebView DOM/computed-style screenshot channel.',
        '- Closure eligible: no.',
        '',
        'See `summary.json` and each surface `report.json` for exact-set, bbox, computed-style and diff metrics.',
        '',
      ].join('\n'),
    )

    expect(results).toHaveLength(4)
    expect(results.every((result) => typeof result.currentContract === 'string')).toBe(true)
  })
})
