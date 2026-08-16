/* BUG-20260816-003 会话列表成对截图：原型「🎓 小明的辅导助手 · 五年级」 vs 实现会话列表 */
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = '/Users/guoyanjun/work/hexclaw-desktop'
const OUT = path.join(ROOT, 'test-results/audit-20260816-session-list')
await mkdir(OUT, { recursive: true })

const VIEWPORT = { width: 1440, height: 1000 }
const AGENT = 'k12-tutor-audit'
const SESSION = 's-audit-k12'

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function capture(page, name, selector) {
  const loc = page.locator(selector)
  await loc.waitFor({ state: 'visible', timeout: 15000 })
  await loc.screenshot({ path: path.join(OUT, name) })
}

const browser = await chromium.launch()

// ── 参考：原型 app.html 会话列表 ──
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const cs = page.locator('.cs-item[data-session-id="k12-ming"]')
  await cs.waitFor({ state: 'visible', timeout: 10000 })
  await cs.screenshot({ path: path.join(OUT, 'reference-cs-item.png') })
  const pin = cs.locator('.cs-pin')
  console.log('reference pin disabled:', await pin.isDisabled())
  console.log('reference text:', (await cs.innerText()).replace(/\n/g, ' | '))
  await page.close()
}

// ── 实现：dev server 会话列表（mock K12 agent 绑定）──
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto('http://127.0.0.1:5173/chat', { waitUntil: 'domcontentloaded' })
  await page.evaluate(([session, agent]) => {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', session)
    localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
    localStorage.setItem('hc-theme', 'light')
  }, [SESSION, AGENT])
  await page.route('http://localhost:11434/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }),
  )
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
    const u = new URL(route.request().url())
    const apiPath = u.pathname.replace(/^\/_hexclaw/, '')
    const m = route.request().method()
    if (apiPath === '/api/v1/agents' && m === 'GET')
      return json(route, { agents: [{ name: AGENT, display_name: '小明的辅导助手', description: '五年级下', provider: '', model: '', metadata: { scenario: 'k12-tutor', avatar: '🎓', 'k12.child_name': '小明', 'k12.learner_id': 'learner-audit', 'k12.grade_term': '五年级下', 'k12.textbook_edition': '人教版' } }], total: 1, default: AGENT })
    if (apiPath === '/api/v1/sessions' && m === 'GET')
      return json(route, { sessions: [{ id: SESSION, title: 'k12-tutor-audit', created_at: '2026-07-20T00:00:00+08:00', updated_at: '2026-07-20T00:00:00+08:00', message_count: 0 }], total: 1 })
    if (apiPath === `/api/v1/sessions/${SESSION}/messages` || apiPath === `/api/v1/sessions/${SESSION}/artifacts`)
      return json(route, { messages: [], artifacts: [], total: 0 })
    if (apiPath === '/api/v1/config') return json(route, { general: { language: 'zh-CN', welcomeCompleted: true }, knowledge: { enabled: true }, llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} } })
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'healthy' }) }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const item = page.locator(`.hc-sessions__item[data-session-id="${SESSION}"]`)
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.screenshot({ path: path.join(OUT, 'implementation-cs-item.png') })
  console.log('implementation text:', (await item.innerText()).replace(/\n/g, ' | '))
  const cls = await item.getAttribute('class')
  console.log('implementation pinned class:', cls)
  await page.close()
}

await browser.close()
console.log('screenshots saved to', OUT)
