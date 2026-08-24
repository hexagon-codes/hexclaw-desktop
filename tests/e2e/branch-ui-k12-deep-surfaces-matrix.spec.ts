import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { BRANCH_UI_FIDELITY_SURFACES } from './branch-ui-fidelity-manifest'

const execFileAsync = promisify(execFile)
const REF = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SRC = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:15151'
const AGENT = 'k12-deep-fidelity-ming'
const SESSION = 'k12-deep-fidelity-session'
const EVIDENCE =
  process.env.HEX_UI_EVIDENCE_ROOT?.trim() || '/tmp/hexclaw-k12-deep-surfaces-evidence'
const DIFF_TOOL = path.resolve('tests/e2e/tools/k12_visual_pixel_diff.swift')
const MAX_RATIO = 0.001
const STATE_FILTER = process.env.HEX_UI_STATE?.trim() || ''

type Classification = 'COMPARABLE' | 'NOT_COMPARABLE'
type OpenResult = { root?: string; issues?: string[] }
type State = {
  name: string
  manifestIds: string[]
  fixture: string
  classification: Classification
  reason: string
  criticalSelectors?: {
    reference: Record<string, string>
    source: Record<string, string>
  }
  reference(page: Page): Promise<OpenResult>
  source(page: Page): Promise<OpenResult>
}

const tinySvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#dbeafe"/><path d="M130 280 Q320 70 510 280" fill="none" stroke="#2563eb" stroke-width="18"/><circle cx="320" cy="210" r="64" fill="#fff"/></svg>'

