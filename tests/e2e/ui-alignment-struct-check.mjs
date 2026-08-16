/* 结构化对齐对比：周练 hero / 到期复习行 / 作品列表 / 回复气泡 */
import { chromium } from '@playwright/test'

const AGENT = 'k12-tutor-audit'
const SESSION = 's-audit-k12'

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const browser = await chromium.launch()

// ═══ 参考（原型 app.html）═══
const ref = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await ref.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'domcontentloaded' })
await ref.evaluate(() => { window.goRecords?.('ming', 'week'); window.k12BookTab?.('week') })
await ref.waitForTimeout(800)

// 1) 周练 hero
const hero = ref.locator('.rc-week-hero').first()
const heroText = (await hero.evaluate((el) => el.innerText)).replace(/\n/g, ' | ')
const heroMeta = await ref.locator('.rc-week-hero__meta .kpill').evaluateAll((els) => els.map((el) => el.innerText))
const heroTrend = await ref.locator('.rc-week-hero__head > .stpill').evaluate((els) => els.length).catch(() => 0)
const heroStyle = await hero.evaluate((el) => {
  const s = getComputedStyle(el)
  return { display: s.display, border: s.borderRadius, background: s.backgroundImage.slice(0, 40), padding: s.padding }
})
console.log('REF hero:', JSON.stringify({ text: heroText, kpills: heroMeta, trendPill: heroTrend, style: heroStyle }))


// 3) 作品列表网格
const worksGrid = await ref.locator('.creative-work-list').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
console.log('REF works grid:', worksGrid)

// 4) 回复气泡（找 .bubble.bot）
const bot = ref.locator('.bubble.bot').first()
const botBorder = await bot.evaluate((el) => { const s = getComputedStyle(el); return { border: s.border, background: s.backgroundColor, padding: s.padding } })
console.log('REF bot bubble:', JSON.stringify(botBorder))
await ref.close()

