import { chromium, webkit } from '@playwright/test'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REFERENCE_URL = process.env.HEX_PROVIDER_REFERENCE_URL || 'http://127.0.0.1:16070/app.html'
const CURRENT_URL = process.env.HEX_PROVIDER_CURRENT_URL || 'http://127.0.0.1:5173/settings'
const OUT = path.resolve(
  process.env.HEX_PROVIDER_EVIDENCE_ROOT ||
    '/tmp/hexclaw-provider-current-source-visual-gate/green',
)
const CASE_FILTER = process.env.HEX_PROVIDER_CASE_FILTER?.trim() || ''
const BROWSER_ENGINE = process.env.HEX_PROVIDER_BROWSER?.trim() || 'chromium'
const VIEWPORT = { width: 1440, height: 1000 }
const DEVICE_SCALE_FACTOR = Number(process.env.HEX_PROVIDER_DEVICE_SCALE_FACTOR || '1')
const PIXEL_THRESHOLD = 0.01
const CHANNEL_TOLERANCE = 16

const require = createRequire(import.meta.url)
const playwrightCoreRoot = dirname(
  require.resolve('playwright-core/package.json', {
    paths: [require.resolve('@playwright/test')],
  }),
)
const { PNG } = require(resolve(playwrightCoreRoot, 'lib/utilsBundle.js'))

const openAIModels = [
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o3-mini',
  'o4-mini',
  'gpt-4-turbo',
]
const deepSeekModels = ['deepseek-chat', 'deepseek-reasoner']
const openRouterModels = Array.from(
  { length: 7 },
  (_, index) => `openrouter/header-layout-${index + 1}`,
)
const nvidiaModels = ['nvidia/llama-3.1-nemotron-ultra-253b-v1']

const llmSnapshot = {
  default: 'openai',
  routing: { mode: 'direct', fallback: [] },
  cache: { enabled: false },
  providers: {
    openai: {
      provider_instance_id: 'pvd_v1_00000000000000000000000000000001',
      display_name: 'OpenAI',
      enabled: true,
      api_key: 'sk-prototype-key',
      base_url: 'https://api.openai.com/v1',
      model: openAIModels[0],
      models: openAIModels,
      model_specs_mode: 'explicit',
      model_specs: openAIModels.map((id) => ({
        id,
        display_name: id,
        is_custom: false,
        capabilities: ['text'],
      })),
      probe_receipt: {
        provider_instance_id: 'pvd_v1_00000000000000000000000000000001',
        outcome: 'passed',
        locality: 'cloud',
        tested_at: 1787337600000,
        detail: '',
      },
    },
    deepseek: {
      provider_instance_id: 'pvd_v1_00000000000000000000000000000002',
      display_name: 'DeepSeek',
      enabled: true,
      api_key: 'sk-prototype-key',
      base_url: 'https://api.deepseek.com/v1',
      model: deepSeekModels[0],
      models: deepSeekModels,
      model_specs_mode: 'explicit',
      model_specs: deepSeekModels.map((id) => ({
        id,
        display_name: id,
        is_custom: false,
        capabilities: ['text'],
      })),
      probe_receipt: {
        provider_instance_id: 'pvd_v1_00000000000000000000000000000002',
        outcome: 'failed',
        locality: 'cloud',
        tested_at: 1787337600000,
        error_message: 'Invalid API key',
      },
    },
    openrouter: {
      provider_instance_id: 'pvd_v1_00000000000000000000000000000003',
      display_name: 'OpenRouter',
      enabled: true,
      api_key: 'sk-prototype-key',
      base_url: 'https://openrouter.ai/api/v1',
      model: openRouterModels[0],
      models: openRouterModels,
      model_specs_mode: 'explicit',
      model_specs: openRouterModels.map((id) => ({
        id,
        display_name: id,
        is_custom: false,
        capabilities: ['text'],
      })),
      probe_receipt: {
        provider_instance_id: 'pvd_v1_00000000000000000000000000000003',
        outcome: 'passed',
        locality: 'cloud',
        tested_at: 1787337600000,
        detail: '',
      },
    },
    nvidia: {
      provider_instance_id: 'pvd_v1_00000000000000000000000000000004',
      display_name: 'Nvidia',
      enabled: true,
      api_key: 'sk-prototype-key',
      base_url: 'https://integrate.api.nvidia.com/v1',
      model: nvidiaModels[0],
      models: nvidiaModels,
      model_specs_mode: 'explicit',
      model_specs: nvidiaModels.map((id) => ({
        id,
        display_name: 'NVIDIA Llama 3.1 Nemotron Ultra 253B v1',
        is_custom: false,
        capabilities: ['text'],
      })),
      probe_receipt: {
        provider_instance_id: 'pvd_v1_00000000000000000000000000000004',
        outcome: 'failed',
        locality: 'cloud',
        tested_at: 1787337600000,
        error_message: '请检查 API Key、Base URL 或网络连接。',
      },
    },
  },
}

const fullConfig = () => ({
  general: { language: 'zh-CN', welcomeCompleted: true },
  server: { host: '127.0.0.1', port: 16061 },
  llm: llmSnapshot,
  security: {},
})

const shouldCapture = (caseId) => !CASE_FILTER || caseId.startsWith(CASE_FILTER)
const safeName = (caseId) => caseId.replace(/[^a-zA-Z0-9._-]+/g, '-')

function normaliseStatus(text) {
  const value = String(text || '').trim().replace('...', '…')
  if (value.includes('测试中')) return 'testing'
  if (value === '成功') return 'success'
  if (value === '失败') return 'failed'
  if (value === '未测试') return 'untested'
  return value || null
}

function boxSnapshot(box, rootBox) {
  if (!box) return null
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    relative: rootBox
      ? { x: box.x - rootBox.x, y: box.y - rootBox.y, width: box.width, height: box.height }
      : null,
  }
}

