import { chromium } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(process.cwd())
const REFERENCE_URL = process.env.HEX_LEGACY_TOOL_REFERENCE_URL ?? 'http://127.0.0.1:16070/app.html'
const IMPLEMENTATION_URL =
  process.env.HEX_LEGACY_TOOL_IMPLEMENTATION_URL ??
  'http://127.0.0.1:15151/tests/e2e/fixtures/legacy-tool-protocol.html'
const EVIDENCE_ROOT = path.resolve(
  process.env.HEX_LEGACY_TOOL_EVIDENCE_ROOT ??
    path.join(ROOT, '../hexclaw-docs/test/evidence/bug-20260820-006-legacy-tool-protocol'),
)
const PIXEL_DIFF_TOOL = path.resolve(ROOT, 'tests/e2e/tools/visual_pixel_diff.py')
const VIEWPORT = { width: 1440, height: 900 }
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01
const STYLE_FIELDS = [
  'display',
  'boxSizing',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'borderRadius',
  'backgroundColor',
  'color',
  'opacity',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'whiteSpace',
  'overflowWrap',
]
const STATES = [
  { id: 'closed-legacy', state: 'closed', height: 112 },
  { id: 'open-legacy', state: 'open', height: 48 },
]

function frameStyles(height) {
  return `
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
    }
    html, body, #app {
      width: 100%;
      height: 100%;
      margin: 0 !important;
    }
    body {
      overflow: hidden;
      background: var(--hc-bg-main) !important;
    }
    #visual-compare-frame {
      box-sizing: border-box;
      width: 780px;
      height: ${height}px;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--hc-bg-main);
      color: var(--hc-text-primary);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text',
        'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
        'Segoe UI', sans-serif;
    }
    #visual-compare-frame > .bubble,
    #visual-compare-frame > .implementation-bubble {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--hc-text-primary);
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;
    }
  `
}

function implementationStateURL(state) {
  const url = new URL(IMPLEMENTATION_URL)
  url.searchParams.set('state', state)
  return url.toString()
}

async function installNetworkGuard(page, blockedRequests, mockedHealthRequests) {
  await page.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/health') {
      mockedHealthRequests.push(url.toString())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'healthy' }),
      })
    }
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return route.fallback()
    blockedRequests.push(url.toString())
    return route.abort('blockedbyclient')
  })
}

async function prepareReference(page, state) {
  await page.goto(REFERENCE_URL, { waitUntil: 'load', timeout: 12_000 })
  await page.evaluate((legacyState) => {
    const variant = document.querySelector(
      `template[data-prototype-variant="chat-tool-display.${legacyState}-legacy"]`,
    )
    if (!(variant instanceof HTMLTemplateElement)) {
      throw new Error(`prototype ${legacyState} legacy fixture is missing`)
    }
    const bubble = variant.content.querySelector('.bubble')?.cloneNode(true)
    if (!(bubble instanceof HTMLElement)) {
      throw new Error(`prototype ${legacyState} legacy bubble is missing`)
    }
    const frame = document.createElement('main')
    frame.id = 'visual-compare-frame'
    frame.dataset.referenceLegacyState = legacyState
    frame.append(bubble)
    document.body.replaceChildren(frame)
    document.documentElement.dataset.theme = 'light'
  }, state.state)
  await page.addStyleTag({ content: frameStyles(state.height) })
  await page.locator('#visual-compare-frame').waitFor({ state: 'visible' })
}

async function prepareImplementation(page, state) {
  await page.goto(implementationStateURL(state.state), {
    waitUntil: 'networkidle',
    timeout: 12_000,
  })
  await page.addStyleTag({ content: frameStyles(state.height) })
  await page.locator('#visual-compare-frame').waitFor({ state: 'visible' })
}