const mistake = {
  record_id: 'mistake-apple',
  question: '苹果每千克 4.2 元，买 3 千克共多少钱？',
  knowledge_point: '小数乘法',
  error_cause: '小数点位置错误',
  status: 'reviewing',
  review_state: 'scheduled',
  version: 2,
  due_at: 1785081600,
  subject: '数学',
  review_kind: 'verify',
}
const accumulation = {
  record_id: 'accum-poem',
  subject: '语文',
  entry_type: '好词好句',
  content: '梅须逊雪三分白，雪却输梅一段香。',
  source: '课堂笔记',
  version: 1,
  created_at: 1784995200,
}
const practice = {
  record_id: 'practice-history-1',
  title: '7月20日–7月26日练习卷',
  source_kind: 'weekly',
  status: 'submitted',
  status_label: '已回传',
  publishable: true,
  question_artifact_id: 'artifact-question-1',
  answer_artifact_id: 'artifact-answer-1',
  paper_no: 'P-2630-01',
  finalized_at: 1785081600,
  finalized_via: 'print',
  delivery_status: 'not_sent',
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
      result_correct: false,
      result_evidence: 'system_verified',
    },
  ],
  return_assets: [
    {
      return_id: 'return-1',
      asset_id: 'asset-return-1',
      item_ids: ['history-item-1'],
      returned_at: 1785081600,
      regrade_job_id: 'regrade-1',
      regrade_status: 'completed',
      annotated_asset_id: 'asset-annotated-1',
      result_markdown: '第 1 题移项时符号需要变化，请重新检查。',
      unresolved_item_ids: ['history-item-1'],
      regrade_updated_at: 1785081660,
    },
  ],
}
const work = {
  work_id: 'ART-20260716-001',
  work_type: 'art',
  display_name: '《雨后的校园》',
  source_asset_id: `asset://${AGENT}/asset-work-1`,
  row_version: 1,
  initial_feedback: {
    generation_id: 'REVIEW-ART-20260716-001',
    status: 'succeeded',
    feedback: {
      feedback_id: 'feedback-art',
      feedback_type: 'art',
      evidence_refs: ['evidence-1', 'evidence-2'],
      visible_evidence: ['构图：主体偏右', '色彩：冷暖有层次'],
      affirmation: '雨后校园的颜色有层次。',
      parent_guidance: '请孩子说说最满意的部分。',
      next_step: '下一次只改进一个小地方。',
      source_snapshot: {
        source: 'ai',
        method_ref: 'k12-creative-feedback-v1',
        capability: 'creative-work-feedback',
      },
    },
  },
}
const webhook = {
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

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installMocks(page: Page) {
  await page.addInitScript(
    ({ agent, session }) => {
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
    },
    { agent: AGENT, session: SESSION },
  )
  await page.route('http://localhost:11434/**', (route) => json(route, { models: [] }))
  await page.route('**/_hexclaw/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const api = url.pathname.replace(/^\/_hexclaw/, '')
    const method = req.method()
    if (api.includes('/assets/') && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tinySvg })
    }
    if (api === '/api/v1/config') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (api === '/api/v1/config/llm') return json(route, { default: '', providers: {} })
    if (api === '/api/v1/ollama/status') return json(route, { running: false, models: [] })
    if (api === '/api/v1/agents') {
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
              'k12.textbook_edition.math': '人教版',
            },
          },
        ],
        total: 1,
        default: AGENT,
      })
    }
    if (api === '/api/v1/agents/rules' || api === '/api/v1/roles' || api === '/api/v1/skills') {
      return json(route, { items: [], rules: [], roles: [], skills: [], total: 0 })
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
    if (api === '/api/k12/curriculum-progress') {
      return json(route, {
        progress: {
          progress_id: 'progress-fidelity',
          agent: AGENT,
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
          confirmed_at: '2026-07-20T00:00:00+08:00',
          created_at: '2026-07-20T00:00:00+08:00',
          updated_at: '2026-07-20T00:00:00+08:00',
        },
      })
    }
    if (api === '/api/k12/textbook-binding-options') {
      return json(route, {
        items: [
          {
            manifest_id: 'manifest-pep-5b',
            document_id: 'doc-pep-5b',
            document_generation: 1,
            document_title: '人教版数学五年级下册.pdf',
            state: 'ready_for_confirmation',
            retryable: false,
            failure_message: '',
            text_index_state: 'ready',
            vector_index_state: 'ready',
            catalog: {
              textbook_edition: '人教版',
              textbook_version: '2022',
              title: '义务教育教科书数学',
              volume: '五年级下册',
              page_min: 1,
              page_max: 120,
              units: [{ unit_id: 'unit-4', unit_title: '第4单元「分数的意义和性质」' }],
              page_refs: [],
            },
            updated_at: '2026-07-20T00:00:00+08:00',
          },
        ],
      })
    }
    if (api === '/api/k12/weekly-practice/settings') {
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
    if (api === '/api/k12/weekly-practice/plans/history') {
      return json(route, {
        items: [
          {
            snapshot_id: 'WPS-MING-2026-W30',
            plan_id: 'weekly-2026-30',
            artifact_id: 'artifact-weekly',
            iso_week_year: 2026,
            iso_week_number: 30,
            timezone: 'Asia/Shanghai',
            local_start_date: '2026-07-20',
            local_end_date: '2026-07-26',
            item_count: 8,
            correct_count: 7,
            wrong_count: 1,
            archived_at: '2026-07-27T00:00:00+08:00',
          },
        ],
        next_cursor: null,
      })
    }
    if (/\/api\/k12\/weekly-practice\/snapshots\//.test(api)) {
      return json(route, {
        snapshot: {
          snapshot_id: 'WPS-MING-2026-W30',
          plan_id: 'weekly-2026-30',
          iso_week_year: 2026,
          iso_week_number: 30,
          local_start_date: '2026-07-20',
          local_end_date: '2026-07-26',
          item_count: 8,
          correct_count: 7,
          wrong_count: 1,
          items: [{ position: 1, prompt_markdown: '解方程：2x + 15 = 43。' }],
        },
      })
    }
    if (api === '/api/k12/weekly-practice/plans' && method === 'POST') {
      return json(route, { plan: null, replayed: false }, 201)
    }
    if (api === '/api/k12/weekly-practice/plans/current') return json(route, { plan: null })
    if (api === '/api/k12/mistakes' || api === '/api/k12/review-queue') {
      return json(route, { items: [mistake] })
    }
    if (api === '/api/k12/accumulation' || api === '/api/k12/accumulations') {
      return json(route, { items: [accumulation] })
    }
    if (api === '/api/k12/practice-sets') return json(route, { items: [practice] })
    if (/\/api\/k12\/practice-sets\/[^/]+\/paper$/.test(api)) {
      const kind = url.searchParams.get('kind') === 'answer' ? 'answer' : 'question'
      return json(route, {
        kind,
        title: practice.title,
        paper_no: practice.paper_no,
        markdown:
          kind === 'answer'
            ? '# 答案卷\\n\\n1. x = 14\\n\\n---\\n卷面号 P-2630-01'
            : '# 练习卷\\n\\n1. 解方程：2x + 15 = 43。\\n\\n---\\n卷面号 P-2630-01',
        preview: false,
      })
    }
    if (api === '/api/k12/creative-works') return json(route, { items: [work] })
    if (api === '/api/k12/insight-report') {
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
    if (api === '/api/k12/study-time') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (api === '/api/v1/webhooks' && method === 'GET') {
      if (url.searchParams.get('binding_name')) {
        return json(route, {
          receipts: [
            {
              receipt_id: 'receipt-1',
              status: 'delivered',
              job_or_execution_ref: 'job-k12-1',
              retryable: false,
            },
          ],
          total: 1,
        })
      }
      if (url.searchParams.get('agent_id'))
        return json(route, { k12_bindings: [webhook], total: 1 })
      return json(route, { webhooks: [], total: 0 })
    }
    if (/\/api\/v1\/webhooks\/[^/]+\/rotate-secret$/.test(api) && method === 'POST') {
      return json(route, { secret: 'whs_k12_visual_matrix_once', binding: webhook })
    }
    if (api.startsWith('/api/k12/')) return json(route, { items: [] })
    if (api.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function visible(locator: Locator, timeout = 5_000) {
  return locator
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false)
}

async function referenceRecords(page: Page, tab: number): Promise<OpenResult> {
  await page.goto(REF, { waitUntil: 'domcontentloaded' })
  const ok = await page.evaluate((value) => {
    const api = window as typeof window & {
      goRecords?: (learner: string, tab: number) => void
      k12BookTab?: (tab: number) => void
    }
    if (!api.goRecords || !api.k12BookTab) return false
    api.goRecords('ming', value)
    api.k12BookTab(value)
    return true
  }, tab)
  return { root: `#k12BookPanel${tab}`, issues: ok ? [] : ['prototype records API missing'] }
}

async function sourceRecords(page: Page, tab: string): Promise<OpenResult> {
  await page.goto(`${SRC}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`, {
    waitUntil: 'domcontentloaded',
  })
  const scenario = page.locator('.k12enh-seg').getByRole('tab', { name: '学习档案', exact: true })
  const issues: string[] = []
  if (await visible(scenario)) await scenario.click()
  else issues.push('source 学习档案 tab missing')
  const objectTab = page.getByTestId(tab)
  if (await visible(objectTab)) await objectTab.click()
  else issues.push(`source ${tab} missing`)
  return { root: '.k12rec', issues }
}

async function referenceCall(
  page: Page,
  fn: string,
  args: unknown[] = [],
  root = '#overlay',
): Promise<OpenResult> {
  await page.goto(REF, { waitUntil: 'domcontentloaded' })
  const ok = await page.evaluate(
    ({ name, values }) => {
      const callable = (window as unknown as Record<string, unknown>)[name]
      if (typeof callable !== 'function') return false
      ;(callable as (...input: unknown[]) => void)(...values)
      return true
    },
    { name: fn, values: args },
  )
  return { root, issues: ok ? [] : [`prototype ${fn} missing`] }
}

async function sourceChat(page: Page): Promise<OpenResult> {
  await page.goto(`${SRC}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`, {
    waitUntil: 'domcontentloaded',
  })
  return { root: '.hc-page-shell', issues: [] }
}

async function prototypeButtonCall(
  page: Page,
  tab: number,
  selector: string,
  fn: string,
): Promise<OpenResult> {
  const result = await referenceRecords(page, tab)
  const ok = await page.evaluate(
    ({ selector: query, name }) => {
      const element = document.querySelector(query)
      const callable = (window as unknown as Record<string, unknown>)[name]
      if (!element || typeof callable !== 'function') return false
      ;(callable as (node: Element) => void)(element)
      return true
    },
    { selector, name: fn },
  )
  if (!ok) result.issues?.push(`prototype ${fn} opener missing`)
  result.root = '#overlay'
  return result
}

async function clickSource(
  page: Page,
  tab: string,
  opener: string,
  root: string,
  after?: string,
): Promise<OpenResult> {
  const result = await sourceRecords(page, tab)
  const button = page.locator(opener).first()
  if (await visible(button)) await button.click()
  else result.issues?.push(`source opener missing: ${opener}`)
  if (after) {
    const next = page.locator(after).first()
    if (await visible(next)) await next.click()
    else result.issues?.push(`source secondary opener missing: ${after}`)
  }
  result.root = root
  return result
}

async function referenceWeeklyDetail(page: Page): Promise<OpenResult> {
  const result = await referenceRecords(page, 0)
  const ok = await page.evaluate(() => {
    const api = window as typeof window & {
      switchK12WeeklyView?: (view: string) => void
      openWeeklyPracticeHistory?: (id: string) => void
    }
    if (!api.switchK12WeeklyView || !api.openWeeklyPracticeHistory) return false
    api.switchK12WeeklyView('history')
    api.openWeeklyPracticeHistory('WPS-MING-2026-W30')
    return true
  })
  if (!ok) result.issues?.push('prototype weekly history detail API missing')
  result.root = '#overlay'
  return result
}

async function sourceWeeklyDetail(page: Page): Promise<OpenResult> {
  const result = await sourceRecords(page, 'subtab-week')
  const history = page.locator('.weekly-toolbar').getByRole('tab', { name: '历史', exact: true })
  if (await visible(history)) await history.click()
  else result.issues?.push('source weekly history tab missing')
  const detail = page.locator('.weekly-history__card button').first()
  if (await visible(detail)) await detail.click()
  else result.issues?.push('source weekly detail opener missing')
  result.root = '.weekly-history-dialog'
  return result
}

async function referenceWork(page: Page, action: 'detail' | 'add' | 'preview' | 'delete') {
  if (action === 'add') {
    await referenceRecords(page, 4)
    return referenceCallOnLoaded(page, 'openAddCreativeWork', '#overlay')
  }
  const result =
    action === 'preview'
      ? await (async () => {
          const opened = await referenceRecords(page, 4)
          const ok = await page.evaluate(() => {
            const buttons = [
              ...document.querySelectorAll(
                '#k12BookPanel4 button[onclick*="openCreativeWorkDetail"]',
              ),
            ]
            const button =
              buttons.find((node) =>
                node.closest('article,li,div')?.textContent?.includes('雨后的校园'),
              ) ?? buttons[1]
            const callable = (window as unknown as Record<string, unknown>).openCreativeWorkDetail
            if (!button || typeof callable !== 'function') return false
            ;(callable as (node: Element) => void)(button)
            return true
          })
          if (!ok) opened.issues?.push('prototype art work opener missing')
          opened.root = '#overlay'
          return opened
        })()
      : await prototypeButtonCall(
          page,
          4,
          '#k12BookPanel4 .creative-work-card[data-work-id="ART-20260716-001"] button[onclick*="openCreativeWorkDetail"]',
          'openCreativeWorkDetail',
        )
  if (action === 'preview') {
    const ok = await page.evaluate(() => {
      const preview = document.querySelector('#overlay .creative-work-preview')
      const fn = (window as unknown as Record<string, unknown>).openCreativeWorkImagePreview
      if (!preview || typeof fn !== 'function') return false
      ;(fn as (node: Element) => void)(preview)
      return true
    })
    if (!ok) result.issues?.push('prototype work preview opener missing')
    result.root = '#creativeWorkImagePreview'
  } else if (action === 'delete') {
    const ok = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>).requestDeleteCreativeWork
      if (typeof fn !== 'function') return false
      ;(fn as () => void)()
      return true
    })
    if (!ok) result.issues?.push('prototype work delete opener missing')
  }
  return result
}