function diffPng(referenceBuffer, currentBuffer, regions = null) {
  const reference = PNG.sync.read(referenceBuffer)
  const current = PNG.sync.read(currentBuffer)
  const width = Math.max(reference.width, current.width)
  const height = Math.max(reference.height, current.height)
  const output = new PNG({ width, height })
  let changedPixels = 0
  let insideChangedPixels = 0
  let outsideChangedPixels = 0
  let insidePixels = 0
  let outsidePixels = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const insideAnyRegion = (x, y) =>
    !regions ||
    regions.some(
      (region) =>
        region &&
        x >= Math.floor(region.x) &&
        x < Math.ceil(region.x + region.width) &&
        y >= Math.floor(region.y) &&
        y < Math.ceil(region.y + region.height),
    )

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const outIndex = (y * width + x) * 4
      const inReference = x < reference.width && y < reference.height
      const inCurrent = x < current.width && y < current.height
      const refIndex = inReference ? (y * reference.width + x) * 4 : -1
      const curIndex = inCurrent ? (y * current.width + x) * 4 : -1
      const referencePixel = inReference
        ? Array.from(reference.data.subarray(refIndex, refIndex + 4))
        : [255, 255, 255, 255]
      const currentPixel = inCurrent
        ? Array.from(current.data.subarray(curIndex, curIndex + 4))
        : [255, 255, 255, 255]
      const inside = insideAnyRegion(x, y)
      if (inside) insidePixels += 1
      else outsidePixels += 1
      const changed =
        !inReference ||
        !inCurrent ||
        Math.max(...referencePixel.map((value, index) => Math.abs(value - currentPixel[index]))) >
          CHANNEL_TOLERANCE
      if (changed) {
        changedPixels += 1
        if (inside) insideChangedPixels += 1
        else outsideChangedPixels += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        output.data.set([239, 35, 60, 255], outIndex)
      } else {
        const gray = Math.round(
          [...referencePixel.slice(0, 3), ...currentPixel.slice(0, 3)].reduce(
            (sum, value) => sum + value,
            0,
          ) / 6,
        )
        const quiet = Math.min(245, Math.round(gray * 0.2 + 204))
        output.data.set([quiet, quiet, quiet, 255], outIndex)
      }
    }
  }
  const totalPixels = width * height
  return {
    buffer: PNG.sync.write(output),
    report: {
      referenceSize: { width: reference.width, height: reference.height },
      currentSize: { width: current.width, height: current.height },
      dimensionMatch: reference.width === current.width && reference.height === current.height,
      changedPixels,
      totalPixels,
      changedPixelRatio: totalPixels ? changedPixels / totalPixels : 0,
      changedBBox:
        maxX >= minX
          ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
          : null,
      insideChangedPixels,
      outsideChangedPixels,
      insideChangedPixelRatio: insidePixels ? insideChangedPixels / insidePixels : 0,
      outsideChangedPixelRatio: outsidePixels ? outsideChangedPixels / outsidePixels : 0,
      outsideChangeShare: changedPixels ? outsideChangedPixels / changedPixels : 0,
      differenceOrigin:
        changedPixels === 0
          ? 'none'
          : outsideChangedPixels / changedPixels >= 0.9
            ? 'mostly-outside-target'
            : outsideChangedPixels / changedPixels <= 0.1
              ? 'mostly-inside-target'
              : 'mixed',
    },
  }
}