async function settle(page, state) {
  await page.evaluate(() => document.fonts.ready)
  if (state.state === 'closed') {
    await page.locator('.code-block-wrapper').hover()
  }
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

async function semanticSnapshot(page, state) {
  return page.locator('#visual-compare-frame').evaluate((frame, legacyState) => {
    const html = frame.innerHTML
    const wrappers = frame.querySelectorAll('.code-block-wrapper')
    const copyButtons = frame.querySelectorAll('.copy-btn')
    return {
      state: legacyState,
      codeBlockCount: wrappers.length,
      copyButtonCount: copyButtons.length,
      language: frame.querySelector('.code-lang')?.textContent?.trim() ?? '',
      code: frame.querySelector('.code-block code')?.textContent?.trimEnd() ?? '',
      visibleText: frame.textContent?.trim() ?? '',
      protocolMarkerCount: [
        'function=',
        'parameter=',
        '/parameter',
        '/function',
        '/tool_call',
      ].reduce((count, marker) => count + (html.includes(marker) ? 1 : 0), 0),
    }
  }, state.state)
}

function selectors(state, source) {
  if (state.state === 'open') {
    return [
      { name: 'frame', selector: '#visual-compare-frame' },
      { name: 'paragraph', selector: source === 'reference' ? '.bubble p' : '.markdown-body p' },
    ]
  }
  return [
    { name: 'frame', selector: '#visual-compare-frame' },
    { name: 'wrapper', selector: '.code-block-wrapper' },
    { name: 'header', selector: '.code-block-header' },
    { name: 'language', selector: '.code-lang' },
    { name: 'copy', selector: '.copy-btn' },
    { name: 'pre', selector: '.code-block' },
    { name: 'code', selector: '.code-block code' },
  ]
}

async function geometryAndStyles(page, targets) {
  return page.evaluate(
    ({ entries, fields }) => {
      const frame = document.querySelector('#visual-compare-frame')
      const frameRect = frame?.getBoundingClientRect()
      return entries.map(({ name, selector }) => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement) || !frameRect) return { name, selector, present: false }
        const rect = node.getBoundingClientRect()
        const computed = getComputedStyle(node)
        return {
          name,
          selector,
          present: true,
          bbox: {
            x: Number((rect.x - frameRect.x).toFixed(2)),
            y: Number((rect.y - frameRect.y).toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
          },
          style: Object.fromEntries(fields.map((field) => [field, computed[field]])),
          text: node.textContent?.trim() ?? '',
        }
      })
    },
    { entries: targets, fields: STYLE_FIELDS },
  )
}

function compareGeometryAndStyles(reference, implementation) {
  const differences = []
  const implementationByName = new Map(implementation.map((entry) => [entry.name, entry]))
  for (const expected of reference) {
    const actual = implementationByName.get(expected.name)
    if (!expected.present || !actual?.present) {
      differences.push(`${expected.name}.present`)
      continue
    }
    for (const field of ['x', 'y', 'width', 'height']) {
      if (Math.abs(expected.bbox[field] - actual.bbox[field]) > 0.01) {
        differences.push(`${expected.name}.bbox.${field}`)
      }
    }
    for (const field of STYLE_FIELDS) {
      const expectedValue =
        field === 'border' && expected.style[field].startsWith('0px ')
          ? '0px'
          : expected.style[field]
      const actualValue =
        field === 'border' && actual.style[field].startsWith('0px ') ? '0px' : actual.style[field]
      if (expectedValue !== actualValue) {
        differences.push(`${expected.name}.style.${field}`)
      }
    }
  }
  return differences
}

function assertSemanticState(snapshot, state, source) {
  if (state.state === 'closed') {
    if (snapshot.codeBlockCount !== 1)
      throw new Error(`${source} closed state has ${snapshot.codeBlockCount} code blocks`)
    if (snapshot.copyButtonCount !== 1)
      throw new Error(`${source} closed state has ${snapshot.copyButtonCount} copy buttons`)
    if (snapshot.language !== 'python')
      throw new Error(`${source} closed language is ${snapshot.language}`)
    if (snapshot.code !== "print('hello from legacy code_exec')")
      throw new Error(`${source} closed code drifted`)
    if (snapshot.protocolMarkerCount !== 0)
      throw new Error(`${source} closed protocol markers leaked`)
    return
  }
  const expected = `<function=code_exec><parameter=code>print('still streaming')`
  if (snapshot.codeBlockCount !== 0) throw new Error(`${source} open state projected too early`)
  if (snapshot.visibleText !== expected) {
    throw new Error(
      `${source} open state did not preserve raw text: ${JSON.stringify(snapshot.visibleText)}`,
    )
  }
}