async function referenceCallOnLoaded(page: Page, fn: string, root: string): Promise<OpenResult> {
  const ok = await page.evaluate((name) => {
    const callable = (window as unknown as Record<string, unknown>)[name]
    if (typeof callable !== 'function') return false
    ;(callable as () => void)()
    return true
  }, fn)
  return { root, issues: ok ? [] : [`prototype ${fn} missing`] }
}

async function sourceWebhook(
  page: Page,
  action: 'panel' | 'history' | 'editor' | 'rotate' | 'secret' | 'delete',
) {
  await page.goto(`${SRC}/automation/webhooks`, { waitUntil: 'domcontentloaded' })
  const result: OpenResult = { root: '[data-testid="k12-webhook-panel"]', issues: [] }
  if (action === 'panel') return result
  const selectors = {
    history: '[data-testid="k12-webhook-history-homework-hook"]',
    editor: '[data-testid="k12-webhook-edit-homework-hook"]',
    rotate: '[data-testid="k12-webhook-rotate-homework-hook"]',
    secret: '[data-testid="k12-webhook-rotate-homework-hook"]',
    delete: '[data-testid="k12-webhook-delete-homework-hook"]',
  }
  const opener = page.locator(selectors[action])
  if (await visible(opener)) await opener.click()
  else result.issues?.push(`source webhook ${action} opener missing`)
  if (action === 'secret') {
    const confirm = page.getByTestId('k12-webhook-rotate-confirm')
    if (await visible(confirm)) await confirm.click()
    else result.issues?.push('source webhook rotate confirmation missing')
  }
  result.root =
    action === 'history'
      ? '[data-testid="k12-webhook-history-dialog"]'
      : action === 'editor'
        ? '[data-testid="k12-webhook-editor-dialog"]'
        : action === 'rotate'
          ? '[data-testid="k12-webhook-rotate-dialog"]'
          : action === 'secret'
            ? '.k12wh__modal:has([data-testid="k12-webhook-secret-close"])'
            : '.hc-dialog[role="alertdialog"]'
  return result
}