async function clickVisibleButtonByText(page, patterns) {
  return page.evaluate((terms) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
    const target = candidates.find((element) => {
      const rect = element.getBoundingClientRect()
      const text = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`.trim()
      return rect.width > 0 && rect.height > 0 && terms.some((term) => text.includes(term))
    })
    if (!target) return false
    target.click()
    return true
  }, patterns)
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
  })
}

async function visualEnvironment(page) {
  return page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      bodyDataset: { ...document.body.dataset },
      tokens: Object.fromEntries(
        ['--hc-bg-hover', '--hc-text-muted', '--hc-border', '--hc-border-hl'].map((key) => [
          key,
          rootStyle.getPropertyValue(key).trim(),
        ]),
      ),
    }
  })
}

async function preparePage(page) {
  await page.addStyleTag({
    content:
      // 成对截图比较稳定状态，不采集状态切换的中间帧；完整禁用 transition 避免 Chromium 将中间色序列化为 oklab。
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await waitForFonts(page)
}

async function openReference(page) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-provider-card="openai"]').waitFor({ state: 'attached' })
  if (!(await page.locator('[data-provider-card="openai"]').isVisible())) {
    await clickVisibleButtonByText(page, ['设置', 'Settings'])
    await page.waitForTimeout(100)
  }
  if (!(await page.locator('[data-provider-card="openai"]').isVisible())) {
    await clickVisibleButtonByText(page, ['大模型', '模型', 'LLM', 'Provider'])
  }
  await page.locator('[data-provider-card="openai"]').waitFor({ state: 'visible' })
  await page.evaluate((models) => {
    const grid = document.querySelector('#openaiProviderModelGrid')
    if (!grid) return
    grid.replaceChildren(
      ...models.map((id, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `provider-model-chip${index === 0 ? ' is-active' : ''}`
        button.dataset.modelId = id
        button.innerHTML = `<span class="provider-model-name"></span><span class="provider-model-cap">💬 文本</span>`
        button.querySelector('.provider-model-name').textContent = id
        return button
      }),
      Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'provider-model-chip provider-model-chip--add',
        textContent: '＋ 自定义',
      }),
    )
  }, openAIModels)
  await preparePage(page)
}

async function openCurrent(page) {
  await page.goto(CURRENT_URL, { waitUntil: 'domcontentloaded' })
  try {
    await page.locator('.hc-provider__card').first().waitFor({ state: 'visible', timeout: 1200 })
  } catch {
    await clickVisibleButtonByText(page, ['大模型', '模型', 'LLM', 'Provider'])
  }
  await page.locator('.hc-provider__card').first().waitFor({ state: 'visible', timeout: 10000 })
  // 该视觉夹具通过路由 mock 水合设置页，不模拟 sidecar-ready；页面内容就绪后移除启动遮罩，
  // 避免它覆盖待比较的已水合卡头。
  await page.locator('#splash-screen').evaluateAll((elements) => elements.forEach((element) => element.remove()))
  await preparePage(page)
}

async function resolveCard(page, side, key, name) {
  const exact =
    side === 'reference'
      ? page.locator(`[data-provider-card="${key}"]`).first()
      : page.locator(`.hc-provider__card[data-provider-type="${key}"]`).first()
  if ((await exact.count()) && (await exact.isVisible())) return exact
  const fallback = page
    .locator(side === 'reference' ? '[data-provider-card]' : '.hc-provider__card')
    .filter({ hasText: name })
    .first()
  await fallback.waitFor({ state: 'visible' })
  return fallback
}

async function setExpanded(card, side, expanded) {
  const current =
    side === 'reference'
      ? await card.evaluate((element) => element.classList.contains('open'))
      : (await card.locator('.hc-provider__edit').count()) > 0
  if (current === expanded) return
  await card.locator(side === 'reference' ? '.prov-name' : '.hc-provider__card-name').click()
  await card.page().waitForTimeout(80)
}

async function setReferenceState(page, key, state, detail = '') {
  return page.evaluate(
    ({ providerKey, providerState, providerDetail }) => {
      const card = document.querySelector(`[data-provider-card="${providerKey}"]`)
      if (!card || typeof window.setProviderConnectionState !== 'function') return false
      window.setProviderConnectionState(card, providerState, providerDetail)
      return true
    },
    { providerKey: key, providerState: state, providerDetail: detail },
  )
}

async function waitForCurrentProviderStatus(card, expectedStatus) {
  const providerName = (await card.locator('.hc-provider__card-name').textContent()).trim()
  try {
    await card.page().waitForFunction(
      ({ name, expected }) => {
        const providerCard = Array.from(document.querySelectorAll('.hc-provider__card')).find(
          (candidate) =>
            candidate.querySelector('.hc-provider__card-name')?.textContent?.trim() === name,
        )
        return providerCard?.querySelector('.hc-provider__connection-status')?.textContent?.trim() === expected
      },
      { name: providerName, expected: expectedStatus },
      { timeout: 10_000 },
    )
  } catch (error) {
    const actual = await card
      .locator('.hc-provider__connection-status')
      .textContent()
      .catch(() => null)
    throw new Error(
      `provider receipt hydration timed out: expected=${expectedStatus} actual=${actual ?? ''} cause=${String(error)}`,
    )
  }
}

async function isolateProviderPair(referencePage, currentPage, providerKeys) {
  const marker = 'data-provider-visual-original-display'
  const apply = (page, selector, keyAttribute) =>
    page.evaluate(
      ({ cardSelector, providerKeyAttribute, keepKeys, hiddenMarker }) => {
        for (const card of document.querySelectorAll(cardSelector)) {
          if (keepKeys.includes(card.getAttribute(providerKeyAttribute))) continue
          card.setAttribute(
            hiddenMarker,
            JSON.stringify({
              value: card.style.getPropertyValue('display'),
              priority: card.style.getPropertyPriority('display'),
            }),
          )
          card.style.setProperty('display', 'none', 'important')
        }
      },
      {
        cardSelector: selector,
        providerKeyAttribute: keyAttribute,
        keepKeys: providerKeys,
        hiddenMarker: marker,
      },
    )
  const restore = (page, selector) =>
    page.evaluate(
      ({ cardSelector, hiddenMarker }) => {
        for (const card of document.querySelectorAll(cardSelector)) {
          const serialized = card.getAttribute(hiddenMarker)
          if (!serialized) continue
          const previous = JSON.parse(serialized)
          if (previous.value) card.style.setProperty('display', previous.value, previous.priority)
          else card.style.removeProperty('display')
          card.removeAttribute(hiddenMarker)
        }
      },
      { cardSelector: selector, hiddenMarker: marker },
    )

  await Promise.all([
    apply(referencePage, '[data-provider-card]', 'data-provider-card'),
    apply(currentPage, '.hc-provider__card', 'data-provider-type'),
  ])
  await Promise.all([
    referencePage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    ),
    currentPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    ),
  ])
  return async () => {
    await Promise.all([
      restore(referencePage, '[data-provider-card]'),
      restore(currentPage, '.hc-provider__card'),
    ])
  }
}

async function providerContract(card, side) {
  const contract = await card.evaluate((root, source) => {
    const all = Array.from(root.querySelectorAll('*'))
    const statusElement = all.find((element) =>
      ['成功', '失败', '未测试', '测试中…', '测试中...'].includes(
        (element.textContent || '').trim(),
      ),
    )
    const text = root.textContent || ''
    const modelMatch =
      source === 'reference'
        ? text.match(/(\d+)\s*个模型/) || text.match(/(\d+)\s*模型(?:列表)?/)
        : (root.querySelector('.hc-provider__card-meta')?.textContent || '').match(/·\s*(\d+)/)
    const detail = root.querySelector('.provider-connection-detail, .hc-provider__connection-detail')
    const keyInput = root.querySelector('[data-provider-field="api-key"]')
    const testButton = Array.from(root.querySelectorAll('button')).find(
      (button) => (button.textContent || '').trim() === '测试',
    )
    const fields = Array.from(root.querySelectorAll('[data-provider-field]')).map((field) =>
      field.getAttribute('data-provider-field'),
    )
    const detailStyle = detail ? getComputedStyle(detail) : null
    const nameElement = root.querySelector(
      source === 'reference' ? '.prov-name' : '.hc-provider__card-name',
    )
    const directName = Array.from(nameElement?.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' ')
      .trim()
      .replace(/\s+/g, ' ')
    return {
      providerName: directName || (nameElement?.textContent || '').trim().replace(/\s+/g, ' '),
      modelCount: modelMatch ? Number(modelMatch[1]) : null,
      statusText: (statusElement?.textContent || '').trim(),
      expanded:
        source === 'reference'
          ? root.classList.contains('open')
          : Boolean(root.querySelector('.hc-provider__edit')),
      fieldOrder: fields,
      apiKeyInputType: keyInput?.getAttribute('type') || null,
      detailVisible: Boolean(
        detail &&
          detailStyle &&
          detailStyle.display !== 'none' &&
          detailStyle.visibility !== 'hidden' &&
          detail.getBoundingClientRect().height > 0,
      ),
      detailText: (detail?.textContent || '').trim().replace(/\s+/g, ' '),
      testDisabled: Boolean(testButton?.disabled),
    }
  }, side)
  contract.status = normaliseStatus(contract.statusText)
  return contract
}

const contractSubset = (contract, fields) =>
  Object.fromEntries(fields.map((field) => [field, contract[field]]))

async function semanticLocators(card, side) {
  const status =
    side === 'reference'
      ? card
          .locator('span, div')
          .filter({ hasText: /^(成功|失败|未测试|测试中…|测试中\.\.\.)$/ })
          .last()
      : card.locator('.hc-provider__connection-status').first()
  const exactButton = (text) =>
    card.locator('button').filter({ hasText: new RegExp(`^${text}$`) }).first()
  return {
    logo: card.locator(side === 'reference' ? '.prov-ic' : '.hc-provider__logo').first(),
    name: card.locator(side === 'reference' ? '.prov-name' : '.hc-provider__card-name').first(),
    meta: card.locator(side === 'reference' ? '.prov-meta' : '.hc-provider__card-meta').first(),
    status,
    testButton: exactButton('测试'),
    deleteButton: exactButton('删除'),
    toggle: card.locator(side === 'reference' ? '.tog' : '.hc-provider__toggle').first(),
    chevron: card.locator(side === 'reference' ? '.prov-cv' : '.hc-provider__chevron').first(),
    grid: card
      .locator(side === 'reference' ? '.provider-config-grid' : '.hc-provider__config-grid')
      .first(),
    baseUrl: card.locator('[data-provider-field="base-url"]').first(),
    apiKey: card.locator('[data-provider-field="api-key"]').first(),
    eye: card
      .locator(side === 'reference' ? '.provider-secret-button' : '.hc-settings__eye-btn')
      .first(),
    detail: card
      .locator(
        side === 'reference'
          ? '.provider-connection-detail'
          : '.hc-provider__connection-detail',
      )
      .first(),
  }
}

async function inspectLocator(locator, rootBox) {
  const box = await locator.boundingBox()
  const data = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const colorCanvas = document.createElement('canvas')
    colorCanvas.width = 1
    colorCanvas.height = 1
    const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true })
    const renderedColor = (value) => {
      if (!colorContext || !value) return null
      colorContext.clearRect(0, 0, 1, 1)
      try {
        colorContext.fillStyle = value
        colorContext.fillRect(0, 0, 1, 1)
        return Array.from(colorContext.getImageData(0, 0, 1, 1).data)
      } catch {
        return null
      }
    }
    const keys = [
      'display',
      'position',
      'alignItems',
      'justifyContent',
      'flexDirection',
      'flexWrap',
      'gridTemplateColumns',
      'columnGap',
      'rowGap',
      'gap',
      'padding',
      'margin',
      'width',
      'height',
      'minHeight',
      'borderRadius',
      'borderWidth',
      'borderColor',
      'backgroundColor',
      'boxShadow',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'color',
      'opacity',
      'overflow',
    ]
    return {
      tagName: element.tagName.toLowerCase(),
      className: String(element.className || ''),
      text: (element.textContent || '').trim().replace(/\s+/g, ' '),
      type: element.getAttribute('type'),
      ariaLabel: element.getAttribute('aria-label'),
      disabled: 'disabled' in element ? Boolean(element.disabled) : null,
      style: Object.fromEntries(keys.map((key) => [key, style[key]])),
      // 浏览器可能将视觉等价的色值分别序列化为 rgba 与 oklab。
      // 保留原始 computed-style，同时记录实际绘制到 sRGB 画布后的像素，避免语法差异误报。
      renderedColors: Object.fromEntries(
        ['color', 'backgroundColor', 'borderColor'].map((key) => [key, renderedColor(style[key])]),
      ),
    }
  })
  return { bbox: boxSnapshot(box, rootBox), ...data }
}

async function collectVisualInfo(target, card, side) {
  const targetBox = await target.boundingBox()
  const targetInfo = await inspectLocator(target, null)
  const locators = await semanticLocators(card, side)
  const elements = {}
  for (const [name, locator] of Object.entries(locators)) {
    try {
      if (!(await locator.count()) || !(await locator.isVisible())) elements[name] = null
      else elements[name] = await inspectLocator(locator, targetBox)
    } catch {
      elements[name] = null
    }
  }
  return { ...targetInfo, elements }
}

function fractionalPhase(value) {
  const phase = value - Math.floor(value)
  return Number(phase.toFixed(6))
}

function phaseAdjustment(from, to) {
  let delta = to - from
  if (delta > 0.5) delta -= 1
  if (delta < -0.5) delta += 1
  return Number(delta.toFixed(6))
}

async function screenshotAtPhase(locator, desiredPhase = null) {
  const box = await locator.boundingBox()
  if (!box) {
    const rawBuffer = await locator.screenshot({ animations: 'disabled' })
    return { rawBuffer, buffer: rawBuffer, phase: null }
  }
  const rawBuffer = await locator.screenshot({ animations: 'disabled' })
  const original = { x: fractionalPhase(box.x), y: fractionalPhase(box.y) }
  const delta = desiredPhase
    ? {
        x: phaseAdjustment(original.x, desiredPhase.x),
        y: phaseAdjustment(original.y, desiredPhase.y),
      }
    : { x: 0, y: 0 }
  const applied = delta.x !== 0 || delta.y !== 0
  let snapshot = null
  const page = locator.page()

  if (applied) {
    snapshot = await locator.evaluate((element, adjustment) => {
      const properties = ['margin-left', 'margin-top']
      const previous = properties.map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      }))
      const style = getComputedStyle(element)
      const left = Number.parseFloat(style.marginLeft) || 0
      const top = Number.parseFloat(style.marginTop) || 0
      // 只移动布局边距，不给被截图元素加 transform；后者会触发 Playwright 的 flex 裁剪缺陷。
      element.style.setProperty('margin-left', `${left + adjustment.x}px`, 'important')
      element.style.setProperty('margin-top', `${top + adjustment.y}px`, 'important')
      return previous
    }, delta)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  }
  try {
    return {
      rawBuffer,
      buffer: await locator.screenshot({ animations: 'disabled' }),
      phase: {
        method: 'layout-margin-phase',
        original,
        target: desiredPhase || original,
        adjustment: delta,
      },
    }
  } finally {
    if (snapshot) {
      await locator.evaluate((element, previous) => {
        for (const entry of previous) {
          if (entry.value) element.style.setProperty(entry.property, entry.value, entry.priority)
          else element.style.removeProperty(entry.property)
        }
      }, snapshot)
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    }
  }
}

function isInsideTarget(element, target) {
  if (!element || !target || !element.bbox || !target.bbox) return false
  const elementBox = element.bbox
  const targetBox = target.bbox
  const tolerance = 1
  return (
    elementBox.x >= targetBox.x - tolerance &&
    elementBox.y >= targetBox.y - tolerance &&
    elementBox.x + elementBox.width <= targetBox.x + targetBox.width + tolerance &&
    elementBox.y + elementBox.height <= targetBox.y + targetBox.height + tolerance
  )
}

function visualMismatch(reference, current) {
  const mismatches = []
  const compare = (name, refElement, curElement, styleProperties) => {
    if (!refElement || !curElement) {
      if (Boolean(refElement) !== Boolean(curElement)) mismatches.push(`${name}:missing-element`)
      return
    }
    const hasRelativeBoxes = Boolean(refElement.bbox.relative && curElement.bbox.relative)
    const referenceBox = refElement.bbox.relative || refElement.bbox
    const currentBox = curElement.bbox.relative || curElement.bbox
    const dimensions = hasRelativeBoxes ? ['x', 'y', 'width', 'height'] : ['width', 'height']
    for (const dimension of dimensions) {
      if (Math.abs(referenceBox[dimension] - currentBox[dimension]) > 1) {
        mismatches.push(
          `${name}.bbox.${dimension}:${referenceBox[dimension]}!=${currentBox[dimension]}`,
        )
      }
    }
    for (const property of styleProperties) {
      const refColor = refElement.renderedColors?.[property]
      const curColor = curElement.renderedColors?.[property]
      const colorsMatch =
        Array.isArray(refColor) &&
        Array.isArray(curColor) &&
        refColor.length === curColor.length &&
        refColor.every((value, index) => Math.abs(value - curColor[index]) <= 1)
      if (refElement.style[property] !== curElement.style[property] && !colorsMatch) {
        mismatches.push(
          `${name}.style.${property}:${refElement.style[property]}!=${curElement.style[property]}`,
        )
      }
    }
  }
  const visualStyleProperties = [
    'display',
    'padding',
    'gap',
    'borderWidth',
    'borderColor',
    'borderRadius',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'color',
    'backgroundColor',
  ]
  compare('target', reference, current, visualStyleProperties)
  for (const name of [
    'logo',
    'name',
    'meta',
    'status',
    'testButton',
    'deleteButton',
    'toggle',
    'chevron',
    'grid',
    'apiKey',
    'baseUrl',
    'eye',
    'detail',
  ]) {
    const refElement = reference.elements[name]
    const curElement = current.elements[name]
    if (!isInsideTarget(refElement, reference) || !isInsideTarget(curElement, current)) continue
    // 原型 checkbox 与实现 button 是等价交互原语；开关以像素、bbox 和状态契约为准，
    // 不以浏览器原生控件的无可见语义 computed style 误报。
    compare(name, refElement, curElement, name === 'toggle' ? [] : visualStyleProperties)
  }
  return mismatches
}

async function captureCase({
  caseId,
  referenceTarget,
  currentTarget,
  referenceCard,
  currentCard,
  secondaryReferenceCard = null,
  secondaryCurrentCard = null,
  stateFields,
}) {
  if (!shouldCapture(caseId)) return null
  const caseDir = path.join(OUT, safeName(caseId))
  await fs.rm(caseDir, { recursive: true, force: true })
  await fs.mkdir(caseDir, { recursive: true })
  const missing = []
  if (!(await referenceTarget.count()) || !(await referenceTarget.isVisible())) missing.push('reference-target')
  if (!(await currentTarget.count()) || !(await currentTarget.isVisible())) missing.push('current-target')
  if (missing.length) {
    const metadata = {
      caseId,
      status: 'NOT_COMPARABLE',
      reason: `missing ${missing.join(', ')}`,
      viewport: VIEWPORT,
      locale: 'zh-CN',
    }
    await fs.writeFile(path.join(caseDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    return metadata
  }

  await referenceTarget.scrollIntoViewIfNeeded()
  await currentTarget.scrollIntoViewIfNeeded()
  // locator.click 会把鼠标留在卡片上；成对的基线态不得混入一侧 :hover。
  await Promise.all([
    referenceTarget.page().mouse.move(VIEWPORT.width - 1, 1),
    currentTarget.page().mouse.move(VIEWPORT.width - 1, 1),
  ])
  await Promise.all([
    referenceTarget.page().evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    ),
    currentTarget.page().evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    ),
  ])
  await waitForFonts(referenceTarget.page())
  await waitForFonts(currentTarget.page())
  const referenceInfo = await collectVisualInfo(referenceTarget, referenceCard, 'reference')
  const currentInfo = await collectVisualInfo(currentTarget, currentCard, 'current')
  const referenceContracts = [contractSubset(await providerContract(referenceCard, 'reference'), stateFields)]
  const currentContracts = [contractSubset(await providerContract(currentCard, 'current'), stateFields)]
  if (secondaryReferenceCard && secondaryCurrentCard) {
    referenceContracts.push(
      contractSubset(await providerContract(secondaryReferenceCard, 'reference'), stateFields),
    )
    currentContracts.push(
      contractSubset(await providerContract(secondaryCurrentCard, 'current'), stateFields),
    )
  }

  const referenceCapture = await screenshotAtPhase(referenceTarget)
  const currentCapture = await screenshotAtPhase(currentTarget, referenceCapture.phase?.target || null)
  const referenceBuffer = referenceCapture.buffer
  const currentBuffer = currentCapture.buffer
  await fs.writeFile(path.join(caseDir, 'reference-raw.png'), referenceCapture.rawBuffer)
  await fs.writeFile(path.join(caseDir, 'current-raw.png'), currentCapture.rawBuffer)
  await fs.writeFile(path.join(caseDir, 'reference.png'), referenceBuffer)
  await fs.writeFile(path.join(caseDir, 'current.png'), currentBuffer)
  const targetDiff = diffPng(referenceBuffer, currentBuffer)
  await fs.writeFile(path.join(caseDir, 'diff.png'), targetDiff.buffer)
  const referencePage = await referenceTarget.page().screenshot({ animations: 'disabled' })
  const currentPage = await currentTarget.page().screenshot({ animations: 'disabled' })
  await fs.writeFile(path.join(caseDir, 'reference-page.png'), referencePage)
  await fs.writeFile(path.join(caseDir, 'current-page.png'), currentPage)
  const pageDiff = diffPng(referencePage, currentPage, [referenceInfo.bbox, currentInfo.bbox])
  await fs.writeFile(path.join(caseDir, 'page-diff.png'), pageDiff.buffer)

  const stateEquivalent = JSON.stringify(referenceContracts) === JSON.stringify(currentContracts)
  const styleMismatches = visualMismatch(referenceInfo, currentInfo)
  const pixelPass =
    targetDiff.report.dimensionMatch && targetDiff.report.changedPixelRatio <= PIXEL_THRESHOLD
  const status = stateEquivalent && styleMismatches.length === 0 && pixelPass ? 'PASS' : 'NOT PASS'
  const metadata = {
    caseId,
    status,
    comparable: true,
    environment: {
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      locale: 'zh-CN',
      colorScheme: 'light',
      referenceUrl: REFERENCE_URL,
      currentUrl: CURRENT_URL,
      referenceVisualState: await visualEnvironment(referenceTarget.page()),
      currentVisualState: await visualEnvironment(currentTarget.page()),
    },
    contract: { fields: stateFields, reference: referenceContracts, current: currentContracts },
    stateEquivalent,
    domEquivalent: stateEquivalent,
    targetPixelDiff: targetDiff.report,
    fullPagePixelDiff: pageDiff.report,
    fullPageDifferenceFromTargetOutsideArea:
      pageDiff.report.differenceOrigin === 'mostly-outside-target',
    capturePhaseNormalization: {
      reference: referenceCapture.phase,
      current: currentCapture.phase,
    },
    criticalBBoxAndComputedStylePass: styleMismatches.length === 0,
    criticalBBoxAndComputedStyleMismatches: styleMismatches,
    reference: referenceInfo,
    current: currentInfo,
    artifacts: {
      reference: path.join(caseDir, 'reference.png'),
      current: path.join(caseDir, 'current.png'),
      referenceRaw: path.join(caseDir, 'reference-raw.png'),
      currentRaw: path.join(caseDir, 'current-raw.png'),
      diff: path.join(caseDir, 'diff.png'),
      referencePage: path.join(caseDir, 'reference-page.png'),
      currentPage: path.join(caseDir, 'current-page.png'),
      pageDiff: path.join(caseDir, 'page-diff.png'),
    },
  }
  await fs.writeFile(path.join(caseDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

async function run() {
  await fs.mkdir(OUT, { recursive: true })
  const browserType = BROWSER_ENGINE === 'webkit' ? webkit : chromium
  const browser = await browserType.launch(
    BROWSER_ENGINE === 'webkit' ? { headless: true } : { channel: 'chrome', headless: true },
  )
  const contextOptions = {
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: 'zh-CN',
      colorScheme: 'light',
      browser: BROWSER_ENGINE,
    reducedMotion: 'reduce',
  }
  const referenceContext = await browser.newContext(contextOptions)
  const currentContext = await browser.newContext(contextOptions)
  const referencePage = await referenceContext.newPage()
  const currentPage = await currentContext.newPage()
  let testMode = 'success'
  const pendingRoutes = []
  const requestLog = []
  const pageErrors = []
  currentPage.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)))

  await currentPage.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    requestLog.push({ method: route.request().method(), pathname })
    if (
      route.request().method() === 'POST' &&
      pathname.endsWith('/config/llm/models')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        // 本用例验证既有配置的卡头/字段投影，不把后台目录自动同步混入回执状态机。
        body: JSON.stringify({ models: [] }),
      })
      return
    }
    if (
      route.request().method() === 'POST' &&
      (pathname.includes('/test') || pathname.includes('/probe'))
    ) {
      if (testMode === 'failed') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"ok":false,"success":false,"message":"Invalid API key","error_message":"Invalid API key"}',
        })
        return
      }
      if (testMode === 'pending') {
        await new Promise((resolvePending) => pendingRoutes.push({ route, resolvePending }))
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"success":true,"message":"Connected"}',
      })
      return
    }
    if (pathname.endsWith('/config/llm')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(llmSnapshot),
      })
      return
    }
    if (pathname.endsWith('/config')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(fullConfig()),
      })
      return
    }
    if (pathname.endsWith('/llm/capabilities')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  const results = []
  const capture = async (options) => {
    const result = await captureCase(options)
    if (result) results.push(result)
  }

  try {
    await Promise.all([openReference(referencePage), openCurrent(currentPage)])
    let refOpenAI = await resolveCard(referencePage, 'reference', 'openai', 'OpenAI')
    let curOpenAI = await resolveCard(currentPage, 'current', 'openai', 'OpenAI')
    let refDeepSeek = await resolveCard(referencePage, 'reference', 'deepseek', 'DeepSeek')
    let curDeepSeek = await resolveCard(currentPage, 'current', 'deepseek', 'DeepSeek')
    let refOpenRouter = await resolveCard(referencePage, 'reference', 'custom', 'OpenRouter')
    let curOpenRouter = await resolveCard(currentPage, 'current', 'openrouter', 'OpenRouter')
    const refNvidia = await resolveCard(referencePage, 'reference', 'nvidia', 'Nvidia')
    const curNvidia = await resolveCard(currentPage, 'current', 'nvidia', 'Nvidia')
    // 初次进入会短暂显示本地默认态；仅在需要已持久回执的三张卡上等待其服务端投影。
    await Promise.all([
      waitForCurrentProviderStatus(curOpenAI, '成功'),
      waitForCurrentProviderStatus(curDeepSeek, '失败'),
      waitForCurrentProviderStatus(curOpenRouter, '成功'),
      waitForCurrentProviderStatus(curNvidia, '失败'),
    ])

    await setExpanded(refOpenRouter, 'reference', false)
    await setExpanded(curOpenRouter, 'current', false)
    await capture({
      caseId: '20260723-021-openrouter-success',
      referenceTarget: refOpenRouter.locator('.prov-top'),
      currentTarget: curOpenRouter.locator('.hc-provider__card-head'),
      referenceCard: refOpenRouter,
      currentCard: curOpenRouter,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded'],
    })

    await setExpanded(refNvidia, 'reference', true)
    await setExpanded(curNvidia, 'current', true)
    await capture({
      caseId: '20260723-021-nvidia-failed',
      referenceTarget: refNvidia.locator('.prov-top'),
      currentTarget: curNvidia.locator('.hc-provider__card-head'),
      referenceCard: refNvidia,
      currentCard: curNvidia,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded', 'detailVisible', 'detailText'],
    })
    await capture({
      caseId: '20260823-provider-probe-redacted-detail',
      referenceTarget: refNvidia.locator('.provider-connection-detail'),
      currentTarget: curNvidia.locator('.hc-provider__connection-detail'),
      referenceCard: refNvidia,
      currentCard: curNvidia,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded', 'detailVisible', 'detailText'],
    })

    await setExpanded(refOpenAI, 'reference', false)
    await setExpanded(curOpenAI, 'current', false)
    await capture({
      caseId: '20260818-001-cardhead-success',
      referenceTarget: refOpenAI.locator('.prov-top'),
      currentTarget: curOpenAI.locator('.hc-provider__card-head'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded'],
    })

    await setReferenceState(referencePage, 'custom', 'untested')
    delete llmSnapshot.providers.openrouter.probe_receipt
    await openCurrent(currentPage)
    curOpenRouter = await resolveCard(currentPage, 'current', 'openrouter', 'OpenRouter')
    await setExpanded(refOpenRouter, 'reference', false)
    await setExpanded(curOpenRouter, 'current', false)
    await capture({
      caseId: '20260818-001-cardhead-untested',
      referenceTarget: refOpenRouter.locator('.prov-top'),
      currentTarget: curOpenRouter.locator('.hc-provider__card-head'),
      referenceCard: refOpenRouter,
      currentCard: curOpenRouter,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded'],
    })

    await setExpanded(refOpenAI, 'reference', true)
    await setExpanded(curOpenAI, 'current', true)
    await capture({
      caseId: '20260817-001-api-key-hidden',
      referenceTarget: refOpenAI.locator('.provider-config-field--key'),
      currentTarget: curOpenAI.locator('.hc-provider__config-key'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      // 卡头回执另有专门状态用例；此处只验证密钥字段的隐藏/显示契约，避免重载夹具后
      // 无关 Provider 回执状态污染字段目标的成对视觉结论。
      stateFields: ['providerName', 'modelCount', 'expanded', 'apiKeyInputType'],
    })
    await refOpenAI.locator('.provider-secret-button').click()
    await curOpenAI.locator('.hc-settings__eye-btn').click({ timeout: 1500 }).catch(() => {})
    await setExpanded(refOpenAI, 'reference', true)
    await setExpanded(curOpenAI, 'current', true)
    await capture({
      caseId: '20260817-001-api-key-revealed',
      referenceTarget: refOpenAI.locator('.provider-config-field--key'),
      currentTarget: curOpenAI.locator('.hc-provider__config-key'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      stateFields: ['providerName', 'modelCount', 'expanded', 'apiKeyInputType'],
    })
    await refOpenAI.locator('.provider-secret-button').click()
    await curOpenAI.locator('.hc-settings__eye-btn').click({ timeout: 1500 }).catch(() => {})
    await capture({
      caseId: '20260817-001-api-key-hidden-again',
      referenceTarget: refOpenAI.locator('.provider-config-field--key'),
      currentTarget: curOpenAI.locator('.hc-provider__config-key'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      stateFields: ['providerName', 'modelCount', 'expanded', 'apiKeyInputType'],
    })
    await setExpanded(curOpenAI, 'current', true)
    await Promise.all([
      referencePage.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        document.body.tabIndex = -1
        document.body.focus()
      }),
      currentPage.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        document.body.tabIndex = -1
        document.body.focus()
      }),
    ])
    await capture({
      caseId: '20260817-004-field-grid',
      referenceTarget: refOpenAI.locator('.provider-config-grid'),
      currentTarget: curOpenAI.locator('.hc-provider__config-grid'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      stateFields: ['providerName', 'modelCount', 'expanded', 'fieldOrder'],
    })

    llmSnapshot.providers.deepseek.probe_receipt = {
      provider_instance_id: 'pvd_v1_00000000000000000000000000000002',
      outcome: 'failed',
      locality: 'cloud',
      tested_at: 1787337600000,
      detail: 'Invalid API key',
      message: 'Invalid API key',
    }
    // 失败态由同一份快照重新水合，避免 current 页面继续沿用上一状态的 DOM。
    await openCurrent(currentPage)
    curOpenAI = await resolveCard(currentPage, 'current', 'openai', 'OpenAI')
    curDeepSeek = await resolveCard(currentPage, 'current', 'deepseek', 'DeepSeek')
    if (
      !(await curDeepSeek
        .locator('.hc-provider__connection-status')
        .filter({ hasText: '失败' })
        .isVisible()
        .catch(() => false))
    ) {
      testMode = 'failed'
      await curDeepSeek.locator('.hc-provider__test-btn').click()
    }
    await curDeepSeek
      .locator('.hc-provider__connection-status')
      .filter({ hasText: '失败' })
      .waitFor({ state: 'visible', timeout: 5000 })
    await setReferenceState(referencePage, 'deepseek', 'failed', 'Invalid API key')
    await setExpanded(refDeepSeek, 'reference', true)
    await setExpanded(curDeepSeek, 'current', true)
    await capture({
      caseId: '20260818-001-cardhead-failed',
      referenceTarget: refDeepSeek.locator('.prov-top'),
      currentTarget: curDeepSeek.locator('.hc-provider__card-head'),
      referenceCard: refDeepSeek,
      currentCard: curDeepSeek,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded'],
    })
    const failureFields = [
      'providerName',
      'modelCount',
      'status',
      'expanded',
      'detailVisible',
      'detailText',
    ]
    await capture({
      caseId: '20260817-002-failed-expanded',
      referenceTarget: refDeepSeek.locator('.provider-connection-detail'),
      currentTarget: curDeepSeek.locator('.hc-provider__connection-detail'),
      referenceCard: refDeepSeek,
      currentCard: curDeepSeek,
      stateFields: failureFields,
    })
    await setExpanded(refDeepSeek, 'reference', false)
    await setExpanded(curDeepSeek, 'current', false)
    await capture({
      caseId: '20260817-002-failed-collapsed',
      referenceTarget: refDeepSeek,
      currentTarget: curDeepSeek,
      referenceCard: refDeepSeek,
      currentCard: curDeepSeek,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded', 'detailVisible'],
    })
    await setExpanded(refDeepSeek, 'reference', true)
    await setExpanded(curDeepSeek, 'current', true)
    await capture({
      caseId: '20260817-002-failed-reopened',
      referenceTarget: refDeepSeek.locator('.provider-connection-detail'),
      currentTarget: curDeepSeek.locator('.hc-provider__connection-detail'),
      referenceCard: refDeepSeek,
      currentCard: curDeepSeek,
      stateFields: failureFields,
    })

    delete llmSnapshot.providers.deepseek.probe_receipt
    await openCurrent(currentPage)
    curOpenAI = await resolveCard(currentPage, 'current', 'openai', 'OpenAI')
    curDeepSeek = await resolveCard(currentPage, 'current', 'deepseek', 'DeepSeek')
    refOpenAI = await resolveCard(referencePage, 'reference', 'openai', 'OpenAI')
    refDeepSeek = await resolveCard(referencePage, 'reference', 'deepseek', 'DeepSeek')
    await setExpanded(refOpenAI, 'reference', false)
    await setExpanded(refDeepSeek, 'reference', false)
    await setExpanded(curOpenAI, 'current', false)
    await setExpanded(curDeepSeek, 'current', false)
    await setReferenceState(referencePage, 'openai', 'testing')
    await setReferenceState(referencePage, 'deepseek', 'testing')
    for (const card of [refOpenAI, refDeepSeek]) {
      await card
        .locator('button')
        .filter({ hasText: /^测试$/ })
        .first()
        .evaluate((element) => {
          element.disabled = true
          element.setAttribute('aria-busy', 'true')
        })
    }
    testMode = 'pending'
    const pendingDom = () =>
      currentPage.evaluate(() => ({
        href: location.href,
        providerCount: document.querySelectorAll('.hc-provider__card').length,
        cards: Array.from(document.querySelectorAll('.hc-provider__card')).map((card) => ({
          type: card.getAttribute('data-provider-type'),
          status: card.querySelector('.hc-provider__connection-status')?.textContent?.trim() || null,
          testDisabled: Boolean(card.querySelector('.hc-provider__test-btn')?.disabled),
          text: card.textContent?.trim().replace(/\s+/g, ' ') || '',
        })),
      }))
    const beforePendingClicks = await pendingDom()
    await curOpenAI.locator('.hc-provider__test-btn').click({ timeout: 3000 })
    try {
      await curOpenAI
        .locator('.hc-provider__connection-status')
        .filter({ hasText: '测试中' })
        .waitFor({ state: 'visible', timeout: 3000 })
      await curDeepSeek.locator('.hc-provider__test-btn').click({ timeout: 3000 })
      await currentPage.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('.hc-provider__connection-status')).filter((element) =>
            (element.textContent || '').includes('测试中'),
          ).length >= 2,
        undefined,
        { timeout: 10000 },
      )
    } catch (error) {
      const dom = await pendingDom()
      await fs.writeFile(
        path.join(OUT, 'pending-state-red.json'),
        `${JSON.stringify({ requestLog, pageErrors, beforePendingClicks, dom }, null, 2)}\n`,
      )
      throw error
    }
    curOpenAI = await resolveCard(currentPage, 'current', 'openai', 'OpenAI')
    curDeepSeek = await resolveCard(currentPage, 'current', 'deepseek', 'DeepSeek')
    await capture({
      caseId: '20260818-001-cardhead-testing',
      referenceTarget: refOpenAI.locator('.prov-top'),
      currentTarget: curOpenAI.locator('.hc-provider__card-head'),
      referenceCard: refOpenAI,
      currentCard: curOpenAI,
      stateFields: ['providerName', 'modelCount', 'status', 'expanded', 'testDisabled'],
    })
    const restorePair = await isolateProviderPair(referencePage, currentPage, ['openai', 'deepseek'])
    try {
      await capture({
        caseId: '20260817-003-dual-card-pending',
        referenceTarget: refOpenAI.locator('xpath=..'),
        currentTarget: currentPage.locator('.hc-provider__list'),
        referenceCard: refOpenAI,
        currentCard: curOpenAI,
        secondaryReferenceCard: refDeepSeek,
        secondaryCurrentCard: curDeepSeek,
        stateFields: ['providerName', 'modelCount', 'status', 'expanded', 'testDisabled'],
      })
    } finally {
      await restorePair()
    }

    for (const pending of pendingRoutes.splice(0)) {
      await pending.route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"success":true,"message":"Connected"}',
      })
      pending.resolvePending()
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'NOT PASS',
      infrastructureStatus: 'PASS',
      evidenceRoot: OUT,
      environment: {
        viewport: VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        locale: 'zh-CN',
        colorScheme: 'light',
        referenceUrl: REFERENCE_URL,
        currentUrl: CURRENT_URL,
      },
      cases: results.map((result) => ({
        caseId: result.caseId,
        status: result.status,
        reason: result.reason ?? null,
        stateEquivalent: result.stateEquivalent ?? false,
        contract: result.contract ?? null,
        targetChangedPixelRatio: result.targetPixelDiff?.changedPixelRatio ?? null,
        targetChangedBBox: result.targetPixelDiff?.changedBBox ?? null,
        fullPageDifferenceOrigin: result.fullPagePixelDiff?.differenceOrigin ?? null,
        fullPageOutsideChangeShare: result.fullPagePixelDiff?.outsideChangeShare ?? null,
        criticalBBoxAndComputedStyleMismatches:
          result.criticalBBoxAndComputedStyleMismatches?.slice(0, 12) ?? [],
        artifacts: result.artifacts ?? null,
        metadata: path.join(OUT, safeName(result.caseId), 'metadata.json'),
      })),
    }
    await fs.writeFile(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } catch (error) {
    const failure = {
      generatedAt: new Date().toISOString(),
      status: 'NOT_COMPARABLE',
      infrastructureStatus: 'FAIL',
      evidenceRoot: OUT,
      error: error instanceof Error ? error.stack || error.message : String(error),
    }
    await fs.writeFile(path.join(OUT, 'infrastructure-error.json'), `${JSON.stringify(failure, null, 2)}\n`)
    throw error
  } finally {
    for (const pending of pendingRoutes.splice(0)) {
      await pending.route.abort('failed').catch(() => {})
      pending.resolvePending()
    }
    await referenceContext.close()
    await currentContext.close()
    await browser.close()
  }
}

await run()
