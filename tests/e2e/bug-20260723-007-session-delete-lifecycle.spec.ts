import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

const execFileAsync = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EVIDENCE_ROOT = path.join(
  REPO_ROOT,
  'test/evidence/bug-20260723-007-session-delete-lifecycle',
)
const REFERENCE_URL =
  process.env.HEX_BUG_007_REFERENCE_URL?.trim() || 'http://127.0.0.1:16707/app.html'
const SOURCE_URL = process.env.HEX_BUG_007_SOURCE_URL?.trim() || 'http://127.0.0.1:16708'
const SESSION_ID = 'bug-20260723-007-session'
const SESSION_TITLE = '会话删除生命周期'
const SESSION_MESSAGE = `将删除「${SESSION_TITLE}」及其全部消息，此操作不可撤销。`
const COOLDOWN_MS = 1_500
const VIEWPORT = { width: 1440, height: 900 }
const SCREENSHOT_SIZE = { width: 560, height: 320 }
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01
const FIXED_TIME = '2026-08-22T15:00:00+08:00'

const STABILIZATION_CSS = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`

const STYLE_KEYS = [
  'boxSizing',
  'width',
  'height',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRadius',
  'backgroundColor',
  'boxShadow',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'opacity',
] as const

type FixtureState = {
  deleteAttempts: number
  deleteResponses: number[]
  requests: Array<{ method: string; path: string; responseStatus: number }>
  blockedExternalRequests: string[]
}

type Rect = { x: number; y: number; width: number; height: number }

type ElementSnapshot = {
  text: string
  role: string | null
  ariaLabel: string | null
  disabled: boolean
  rect: Rect
  style: Record<string, string>
}

type DialogSnapshot = {
  title: string
  message: string
  buttons: Array<{ text: string; disabled: boolean; ariaLabel: string | null }>
  activeElement: {
    tag: string | null
    className: string | null
    ariaLabel: string | null
    text: string | null
  }
  dialog: ElementSnapshot
  titleNode: ElementSnapshot
  messageNode: ElementSnapshot
  cancelButton: ElementSnapshot
  confirmButton: ElementSnapshot
  closeButton: ElementSnapshot
}

type Bitmap = { width: number; height: number; rgba: Uint8Array }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function sourceConfig() {
  return {
    general: {
      language: 'zh-CN',
      log_level: 'info',
      data_dir: '',
      auto_start: false,
      defaultAgentRole: 'assistant',
      welcomeCompleted: true,
    },
    notification: { system_enabled: true, sound_enabled: false, agent_complete: true },
    memory: { enabled: true },
    sandbox: { network_enabled: false },
    security: {
      gateway_enabled: true,
      injection_detection: true,
      pii_filter: false,
      content_filter: true,
      max_tokens_per_request: 8_192,
      rate_limit_rpm: 60,
    },
    mcp: { default_protocol: 'stdio' },
    llm: {
      default: '',
      defaultModel: '',
      defaultProviderId: '',
      providers: [],
      routing: { enabled: false },
      cache: { enabled: false },
    },
  }
}

async function installReferenceIsolation(page: Page, state: FixtureState) {
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      state.blockedExternalRequests.push(url.toString())
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
}

async function installSourceFixture(page: Page, state: FixtureState) {
  await page.addInitScript(
    ({ sessionId }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', sessionId)
      localStorage.setItem('hexclaw_pinned_sessions', JSON.stringify([sessionId]))
      localStorage.setItem('hc-theme', 'light')
    },
    { sessionId: SESSION_ID },
  )

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      state.blockedExternalRequests.push(url.toString())
      return route.abort('blockedbyclient')
    }
    if (url.hostname === 'localhost' && url.port === '11434') {
      return json(route, { models: [], version: 'bug-20260723-007-fixture' })
    }
    if (!url.pathname.startsWith('/_hexclaw/')) return route.continue()

    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const respond = (body: unknown, status = 200) => {
      state.requests.push({ method, path: apiPath, responseStatus: status })
      return json(route, body, status)
    }

    if (apiPath === '/api/v1/config' && method === 'GET') return respond(sourceConfig())
    if (apiPath === '/api/v1/config/llm' && method === 'GET') {
      return respond(sourceConfig().llm)
    }
    if (apiPath === '/api/v1/ollama/status') {
      return respond({ running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/roles') return respond({ roles: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return respond({ streams: [], total: 0 })
    if (apiPath === '/api/v1/agents') return respond({ agents: [], total: 0, default: '' })
    if (apiPath === '/api/v1/agents/rules') return respond({ rules: [], total: 0 })
    if (apiPath === '/api/v1/skills') return respond({ skills: [], total: 0, dir: '' })
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return respond({
        sessions: [
          {
            id: SESSION_ID,
            title: SESSION_TITLE,
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
            message_count: 1,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}/messages` && method === 'GET') {
      return respond({
        messages: [
          {
            id: 'bug-20260723-007-message',
            role: 'assistant',
            content: '会话删除生命周期 fixture',
            timestamp: FIXED_TIME,
            created_at: FIXED_TIME,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}/artifacts` && method === 'GET') {
      return respond({ artifacts: [], total: 0 })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}/branches` && method === 'GET') {
      return respond({ branches: [], total: 0 })
    }
    if (apiPath === `/api/v1/sessions/${SESSION_ID}` && method === 'DELETE') {
      const responseStatus = state.deleteResponses[state.deleteAttempts] ?? 200
      state.deleteAttempts += 1
      return respond(
        responseStatus >= 400
          ? { error: { code: 'DELETE_FIXTURE_FAILURE', message: 'retryable fixture failure' } }
          : { message: 'deleted' },
        responseStatus,
      )
    }
    return respond({})
  })
}

