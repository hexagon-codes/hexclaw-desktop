import { expect, test, type Browser, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(process.cwd())
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const sourcePort = Number(process.env.HEX_CONFIRM_DIALOG_SOURCE_PORT)
const referencePort = Number(process.env.HEX_CONFIRM_DIALOG_REFERENCE_PORT)
const sourceUrl = `http://127.0.0.1:${sourcePort}/tests/e2e/fixtures/confirm-dialog-consumer-harness.html`
const referenceUrl = `http://127.0.0.1:${referencePort}/app.html`
const evidenceRoot = path.resolve(
  desktopRoot,
  'test/evidence/bug-20260725-018-bug-20260726-013-confirm-dialog-visual/chromium',
)
const pixelDiffTool = path.resolve(desktopRoot, 'tests/e2e/tools/visual_pixel_diff.py')
const viewport = { width: 1440, height: 1000 }
const commonClip = { x: 280, y: 20, width: 880, height: 760 }
const pixelThreshold = 8
const maxChangedPixelRatio = 0.01

type StateId =
  | 'shared-confirm-dialog'
  | 'skills-uninstall'
  | 'memory-delete-one'
  | 'quick-chat-clear'
  | 'notifications-clear'

interface StateDefinition {
  id: StateId
  name: string
  prototypeContract: RegExp
}

interface PixelDiff {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

interface TargetEvidence {
  selector: string
  count: number
  text: string
  role: string | null
  ariaLabel: string | null
  disabled: boolean | null
  bbox: { x: number; y: number; width: number; height: number } | null
  style: Record<string, string>
}

interface LifecycleEvidence {
  initialFocusInside: boolean
  forwardTabWrapped: boolean
  backwardTabWrapped: boolean
  confirmDisabledAt0: boolean
  confirmDisabledAt1499: boolean
  confirmEnabledAt1500: boolean
  closedAfterCancel: boolean
  focusRestoredAfterCancel: boolean
  cancelCountAfterCancel: number | null
  confirmCountAfterCancel: number
}

interface StateResult {
  id: StateId
  name: string
  mapping: 'COMPARABLE' | 'NOT COMPARABLE'
  mappingReason: string
  status: 'PASS' | 'NOT PASS' | 'NOT COMPARABLE'
  visualStatus: 'PASS' | 'NOT PASS' | 'NOT COMPARABLE'
  lifecycleStatus: 'PASS' | 'NOT PASS' | 'NOT COMPARABLE'
  evidenceDir: string
  pixelDiff?: PixelDiff
  criticalDifferences?: string[]
  lifecycleViolations?: string[]
}

const states: StateDefinition[] = [
  {
    id: 'shared-confirm-dialog',
    name: '共享 ConfirmDialog 本身',
    prototypeContract: /function confirmDelete\(title,message,onConfirm\)/,
  },
  {
    id: 'skills-uninstall',
    name: 'Skills 卸载',
    prototypeContract: /function skillPreviewDemo[\s\S]*卸载 Skill？/,
  },
  {
    id: 'memory-delete-one',
    name: 'Memory 单条删除',
    prototypeContract: /confirmDelete\('删除记忆','确定要删除这条记忆吗？此操作不可撤销。'\)/,
  },
  {
    id: 'quick-chat-clear',
    name: 'Quick Chat 清空',
    prototypeContract: /function openQuickChat\(\)[\s\S]*清空聊天/,
  },
  {
    id: 'notifications-clear',
    name: '通知中心清空',
    prototypeContract: /confirmDelete\('清空通知？','此操作不可撤销。'/,
  },
]

const styleFields = [
  'display',
  'boxSizing',
  'width',
  'height',
  'padding',
  'margin',
  'gap',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'opacity',
  'boxShadow',
] as const

const targetSelectors = {
  reference: {
    root: '#overlayCard .modal',
    header: '#overlayCard .modal-h',
    title: '#overlayCard .modal-h b',
    message: '#overlayCard .modal-b p',
    actions: '#overlayCard .modal-f',
    close: '#overlayCard .modal-h .x',
    cancel: '#mCancel',
    confirm: '#mPrimary',
  },
  implementation: {
    root: '.hc-dialog',
    header: '.hc-dialog__header',
    title: '.hc-dialog__title',
    message: '.hc-dialog__msg',
    actions: '.hc-dialog__actions',
    close: '.hc-dialog__close',
    cancel: '.hc-dialog__actions .hc-btn-secondary',
    confirm: '.hc-dialog__actions button:last-child',
  },
} as const

const results: StateResult[] = []
const cancelRouteResults: Record<string, unknown>[] = []
const cancelRouteViolations: string[] = []
let prototypeSource = ''

test.beforeAll(async () => {
  await mkdir(evidenceRoot, { recursive: true })
  prototypeSource = await readFile(path.join(docsRoot, 'prototype/app.html'), 'utf8')
})

test.afterAll(async () => {
  const summary = {
    bugs: ['BUG-20260725-018', 'BUG-20260726-013'],
    generatedAt: new Date().toISOString(),
    environment: {
      browser: 'chromium',
      viewport,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      theme: 'light',
      reducedMotion: 'reduce',
      workers: 1,
    },
    installedApplicationBoundary: {
      status: 'NOT RUN',
      reason:
        'The authorized scope is an isolated current-source visual harness. It does not launch or replace /Applications and does not read or mutate user data.',
    },
    status:
      results.every((result) => result.status === 'PASS') && cancelRouteViolations.length === 0
        ? 'PASS'
        : 'NOT PASS',
    cancelRouteStatus: cancelRouteViolations.length === 0 ? 'PASS' : 'NOT PASS',
    cancelRoutes: cancelRouteResults,
    cancelRouteViolations,
    results,
  }
  await writeFile(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
})

test('current consumers keep their exact shared ConfirmDialog wiring', async () => {
  const [skills, memory, quickChat, notifications, locale] = await Promise.all([
    readFile(path.join(desktopRoot, 'src/views/SkillsView.vue'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/views/MemoryView.vue'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/views/QuickChatView.vue'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/components/layout/NotificationPanel.vue'), 'utf8'),
    readFile(path.join(desktopRoot, 'src/i18n/locales/zh-CN.ts'), 'utf8'),
  ])
  const skillsDialog = findConfirmDialogBlock(skills, ':open="pendingUninstall !== null"')
  const memoryDialog = findConfirmDialogBlock(memory, ':open="!!deleteTarget"')
  const quickChatDialog = findConfirmDialogBlock(quickChat, ':open="showClearChatConfirm"')
  const notificationsDialog = findConfirmDialogBlock(notifications, ':open="clearConfirmOpen"')

  expect(skills).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
  expect(skillsDialog).toMatch(/:confirmation-key="pendingUninstall"/)
  expect(skillsDialog).toMatch(/:title="t\('skills\.uninstallTitle'\)"/)
  expect(skillsDialog).toContain(":message=\"pendingUninstall ? t('skills.uninstallMessage', { name: pendingUninstall }) : ''\"")
  expect(skillsDialog).toMatch(/:confirm-text="t\('skills\.uninstallConfirm'\)"/)
  expect(skillsDialog).toMatch(/:cancel-text="t\('common\.cancel'\)"/)
  expect(skillsDialog).toMatch(/\n\s+danger\n/)
  expect(skillsDialog).toMatch(/@cancel="pendingUninstall = null"/)

  expect(memory).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
  expect(memoryDialog).toMatch(/:confirmation-key="deleteTarget\?\.id"/)
  expect(memoryDialog).toMatch(/:title="t\('memory\.deleteTitle'\)"/)
  expect(memoryDialog).toMatch(/:message="t\('memory\.deleteMessage'\)"/)
  expect(memoryDialog).toMatch(/:confirm-text="t\('common\.delete'\)"/)
  expect(memoryDialog).toMatch(/:danger="true"/)
  expect(memoryDialog).toMatch(/@cancel="deleteTarget = null"/)

  expect(quickChat).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
  expect(quickChatDialog).toMatch(/:confirmation-key="QUICK_CHAT_CONFIRMATION_KEY"/)
  expect(quickChatDialog).toMatch(/:title="t\('chat\.clearConfirmTitle'\)"/)
  expect(quickChatDialog).toMatch(/:message="t\('chat\.clearConfirmMessage'\)"/)
  expect(quickChatDialog).toMatch(/:confirm-text="t\('chat\.clearConfirm'\)"/)
  expect(quickChatDialog).toMatch(/:cancel-text="t\('common\.cancel'\)"/)
  expect(quickChatDialog).toMatch(/\n\s+danger\n/)
  expect(quickChatDialog).toMatch(/@cancel="showClearChatConfirm = false"/)

  expect(notifications).toContain(
    "import ConfirmDialog from '@/components/common/ConfirmDialog.vue'",
  )
  expect(notificationsDialog).toMatch(/:confirmation-key="'notifications-clear-all'"/)
  expect(notificationsDialog).toMatch(/:title="t\('notifications\.clearConfirmTitle'\)"/)
  expect(notificationsDialog).toMatch(/:message="t\('notifications\.clearConfirmMessage'\)"/)
  expect(notificationsDialog).toMatch(/:confirm-text="t\('notifications\.clearConfirm'\)"/)
  expect(notificationsDialog).toMatch(/:cancel-text="t\('common\.cancel'\)"/)
  expect(notificationsDialog).toMatch(/:danger="true"/)
  expect(notificationsDialog).toMatch(/@cancel="cancelClearAll"/)

  expect(locale).toContain("deleteTitle: '删除记忆'")
  expect(locale).toContain("deleteMessage: '确定要删除这条记忆吗？此操作不可撤销。'")
  expect(locale).toContain("clearChat: '清空聊天'")
  expect(locale).toContain("uninstallTitle: '卸载 Skill？'")
  expect(locale).toContain("uninstallMessage: '将卸载「{name}」，此操作不可撤销。'")
  expect(locale).toContain("uninstallConfirm: '卸载'")
  expect(locale).toContain("clearConfirmTitle: '清空聊天？'")
  expect(locale).toContain("clearConfirmMessage: '此操作不可撤销。'")
  expect(locale).toContain("clearConfirm: '清空'")
  expect(locale).toContain("clearConfirmTitle: '清空通知？'")
  expect(locale).toContain("clearConfirmMessage: '此操作不可撤销。'")
})

function findConfirmDialogBlock(source: string, marker: string) {
  const block = source
    .match(/<ConfirmDialog[\s\S]*?\/>/g)
    ?.find((candidate) => candidate.includes(marker))
  expect(block, `missing ConfirmDialog block containing ${marker}`).toBeDefined()
  return block!
}

test('all shared cancel routes preserve focus, target and cooldown semantics', async ({
  browser,
}) => {
  const routes = ['footer', 'header', 'escape', 'overlay'] as const

  for (const route of routes) {
    const { referencePage, implementationPage, close } = await createEvidencePages(browser)
    try {
      await installDeterministicTimeouts(referencePage)
      await installDeterministicTimeouts(implementationPage)
      const referenceInvoker = await openReferenceState(referencePage, 'shared-confirm-dialog')
      const implementationInvoker = await openImplementationState(
        implementationPage,
        'shared-confirm-dialog',
      )

      const referenceBefore = await collectLifecycleStart(referencePage, 'reference')
      const implementationBefore = await collectLifecycleStart(implementationPage, 'implementation')

      const referenceDismissed = await dismiss(referencePage, 'reference', route)
      const implementationDismissed = await dismiss(implementationPage, 'implementation', route)

      const referenceClosed = await referencePage.locator('#overlay').evaluate((element) => {
        const runtime = window as Window & { __confirmExecuted?: number }
        return {
          closed: !element.classList.contains('on'),
          confirmCount: runtime.__confirmExecuted ?? 0,
        }
      })
      const implementationClosed = await implementationPage
        .locator('.confirm-dialog-harness')
        .evaluate((element) => ({
          closed: element.getAttribute('data-active-state') === '',
          cancelCount: Number(element.getAttribute('data-cancel-count') ?? '0'),
          confirmCount: Number(element.getAttribute('data-confirm-count') ?? '0'),
        }))
      const referenceFocusRestored = await isActiveElement(referencePage, referenceInvoker)
      const implementationFocusRestored = await isActiveElement(
        implementationPage,
        implementationInvoker,
      )

      const entry = {
        route,
        referenceBefore,
        implementationBefore,
        referenceDismissed,
        implementationDismissed,
        referenceClosed,
        implementationClosed,
        referenceFocusRestored,
        implementationFocusRestored,
      }
      cancelRouteResults.push(entry)
      if (!referenceDismissed) cancelRouteViolations.push(`${route}.reference.dismissed=false`)
      if (!implementationDismissed) {
        cancelRouteViolations.push(`${route}.implementation.dismissed=false`)
      }
      if (!referenceClosed.closed) cancelRouteViolations.push(`${route}.reference.closed=false`)
      if (!implementationClosed.closed) {
        cancelRouteViolations.push(`${route}.implementation.closed=false`)
      }
      if (referenceClosed.confirmCount !== 0) {
        cancelRouteViolations.push(
          `${route}.reference.confirmCount=${referenceClosed.confirmCount}`,
        )
      }
      if (implementationClosed.cancelCount !== 1) {
        cancelRouteViolations.push(
          `${route}.implementation.cancelCount=${implementationClosed.cancelCount}`,
        )
      }
      if (implementationClosed.confirmCount !== 0) {
        cancelRouteViolations.push(
          `${route}.implementation.confirmCount=${implementationClosed.confirmCount}`,
        )
      }
      if (!referenceFocusRestored) {
        cancelRouteViolations.push(`${route}.reference.focusRestored=false`)
      }
      if (!implementationFocusRestored) {
        cancelRouteViolations.push(`${route}.implementation.focusRestored=false`)
      }
    } finally {
      await close()
    }
  }

  await writeFile(
    path.join(evidenceRoot, 'cancel-routes.json'),
    `${JSON.stringify({ routes: cancelRouteResults, cancelRouteViolations }, null, 2)}\n`,
  )
  expect(cancelRouteResults).toHaveLength(routes.length)
})

for (const state of states) {
  test(`${state.name} has paired visual and exact lifecycle evidence`, async ({ browser }) => {
    const directory = path.join(evidenceRoot, state.id)
    await mkdir(directory, { recursive: true })

    if (!state.prototypeContract.test(prototypeSource)) {
      const result: StateResult = {
        id: state.id,
        name: state.name,
        mapping: 'NOT COMPARABLE',
        mappingReason: 'The authoritative prototype has no matching entry or open state.',
        status: 'NOT COMPARABLE',
        visualStatus: 'NOT COMPARABLE',
        lifecycleStatus: 'NOT COMPARABLE',
        evidenceDir: path.relative(desktopRoot, directory),
      }
      results.push(result)
      await writeFile(
        path.join(directory, 'not-comparable.json'),
        `${JSON.stringify(result, null, 2)}\n`,
      )
      return
    }

    const { referencePage, implementationPage, close } = await createEvidencePages(browser)
    try {
      await installDeterministicTimeouts(referencePage)
      await installDeterministicTimeouts(implementationPage)
      const referenceInvoker = await openReferenceState(referencePage, state.id)
      const implementationInvoker = await openImplementationState(implementationPage, state.id)

      const referenceLifecycleStart = await collectLifecycleStart(referencePage, 'reference')
      const implementationLifecycleStart = await collectLifecycleStart(
        implementationPage,
        'implementation',
      )
      const [referenceTargets, implementationTargets] = await Promise.all([
        collectTargets(referencePage, 'reference'),
        collectTargets(implementationPage, 'implementation'),
      ])

      const referencePath = path.join(directory, 'reference.png')
      const implementationPath = path.join(directory, 'implementation.png')
      await captureNormalized(referencePage, 'reference', referencePath)
      await captureNormalized(implementationPage, 'implementation', implementationPath)
      await referencePage
        .locator(targetSelectors.reference.root)
        .screenshot({ path: path.join(directory, 'reference-dialog.png'), animations: 'disabled' })
      await implementationPage.locator(targetSelectors.implementation.root).screenshot({
        path: path.join(directory, 'implementation-dialog.png'),
        animations: 'disabled',
      })

      const referenceDelay = await collectDelayEvidence(referencePage, 'reference')
      const implementationDelay = await collectDelayEvidence(implementationPage, 'implementation')
      const referenceDismissed = await dismiss(referencePage, 'reference', 'footer')
      const implementationDismissed = await dismiss(implementationPage, 'implementation', 'footer')

      const lifecycle: { reference: LifecycleEvidence; implementation: LifecycleEvidence } = {
        reference: {
          ...referenceLifecycleStart,
          ...referenceDelay,
          closedAfterCancel: referenceDismissed,
          focusRestoredAfterCancel: await isActiveElement(referencePage, referenceInvoker),
          cancelCountAfterCancel: null,
          confirmCountAfterCancel: await referencePage.evaluate(
            () => (window as Window & { __confirmExecuted?: number }).__confirmExecuted ?? 0,
          ),
        },
        implementation: {
          ...implementationLifecycleStart,
          ...implementationDelay,
          closedAfterCancel: implementationDismissed,
          focusRestoredAfterCancel: await isActiveElement(
            implementationPage,
            implementationInvoker,
          ),
          cancelCountAfterCancel: await implementationPage
            .locator('.confirm-dialog-harness')
            .evaluate((element) => Number(element.getAttribute('data-cancel-count') ?? '0')),
          confirmCountAfterCancel: await implementationPage
            .locator('.confirm-dialog-harness')
            .evaluate((element) => Number(element.getAttribute('data-confirm-count') ?? '0')),
        },
      }
      const lifecycleViolations = lifecycleDifferences(lifecycle)

      const diffPath = path.join(directory, 'pixel-diff.png')
      const pixelDiff = await runPixelDiff(referencePath, implementationPath, diffPath)
      const criticalDifferences = compareCriticalTargets(referenceTargets, implementationTargets)
      const visualStatus =
        pixelDiff.changed_pixel_ratio <= maxChangedPixelRatio && criticalDifferences.length === 0
          ? 'PASS'
          : 'NOT PASS'
      const lifecycleStatus = lifecycleViolations.length === 0 ? 'PASS' : 'NOT PASS'
      const result: StateResult = {
        id: state.id,
        name: state.name,
        mapping: 'COMPARABLE',
        mappingReason:
          'The authoritative prototype exposes the same destructive semantic state; actual prototype entry behavior is used.',
        status: visualStatus === 'PASS' && lifecycleStatus === 'PASS' ? 'PASS' : 'NOT PASS',
        visualStatus,
        lifecycleStatus,
        evidenceDir: path.relative(desktopRoot, directory),
        pixelDiff,
        criticalDifferences,
        lifecycleViolations,
      }
      results.push(result)

      await Promise.all([
        writeFile(
          path.join(directory, 'pixel-diff.json'),
          `${JSON.stringify(pixelDiff, null, 2)}\n`,
        ),
        writeFile(
          path.join(directory, 'bbox-computed-style.json'),
          `${JSON.stringify(
            {
              reference: referenceTargets,
              implementation: implementationTargets,
              criticalDifferences,
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          path.join(directory, 'lifecycle.json'),
          `${JSON.stringify({ lifecycle, lifecycleViolations }, null, 2)}\n`,
        ),
      ])

      expect(result.mapping).toBe('COMPARABLE')
    } finally {
      await close().catch(() => undefined)
    }
  })
}

test('aggregate visual acceptance gate requires every comparable state to pass', () => {
  expect(results).toHaveLength(states.length)
  expect(
    {
      states: results.map((result) => ({ id: result.id, status: result.status })),
      cancelRouteViolations,
    },
    `visual evidence summary: ${path.join(evidenceRoot, 'summary.json')}`,
  ).toEqual({
    states: states.map((state) => ({ id: state.id, status: 'PASS' })),
    cancelRouteViolations: [],
  })
})

async function createEvidencePages(browser: Browser) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const referencePage = await context.newPage()
  const implementationPage = await context.newPage()
  await Promise.all([
    referencePage.goto(referenceUrl, { waitUntil: 'networkidle' }),
    implementationPage.goto(sourceUrl, { waitUntil: 'networkidle' }),
  ])
  await Promise.all([
    referencePage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light')),
    implementationPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light')),
  ])
  await Promise.all([
    referencePage.addStyleTag({
      content:
        '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
    }),
    implementationPage.addStyleTag({
      content:
        '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
    }),
  ])
  return {
    referencePage,
    implementationPage,
    close: () => context.close(),
  }
}

async function installDeterministicTimeouts(page: Page) {
  await page.evaluate(() => {
    type TimerTask = { due: number; callback: (...args: unknown[]) => void; args: unknown[] }
    const runtime = window as Window & {
      __confirmClock?: {
        advance: (milliseconds: number) => void
        pending: () => number
        scheduledDelays: number[]
      }
    }
    let now = 0
    let nextId = 100_000
    const tasks = new Map<number, TimerTask>()
    const scheduledDelays: number[] = []
    const nativeSetTimeout = window.setTimeout.bind(window)
    const nativeClearTimeout = window.clearTimeout.bind(window)

    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) => {
      if (typeof handler !== 'function')
        throw new Error('String timers are not allowed in this gate')
      const delay = Number(timeout) || 0
      // 只接管共享确认框的 1500ms 冷却；页面其它生命周期定时器继续走浏览器时钟，
      // 避免业务轮询在一次人工 advance 中自重排并形成无限执行。
      if (delay !== 1_500) return nativeSetTimeout(handler, delay, ...args)
      const id = nextId++
      scheduledDelays.push(delay)
      tasks.set(id, { due: now + delay, callback: handler, args })
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id: number | undefined) => {
      if (id === undefined) return
      if (!tasks.delete(Number(id))) nativeClearTimeout(id)
    }) as typeof window.clearTimeout

    runtime.__confirmClock = {
      scheduledDelays,
      pending: () => tasks.size,
      advance: (milliseconds: number) => {
        now += milliseconds
        let progressed = true
        while (progressed) {
          progressed = false
          const dueTasks = [...tasks.entries()]
            .filter(([, task]) => task.due <= now)
            .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])
          for (const [id, task] of dueTasks) {
            tasks.delete(id)
            task.callback(...task.args)
            progressed = true
          }
        }
      },
    }
  })
}

async function advanceDeterministicTimeouts(page: Page, milliseconds: number) {
  await page.evaluate((amount) => {
    const clock = (
      window as Window & { __confirmClock?: { advance: (milliseconds: number) => void } }
    ).__confirmClock
    if (!clock) throw new Error('deterministic timeout clock is not installed')
    clock.advance(amount)
  }, milliseconds)
}

async function openImplementationState(page: Page, id: StateId) {
  const selector = `[data-open-state="${id}"]`
  const invoker = page.locator(selector)
  await invoker.focus()
  await invoker.click()
  await expect(page.locator(targetSelectors.implementation.root)).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.hc-dialog') !== null))
    .toBe(true)
  return selector
}

async function openReferenceState(page: Page, id: StateId) {
  await page.evaluate(() => {
    ;(window as Window & { __confirmExecuted?: number }).__confirmExecuted = 0
  })

  if (id === 'shared-confirm-dialog') {
    const invoker = '.sb-item[data-screen="chat"]'
    await page.locator(invoker).focus()
    await page.evaluate(() => {
      const runtime = window as Window & {
        confirmDelete: (title: string, message: string, confirm: () => void) => void
        __confirmExecuted?: number
      }
      runtime.confirmDelete('确认操作', '此操作不可撤销，确定要继续吗？', () => {
        runtime.__confirmExecuted = (runtime.__confirmExecuted ?? 0) + 1
      })
    })
    await expect(page.locator(targetSelectors.reference.root)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('#overlayCard .modal') !== null),
      )
      .toBe(true)
    return invoker
  }

  if (id === 'skills-uninstall') {
    await page.locator('.sb-item[data-screen="integration"]:visible').click()
    await expect(page.locator('.screen[data-pane="integration"].on')).toBeVisible()
    const invoker =
      '.screen[data-pane="integration"].on .capability-installed-row:first-of-type .capability-installed-actions button:first-of-type'
    await page.locator(invoker).click()
    await expect(page.locator('#overlayCard .modal')).toBeVisible()
    await page.locator('#overlayCard .modal-f button', { hasText: '卸载' }).click()
    await expect(page.locator(targetSelectors.reference.root)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('#overlayCard .modal') !== null),
      )
      .toBe(true)
    return invoker
  }

  if (id === 'memory-delete-one') {
    await page.locator('.sb-item[data-screen="knowledge"]').click()
    await page
      .locator('.screen[data-pane="knowledge"] [data-segset="kn"] button', {
        hasText: '长期记忆',
      })
      .click()
    const invoker = '.subview[data-sub="kn1"] .cxcard:first-of-type .crow button:last-child'
    await page.locator(invoker).click()
    await expect(page.locator(targetSelectors.reference.root)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('#overlayCard .modal') !== null),
      )
      .toBe(true)
    return invoker
  }

  if (id === 'quick-chat-clear') {
    await page.evaluate(() => {
      ;(window as Window & { openQuickChat: () => void }).openQuickChat()
    })
    const invoker = '.quick-route-title .status-line button:nth-of-type(2)'
    await page.locator(invoker).click()
    await expect(page.locator(targetSelectors.reference.root)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('#overlayCard .modal') !== null),
      )
      .toBe(true)
    return invoker
  }

  await page.locator('#notifBtn').click()
  const invoker = '#notifClearBtn'
  await page.locator(invoker).click()
  await expect(page.locator(targetSelectors.reference.root)).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('#overlayCard .modal') !== null),
    )
    .toBe(true)
  return invoker
}

async function collectLifecycleStart(
  page: Page,
  leg: keyof typeof targetSelectors,
): Promise<
  Pick<LifecycleEvidence, 'initialFocusInside' | 'forwardTabWrapped' | 'backwardTabWrapped'>
> {
  const selectors = targetSelectors[leg]
  const initialFocusInside = await page
    .locator(selectors.root)
    .evaluate((dialog) => dialog.contains(document.activeElement))
  const focusableSelector =
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  const boundary = await page.locator(selectors.root).evaluate((dialog, selector) => {
    const focusable = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => !element.hidden && element.getClientRects().length > 0,
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) throw new Error('dialog must expose at least one focusable element')
    last.focus()
    return { firstMarker: marker(first), lastMarker: marker(last) }

    function marker(element: HTMLElement) {
      return element.getAttribute('aria-label') || element.id || element.textContent?.trim() || ''
    }
  }, focusableSelector)
  await page.keyboard.press('Tab')
  const forwardTabWrapped = await activeElementMatchesMarker(page, boundary.firstMarker)

  await page.locator(selectors.root).evaluate((dialog, selector) => {
    const first = [...dialog.querySelectorAll<HTMLElement>(selector)].find(
      (element) => !element.hidden && element.getClientRects().length > 0,
    )
    if (!first) throw new Error('dialog must expose a focusable element')
    first.focus()
  }, focusableSelector)
  await page.keyboard.press('Shift+Tab')
  const backwardTabWrapped = await activeElementMatchesMarker(page, boundary.lastMarker)

  return { initialFocusInside, forwardTabWrapped, backwardTabWrapped }
}

async function activeElementMatchesMarker(page: Page, expected: string) {
  return page.evaluate((markerValue) => {
    const active = document.activeElement as HTMLElement | null
    const marker =
      active?.getAttribute('aria-label') || active?.id || active?.textContent?.trim() || ''
    return marker === markerValue
  }, expected)
}

async function collectDelayEvidence(
  page: Page,
  leg: keyof typeof targetSelectors,
): Promise<
  Pick<LifecycleEvidence, 'confirmDisabledAt0' | 'confirmDisabledAt1499' | 'confirmEnabledAt1500'>
> {
  const confirm = page.locator(targetSelectors[leg].confirm)
  const confirmDisabledAt0 = await confirm.isDisabled()
  await advanceDeterministicTimeouts(page, 1_499)
  const confirmDisabledAt1499 = await confirm.isDisabled()
  await advanceDeterministicTimeouts(page, 1)
  const confirmEnabledAt1500 = !(await confirm.isDisabled())
  return { confirmDisabledAt0, confirmDisabledAt1499, confirmEnabledAt1500 }
}

async function dismiss(
  page: Page,
  leg: keyof typeof targetSelectors,
  route: 'footer' | 'header' | 'escape' | 'overlay',
) {
  const selectors = targetSelectors[leg]
  if (route === 'footer') await page.locator(selectors.cancel).click()
  else if (route === 'header') await page.locator(selectors.close).click()
  else if (route === 'escape') await page.keyboard.press('Escape')
  else {
    const overlaySelector = leg === 'reference' ? '#overlay' : '.hc-dialog-overlay'
    const overlay = page.locator(overlaySelector)
    const box = await overlay.boundingBox()
    if (!box) throw new Error(`${leg} overlay has no bounding box`)
    const point = { x: box.x + 8, y: box.y + box.height - 8 }
    const hitsOverlaySelf = await page.evaluate(
      ({ selector, x, y }) => document.elementFromPoint(x, y) === document.querySelector(selector),
      { selector: overlaySelector, ...point },
    )
    if (!hitsOverlaySelf) throw new Error(`${leg} overlay empty-point does not hit overlay self`)
    await page.mouse.click(point.x, point.y)
  }
  try {
    await expect(page.locator(selectors.root)).toBeHidden({ timeout: 1_000 })
    return true
  } catch {
    return false
  }
}

async function isActiveElement(page: Page, selector: string) {
  try {
    await page.waitForFunction(
      (targetSelector) => document.activeElement === document.querySelector(targetSelector),
      selector,
      { timeout: 1_000 },
    )
    return true
  } catch {
    return false
  }
}

async function collectTargets(page: Page, leg: keyof typeof targetSelectors) {
  const entries = await Promise.all(
    Object.entries(targetSelectors[leg]).map(async ([name, selector]) => [
      name,
      await collectTarget(page, selector),
    ]),
  )
  return Object.fromEntries(entries) as Record<string, TargetEvidence>
}

async function collectTarget(page: Page, selector: string): Promise<TargetEvidence> {
  return page.locator(selector).evaluate(
    (element, input) => {
      const htmlElement = element as HTMLElement
      const style = getComputedStyle(htmlElement)
      const rect = htmlElement.getBoundingClientRect()
      return {
        selector: input.selector,
        count: document.querySelectorAll(input.selector).length,
        text: htmlElement.innerText.trim(),
        role: htmlElement.getAttribute('role'),
        ariaLabel: htmlElement.getAttribute('aria-label'),
        disabled: htmlElement instanceof HTMLButtonElement ? htmlElement.disabled : null,
        bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: Object.fromEntries(
          input.fields.map((field) => [field, (style as unknown as Record<string, string>)[field]]),
        ),
      }
    },
    { selector, fields: styleFields },
  )
}

async function captureNormalized(page: Page, leg: keyof typeof targetSelectors, output: string) {
  const styleId = 'confirm-dialog-visual-normalization'
  await page.addStyleTag({
    content:
      leg === 'reference'
        ? `
          *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
          html, body { background: #fbfcfe !important; }
          body > :not(#overlay):not(#toast) { visibility: hidden !important; }
          #overlay, #overlay * { visibility: visible !important; }
        `
        : `
          *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
          html, body { background: #fbfcfe !important; }
          body > #app { visibility: hidden !important; }
          .hc-dialog-overlay, .hc-dialog-overlay * { visibility: visible !important; }
        `,
  })
  await page
    .locator('head style')
    .last()
    .evaluate((element, id) => {
      element.id = id
    }, styleId)
  await page.screenshot({ path: output, clip: commonClip, animations: 'disabled' })
  await page.locator(`#${styleId}`).evaluate((element) => element.remove())
}

async function runPixelDiff(reference: string, implementation: string, output: string) {
  try {
    const { stdout } = await execFileAsync('python3', [
      pixelDiffTool,
      reference,
      implementation,
      output,
      String(pixelThreshold),
    ])
    return JSON.parse(stdout) as PixelDiff
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("No module named 'PIL'")) throw error
    const { stdout } = await execFileAsync('uv', [
      'run',
      '--isolated',
      '--python',
      '3.12',
      '--with',
      'pillow==10.4.0',
      'python',
      pixelDiffTool,
      reference,
      implementation,
      output,
      String(pixelThreshold),
    ])
    return JSON.parse(stdout) as PixelDiff
  }
}

function compareCriticalTargets(
  reference: Record<string, TargetEvidence>,
  implementation: Record<string, TargetEvidence>,
) {
  const differences: string[] = []
  compare('root', 'role', reference.root.role, implementation.root.role)
  compare('root', 'bbox.width', reference.root.bbox?.width, implementation.root.bbox?.width)
  compare(
    'root',
    'borderRadius',
    reference.root.style.borderRadius,
    implementation.root.style.borderRadius,
  )
  compare(
    'root',
    'backgroundColor',
    reference.root.style.backgroundColor,
    implementation.root.style.backgroundColor,
  )
  compare(
    'root',
    'borderColor',
    reference.root.style.borderColor,
    implementation.root.style.borderColor,
  )
  compare('title', 'text', reference.title.text, implementation.title.text)
  compare('title', 'fontSize', reference.title.style.fontSize, implementation.title.style.fontSize)
  compare(
    'title',
    'fontWeight',
    reference.title.style.fontWeight,
    implementation.title.style.fontWeight,
  )
  compare('message', 'text', reference.message.text, implementation.message.text)
  compare(
    'message',
    'fontSize',
    reference.message.style.fontSize,
    implementation.message.style.fontSize,
  )
  compare(
    'message',
    'lineHeight',
    reference.message.style.lineHeight,
    implementation.message.style.lineHeight,
  )
  compare('actions', 'gap', reference.actions.style.gap, implementation.actions.style.gap)
  compare('close', 'ariaLabel', reference.close.ariaLabel, implementation.close.ariaLabel)
  compare('close', 'bbox.width', reference.close.bbox?.width, implementation.close.bbox?.width)
  compare('close', 'bbox.height', reference.close.bbox?.height, implementation.close.bbox?.height)
  compare('cancel', 'text', reference.cancel.text, implementation.cancel.text)
  compare('confirm', 'text', reference.confirm.text, implementation.confirm.text)

  return differences

  function compare(target: string, field: string, expected: unknown, actual: unknown) {
    if (expected !== actual) {
      differences.push(
        `${target}.${field}: reference=${JSON.stringify(expected)} implementation=${JSON.stringify(actual)}`,
      )
    }
  }
}

function lifecycleDifferences(evidence: {
  reference: LifecycleEvidence
  implementation: LifecycleEvidence
}) {
  const differences: string[] = []
  for (const leg of ['reference', 'implementation'] as const) {
    const current = evidence[leg]
    for (const key of [
      'initialFocusInside',
      'forwardTabWrapped',
      'backwardTabWrapped',
      'confirmDisabledAt0',
      'confirmDisabledAt1499',
      'confirmEnabledAt1500',
      'closedAfterCancel',
      'focusRestoredAfterCancel',
    ] as const) {
      if (!current[key]) differences.push(`${leg}.${key}=false`)
    }
    if (current.confirmCountAfterCancel !== 0) {
      differences.push(`${leg}.confirmCountAfterCancel=${current.confirmCountAfterCancel}`)
    }
  }
  if (evidence.implementation.cancelCountAfterCancel !== 1) {
    differences.push(
      `implementation.cancelCountAfterCancel=${evidence.implementation.cancelCountAfterCancel}`,
    )
  }
  return differences
}
