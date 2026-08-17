/* Provider 卡头成对截图 + 结构化对比（CFG-043 复现尺寸 1226×1548 zh-CN light） */
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const OUT = path.join(ROOT, 'test-results/audit-20260817-provider-cardhead')
await mkdir(OUT, { recursive: true })

const VIEWPORT = { width: 1226, height: 1548 }
const browser = await chromium.launch({ channel: 'chrome' })

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function collectStyles(page, selector, classes) {
  return page.evaluate(({ selector, classes }) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = { selector, box: el.getBoundingClientRect().toJSON() }
    for (const c of classes) out[c] = cs[c]
    return out
  }, { selector, classes })
}

// ── 参考：原型 ──
let ref = {}
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'load' })
  await page.waitForTimeout(600)
  await page.locator('.sb-item[data-screen="settings"]').click()
  await page.waitForTimeout(800)
  await page.locator('[data-provider-card="openai"] .prov-top').screenshot({ path: path.join(OUT, 'reference-cardhead.png') })
  const top = await page.locator('[data-provider-card="openai"] .prov-top').boundingBox()
  await page.screenshot({ path: path.join(OUT, 'reference-card.png'), clip: { x: 0, y: Math.max(0, top.y - 40), width: VIEWPORT.width, height: top.height + 90 } })
  ref = {
    provTop: await collectStyles(page, '[data-provider-card="openai"] .prov-top', ['display', 'alignItems', 'gap', 'padding', 'flexWrap', 'flexDirection']),
    provIc: await collectStyles(page, '[data-provider-card="openai"] .prov-ic', ['width', 'height', 'borderRadius', 'background']),
    provName: await collectStyles(page, '[data-provider-card="openai"] .prov-name', ['fontSize', 'fontWeight', 'lineHeight']),
    provMeta: await collectStyles(page, '[data-provider-card="openai"] .prov-meta', ['fontSize', 'color', 'whiteSpace', 'overflow']),
    status: await collectStyles(page, '[data-provider-card="openai"] .provider-connection-status', ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight', 'background', 'color', 'gap', 'whiteSpace']),
    btnTest: await collectStyles(page, '[data-provider-card="openai"] .btn-test', ['height', 'padding', 'borderRadius', 'fontSize', 'borderColor', 'color', 'background']),
    btnDelete: await collectStyles(page, '[data-provider-card="openai"] .provider-delete-action', ['height', 'padding', 'borderRadius', 'fontSize', 'color', 'background']),
    toggle: await collectStyles(page, '[data-provider-card="openai"] .tog', ['width', 'height', 'borderRadius', 'background']),
    card: await collectStyles(page, '[data-provider-card="openai"]', ['padding', 'borderRadius', 'border', 'background', 'gap']),
    headHTML: await page.locator('[data-provider-card="openai"] .prov-top').innerHTML(),
    headText: (await page.locator('[data-provider-card="openai"] .prov-top').innerText()).replace(/\n/g, ' | '),
  }
  await page.close()
}

// ── 实现：dev server ──
let impl = {}
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.addInitScript(() => { localStorage.setItem('hc-theme', 'light') })
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
    const u = new URL(route.request().url())
    const p = u.pathname.replace(/^\/_hexclaw/, '')
    const m = route.request().method()
    if (p === '/api/v1/config/llm' && m === 'GET')
      return json(route, { default: 'openai', routing: { enabled: false, strategy: 'cost-aware' }, cache: { enabled: true }, providers: [{ name: 'openai', provider_instance_id: 'pvd_v1_' + 'a'.repeat(32), display_name: 'OpenAI', type: 'openai', enabled: true, api_key: 'fixture-redacted', base_url: 'https://api.openai.com/v1', model: 'gpt-5.6', models: ['gpt-5.6'] }] })
    if (p === '/api/v1/config/llm/test') return json(route, { ok: true, message: 'ok', tested_at: new Date().toISOString(), persisted: true })
    if (p === '/api/v1/config' ) return json(route, { server: { host: '127.0.0.1', port: 16060, mode: 'desktop' }, llm: { default: 'openai', providers: [] }, security: { gateway_enabled: false } })
    if (p === '/api/v1/llm/capabilities') return json(route, { models: [] })
    return json(route, {})
  })
  await page.route('http://localhost:11434/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }))
  await page.goto('http://127.0.0.1:15151/settings', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const card = page.locator('.hc-provider__card').first()
  await card.waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.hc-provider__card-head').first().screenshot({ path: path.join(OUT, 'implementation-cardhead.png') })
  const top = await page.locator('.hc-provider__card-head').first().boundingBox()
  await page.screenshot({ path: path.join(OUT, 'implementation-card.png'), clip: { x: 0, y: Math.max(0, top.y - 40), width: VIEWPORT.width, height: top.height + 90 } })
  impl = {
    provTop: await collectStyles(page, '.hc-provider__card-head', ['display', 'alignItems', 'gap', 'padding', 'flexWrap', 'flexDirection']),
    provIc: await collectStyles(page, '.hc-provider__logo', ['width', 'height', 'borderRadius', 'background']),
    provName: await collectStyles(page, '.hc-provider__card-name', ['fontSize', 'fontWeight', 'lineHeight']),
    provMeta: await collectStyles(page, '.hc-provider__meta', ['fontSize', 'color', 'whiteSpace', 'overflow']),
    status: await collectStyles(page, '.hc-provider__connection-status', ['minHeight', 'padding', 'borderRadius', 'fontSize', 'fontWeight', 'background', 'color', 'gap', 'whiteSpace']),
    btnTest: await collectStyles(page, '.hc-provider__test-btn', ['height', 'padding', 'borderRadius', 'fontSize', 'borderColor', 'color', 'background']),
    btnDelete: await collectStyles(page, '.hc-provider__delete-btn', ['height', 'padding', 'borderRadius', 'fontSize', 'color', 'background']),
    toggle: await collectStyles(page, '.hc-provider__toggle', ['width', 'height', 'borderRadius', 'background']),
    card: await collectStyles(page, '.hc-provider__card', ['padding', 'borderRadius', 'border', 'background', 'gap']),
    headHTML: await page.locator('.hc-provider__card-head').first().innerHTML(),
    headText: (await page.locator('.hc-provider__card-head').first().innerText()).replace(/\n/g, ' | '),
  }
  await page.close()
}

await writeFile(path.join(OUT, 'compare.json'), JSON.stringify({ ref, impl }, null, 2))
console.log('ref.provTop:', JSON.stringify(ref.provTop))
console.log('impl.provTop:', JSON.stringify(impl.provTop))
console.log('ref.headText:', ref.headText)
console.log('impl.headText:', impl.headText)
console.log('--- diff ---')
for (const k of Object.keys(ref)) {
  if (k.endsWith('HTML')) continue
  if (JSON.stringify(ref[k]) === JSON.stringify(impl[k])) continue
  console.log(k, '\n  ref :', JSON.stringify(ref[k]?.box || ref[k]), '\n  impl:', JSON.stringify(impl[k]?.box || impl[k]))
}
await browser.close()