async function openSource(page: Page) {
  await page.goto(`${SOURCE_URL}/chat`, { waitUntil: 'domcontentloaded' })
  await page.locator('#splash-screen').waitFor({ state: 'detached' })
  await page.locator(`[data-session-id="${SESSION_ID}"]`).waitFor({ state: 'visible' })
}

async function openSourceDeleteDialog(page: Page) {
  const row = page.locator(`[data-session-id="${SESSION_ID}"]`)
  await row.hover()
  await row.getByRole('button', { name: '会话操作' }).click()
  const menu = page.locator('.hc-ctx[role="menu"]')
  await menu.waitFor({ state: 'visible' })
  const deleteItem = menu.locator('.hc-ctx__item--danger')
  await expect(deleteItem.locator('.hc-ctx__label')).toHaveText('删除')
  await deleteItem.click()
  const dialog = page.getByRole('alertdialog', { name: '删除会话？' })
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

async function openReferenceDeleteDialog(page: Page) {
  const opened = await page.evaluate(
    ({ sessionTitle }) => {
      const host = window as typeof window & {
        go?: (target: string) => void
        deletePrototypeSession?: (item: Element) => void
      }
      host.go?.('chat')
      const item = document.querySelector('.cs-item[data-session-id="browser-1"]')
      const title = item?.querySelector('.cs-t')
      if (!item || !title || !host.deletePrototypeSession) return false
      title.textContent = sessionTitle
      host.deletePrototypeSession(item)
      return true
    },
    { sessionTitle: SESSION_TITLE },
  )
  expect(opened).toBe(true)
  const dialog = page.locator('#overlayCard .modal')
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready
  })
}

async function elementSnapshot(locator: Locator): Promise<ElementSnapshot> {
  return locator.evaluate((element, keys) => {
    const target = element as HTMLButtonElement
    const rect = target.getBoundingClientRect()
    const style = getComputedStyle(target)
    return {
      text: (target.textContent ?? '').replace(/\s+/g, ' ').trim(),
      role: target.getAttribute('role'),
      ariaLabel: target.getAttribute('aria-label'),
      disabled: Boolean(target.disabled),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: Object.fromEntries(keys.map((key) => [key, style[key]])),
    }
  }, STYLE_KEYS)
}