const NC = (reason: string): Pick<State, 'classification' | 'reason'> => ({
  classification: 'NOT_COMPARABLE',
  reason,
})
const CMP: Pick<State, 'classification' | 'reason'> = {
  classification: 'COMPARABLE',
  reason: 'same approved user-visible state with deterministic equivalent fixture',
}

const states: State[] = [
  {
    name: 'profile-modal',
    manifestIds: ['k12.profile-modal'],
    fixture: '小明 / 五年级下 / 人教版数学 / confirmed unit',
    ...NC(
      'manifest ledger blocks profile fidelity; source and prototype authority are not equivalent',
    ),
    reference: (page) => referenceCall(page, 'openTutorProfile', ['ming'], '#overlay'),
    source: async (page) => {
      await page.goto(`${SRC}/agents`, { waitUntil: 'domcontentloaded' })
      const button = page.getByRole('button', { name: /编辑档案/ }).first()
      const issues: string[] = []
      if (await visible(button)) await button.click()
      else issues.push('source profile opener missing')
      return { root: '.k12pf[role="dialog"]', issues }
    },
  },
  {
    name: 'capabilities-modal',
    manifestIds: ['k12.capabilities-modal'],
    fixture: '六学科 capability list / deterministic descriptor chips',
    ...CMP,
    reference: (page) => referenceCall(page, 'openK12SubjectCapabilities'),
    source: async (page) => {
      const result = await sourceChat(page)
      const button = page.getByTestId('composer-preset-chip-action').first()
      if (await visible(button)) await button.click()
      else result.issues?.push('source capability opener missing')
      result.root = '[data-testid="k12-capability-dialog"]'
      return result
    },
  },
  {
    name: 'task-progress-collapsed',
    manifestIds: ['k12.task-progress-collapsed'],
    fixture:
      'prototype task shell collapsed; source has no equivalent restorable dispatch in this fixture',
    ...NC(
      'collapsed source requires a persisted real image-task dispatch; static prototype shell is not equivalent',
    ),
    reference: async (page) => {
      await page.goto(REF, { waitUntil: 'domcontentloaded' })
      const ok = await page.evaluate(() => {
        const api = window as typeof window & { goK12Learner?: (key: string) => void }
        api.goK12Learner?.('ming')
        const button = document.querySelector<HTMLButtonElement>(
          '[data-k12-task-shell] .k12-task-shell__toggle',
        )
        button?.click()
        return Boolean(button)
      })
      return { root: '[data-k12-task-shell]', issues: ok ? [] : ['prototype task shell missing'] }
    },
    source: sourceChat,
  },
  {
    name: 'weekly-current-and-state',
    manifestIds: ['k12.weekly-period-tabs', 'k12.weekly-current', 'k12.weekly-state-matrix'],
    fixture: 'current week / source no-plan response; static prototype populated current week',
    ...NC(
      'period contract is blocked and source no-plan fixture is not equivalent to populated prototype',
    ),
    reference: (page) => referenceRecords(page, 0),
    source: (page) => sourceRecords(page, 'subtab-week'),
  },
  {
    name: 'weekly-history-detail',
    manifestIds: ['k12.weekly-history', 'k12.weekly-history-detail-modal'],
    fixture: '2026-W30 / 8 items / 7 correct / 1 wrong',
    ...CMP,
    reference: referenceWeeklyDetail,
    source: sourceWeeklyDetail,
  },
  {
    name: 'mistake-add',
    manifestIds: ['k12.mistake-add-modal'],
    fixture: 'new mistake / math',
    ...CMP,
    reference: async (page) => {
      await referenceRecords(page, 1)
      return referenceCallOnLoaded(page, 'openAddMistake', '#overlay')
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-mistakes',
        '[data-testid="mistake-add-open"]',
        '[data-testid="mistake-add-form"]',
      ),
  },
  {
    name: 'mistake-detail',
    manifestIds: ['k12.mistake-detail-modal'],
    fixture: 'mistake-apple / scheduled review',
    ...CMP,
    reference: (page) =>
      prototypeButtonCall(
        page,
        1,
        '#k12BookPanel1 button[onclick*="openMistakeDetail"]',
        'openMistakeDetail',
      ),
    source: (page) =>
      clickSource(
        page,
        'subtab-mistakes',
        'button:has-text("详情")',
        '[data-testid="mistake-detail"]',
      ),
  },
  {
    name: 'mistake-edit-absent',
    manifestIds: ['k12.mistake-edit-modal'],
    fixture: 'prototype edit modal; source intentionally has no edit modal',
    ...NC('manifest explicitly records missing source edit modal'),
    reference: async (page) => {
      const result = await prototypeButtonCall(
        page,
        1,
        '#k12BookPanel1 button[onclick*="openMistakeDetail"]',
        'openMistakeDetail',
      )
      const edit = page.locator('#overlay button').filter({ hasText: /编辑/ }).first()
      if (await visible(edit, 2_000)) await edit.click()
      else result.issues?.push('prototype edit control not reachable')
      return result
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-mistakes',
        'button:has-text("详情")',
        '[data-testid="mistake-detail"]',
      ),
  },
  {
    name: 'mistake-delete-confirmation',
    manifestIds: ['k12.mistake-review-confirmations'],
    fixture: 'delete mistake-apple confirmation',
    ...CMP,
    reference: async (page) => {
      const result = await prototypeButtonCall(
        page,
        1,
        '#k12BookPanel1 button[onclick*="openMistakeDetail"]',
        'openMistakeDetail',
      )
      const deleteButton = page.locator('#overlay button').filter({ hasText: /删除/ }).last()
      if (await visible(deleteButton)) await deleteButton.click()
      else result.issues?.push('prototype delete confirmation opener missing')
      return result
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-mistakes',
        'button:has-text("详情")',
        '.hc-dialog[role="alertdialog"]',
        '[data-testid="detail-delete"]',
      ),
  },
  {
    name: 'practice-candidate-and-basket',
    manifestIds: ['k12.practice-candidate-selection-modal', 'k12.practice-basket'],
    fixture: 'candidate flow and Friday basket semantics',
    ...NC(
      'manifest blocks basket copy/auto-add semantics; candidate fixture has no equivalent committed source batch',
    ),
    reference: (page) => referenceRecords(page, 2),
    source: (page) => sourceRecords(page, 'subtab-practicesets'),
  },
  {
    name: 'practice-paper',
    manifestIds: ['k12.practice-paper-modal'],
    fixture: 'P-2630-01 question paper',
    ...CMP,
    reference: async (page) => {
      await referenceRecords(page, 2)
      return referenceCallOnLoaded(page, 'openPracticePrintPreview', '#overlay')
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-practicesets',
        '[data-testid="ps-paper-question"]',
        '[data-testid="ps-paper-modal"]',
      ),
  },
  {
    name: 'practice-return',
    manifestIds: ['k12.practice-return-modal'],
    fixture: 'submitted practice / append return photo',
    ...CMP,
    reference: (page) =>
      prototypeButtonCall(
        page,
        2,
        '#k12BookPanel2 button[onclick*="simulatePracticeReturn"]',
        'simulatePracticeReturn',
      ),
    source: (page) =>
      clickSource(
        page,
        'subtab-practicesets',
        '[data-testid="ps-return-open"]',
        '[data-testid="ps-return-modal"]',
      ),
  },
  {
    name: 'practice-manual-grade',
    manifestIds: ['k12.practice-manual-grade-modal'],
    fixture: 'one unresolved math item',
    ...CMP,
    reference: (page) =>
      prototypeButtonCall(
        page,
        2,
        '#k12BookPanel2 button[onclick*="manualRecordResults"]',
        'manualRecordResults',
      ),
    source: (page) =>
      clickSource(
        page,
        'subtab-practicesets',
        '[data-testid="ps-regrade-manual"]',
        '[data-testid="ps-grade-modal"]',
      ),
  },
  {
    name: 'practice-regrade-result',
    manifestIds: ['k12.practice-regrade-result-modal'],
    fixture: 'completed regrade / annotated asset / one unresolved item',
    ...CMP,
    reference: async (page) => {
      await referenceRecords(page, 2)
      return referenceCallOnLoaded(page, 'openPracticeResult', '#overlay')
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-practicesets',
        '[data-testid="ps-regrade-result-open"]',
        '[data-testid="ps-regrade-result-modal"]',
      ),
  },
  {
    name: 'accumulation-add',
    manifestIds: ['k12.accumulation-add-modal'],
    fixture: 'new Chinese accumulation',
    ...CMP,
    reference: async (page) => {
      await referenceRecords(page, 3)
      return referenceCallOnLoaded(page, 'openAddAccumulation', '#overlay')
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-accumulation',
        '[data-testid="accum-add-open"]',
        '[data-testid="accum-add-form"]',
      ),
  },
  {
    name: 'accumulation-detail',
    manifestIds: ['k12.accumulation-detail-modal'],
    fixture: 'accum-poem detail',
    ...CMP,
    reference: (page) =>
      prototypeButtonCall(
        page,
        3,
        '#k12BookPanel3 button[onclick*="openAccumulationDetail"]',
        'openAccumulationDetail',
      ),
    source: (page) =>
      clickSource(
        page,
        'subtab-accumulation',
        '[data-testid^="accum-list-detail-"]',
        '[data-testid="mistake-detail"]',
      ),
  },
  {
    name: 'accumulation-delete-confirm',
    manifestIds: ['k12.accumulation-delete-confirm'],
    fixture: 'delete accum-poem confirmation',
    ...CMP,
    reference: async (page) => {
      const result = await prototypeButtonCall(
        page,
        3,
        '#k12BookPanel3 button[onclick*="openAccumulationDetail"]',
        'openAccumulationDetail',
      )
      const ok = await page.evaluate(() => {
        const fn = (window as unknown as Record<string, unknown>).requestDeleteAccumulation
        if (typeof fn !== 'function') return false
        ;(fn as () => void)()
        return true
      })
      if (!ok) result.issues?.push('prototype accumulation delete opener missing')
      return result
    },
    source: (page) =>
      clickSource(
        page,
        'subtab-accumulation',
        '[data-testid^="accum-list-detail-"]',
        '.hc-dialog[role="alertdialog"]',
        '[data-testid="detail-delete"]',
      ),
  },
  {
    name: 'works-detail',
    manifestIds: ['k12.work-detail-modal'],
    fixture: 'reviewed art work',
    ...NC('manifest blocks works modals behind open works visual gate'),
    criticalSelectors: {
      reference: {
        modal: '#overlayCard .creative-work-detail-modal',
        body: '#overlayCard .creative-work-detail-modal .modal-b',
        feedback: '[data-creative-work-latest-review-host]',
        actions: '[data-creative-work-action-bar]',
      },
      source: {
        modal: '[data-testid="cw-detail-modal"]',
        body: '.k12cw-detail-modal__body',
        feedback: '[data-testid="cw-latest-feedback"]',
        actions: '[data-testid="cw-action-bar"]',
      },
    },
    reference: (page) => referenceWork(page, 'detail'),
    source: (page) =>
      clickSource(
        page,
        'subtab-works',
        '[data-testid="cw-detail-toggle"]',
        '[data-testid="cw-detail-modal"]',
      ),
  },
  {
    name: 'works-add',
    manifestIds: ['k12.work-add-modal'],
    fixture: 'new creative work',
    ...NC('manifest blocks works modals behind open works visual gate'),
    criticalSelectors: {
      reference: {
        modal: '#overlayCard .modal',
        body: '#overlayCard .modal-b',
        footer: '#overlayCard .modal-f',
        form: '#overlayCard .modal-form',
        type: '#k12CreativeWorkType',
        photo: '#k12CreativeWorkFile',
        content: '#k12CreativeWorkDraft',
      },
      source: {
        modal: '.k12cw-modal',
        body: '.k12cw-modal__body',
        footer: '.k12cw-modal__foot',
        form: '.k12cw-modal__body',
        type: '.k12cw__seg',
        photo: '[data-testid="cw-add-photo"]',
        content: '[data-testid="cw-add-draft"]',
      },
    },
    reference: (page) => referenceWork(page, 'add'),
    source: (page) =>
      clickSource(
        page,
        'subtab-works',
        '[data-testid="cw-add-open"]',
        '[data-testid="cw-add-modal"]',
      ),
  },
  {
    name: 'works-preview',
    manifestIds: ['k12.work-image-preview-modal'],
    fixture: 'art thumbnail preview',
    ...NC('manifest blocks works modals behind open works visual gate'),
    reference: (page) => referenceWork(page, 'preview'),
    source: (page) =>
      clickSource(
        page,
        'subtab-works',
        '[data-testid="cw-thumb"]',
        '[data-testid="cw-image-preview"]',
      ),
  },
  {
    name: 'works-delete-confirm',
    manifestIds: ['k12.work-delete-confirm'],
    fixture: 'delete reviewed art work confirmation',
    ...NC('manifest blocks works modals behind open works visual gate'),
    reference: (page) => referenceWork(page, 'delete'),
    source: (page) =>
      clickSource(
        page,
        'subtab-works',
        '[data-testid="cw-detail-toggle"]',
        '.hc-dialog[role="alertdialog"]',
        '[data-testid="cw-delete"]',
      ),
  },
  {
    name: 'webhook-panel-history',
    manifestIds: ['k12.webhook-panel', 'k12.webhook-history-modal'],
    fixture: 'homework-hook / one delivered receipt',
    ...NC('manifest blocks webhook entry/event contract; screenshots are diagnostic only'),
    reference: async (page) => {
      await page.goto(REF, { waitUntil: 'domcontentloaded' })
      const ok = await page.evaluate(() => {
        const api = window as typeof window & {
          showPane?: (pane: string) => void
          seg?: (group: string, index: number) => void
          openK12WebhookEvents?: () => void
        }
        api.showPane?.('automation')
        api.seg?.('au', 1)
        api.openK12WebhookEvents?.()
        return Boolean(api.openK12WebhookEvents)
      })
      return { root: '#overlay', issues: ok ? [] : ['prototype webhook history missing'] }
    },
    source: (page) => sourceWebhook(page, 'history'),
  },
  {
    name: 'webhook-editor',
    manifestIds: ['k12.webhook-editor-modal'],
    fixture: 'homework-hook editor',
    ...NC('manifest blocks webhook direct-entry and event contracts'),
    reference: (page) => referenceCall(page, 'openK12WebhookBinding'),
    source: (page) => sourceWebhook(page, 'editor'),
  },
  {
    name: 'webhook-rotate-secret-delete',
    manifestIds: [
      'k12.webhook-rotate-modal',
      'k12.webhook-secret-modal',
      'k12.webhook-delete-confirm',
    ],
    fixture: 'rotate confirmation / one-time secret / delete has no prototype',
    ...NC('prototype has no equivalent distinct rotate/secret/delete state'),
    reference: (page) => referenceCall(page, 'openK12WebhookBinding'),
    source: (page) => sourceWebhook(page, 'secret'),
  },
  {
    name: 'dingtalk-delivery-receipt',
    manifestIds: ['k12.dingtalk-delivery-receipt'],
    fixture: 'reviewed work send action; no external message is sent by this visual audit',
    ...NC(
      'installed-app real DingTalk delivery receipt is required; mocked UI cannot satisfy boundary evidence',
    ),
    reference: (page) => referenceWork(page, 'detail'),
    source: (page) =>
      clickSource(
        page,
        'subtab-works',
        '[data-testid="cw-detail-toggle"]',
        '[data-testid="cw-send"]',
      ),
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

async function geometry(page: Page, root?: string, criticalSelectors: Record<string, string> = {}) {
  return page.evaluate(
    ({ selector, criticalSelectors }) => {
      const node = selector ? (document.querySelector(selector) as HTMLElement | null) : null
      const body = document.body
      const inspect = (element: HTMLElement | null) => {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: element.className,
          text: element.innerText.replace(/\s+/g, ' ').trim().slice(0, 600),
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
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            padding: style.padding,
            gap: style.gap,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          },
        }
      }
      return {
        url: location.href,
        rootSelector: selector,
        root: inspect(node),
        critical: Object.fromEntries(
          Object.entries(criticalSelectors).map(([name, criticalSelector]) => [
            name,
            inspect(document.querySelector(criticalSelector) as HTMLElement | null),
          ]),
        ),
        body: inspect(body),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      }
    },
    { selector: root, criticalSelectors },
  )
}

