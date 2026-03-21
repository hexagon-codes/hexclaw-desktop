import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = 9333
const USER_DATA_DIR = '/tmp/hexclaw-wechat-chrome'
const BASE_URL = 'http://127.0.0.1:4173'
const OUTPUT_DIR = join(process.cwd(), 'docs', 'wechat-launch-assets')

async function waitForChrome() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (res.ok) return
    } catch {
      // retry
    }
    await delay(200)
  }
  throw new Error('Chrome DevTools endpoint did not become ready in time')
}

function startChrome() {
  return spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      'about:blank',
    ],
    {
      stdio: 'ignore',
    },
  )
}

async function openTarget() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) {
    throw new Error(`Failed to open Chrome target: ${res.status}`)
  }
  return res.json()
}

class CDPPage {
  constructor(wsUrl) {
    this.socket = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.loadResolvers = []
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve)
      this.socket.addEventListener('error', reject)
    })

    this.socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data.toString())
      if (typeof msg.id === 'number') {
        const pending = this.pending.get(msg.id)
        if (!pending) return
        this.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message))
        else pending.resolve(msg.result)
        return
      }

      if (msg.method === 'Page.loadEventFired') {
        const resolvers = [...this.loadResolvers]
        this.loadResolvers.length = 0
        resolvers.forEach((resolve) => resolve())
      }
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(payload)
    })
  }

  waitForLoad() {
    return new Promise((resolve) => {
      this.loadResolvers.push(resolve)
    })
  }

  async enable() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    })
  }

  async navigate(url, settleMs = 1800) {
    const loaded = this.waitForLoad()
    await this.send('Page.navigate', { url })
    await loaded
    await delay(settleMs)
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    return result.result?.value
  }

  async waitFor(expression, timeoutMs = 10000, intervalMs = 200) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await this.evaluate(expression)
      if (value) return
      await delay(intervalMs)
    }
    throw new Error(`Timed out waiting for expression: ${expression}`)
  }

  async click(selector) {
    const clicked = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        el.click()
        return true
      })()
    `)
    if (!clicked) throw new Error(`Element not found for click: ${selector}`)
  }

  async clickButtonByText(text) {
    const clicked = await this.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll('button')]
        const target = buttons.find((btn) => btn.innerText && btn.innerText.includes(${JSON.stringify(text)}))
        if (!target) return false
        target.click()
        return true
      })()
    `)
    if (!clicked) throw new Error(`Button not found by text: ${text}`)
  }

  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    await writeFile(filePath, Buffer.from(result.data, 'base64'))
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close()
    }
  }
}

const REMOVE_RUNTIME_NOISE = `
  (() => {
    document.querySelectorAll('.hc-sidebar__engine-row').forEach((el) => {
      el.style.visibility = 'hidden'
    })
    document.querySelectorAll('div').forEach((el) => {
      const text = (el.innerText || '').trim()
      if (text.includes('Failed to fetch') || text.includes('no response')) {
        if (el.children.length <= 2) {
          el.remove()
        }
      }
    })
  })()
`

async function main() {
  await rm(USER_DATA_DIR, { recursive: true, force: true })
  await mkdir(OUTPUT_DIR, { recursive: true })

  const chrome = startChrome()
  try {
    await waitForChrome()
    const target = await openTarget()
    const page = new CDPPage(target.webSocketDebuggerUrl)
    await page.enable()

    await page.navigate(`${BASE_URL}/welcome`, 2400)
    await page.waitFor(`!document.body.innerText.includes('正在启动')`, 12000).catch(() => {})
    await page.screenshot(join(OUTPUT_DIR, 'welcome.png'))

    await page.evaluate(`sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')`)

    await page.navigate(`${BASE_URL}/dashboard`, 2600)
    await page.evaluate(`
      (() => {
        document.querySelectorAll('.hc-page-header__status, .hc-sidebar__engine-row').forEach((el) => {
          el.style.visibility = 'hidden'
        })
      })()
    `)
    await page.screenshot(join(OUTPUT_DIR, 'dashboard.png'))

    await page.navigate(`${BASE_URL}/chat`, 2200)
    await page.evaluate(REMOVE_RUNTIME_NOISE)
    await page.screenshot(join(OUTPUT_DIR, 'chat.png'))

    await page.navigate(`${BASE_URL}/knowledge`, 2200)
    await page.evaluate(REMOVE_RUNTIME_NOISE)
    await page.screenshot(join(OUTPUT_DIR, 'knowledge.png'))

    await page.navigate(`${BASE_URL}/integration/mcp`, 2200)
    await page.evaluate(REMOVE_RUNTIME_NOISE)
    await page.screenshot(join(OUTPUT_DIR, 'mcp.png'))

    await page.navigate(`${BASE_URL}/channels`, 2200)
    await page.click('button.hc-im-btn--accent')
    await delay(600)
    await page.click('.hc-im-type-card')
    await delay(600)
    await page.screenshot(join(OUTPUT_DIR, 'channels.png'))

    await page.navigate(`${BASE_URL}/settings`, 2200)
    await page.click('.hc-provider__header .hc-btn-sm')
    await delay(600)
    await page.evaluate(REMOVE_RUNTIME_NOISE)
    await page.screenshot(join(OUTPUT_DIR, 'settings.png'))

    await page.navigate(`${BASE_URL}/about`, 2200)
    await page.screenshot(join(OUTPUT_DIR, 'about.png'))

    await page.close()
  } finally {
    chrome.kill('SIGKILL')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