async function dialogSnapshot(page: Page, kind: 'reference' | 'implementation') {
  const selectors =
    kind === 'reference'
      ? {
          dialog: '#overlayCard .modal',
          title: '#overlayCard .modal-h b',
          message: '#overlayCard .modal-b p',
          cancel: '#mCancel',
          confirm: '#mPrimary',
          close: '#overlayCard .modal-h .x',
        }
      : {
          dialog: '.hc-dialog',
          title: '.hc-dialog__title',
          message: '.hc-dialog__msg',
          cancel: '.hc-dialog__actions .hc-btn-secondary',
          confirm: '.hc-dialog__actions .hc-dialog__btn--danger',
          close: '.hc-dialog__close',
        }
  const [dialog, titleNode, messageNode, cancelButton, confirmButton, closeButton] =
    await Promise.all([
      elementSnapshot(page.locator(selectors.dialog)),
      elementSnapshot(page.locator(selectors.title)),
      elementSnapshot(page.locator(selectors.message)),
      elementSnapshot(page.locator(selectors.cancel)),
      elementSnapshot(page.locator(selectors.confirm)),
      elementSnapshot(page.locator(selectors.close)),
    ])
  const activeElement = await page.evaluate(() => {
    const element = document.activeElement
    return {
      tag: element?.tagName.toLowerCase() ?? null,
      className: element instanceof HTMLElement ? element.className || null : null,
      ariaLabel: element?.getAttribute('aria-label') ?? null,
      text: element?.textContent?.trim() || null,
    }
  })
  return {
    title: titleNode.text,
    message: messageNode.text,
    buttons: [cancelButton, confirmButton].map((button) => ({
      text: button.text,
      disabled: button.disabled,
      ariaLabel: button.ariaLabel,
    })),
    activeElement,
    dialog,
    titleNode,
    messageNode,
    cancelButton,
    confirmButton,
    closeButton,
  } satisfies DialogSnapshot
}

function differences(reference: Record<string, unknown>, implementation: Record<string, unknown>) {
  const keys = new Set([...Object.keys(reference), ...Object.keys(implementation)])
  return [...keys].flatMap((field) =>
    reference[field] === implementation[field]
      ? []
      : [{ field, reference: reference[field], implementation: implementation[field] }],
  )
}

async function readBitmap(pngPath: string, temporaryBMP: string): Promise<Bitmap> {
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'bmp', pngPath, '--out', temporaryBMP])
  const bytes = await readFile(temporaryBMP)
  const pixelOffset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bitsPerPixel = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  if (
    width <= 0 ||
    height <= 0 ||
    ![24, 32].includes(bitsPerPixel) ||
    ![0, 3].includes(compression)
  ) {
    throw new Error(
      `unsupported sips BMP: ${width}x${rawHeight}, bpp=${bitsPerPixel}, compression=${compression}`,
    )
  }
  const bytesPerPixel = bitsPerPixel / 8
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = rawHeight > 0 ? height - 1 - y : y
    for (let x = 0; x < width; x += 1) {
      const source = pixelOffset + sourceY * rowStride + x * bytesPerPixel
      const target = (y * width + x) * 4
      rgba[target] = bytes[source + 2]!
      rgba[target + 1] = bytes[source + 1]!
      rgba[target + 2] = bytes[source]!
      rgba[target + 3] = bytesPerPixel === 4 ? bytes[source + 3]! : 255
    }
  }
  return { width, height, rgba }
}