async function captureState(browser, state) {
  const options = {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  }
  const referenceContext = await browser.newContext(options)
  const implementationContext = await browser.newContext(options)
  const blockedRequests = []
  const mockedHealthRequests = []
  const directory = path.join(EVIDENCE_ROOT, state.id)
  await mkdir(directory, { recursive: true })

  try {
    await Promise.all([
      installNetworkGuard(referenceContext, blockedRequests, mockedHealthRequests),
      installNetworkGuard(implementationContext, blockedRequests, mockedHealthRequests),
    ])
    const referencePage = await referenceContext.newPage()
    const implementationPage = await implementationContext.newPage()
    await Promise.all([
      prepareReference(referencePage, state),
      prepareImplementation(implementationPage, state),
    ])
    await Promise.all([settle(referencePage, state), settle(implementationPage, state)])

    const [referenceSemantic, implementationSemantic, referenceGeometry, implementationGeometry] =
      await Promise.all([
        semanticSnapshot(referencePage, state),
        semanticSnapshot(implementationPage, state),
        geometryAndStyles(referencePage, selectors(state, 'reference')),
        geometryAndStyles(implementationPage, selectors(state, 'implementation')),
      ])
    assertSemanticState(referenceSemantic, state, 'reference')
    assertSemanticState(implementationSemantic, state, 'implementation')

    const referencePath = path.join(directory, 'reference.png')
    const implementationPath = path.join(directory, 'current.png')
    await Promise.all([
      referencePage.locator('#visual-compare-frame').screenshot({ path: referencePath }),
      implementationPage.locator('#visual-compare-frame').screenshot({ path: implementationPath }),
    ])
    const diffPath = path.join(directory, 'pixel-diff.png')
    const diff = await execFileAsync('uv', [
      'run',
      '--offline',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      PIXEL_DIFF_TOOL,
      referencePath,
      implementationPath,
      diffPath,
      String(PIXEL_THRESHOLD),
    ])
    const pixel = JSON.parse(diff.stdout)
    const differences = compareGeometryAndStyles(referenceGeometry, implementationGeometry)
    const result = {
      id: state.id,
      viewport: { ...VIEWPORT, deviceScaleFactor: 1, locale: 'zh-CN', theme: 'light' },
      semantic: { reference: referenceSemantic, implementation: implementationSemantic },
      pixel,
      blockedRequests,
      mockedHealthRequests,
      geometryAndStyleDifferences: differences,
      reference: referenceGeometry,
      implementation: implementationGeometry,
      status:
        pixel.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO &&
        differences.length === 0 &&
        blockedRequests.length === 0
          ? 'PASS'
          : 'DRIFT',
    }
    await writeFile(
      path.join(directory, 'bbox-computed-style.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    )
    return result
  } finally {
    await referenceContext.close()
    await implementationContext.close()
  }
}

async function run() {
  await mkdir(EVIDENCE_ROOT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const states = []
    for (const state of STATES) states.push(await captureState(browser, state))
    const summary = {
      generatedAt: new Date().toISOString(),
      oracle: {
        reference: REFERENCE_URL,
        implementation: IMPLEMENTATION_URL,
        network: 'offline local prototype and real MarkdownRenderer fixture only',
      },
      states,
      status: states.every((state) => state.status === 'PASS') ? 'PASS' : 'DRIFT',
    }
    await writeFile(
      path.join(EVIDENCE_ROOT, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    console.log(JSON.stringify(summary, null, 2))
    if (summary.status !== 'PASS') process.exitCode = 1
  } finally {
    await browser.close()
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