// ═══ 实现（dev + mock）═══
const imp = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await imp.goto('http://127.0.0.1:5173/chat', { waitUntil: 'domcontentloaded' })
await imp.evaluate(() => {
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  localStorage.setItem('hexclaw_lastSessionId', 's-audit-k12')
  localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 's-audit-k12': 'k12-tutor-audit' }))
  localStorage.setItem('hc-theme', 'light')
})
const plan = {
  plan_id: 'weekly-2026-30', agent: AGENT, revision: 11, iso_week_year: 2026, iso_week_number: 30,
  timezone: 'Asia/Shanghai', week_start: '2026-07-20T00:00:00+08:00', week_end: '2026-07-26T23:59:59+08:00',
  local_start_date: '2026-07-20', local_end_date: '2026-07-26', status: 'draft', settings_revision: 7, curriculum_progress_revision: 4,
  tracks: [
    { plan_section: 'due_review', status: 'ready', arithmetic_batch: null, items: [
      { item_id: 'wi-1', position: 1, plan_section: 'due_review', source_kind: 'mistake', generation_method: 'original', source_ref: 'mistake-apple', subject: '数学', knowledge_point: '小数乘法', mastery_status: 'new', verification: { status: 'verified', evidence_refs: ['小数乘法错题 · 连续错 2 次'] }, prompt_markdown: '苹果每千克 4.2 元，买 3 千克共多少钱？' },
      { item_id: 'wi-2', position: 2, plan_section: 'due_review', source_kind: 'mistake', generation_method: 'original', source_ref: 'mistake-eq', subject: '数学', knowledge_point: '简易方程', mastery_status: 'explained', verification: { status: 'verified', evidence_refs: ['简易方程错题 · 移项符号错'] }, prompt_markdown: '解方程：2x + 15 = 43。' } ] },
    { plan_section: 'textbook_consolidation', status: 'ready', arithmetic_batch: null, items: [{ item_id: 'ws-1', position: 1, plan_section: 'textbook_consolidation', source_kind: 'curriculum', generation_method: 'ai_generated', source_ref: 'progress-1', verification: { status: 'verified', evidence_refs: ['人教版五下 · 第4单元'] }, prompt_markdown: '写出一个与 3/4 相等的分数。' }] },
    { plan_section: 'arithmetic_warmup', status: 'ready', arithmetic_batch: { batch_id: 'batch-1', state: 'ready', item_count: 10, content_digest: 'd', retryable: false, failure_message: '', created_at: '', updated_at: '' }, items: [{ item_id: 'wa-1', position: 1, plan_section: 'arithmetic_warmup', source_kind: 'arithmetic', generation_method: 'rule_generated', source_ref: 'arith-1', verification: { status: 'verified', evidence_refs: ['已学运算范围'] }, prompt_markdown: '口算：25 × 4 = ?' }] },
  ],
  manual_track_recommendations: {
    textbook_consolidation: { availability: 'available', selected_item_count: 5, recommended_item_count: 5, min_item_count: 1, max_item_count: 10 },
    arithmetic_warmup: { availability: 'available', selected_item_count: 10, recommended_item_count: 10, min_item_count: 1, max_item_count: 20 },
  },
  created_at: '', updated_at: '',
}
await imp.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
  const u = new URL(route.request().url()); const apiPath = u.pathname.replace(/^\/_hexclaw/, ''); const m = route.request().method()
  if (apiPath === '/api/v1/agents' && m === 'GET') return json(route, { agents: [{ name: AGENT, display_name: '小明的辅导助手', description: '五年级下', provider: '', model: '', metadata: { scenario: 'k12-tutor', avatar: '🎓', 'k12.child_name': '小明', 'k12.learner_id': 'learner-audit', 'k12.grade_term': '五年级下', 'k12.textbook_edition': '人教版' } }], total: 1, default: AGENT })
  if (apiPath === '/api/v1/sessions' && m === 'GET') return json(route, { sessions: [{ id: SESSION, title: 'k12-tutor-audit', created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00', message_count: 0 }], total: 1 })
  if (apiPath.startsWith('/api/v1/sessions/')) return json(route, { messages: [], artifacts: [], total: 0 })
  if (apiPath === '/api/v1/config') return json(route, { general: { language: 'zh-CN', welcomeCompleted: true }, knowledge: { enabled: true }, llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} } })
  if (apiPath === '/api/k12/weekly-practice/plans' && m === 'POST') return json(route, { plan, replayed: false }, 201)
  if (apiPath === '/api/k12/weekly-practice/settings' && m === 'GET') return json(route, { agent: AGENT, revision: 7, timezone: 'Asia/Shanghai', due_review_enabled: true, textbook_consolidation_enabled: true, textbook_consolidation_tier: 'standard', arithmetic_warmup_enabled: true, arithmetic_minutes: 2, created_at: '', updated_at: '' })
  if (apiPath === '/api/k12/curriculum-progress' && m === 'GET') return json(route, { progress: { progress_id: 'p-audit', agent: AGENT, subject: 'math', revision: 4, textbook_binding_id: 'pep-5b', textbook_edition: '人教版', title: '义务教育教科书数学', volume: '五年级下册', unit_id: 'unit-4', unit_title: '第4单元', verified_page_from: 45, verified_page_to: 62, page_verification_status: 'verified', segment_refs: [], evidence_source: 'parent_confirmed', confirmed_at: '', created_at: '', updated_at: '' } })
  if (apiPath === '/api/k12/view-descriptor') return json(route, { header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
  if (apiPath === '/api/k12/mistakes' || apiPath === '/api/k12/review-queue' || apiPath === '/api/k12/practice-sets' || apiPath === '/api/k12/creative-works' || apiPath === '/api/k12/accumulation') return json(route, { items: [] })
  if (apiPath === '/api/k12/insight-report') return json(route, { grade_term: '五年级下', trend: { total: 6, mastered: 2, reviewing: 3, retried: 1, archived: 0 }, weak_top3: [], consecutive_fail_kps: [], month_new_mistakes: 0, review_completion_rate: 0.5, week_pending: 0, practice_pending: 0, suggestion: '' })
  if (apiPath === '/api/v1/agents/rules' || apiPath === '/api/v1/roles' || apiPath === '/api/v1/skills' || apiPath === '/api/v1/streams/active' || apiPath === '/api/v1/webhooks' || apiPath === '/api/v1/cron/jobs' || apiPath === '/api/v1/tasks') return json(route, {})
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
})
await imp.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'healthy' }) }))
await imp.route('http://localhost:11434/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }))
await imp.reload({ waitUntil: 'domcontentloaded' })
await imp.waitForTimeout(2000)
const k12Header = imp.locator('.k12enh-seg')
if (await k12Header.count()) {
  const recordsTab = k12Header.getByRole('tab', { name: '学习档案', exact: true })
  await recordsTab.waitFor({ state: 'visible', timeout: 15000 })
  await recordsTab.click()
} else {
  console.log('IMPL K12 header missing; body:', (await imp.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '))
}
const weekTab = imp.getByTestId('subtab-week').first()
if (await weekTab.count()) { await weekTab.click() }
await imp.locator('.k12rec').waitFor({ state: 'visible', timeout: 15000 })
await imp.waitForTimeout(800)

// 1) hero
const implHero = imp.locator('.weekly-hero')
await implHero.waitFor({ state: 'visible', timeout: 20000 })
const implHeroText = (await implHero.innerText()).replace(/\n/g, ' | ')
const implHeroKpills = await implHero.locator('.kpill').allInnerTexts()
const implTrend = await implHero.locator('.stpill').count()
const implHeroStyle = await implHero.evaluate((el) => { const s = getComputedStyle(el); return { display: s.display, borderRadius: s.borderRadius, background: s.backgroundImage.slice(0, 40), padding: s.padding } })
console.log('IMPL hero:', JSON.stringify({ text: implHeroText, kpills: implHeroKpills, trendPill: implTrend, style: implHeroStyle }))

// 2) 到期复习行
const implRow = imp.locator('.weekly-item').first()
await implRow.waitFor({ state: 'visible' })
const implRowText = (await implRow.innerText()).replace(/\n/g, ' | ')
const implRowButtons = await implRow.locator('button').allInnerTexts()
const implRowPills = await implRow.locator('.kpill, .stpill').allInnerTexts()
console.log('IMPL row:', JSON.stringify({ text: implRowText, pills: implRowPills, buttons: implRowButtons }))

await imp.close()
await browser.close()
console.log('STRUCT CHECK DONE')