async function capture(referencePage: Page, sourcePage: Page, state: State, testInfo: TestInfo) {
  const reference = await state.reference(referencePage).catch((error: unknown) => ({
    issues: [`reference opener threw: ${error instanceof Error ? error.message : String(error)}`],
  }))
  const source = await state.source(sourcePage).catch((error: unknown) => ({
    issues: [`source opener threw: ${error instanceof Error ? error.message : String(error)}`],
  }))
  const targetViewport = testInfo.project.use.viewport
  if (targetViewport) {
    await Promise.all([
      referencePage.setViewportSize(targetViewport),
      sourcePage.setViewportSize(targetViewport),
    ])
  }
  await Promise.all([freeze(referencePage).catch(() => {}), freeze(sourcePage).catch(() => {})])
  const dir = path.join(EVIDENCE, testInfo.project.name, state.name)
  await mkdir(dir, { recursive: true })
  const refPath = path.join(dir, 'reference.png')
  const srcPath = path.join(dir, 'current-source.png')
  const diffPath = path.join(dir, 'pixel-diff.png')
  await referencePage.screenshot({
    path: refPath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    timeout: 30_000,
  })
  await sourcePage.screenshot({
    path: srcPath,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    timeout: 30_000,
  })
  const [refGeometry, srcGeometry] = await Promise.all([
    geometry(referencePage, reference.root, state.criticalSelectors?.reference),
    geometry(sourcePage, source.root, state.criticalSelectors?.source),
  ])
  let diff: Record<string, unknown> = {}
  let diffError = ''
  try {
    const { stdout } = await execFileAsync('xcrun', [
      'swift',
      DIFF_TOOL,
      refPath,
      srcPath,
      diffPath,
      '8',
    ])
    diff = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch (error) {
    diffError = error instanceof Error ? error.message : String(error)
  }
  const issues = [...(reference.issues ?? []), ...(source.issues ?? [])]
  const rootMissing = !refGeometry.root || !srcGeometry.root
  const effectiveClassification: Classification =
    state.classification === 'COMPARABLE' && (issues.length > 0 || rootMissing)
      ? 'NOT_COMPARABLE'
      : state.classification
  const ratio = Number(diff.changed_pixel_ratio ?? 1)
  const status =
    effectiveClassification === 'NOT_COMPARABLE'
      ? 'NOT_COMPARABLE'
      : ratio <= MAX_RATIO
        ? 'PASS'
        : 'RED'
  const reason =
    effectiveClassification !== state.classification
      ? `downgraded: opener/root evidence incomplete (${issues.join('; ') || 'root missing'})`
      : state.reason
  await Promise.all([
    writeFile(
      path.join(dir, 'geometry.json'),
      `${JSON.stringify({ reference: refGeometry, source: srcGeometry }, null, 2)}\n`,
    ),
    writeFile(
      path.join(dir, 'diff.json'),
      `${JSON.stringify({ ...diff, error: diffError }, null, 2)}\n`,
    ),
    writeFile(
      path.join(dir, 'status.json'),
      `${JSON.stringify(
        {
          state: state.name,
          manifest_ids: state.manifestIds,
          fixture: state.fixture,
          declared_classification: state.classification,
          classification: effectiveClassification,
          status,
          reason,
          issues,
          changed_pixel_ratio: diff.changed_pixel_ratio ?? null,
          threshold: MAX_RATIO,
          screenshots: {
            reference: 'reference.png',
            source: 'current-source.png',
            diff: diffError ? null : 'pixel-diff.png',
          },
        },
        null,
        2,
      )}\n`,
    ),
  ])
  return { status, classification: effectiveClassification, ratio, issues, dir }
}

test.describe('K12 deep page/modal visual matrix', () => {
  test('manifest coverage and frozen fixture evidence', async ({ browser }, testInfo) => {
    const requestedIds = [
      'k12.profile-modal',
      'k12.capabilities-modal',
      'k12.task-progress-collapsed',
      'k12.weekly-period-tabs',
      'k12.weekly-current',
      'k12.weekly-state-matrix',
      'k12.weekly-history',
      'k12.weekly-history-detail-modal',
      'k12.mistake-add-modal',
      'k12.mistake-detail-modal',
      'k12.mistake-edit-modal',
      'k12.mistake-review-confirmations',
      'k12.practice-candidate-selection-modal',
      'k12.practice-basket',
      'k12.practice-paper-modal',
      'k12.practice-return-modal',
      'k12.practice-manual-grade-modal',
      'k12.practice-regrade-result-modal',
      'k12.accumulation-add-modal',
      'k12.accumulation-detail-modal',
      'k12.accumulation-delete-confirm',
      'k12.work-detail-modal',
      'k12.work-add-modal',
      'k12.work-image-preview-modal',
      'k12.work-delete-confirm',
      'k12.webhook-panel',
      'k12.webhook-history-modal',
      'k12.webhook-editor-modal',
      'k12.webhook-rotate-modal',
      'k12.webhook-secret-modal',
      'k12.webhook-delete-confirm',
      'k12.dingtalk-delivery-receipt',
    ]
    const manifest = new Set(BRANCH_UI_FIDELITY_SURFACES.map((surface) => surface.id))
    const selectedStates = STATE_FILTER
      ? states.filter((state) => state.name === STATE_FILTER)
      : states
    expect(
      selectedStates.length,
      STATE_FILTER ? `unknown HEX_UI_STATE=${STATE_FILTER}` : 'visual states missing',
    ).toBeGreaterThan(0)
    const mapped = selectedStates.flatMap((state) => state.manifestIds)
    if (!STATE_FILTER) {
      expect([...new Set(mapped)].sort()).toEqual([...requestedIds].sort())
      expect(requestedIds.filter((id) => !manifest.has(id))).toEqual([])
    } else {
      expect(mapped.filter((id) => !manifest.has(id))).toEqual([])
    }
    expect(mapped.length).toBe(new Set(mapped).size)

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    const referencePage = await context.newPage()
    const sourcePage = await context.newPage()
    referencePage.setDefaultTimeout(5_000)
    referencePage.setDefaultNavigationTimeout(10_000)
    sourcePage.setDefaultTimeout(5_000)
    sourcePage.setDefaultNavigationTimeout(10_000)
    await installMocks(sourcePage)
    const results: Record<string, unknown>[] = []
    for (const state of selectedStates) {
      const result = await test.step(state.name, () =>
        capture(referencePage, sourcePage, state, testInfo),
      )
      results.push({
        state: state.name,
        manifest_ids: state.manifestIds,
        fixture: state.fixture,
        ...result,
      })
    }
    await context.close()
    const summary = {
      engine: testInfo.project.name,
      manifest_coverage: {
        requested: requestedIds.length,
        covered: new Set(mapped).size,
        states: states.length,
      },
      status_counts: results.reduce<Record<string, number>>((acc, item) => {
        const status = String(item.status)
        acc[status] = (acc[status] ?? 0) + 1
        return acc
      }, {}),
      results,
    }
    const summaryDir = path.join(EVIDENCE, testInfo.project.name)
    await mkdir(summaryDir, { recursive: true })
    await writeFile(
      path.join(summaryDir, 'matrix-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    expect(results).toHaveLength(selectedStates.length)
  })
})