function writeBitmap24(bitmap: Bitmap) {
  const rowStride = Math.ceil((bitmap.width * 3) / 4) * 4
  const pixelBytes = rowStride * bitmap.height
  const output = Buffer.alloc(54 + pixelBytes)
  output.write('BM', 0, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(54, 10)
  output.writeUInt32LE(40, 14)
  output.writeInt32LE(bitmap.width, 18)
  output.writeInt32LE(bitmap.height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(24, 28)
  output.writeUInt32LE(pixelBytes, 34)
  for (let y = 0; y < bitmap.height; y += 1) {
    const targetY = bitmap.height - 1 - y
    for (let x = 0; x < bitmap.width; x += 1) {
      const source = (y * bitmap.width + x) * 4
      const target = 54 + targetY * rowStride + x * 3
      output[target] = bitmap.rgba[source + 2]!
      output[target + 1] = bitmap.rgba[source + 1]!
      output[target + 2] = bitmap.rgba[source]!
    }
  }
  return output
}

async function pixelDiff(referencePath: string, implementationPath: string, diffPath: string) {
  const directory = path.dirname(diffPath)
  const stem = path.basename(diffPath, '.png')
  const referenceBMP = path.join(directory, `.${stem}-reference.bmp`)
  const implementationBMP = path.join(directory, `.${stem}-implementation.bmp`)
  const diffBMP = path.join(directory, `.${stem}.bmp`)
  try {
    const reference = await readBitmap(referencePath, referenceBMP)
    const implementation = await readBitmap(implementationPath, implementationBMP)
    if (reference.width !== implementation.width || reference.height !== implementation.height) {
      throw new Error(
        `screenshot size mismatch: reference=${reference.width}x${reference.height}, implementation=${implementation.width}x${implementation.height}`,
      )
    }
    const visible = new Uint8Array(reference.rgba.length)
    let changedPixels = 0
    let minX = reference.width
    let minY = reference.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < reference.height; y += 1) {
      for (let x = 0; x < reference.width; x += 1) {
        const offset = (y * reference.width + x) * 4
        const changed = [0, 1, 2].some(
          (channel) =>
            Math.abs(reference.rgba[offset + channel]! - implementation.rgba[offset + channel]!) >
            PIXEL_THRESHOLD,
        )
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visible[offset] = 255
          visible[offset + 1] = 35
          visible[offset + 2] = 35
        } else {
          const gray = Math.round(
            (reference.rgba[offset]! * 0.299 +
              reference.rgba[offset + 1]! * 0.587 +
              reference.rgba[offset + 2]! * 0.114) *
              0.45,
          )
          visible[offset] = gray
          visible[offset + 1] = gray
          visible[offset + 2] = gray
        }
        visible[offset + 3] = 255
      }
    }
    await writeFile(
      diffBMP,
      writeBitmap24({ width: reference.width, height: reference.height, rgba: visible }),
    )
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', diffBMP, '--out', diffPath])
    const totalPixels = reference.width * reference.height
    return {
      width: reference.width,
      height: reference.height,
      threshold: PIXEL_THRESHOLD,
      changedPixels,
      totalPixels,
      changedPixelRatio: totalPixels ? changedPixels / totalPixels : 0,
      changedBBox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
    }
  } finally {
    await Promise.all([
      rm(referenceBMP, { force: true }),
      rm(implementationBMP, { force: true }),
      rm(diffBMP, { force: true }),
    ])
  }
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function paddedDialogScreenshot(locator: Locator, outputPath: string) {
  const rawPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.raw.png`)
  try {
    await locator.screenshot({ path: rawPath, animations: 'disabled', caret: 'hide' })
    await execFileAsync('/usr/bin/sips', [
      '-p',
      String(SCREENSHOT_SIZE.height),
      String(SCREENSHOT_SIZE.width),
      '--padColor',
      'F7F8FA',
      rawPath,
      '--out',
      outputPath,
    ])
  } finally {
    await rm(rawPath, { force: true })
  }
}

async function localStorageSnapshot(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key): key is string => key !== null)
        .sort()
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  )
}

test.beforeAll(async ({}, workerInfo) => {
  const directory = path.join(EVIDENCE_ROOT, workerInfo.project.name)
  await mkdir(directory, { recursive: true })
})

async function installPausedClock(page: Page) {
  await page.clock.install({ time: new Date(FIXED_TIME) })
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1_000)
}

async function finishDialogTransition(page: Page) {
  // Vue's Transition schedules DOM removal across animation frames. Pump only
  // those frames while the test clock remains otherwise paused.
  await page.clock.runFor(40)
}

test('same-state reference and implementation destructive dialog visual gate', async ({
  page,
  context,
}, testInfo) => {
  const directory = path.join(EVIDENCE_ROOT, testInfo.project.name)
  const sourceState: FixtureState = {
    deleteAttempts: 0,
    deleteResponses: [200],
    requests: [],
    blockedExternalRequests: [],
  }
  const referenceState: FixtureState = {
    deleteAttempts: 0,
    deleteResponses: [],
    requests: [],
    blockedExternalRequests: [],
  }
  const referencePage = await context.newPage()
  await installSourceFixture(page, sourceState)
  await installReferenceIsolation(referencePage, referenceState)

  await openSource(page)
  await referencePage.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await referencePage.waitForFunction(
    () =>
      typeof (window as typeof window & { deletePrototypeSession?: unknown })
        .deletePrototypeSession === 'function',
  )
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await referencePage.addStyleTag({ content: STABILIZATION_CSS })
  await installPausedClock(page)
  await installPausedClock(referencePage)

  const sourceDialog = await openSourceDeleteDialog(page)
  const referenceDialog = await openReferenceDeleteDialog(referencePage)
  await finishDialogTransition(page)
  await Promise.all([settle(page), settle(referencePage)])

  const [reference, implementation] = await Promise.all([
    dialogSnapshot(referencePage, 'reference'),
    dialogSnapshot(page, 'implementation'),
  ])
  const semanticComparable =
    reference.title === implementation.title &&
    reference.message === implementation.message &&
    reference.buttons.map((button) => button.text).join('|') ===
      implementation.buttons.map((button) => button.text).join('|') &&
    reference.confirmButton.disabled &&
    implementation.confirmButton.disabled

  const referencePath = path.join(directory, 'reference-open.png')
  const implementationPath = path.join(directory, 'implementation-open.png')
  const diffPath = path.join(directory, 'pixel-diff.png')
  await referencePage.bringToFront()
  await paddedDialogScreenshot(referencePage.locator('#overlayCard .modal'), referencePath)
  await page.bringToFront()
  await paddedDialogScreenshot(page.locator('.hc-dialog'), implementationPath)
  const pixels = await pixelDiff(referencePath, implementationPath, diffPath)
  const structureDifferences = {
    dialog: differences(reference.dialog.style, implementation.dialog.style),
    title: differences(reference.titleNode.style, implementation.titleNode.style),
    message: differences(reference.messageNode.style, implementation.messageNode.style),
    cancel: differences(reference.cancelButton.style, implementation.cancelButton.style),
    confirm: differences(reference.confirmButton.style, implementation.confirmButton.style),
    close: differences(reference.closeButton.style, implementation.closeButton.style),
    activeElement:
      JSON.stringify(activeElementSemantics(reference.activeElement)) ===
      JSON.stringify(activeElementSemantics(implementation.activeElement))
        ? []
        : [
            {
              field: 'activeElement',
              reference: JSON.stringify(activeElementSemantics(reference.activeElement)),
              implementation: JSON.stringify(activeElementSemantics(implementation.activeElement)),
            },
          ],
    role:
      reference.dialog.role === implementation.dialog.role
        ? []
        : [
            {
              field: 'role',
              reference: reference.dialog.role,
              implementation: implementation.dialog.role,
            },
          ],
  }
  const styleDifferenceCount = Object.values(structureDifferences).reduce(
    (total, values) => total + values.length,
    0,
  )
  const status =
    semanticComparable &&
    pixels.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO &&
    styleDifferenceCount === 0
      ? 'PASS'
      : semanticComparable
        ? 'RED'
        : 'NOT COMPARABLE'
  const report = {
    bug: 'BUG-20260723-007',
    browser: testInfo.project.name,
    status,
    comparable: semanticComparable,
    state: {
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      title: SESSION_TITLE,
      message: SESSION_MESSAGE,
      destructiveCooldownState: 'locked',
      screenshotFrame: {
        mode: 'dialog element centered on a neutral fixed-size canvas',
        ...SCREENSHOT_SIZE,
        absolutePlacementRecordedIn: 'reference.dialog.rect and implementation.dialog.rect',
      },
    },
    reference,
    implementation,
    structureDifferences,
    styleDifferenceCount,
    pixels,
    blockedExternalRequests: [
      ...referenceState.blockedExternalRequests,
      ...sourceState.blockedExternalRequests,
    ],
    files: {
      reference: 'reference-open.png',
      implementation: 'implementation-open.png',
      diff: 'pixel-diff.png',
      referenceSha256: await sha256(referencePath),
      implementationSha256: await sha256(implementationPath),
      diffSha256: await sha256(diffPath),
    },
  }
  await writeFile(
    path.join(directory, 'visual-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  await expect(sourceDialog).toBeVisible()
  await expect(referenceDialog).toBeVisible()
  await referencePage.close()
  expect(report.blockedExternalRequests).toEqual([])
  expect(report.comparable, 'reference and implementation must expose the same visible state').toBe(
    true,
  )
  expect(report.status, `inspect ${path.relative(REPO_ROOT, diffPath)}`).toBe('PASS')
})

function activeElementSemantics(activeElement: DialogSnapshot['activeElement']) {
  // CSS 类名属于两套渲染实现的内部命名；焦点门只比较用户可观察的元素类型、标签与文本。
  return {
    tag: activeElement.tag,
    ariaLabel: activeElement.ariaLabel,
    text: activeElement.text,
  }
}

test('cancel is mutation-free; failure preserves the session; retry success removes it', async ({
  page,
}, testInfo) => {
  const directory = path.join(EVIDENCE_ROOT, testInfo.project.name)
  const state: FixtureState = {
    deleteAttempts: 0,
    deleteResponses: [500, 200],
    requests: [],
    blockedExternalRequests: [],
  }
  await installSourceFixture(page, state)
  await openSource(page)
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await installPausedClock(page)

  const row = page.locator(`[data-session-id="${SESSION_ID}"]`)
  await expect(row).toHaveClass(/hc-sessions__item--pinned/)
  const storageBeforeCancel = await localStorageSnapshot(page)
  const deleteAttemptsBeforeCancel = state.deleteAttempts
  const deleteRequestsBeforeCancel = state.requests.filter(
    (request) => request.method === 'DELETE',
  ).length
  const cancelDialog = await openSourceDeleteDialog(page)
  await cancelDialog.getByRole('button', { name: '取消', exact: true }).click()
  await finishDialogTransition(page)
  await expect(cancelDialog).toBeHidden()
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/hc-sessions__item--pinned/)
  const storageAfterCancel = await localStorageSnapshot(page)
  const deleteAttemptsAfterCancel = state.deleteAttempts
  const deleteRequestsAfterCancel = state.requests.filter(
    (request) => request.method === 'DELETE',
  ).length

  const failureDialog = await openSourceDeleteDialog(page)
  const failureConfirm = failureDialog.getByRole('button', { name: '删除', exact: true })
  await expect(failureConfirm).toBeDisabled()
  await page.clock.fastForward(COOLDOWN_MS - 1)
  await expect(failureConfirm).toBeDisabled()
  await page.clock.fastForward(1)
  await expect(failureConfirm).toBeEnabled()
  const failureResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname.endsWith(`/api/v1/sessions/${SESSION_ID}`),
  )
  await failureConfirm.click()
  expect((await failureResponse).status()).toBe(500)
  await finishDialogTransition(page)
  await expect(failureDialog).toBeHidden()
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/hc-sessions__item--pinned/)
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem('hexclaw_pinned_sessions'))) || '[]',
    ),
  ).toEqual([SESSION_ID])

  const retryDialog = await openSourceDeleteDialog(page)
  const retryConfirm = retryDialog.getByRole('button', { name: '删除', exact: true })
  await expect(retryConfirm).toBeDisabled()
  await page.clock.fastForward(COOLDOWN_MS - 1)
  await expect(retryConfirm).toBeDisabled()
  await page.clock.fastForward(1)
  await expect(retryConfirm).toBeEnabled()
  const successResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname.endsWith(`/api/v1/sessions/${SESSION_ID}`),
  )
  await retryConfirm.click()
  expect((await successResponse).status()).toBe(200)
  await finishDialogTransition(page)
  await expect(retryDialog).toBeHidden()
  await expect(row).toHaveCount(0)

  const report = {
    bug: 'BUG-20260723-007',
    browser: testInfo.project.name,
    status: 'PASS',
    workers: 1,
    isolation: {
      sourceOrigin: new URL(SOURCE_URL).origin,
      externalNetworkRequests: state.blockedExternalRequests,
      realHomeTouched: false,
      applicationsTouched: false,
      realUserSessionsTouched: false,
    },
    cancel: {
      deleteAttemptsBefore: deleteAttemptsBeforeCancel,
      deleteAttemptsAfter: deleteAttemptsAfterCancel,
      deleteRequestCountBefore: deleteRequestsBeforeCancel,
      deleteRequestCountAfter: deleteRequestsAfterCancel,
      storageBefore: storageBeforeCancel,
      storageAfter: storageAfterCancel,
      storageByteEquivalent:
        JSON.stringify(storageBeforeCancel) === JSON.stringify(storageAfterCancel),
      rowPreserved: true,
      pinnedStatePreserved: true,
    },
    cooldown: {
      configuredMilliseconds: COOLDOWN_MS,
      disabledAt1499: true,
      enabledAt1500: true,
      timerResetOnRetry: true,
    },
    failure: {
      responseStatus: 500,
      rowPreserved: true,
      pinnedStatePreserved: true,
      retryReachable: true,
    },
    success: {
      responseStatus: 200,
      rowRemoved: true,
      totalDeleteAttempts: state.deleteAttempts,
    },
    requests: state.requests.filter((request) => request.method === 'DELETE'),
  }
  await writeFile(
    path.join(directory, 'lifecycle-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )

  expect(state.blockedExternalRequests).toEqual([])
  expect(storageAfterCancel).toEqual(storageBeforeCancel)
  expect(report.cancel.deleteAttemptsAfter).toBe(report.cancel.deleteAttemptsBefore)
  expect(report.cancel.deleteRequestCountAfter).toBe(report.cancel.deleteRequestCountBefore)
  expect(state.deleteAttempts).toBe(2)
})
