/* 2026-08-18 Provider 状态三态成对截图 + 文本对比（SETTINGS-PROVIDER-HEAD-SINGLE-ROW-001 证据） */
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const OUT = path.join(ROOT, 'test-results/audit-20260818-provider-status')
await mkdir(OUT, { recursive: true })

const VIEWPORT = { width: 1226, height: 1548 }
const browser = await chromium.launch({ channel: 'chrome' })

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// ── 参考：原型（openai=成功、deepseek 由脚本驱动 未测试/失败）──
const ref = {}
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto('http://127.0.0.1:16070/app.html', { waitUntil: 'load' })
  await page.waitForTimeout(600)
  await page.locator('.sb-item[data-screen="settings"]').click()
  await page.waitForTimeout(800)
  for (const key of ['openai', 'deepseek-untested', 'deepseek-failed']) {
    if (key === 'deepseek-untested') await page.evaluate(() => { const c = document.querySelector('[data-provider-card="deepseek"]'); if (c && window.setProviderConnectionState) window.setProviderConnectionState(c, 'untested') })
    if (key === 'deepseek-failed') await page.evaluate(() => { const c = document.querySelector('[data-provider-card="deepseek"]'); if (c && window.setProviderConnectionState) window.setProviderConnectionState(c, 'failed', '请检查 API Key、Base URL 或网络连接。') })
    const card = key === 'openai'
      ? page.locator('[data-provider-card="openai"]')
      : page.locator('[data-provider-card="deepseek"]')
    await card.scrollIntoViewIfNeeded()
    const top = await card.locator('.prov-top').boundingBox()
    await page.screenshot({
      path: path.join(OUT, `reference-${key}.png`),
      clip: { x: 0, y: Math.max(0, top.y - 12), width: VIEWPORT.width, height: top.height + 24 },
    })
    ref[key] = {
      text: (await card.locator('.prov-top').innerText()).replace(/\n/g, ' | '),
      status: await card.locator('.provider-connection-status').innerText(),
      rowY: (await Promise.all([
        card.locator('.prov-name').boundingBox(),
        card.locator('.provider-connection-status').boundingBox(),
        card.locator('.btn-test').boundingBox(),
      ])).map((b) => Math.round(b.y)),
    }
  }
  await page.close()
}

// ── 实现：dev server（三 Provider 固定三态 fixture）──
const impl = {}
{
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.addInitScript(() => { localStorage.setItem('hc-theme', 'light') })
  await page.route(/\/(?:_hexclaw\/)?api\/(?:v1|k12)\//, async (route) => {
    const u = new URL(route.request().url())
    const p = u.pathname.replace(/^\/_hexclaw/, '')
    const m = route.request().method()
    if (p === '/api/v1/config/llm' && m === 'GET') {
      return json(route, {
        default: 'openai',
        routing: { enabled: false, strategy: 'cost-aware' },
        cache: { enabled: true },
        providers: {
          openai: { provider_instance_id: 'pvd_v1_' + 'a'.repeat(32), display_name: 'OpenAI', enabled: true, api_key: 'fixture-redacted', base_url: 'https://api.openai.com/v1', model: 'gpt-5.6', models: ['gpt-5.6'], probe_receipt: { provider_instance_id: 'pvd_v1_' + 'a'.repeat(32), outcome: 'passed', locality: 'cloud', tested_at: '2026-08-18T08:00:00Z', latency_ms: 210 } },
          nvidia: { provider_instance_id: 'pvd_v1_' + 'b'.repeat(32), display_name: 'NVIDIA', enabled: true, api_key: 'fixture-redacted', base_url: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.1-8b-instruct', models: ['meta/llama-3.1-8b-instruct'], probe_receipt: { provider_instance_id: 'pvd_v1_' + 'b'.repeat(32), outcome: 'failed', error_message: 'openai api error: 401', locality: 'cloud', tested_at: '2026-08-18T08:00:00Z', latency_ms: 1200 } },
          deepseek: { provider_instance_id: 'pvd_v1_' + 'c'.repeat(32), display_name: 'DeepSeek', enabled: true, api_key: 'fixture-redacted', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', models: ['deepseek-chat'] },
        },
      })
    }
    if (p === '/api/v1/config/llm/test') return json(route, { ok: true, message: 'ok', tested_at: new Date().toISOString(), persisted: true })
    if (p === '/api/v1/config') return json(route, { server: { host: '127.0.0.1', port: 16060, mode: 'desktop' }, llm: { default: 'openai', providers: [] }, security: { gateway_enabled: false } })
    if (p === '/api/v1/llm/capabilities') return json(route, { models: [] })
    return json(route, {})
  })
  await page.route('http://localhost:11434/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) }))
  await page.goto('http://127.0.0.1:15151/settings', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const cards = page.locator('.hc-provider__card')
  const count = await cards.count()
  const implKeys = ['openai', 'nvidia', 'deepseek']
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i)
    const key = implKeys[i] ?? `card-${i}`
    await card.scrollIntoViewIfNeeded()
    const head = card.locator('.hc-provider__card-head')
    const top = await head.boundingBox()
    await page.screenshot({
      path: path.join(OUT, `implementation-${key}.png`),
      clip: { x: 0, y: Math.max(0, top.y - 12), width: VIEWPORT.width, height: top.height + 24 },
    })
    impl[key] = {
      text: (await head.innerText()).replace(/\n/g, ' | '),
      status: await card.locator('.hc-provider__connection-status').innerText(),
      rowY: (await Promise.all([
        card.locator('.hc-provider__card-name').boundingBox(),
        card.locator('.hc-provider__connection-status').boundingBox(),
        card.locator('.hc-provider__test-btn').boundingBox(),
      ])).map((b) => Math.round(b.y)),
    }
  }
  await page.close()
}

await writeFile(path.join(OUT, 'status-compare.json'), JSON.stringify({ ref, impl }, null, 2))
console.log('--- 三态文本对照 ---')
for (const key of ['openai', 'deepseek-untested', 'deepseek-failed']) {
  console.log(key.padEnd(8), 'ref :', JSON.stringify(ref[key]?.text), JSON.stringify(ref[key]?.rowY))
  console.log(''.padEnd(8), 'impl:', JSON.stringify(impl[key]?.text), JSON.stringify(impl[key]?.rowY))
}
await browser.close()