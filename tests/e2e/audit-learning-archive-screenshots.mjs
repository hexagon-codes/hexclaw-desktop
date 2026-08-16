/* BUG 审计成对截图：学习档案三处差异（hero meta / 状态筛选 / ⋯菜单） */
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = '/Users/guoyanjun/work/hexclaw-desktop'
const OUT = path.join(ROOT, 'test-results/audit-20260815-learning-archive')
await mkdir(OUT, { recursive: true })

const VIEWPORT = { width: 1440, height: 1000 }
const AGENT = 'audit-ming'
const SESSION = 'audit-session'

async function openReference(page, recordsTab) {
  await page.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'domcontentloaded' })
  await page.evaluate((tab) => {
    const api = window
    api.goRecords?.('ming', tab)
    api.k12BookTab?.(tab)
  }, recordsTab)
  await page.locator('#k12ViewRecords').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(500)
}

async function openImplementation(page, tabTestId, routes) {
  await page.goto(`http://127.0.0.1:5173/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.evaluate(
    ([session, agent]) => {
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem('hc-theme', 'light')
    },
    [SESSION, AGENT],
  )
  await page.route('http://localhost:11434/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }),
  )
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, routes)
  await page.route('**/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'healthy' }),
    }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  const recordsTab = page.locator('.k12enh-seg').getByRole('tab', { name: '学习档案', exact: true })
  await recordsTab.waitFor({ state: 'visible', timeout: 15000 })
  await recordsTab.click()
  const objectTab = page.getByTestId(tabTestId)
  await objectTab.waitFor({ state: 'visible', timeout: 15000 })
  await objectTab.click()
  await page.locator('.k12rec').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(800)
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function makeRoutes() {
  return async (route) => {
    const u = new URL(route.request().url())
    const apiPath = u.pathname.replace(/^\/_hexclaw/, '')
    const m = route.request().method()
    if (apiPath === '/api/v1/config') return json(route, { general: { language: 'zh-CN', welcomeCompleted: true }, knowledge: { enabled: true }, llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} } })
    if (apiPath === '/api/v1/config/llm') return json(route, { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } })
    if (apiPath === '/api/v1/ollama/status') return json(route, { running: false, associated: false, models: [] })
    if (apiPath === '/api/v1/agents' && m === 'GET') return json(route, { agents: [{ name: AGENT, display_name: '小明的辅导助手', description: '五年级下', provider: '', model: '', metadata: { scenario: 'k12-tutor', avatar: '🎓', 'k12.child_name': '小明', 'k12.learner_id': 'learner-audit', 'k12.grade_term': '五年级下', 'k12.textbook_edition': '人教版' } }], total: 1, default: AGENT })
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/sessions' && m === 'GET') return json(route, { sessions: [{ id: SESSION, title: '小明的辅导助手', created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00', message_count: 0 }], total: 1 })
    if (apiPath === `/api/v1/sessions/${SESSION}/messages` || apiPath === `/api/v1/sessions/${SESSION}/artifacts`) return json(route, { messages: [], artifacts: [], total: 0 })
    if (apiPath === '/api/k12/view-descriptor') return json(route, { header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
    if (apiPath === '/api/k12/curriculum-progress' && m === 'GET') return json(route, { progress: { progress_id: 'p-audit', agent: AGENT, subject: 'math', revision: 4, textbook_binding_id: 'pep-5b', textbook_edition: '人教版', textbook_version: '2022', title: '义务教育教科书数学', volume: '五年级下册', unit_id: 'unit-4', unit_title: '第4单元「分数的意义和性质」', verified_page_from: 45, verified_page_to: 62, page_verification_status: 'verified', segment_refs: ['segment-45-62'], evidence_source: 'parent_confirmed', confirmed_at: '2026-07-20T00:00:00+08:00', created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00' } })
    if (apiPath === '/api/k12/weekly-practice/settings' && m === 'GET') return json(route, { agent: AGENT, revision: 7, timezone: 'Asia/Shanghai', due_review_enabled: true, textbook_consolidation_enabled: true, textbook_consolidation_tier: 'standard', arithmetic_warmup_enabled: true, arithmetic_minutes: 2, created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00' })
    if (apiPath === '/api/k12/weekly-practice/plans' && m === 'POST') {
      const plan = {
        plan_id: 'weekly-2026-30', agent: AGENT, revision: 11, iso_week_year: 2026, iso_week_number: 30,
        timezone: 'Asia/Shanghai', week_start: '2026-07-20T00:00:00+08:00', week_end: '2026-07-26T23:59:59+08:00',
        local_start_date: '2026-07-20', local_end_date: '2026-07-26', status: 'draft', settings_revision: 7, curriculum_progress_revision: 4,
        tracks: [
          { plan_section: 'due_review', status: 'ready', arithmetic_batch: null, items: [{ item_id: 'wi-1', position: 1, plan_section: 'due_review', source_kind: 'mistake', generation_method: 'original', source_ref: 'mistake-apple', verification: { status: 'verified', evidence_refs: ['小数乘法错题 · 连续错 2 次'] }, prompt_markdown: '苹果每千克 4.2 元，买 3 千克共多少钱？' }, { item_id: 'wi-2', position: 2, plan_section: 'due_review', source_kind: 'mistake', generation_method: 'original', source_ref: 'mistake-eq', verification: { status: 'verified', evidence_refs: ['简易方程错题 · 移项符号错'] }, prompt_markdown: '解方程：2x + 15 = 43。' }] },
          { plan_section: 'textbook_consolidation', status: 'ready', arithmetic_batch: null, items: [{ item_id: 'ws-1', position: 1, plan_section: 'textbook_consolidation', source_kind: 'curriculum', generation_method: 'ai_generated', source_ref: 'progress-1', verification: { status: 'verified', evidence_refs: ['人教版五下 · 第4单元'], textbook_binding_id: 'pep-5b', unit_id: 'unit-4', verified_page_from: 45, verified_page_to: 62 }, prompt_markdown: '写出一个与 3/4 相等的分数。' }] },
          { plan_section: 'arithmetic_warmup', status: 'ready', arithmetic_batch: { batch_id: 'batch-1', state: 'ready', item_count: 10, content_digest: 'digest-1', retryable: false, failure_message: '', created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z' }, items: [{ item_id: 'wa-1', position: 1, plan_section: 'arithmetic_warmup', source_kind: 'arithmetic', generation_method: 'rule_generated', source_ref: 'arith-1', verification: { status: 'verified', evidence_refs: ['已学运算范围'] }, prompt_markdown: '口算：25 × 4 = ?' }] },
        ],
        manual_track_recommendations: {
          textbook_consolidation: { availability: 'available', selected_item_count: 5, recommended_item_count: 5, min_item_count: 1, max_item_count: 10 },
          arithmetic_warmup: { availability: 'available', selected_item_count: 10, recommended_item_count: 10, min_item_count: 1, max_item_count: 20 },
        },
        created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00',
      }
      return json(route, { plan, replayed: false }, 201)
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && m === 'GET') return json(route, { items: [], next_cursor: null })
    if (apiPath === '/api/k12/mistakes') return json(route, { items: [] })
    if (apiPath === '/api/k12/review-queue') return json(route, { items: [] })
    if (apiPath === '/api/k12/accumulation' || apiPath === '/api/k12/accumulations') return json(route, { items: [] })
    if (apiPath === '/api/k12/practice-sets' && m === 'GET') return json(route, { items: [] })
    if (apiPath === '/api/k12/creative-works' && m === 'GET') return json(route, { items: [] })
    if (apiPath === '/api/k12/insight-report') return json(route, { grade_term: '五年级下', trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], consecutive_fail_kps: [], month_new_mistakes: 0, review_completion_rate: -1, week_pending: 0, practice_pending: 0, suggestion: '' })
    if (apiPath === '/api/v1/webhooks' && m === 'GET') return json(route, { webhooks: [], total: 0 })
    if (apiPath === '/api/v1/cron/jobs' || apiPath === '/api/v1/tasks' || apiPath === '/api/v1/autonomy/summary') return json(route, {})
    if (apiPath === '/api/k12/tutoring-tips') return json(route, { knowledge_points: [], sections: [] })
    if (apiPath === '/api/k12/study-time') return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    if (apiPath === '/api/v1/provider/runtime') return json(route, {})
    if (apiPath === '/api/v1/agent-memory') return json(route, {})
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  // ── 对比 1：本周该练 hero meta ──
  {
    const ref = await browser.newPage({ viewport: VIEWPORT })
    await openReference(ref, 0)
    await ref.locator('.rc-week-hero').first().screenshot({ path: path.join(OUT, 'ref-hero-week.png') })
    await ref.close()

    const impl = await browser.newPage({ viewport: VIEWPORT })
    await openImplementation(impl, 'subtab-week', makeRoutes())
    await impl.locator('.weekly-hero').screenshot({ path: path.join(OUT, 'impl-hero-week.png') })
    await impl.close()
  }

  // ── 对比 2：全部错题状态筛选 ──
  {
    const ref = await browser.newPage({ viewport: VIEWPORT })
    await openReference(ref, 1)
    await ref
      .locator('.k12-secondary-tabs__row[data-filter-kind="status"]')
      .screenshot({ path: path.join(OUT, 'ref-status-filter.png') })
    await ref.close()

    const impl = await browser.newPage({ viewport: VIEWPORT })
    await openImplementation(impl, 'subtab-mistakes', makeRoutes())
    const filterRow = impl.locator('.k12rec__filter-stack')
    await filterRow.screenshot({ path: path.join(OUT, 'impl-status-filter.png') })
    await impl.close()
  }

  // ── 对比 3：本周该练顶部（⋯菜单缺席 vs 工具栏） ──
  {
    const ref = await browser.newPage({ viewport: VIEWPORT })
    await openReference(ref, 0)
    await ref.locator('.tbar').first().screenshot({ path: path.join(OUT, 'ref-week-toolbar.png') })
    await ref.close()

    const impl = await browser.newPage({ viewport: VIEWPORT })
    await openImplementation(impl, 'subtab-week', makeRoutes())
    await impl.locator('.weekly-toolbar').screenshot({ path: path.join(OUT, 'impl-week-toolbar.png') })
    await impl.close()
  }
  console.log('screenshots written to', OUT)
} finally {
  await browser.close()
}
