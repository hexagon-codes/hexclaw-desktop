import { chromium } from '@playwright/test'
const browser = await chromium.launch()
// 参考
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const cs = page.locator('.cs-item[data-session-id="k12-ming"]')
  await cs.waitFor({ state: 'visible' })
  const t = await cs.locator('.cs-t').innerText()
  const meta = await cs.locator('.cs-m').innerText()
  const pin = cs.locator('.cs-pin')
  const pinDisabled = await pin.isDisabled()
  const pinLabel = await pin.getAttribute('aria-label')
  const style = await cs.evaluate((el) => {
    const s = getComputedStyle(el)
    const t = getComputedStyle(el.querySelector('.cs-t'))
    return { cs: { display: s.display, grid: s.gridTemplateColumns, padding: s.padding, border: s.border }, title: { fontSize: t.fontSize, fontWeight: t.fontWeight, whiteSpace: t.whiteSpace, overflow: t.overflow, textOverflow: t.textOverflow } }
  })
  console.log('REF title:', JSON.stringify(t))
  console.log('REF meta:', JSON.stringify(meta))
  console.log('REF pinDisabled:', pinDisabled, 'pinLabel:', pinLabel)
  console.log('REF style:', JSON.stringify(style))
  await page.close()
}
// 实现
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto('http://127.0.0.1:5173/chat', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', 's-audit-k12')
    localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 's-audit-k12': 'k12-tutor-audit' }))
    localStorage.setItem('hc-theme', 'light')
  })
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
    const u = new URL(route.request().url()); const apiPath = u.pathname.replace(/^\/_hexclaw/, ''); const m = route.request().method()
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) })
    if (apiPath === '/api/v1/agents' && m === 'GET') return json({ agents: [{ name: 'k12-tutor-audit', display_name: '小明的辅导助手', description: '五年级下', provider: '', model: '', metadata: { scenario: 'k12-tutor', avatar: '🎓', 'k12.child_name': '小明', 'k12.learner_id': 'learner-audit', 'k12.grade_term': '五年级下', 'k12.textbook_edition': '人教版' } }], total: 1, default: 'k12-tutor-audit' })
    if (apiPath === '/api/v1/sessions' && m === 'GET') return json({ sessions: [{ id: 's-audit-k12', title: 'k12-tutor-audit', created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00', message_count: 0 }], total: 1 })
    if (apiPath.startsWith('/api/v1/sessions/')) return json({ messages: [], artifacts: [], total: 0 })
    if (apiPath === '/api/v1/config') return json({ general: { language: 'zh-CN', welcomeCompleted: true }, knowledge: { enabled: true }, llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} } })
    if (apiPath === '/api/v1/agents/rules' || apiPath === '/api/v1/roles' || apiPath === '/api/v1/skills' || apiPath === '/api/v1/streams/active') return json({})
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'healthy' }) }))
  await page.route('http://localhost:11434/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const item = page.locator('.hc-sessions__item[data-session-id="s-audit-k12"]')
  await item.waitFor({ state: 'visible' })
  const t = await item.locator('.hc-sessions__title, .hc-sessions__name').first().innerText().catch(() => item.innerText())
  const pinBtn = item.locator('button[aria-label*="置顶"], .hc-sessions__pin')
  const pinDisabled = (await pinBtn.count()) ? await pinBtn.isDisabled() : 'N/A'
  const pinTitle = (await pinBtn.count()) ? await pinBtn.getAttribute('aria-label') : 'N/A'
  const style = await item.evaluate((el) => {
    const s = getComputedStyle(el)
    const titleEl = el.querySelector('.hc-sessions__title, [class*="name"], .cs-t')
    const t = titleEl ? getComputedStyle(titleEl) : null
    return { item: { display: s.display, padding: s.padding, grid: s.gridTemplateColumns }, title: t ? { fontSize: t.fontSize, fontWeight: t.fontWeight, whiteSpace: t.whiteSpace, overflow: t.overflow, textOverflow: t.textOverflow } : null }
  })
  console.log('IMPL text:', JSON.stringify(t))
  console.log('IMPL pinDisabled:', pinDisabled, 'pinTitle:', pinTitle)
  console.log('IMPL style:', JSON.stringify(style))
  await page.close()
}
await browser.close()
