import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'

const ROOT = path.resolve(process.cwd())
const EVIDENCE_ROOT = path.join(ROOT, 'test/evidence/bug-20260723-019-current-source')
const PROTOTYPE_PATH = path.resolve(ROOT, '../hexclaw-docs/prototype/app.html')
const PROTOTYPE_URL = process.env.HEX_AGENTS_PROTOTYPE_URL ?? 'http://127.0.0.1:16070/app.html'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.01

const DIARY_AGENT = 'daily-report-layout'
const MAIL_AGENT = 'mail-layout'
const K12_MING_AGENT = 'k12-ming-layout'
const K12_HONG_AGENT = 'k12-hong-layout'

const VISUAL_STATES = [
  { id: 'desktop', viewport: { width: 1280, height: 820 }, columns: 2 },
  { id: 'narrow-900', viewport: { width: 900, height: 820 }, columns: 1 },
] as const

const STABILIZATION_CSS = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`

type JsonRecord = Record<string, unknown>
type Rectangle = { x: number; y: number; width: number; height: number }
type PixelDiff = {
  width: number
  height: number
  reference_size: { width: number; height: number }
  implementation_size: { width: number; height: number }
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

function assertLoopbackURL(value: string, label: string) {
  const parsed = new URL(value)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`${label} must be loopback-only: ${value}`)
  }
}

assertLoopbackURL(PROTOTYPE_URL, 'HEX_AGENTS_PROTOTYPE_URL')

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function fixtureItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `fixture-${index + 1}` }))
}

async function mockCurrentSource(page: Page, blockedRequests: string[]) {
  await page.addInitScript(() => {
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  })

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname)) {
      blockedRequests.push(requestUrl.toString())
      return route.abort('blockedbyclient')
    }

    if (!requestUrl.pathname.startsWith('/_hexclaw/')) return route.continue()
    const apiPath = requestUrl.pathname.replace('/_hexclaw', '')

    if (apiPath === '/health') return json(route, { status: 'ok' })
    if (apiPath === '/api/v1/config/llm') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: {},
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/agents/rules') {
      return json(route, {
        rules: [
          {
            id: 1,
            platform: '飞书',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: DIARY_AGENT,
            priority: 0,
          },
          {
            id: 2,
            platform: '邮箱',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: MAIL_AGENT,
            priority: 0,
          },
          {
            id: 3,
            platform: 'dingtalk',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: K12_MING_AGENT,
            priority: 0,
          },
          {
            id: 4,
            platform: 'dingtalk',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: K12_HONG_AGENT,
            priority: 0,
          },
        ],
        total: 4,
      })
    }
    if (apiPath === '/api/v1/agents') {
      return json(route, {
        agents: [
          {
            name: DIARY_AGENT,
            display_name: '日报分析师',
            description: '日报整理 · 简洁理性',
            model: '',
            provider: '',
            metadata: { card_icon: 'bar-chart' },
          },
          {
            name: MAIL_AGENT,
            display_name: '邮件助理',
            description: '收发邮件 · 正式礼貌',
            model: '',
            provider: '',
            metadata: { card_icon: 'mail' },
          },
          {
            name: K12_MING_AGENT,
            display_name: '小明的辅导助手 · 五年级',
            description: '五年级上 · 数学教材与当前进度 · 按年级边界讲解',
            model: '',
            provider: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              card_enter_variant: 'primary',
              'k12.child_name': '小明',
              'k12.grade_term': '五年级上',
            },
          },
          {
            name: K12_HONG_AGENT,
            display_name: '小红的辅导助手 · 三年级',
            description: '三年级上 · 数学教材与当前进度 · 独立档案与学习记录',
            model: '',
            provider: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              card_enter_variant: 'default',
              'k12.child_name': '小红',
              'k12.grade_term': '三年级上',
            },
          },
        ],
        total: 4,
        default: DIARY_AGENT,
      })
    }
    if (apiPath === '/api/k12/mistakes') {
      const count = requestUrl.searchParams.get('agent') === K12_MING_AGENT ? 11 : 7
      return json(route, { items: fixtureItems(count) })
    }
    if (apiPath === '/api/k12/review-queue') {
      const count = requestUrl.searchParams.get('agent') === K12_MING_AGENT ? 6 : 3
      return json(route, { items: fixtureItems(count) })
    }

    return json(route, {})
  })
}

async function blockPrototypeExternalRequests(page: Page, blockedRequests: string[]) {
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(requestUrl.hostname)) {
      return route.continue()
    }
    blockedRequests.push(requestUrl.toString())
    return route.abort('blockedbyclient')
  })
}

async function waitForFonts(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

async function preparePrototype(page: Page) {
  await page.goto(PROTOTYPE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => typeof (globalThis as { showPane?: unknown }).showPane === 'function',
  )
  await page.evaluate(() => {
    ;(globalThis as { showPane: (pane: string, title: string) => void }).showPane(
      'agents',
      '智能体',
    )
  })
  await expect(page.locator('.screen[data-pane="agents"]')).toHaveClass(/\bon\b/)
  await expect(page.locator('.screen[data-pane="agents"] .agent-card')).toHaveCount(4)
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await waitForFonts(page)
}

async function prepareImplementation(page: Page, sourceUrl: string) {
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.hc-cxcard--dedicated')).toHaveCount(4)
  await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 10_000 })
  await expect(
    page.locator('.hc-cxcard--dedicated').filter({ hasText: '小明的辅导助手' }),
  ).toContainText('错题 11')
  await expect(
    page.locator('.hc-cxcard--dedicated').filter({ hasText: '小红的辅导助手' }),
  ).toContainText('待复习 3')
  await page.addStyleTag({ content: STABILIZATION_CSS })
  await waitForFonts(page)
}

async function captureSurface(page: Page, kind: 'prototype' | 'implementation') {
  return page.evaluate((surfaceKind) => {
    const round = (value: number) => Math.round(value * 100) / 100
    const rect = (element: Element): Rectangle => {
      const box = element.getBoundingClientRect()
      return {
        x: round(box.x),
        y: round(box.y),
        width: round(box.width),
        height: round(box.height),
      }
    }
    const relativeRect = (element: Element, owner: Element): Rectangle => {
      const box = element.getBoundingClientRect()
      const parent = owner.getBoundingClientRect()
      return {
        x: round(box.x - parent.x),
        y: round(box.y - parent.y),
        width: round(box.width),
        height: round(box.height),
      }
    }
    const text = (element: Element | null) =>
      (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const css = (element: Element, properties: string[]) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(
        properties.map((property) => [property, style.getPropertyValue(property)]),
      )
    }
    const grid = document.querySelector(
      surfaceKind === 'prototype' ? '.screen[data-pane="agents"] .agent-cards' : '.hc-cxcards',
    ) as HTMLElement | null
    if (!grid) throw new Error(`${surfaceKind} agent-card grid is missing`)

    const cardSelector = surfaceKind === 'prototype' ? '.agent-card' : '.hc-cxcard--dedicated'
    const cards = Array.from(grid.querySelectorAll(cardSelector)) as HTMLElement[]
    const cardSnapshots = cards.map((card) => {
      const header = card.querySelector(
        surfaceKind === 'prototype' ? '.agent-card__header' : '.hc-agent-card__header',
      ) as HTMLElement
      const facts = card.querySelector(
        surfaceKind === 'prototype' ? '.agent-card__facts' : '.hc-agent-card__facts',
      ) as HTMLElement
      const footer = card.querySelector(
        surfaceKind === 'prototype' ? '.agent-card__footer' : '.hc-agent-card__footer',
      ) as HTMLElement
      const name = card.querySelector(
        surfaceKind === 'prototype' ? '.agent-card__name' : '.hc-cxnm__label',
      ) as HTMLElement
      const description = card.querySelector(
        surfaceKind === 'prototype' ? '.agent-card__description' : '.hc-cxmeta--card',
      ) as HTMLElement
      const badgeSelector =
        surfaceKind === 'prototype'
          ? '.agent-card__titleline .agent-card__badge'
          : '.hc-cxnm--card .hc-cxnm__badge'
      const factSelector =
        surfaceKind === 'prototype'
          ? '.agent-card__facts .tag, .agent-card__facts .pill'
          : '.hc-agent-card__facts .hc-tag, .hc-agent-card__facts .k12ac__tag'
      const badges = Array.from(card.querySelectorAll(badgeSelector)) as HTMLElement[]
      const factItems = Array.from(card.querySelectorAll(factSelector)) as HTMLElement[]
      const actions = Array.from(footer.querySelectorAll('button')) as HTMLButtonElement[]

      return {
        semantics: {
          kind:
            surfaceKind === 'prototype'
              ? card.dataset.agentKind
              : badges.some((badge) => text(badge) === 'K12')
                ? 'k12'
                : 'generic',
          name: text(name),
          description: text(description),
          badges: badges.map(text),
          facts: factItems.map(text),
          actions: actions.map(text),
        },
        absolute: {
          card: rect(card),
          header: rect(header),
          facts: rect(facts),
          footer: rect(footer),
          actions: actions.map(rect),
        },
        relative: {
          card: relativeRect(card, grid),
          header: relativeRect(header, card),
          facts: relativeRect(facts, card),
          footer: relativeRect(footer, card),
          actions: actions.map((action) => relativeRect(action, card)),
        },
        styles: {
          card: css(card, [
            'display',
            'flex-direction',
            'gap',
            'min-height',
            'padding-top',
            'padding-right',
            'padding-bottom',
            'padding-left',
            'border-radius',
          ]),
          header: css(header, ['min-height', 'min-width']),
          facts: css(facts, ['display', 'min-height', 'align-content', 'flex-wrap']),
          footer: css(footer, ['display', 'gap', 'flex-wrap']),
          name: css(name, ['min-width', 'overflow', 'text-overflow', 'white-space']),
          description: css(description, ['min-width', 'overflow', 'text-overflow', 'white-space']),
          badges: badges.map((badge) =>
            css(badge, ['flex-shrink', 'white-space', 'font-size', 'border-radius']),
          ),
          actions: actions.map((action) =>
            css(action, [
              'height',
              'padding-left',
              'padding-right',
              'border-radius',
              'border-top-color',
              'background-color',
              'color',
              'font-size',
              'line-height',
              'box-shadow',
            ]),
          ),
        },
      }
    })
    const gridStyle = getComputedStyle(grid)

    return {
      semantics: cardSnapshots.map((card) => card.semantics),
      absolute: {
        grid: rect(grid),
        cards: cardSnapshots.map((card) => card.absolute),
      },
      relative: {
        grid: {
          width: round(grid.getBoundingClientRect().width),
          height: round(grid.getBoundingClientRect().height),
        },
        cards: cardSnapshots.map((card) => card.relative),
      },
      styles: {
        grid: {
          display: gridStyle.display,
          columns: gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length,
          columnGap: gridStyle.columnGap,
          rowGap: gridStyle.rowGap,
          alignItems: gridStyle.alignItems,
        },
        cards: cardSnapshots.map((card) => card.styles),
      },
      overflow: {
        grid: round(grid.scrollWidth - grid.clientWidth),
        cards: cards.map((card) => round(card.scrollWidth - card.clientWidth)),
      },
    }
  }, kind)
}

function differences(
  reference: unknown,
  implementation: unknown,
  tolerance = 0,
  prefix = '$',
): string[] {
  if (typeof reference === 'number' && typeof implementation === 'number') {
    return Math.abs(reference - implementation) <= tolerance
      ? []
      : [`${prefix}: reference=${reference} implementation=${implementation}`]
  }
  if (Array.isArray(reference) && Array.isArray(implementation)) {
    const output: string[] = []
    if (reference.length !== implementation.length) {
      output.push(
        `${prefix}.length: reference=${reference.length} implementation=${implementation.length}`,
      )
    }
    for (let index = 0; index < Math.min(reference.length, implementation.length); index += 1) {
      output.push(
        ...differences(reference[index], implementation[index], tolerance, `${prefix}[${index}]`),
      )
    }
    return output
  }
  if (
    reference !== null &&
    implementation !== null &&
    typeof reference === 'object' &&
    typeof implementation === 'object'
  ) {
    const output: string[] = []
    const keys = [...new Set([...Object.keys(reference), ...Object.keys(implementation)])].sort()
    for (const key of keys) {
      output.push(
        ...differences(
          (reference as JsonRecord)[key],
          (implementation as JsonRecord)[key],
          tolerance,
          `${prefix}.${key}`,
        ),
      )
    }
    return output
  }
  return Object.is(reference, implementation)
    ? []
    : [
        `${prefix}: reference=${JSON.stringify(reference)} implementation=${JSON.stringify(implementation)}`,
      ]
}

async function runPixelDiff(
  page: Page,
  referencePath: string,
  implementationPath: string,
  diffPath: string,
) {
  const referenceDataUrl = `data:image/png;base64,${(await readFile(referencePath)).toString('base64')}`
  const implementationDataUrl = `data:image/png;base64,${(await readFile(implementationPath)).toString('base64')}`
  const result = await page.evaluate(
    async ({ referenceDataUrl, implementationDataUrl, threshold }) => {
      const loadImage = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () =>
            reject(new Error(`Unable to decode screenshot: ${src.slice(0, 32)}`))
          image.src = src
        })
      const [reference, implementation] = await Promise.all([
        loadImage(referenceDataUrl),
        loadImage(implementationDataUrl),
      ])
      const referenceSize = {
        width: reference.naturalWidth,
        height: reference.naturalHeight,
      }
      const implementationSize = {
        width: implementation.naturalWidth,
        height: implementation.naturalHeight,
      }
      const width = Math.max(referenceSize.width, implementationSize.width)
      const height = Math.max(referenceSize.height, implementationSize.height)
      const referenceCanvas = document.createElement('canvas')
      const implementationCanvas = document.createElement('canvas')
      const visibleDiffCanvas = document.createElement('canvas')
      for (const canvas of [referenceCanvas, implementationCanvas, visibleDiffCanvas]) {
        canvas.width = width
        canvas.height = height
      }
      const referenceContext = referenceCanvas.getContext('2d', { willReadFrequently: true })!
      const implementationContext = implementationCanvas.getContext('2d', {
        willReadFrequently: true,
      })!
      const visibleDiffContext = visibleDiffCanvas.getContext('2d')!
      for (const context of [referenceContext, implementationContext]) {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
      }
      referenceContext.drawImage(reference, 0, 0)
      implementationContext.drawImage(implementation, 0, 0)
      const referencePixels = referenceContext.getImageData(0, 0, width, height).data
      const implementationPixels = implementationContext.getImageData(0, 0, width, height).data
      const visiblePixels = visibleDiffContext.createImageData(width, height)
      let changedPixels = 0
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1

      for (let offset = 0; offset < referencePixels.length; offset += 4) {
        const changed =
          Math.abs(referencePixels[offset]! - implementationPixels[offset]!) > threshold ||
          Math.abs(referencePixels[offset + 1]! - implementationPixels[offset + 1]!) > threshold ||
          Math.abs(referencePixels[offset + 2]! - implementationPixels[offset + 2]!) > threshold
        const pixelIndex = offset / 4
        const x = pixelIndex % width
        const y = Math.floor(pixelIndex / width)
        if (changed) {
          changedPixels += 1
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          visiblePixels.data[offset] = 255
          visiblePixels.data[offset + 1] = 35
          visiblePixels.data[offset + 2] = 35
        } else {
          const grayscale = Math.round(
            referencePixels[offset]! * 0.299 +
              referencePixels[offset + 1]! * 0.587 +
              referencePixels[offset + 2]! * 0.114,
          )
          const dimmed = Math.round(grayscale * 0.45)
          visiblePixels.data[offset] = dimmed
          visiblePixels.data[offset + 1] = dimmed
          visiblePixels.data[offset + 2] = dimmed
        }
        visiblePixels.data[offset + 3] = 255
      }
      visibleDiffContext.putImageData(visiblePixels, 0, 0)
      const totalPixels = width * height
      return {
        summary: {
          width,
          height,
          reference_size: referenceSize,
          implementation_size: implementationSize,
          threshold,
          changed_pixels: changedPixels,
          total_pixels: totalPixels,
          changed_pixel_ratio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
          changed_bbox: changedPixels === 0 ? null : ([minX, minY, maxX + 1, maxY + 1] as number[]),
        },
        reference: referenceCanvas.toDataURL('image/png'),
        implementation: implementationCanvas.toDataURL('image/png'),
        diff: visibleDiffCanvas.toDataURL('image/png'),
      }
    },
    { referenceDataUrl, implementationDataUrl, threshold: PIXEL_THRESHOLD },
  )
  await Promise.all([
    writeFile(referencePath, Buffer.from(result.reference.split(',', 2)[1]!, 'base64')),
    writeFile(implementationPath, Buffer.from(result.implementation.split(',', 2)[1]!, 'base64')),
    writeFile(diffPath, Buffer.from(result.diff.split(',', 2)[1]!, 'base64')),
  ])
  return result.summary as PixelDiff
}

async function sha256(filePath: string) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

async function captureState(
  browser: Browser,
  testInfo: TestInfo,
  state: (typeof VISUAL_STATES)[number],
  sourceUrl: string,
) {
  const stateDirectory = path.join(EVIDENCE_ROOT, state.id)
  await mkdir(stateDirectory, { recursive: true })
  const blockedRequests: { prototype: string[]; implementation: string[] } = {
    prototype: [],
    implementation: [],
  }
  const context = await browser.newContext({
    viewport: state.viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  const prototypePage = await context.newPage()
  const implementationPage = await context.newPage()

  try {
    await blockPrototypeExternalRequests(prototypePage, blockedRequests.prototype)
    await mockCurrentSource(implementationPage, blockedRequests.implementation)
    await preparePrototype(prototypePage)
    await prepareImplementation(implementationPage, sourceUrl)

    const referenceSnapshot = await captureSurface(prototypePage, 'prototype')
    const implementationSnapshot = await captureSurface(implementationPage, 'implementation')
    const referenceGrid = referenceSnapshot.absolute.grid
    const implementationGrid = implementationSnapshot.absolute.grid
    const targetWidth = Math.max(
      1,
      Math.floor(Math.min(referenceGrid.width, implementationGrid.width)),
    )
    const targetHeight = Math.max(
      1,
      Math.ceil(Math.max(referenceGrid.height, implementationGrid.height)),
    )

    const referencePath = path.join(stateDirectory, 'reference.png')
    const implementationPath = path.join(stateDirectory, 'implementation.png')
    const diffPath = path.join(stateDirectory, 'pixel-diff.png')
    const pageReferencePath = path.join(stateDirectory, 'page-reference.png')
    const pageImplementationPath = path.join(stateDirectory, 'page-implementation.png')
    const pageDiffPath = path.join(stateDirectory, 'page-pixel-diff.png')

    await prototypePage.screenshot({
      path: referencePath,
      animations: 'disabled',
      caret: 'hide',
      clip: {
        x: Math.floor(referenceGrid.x),
        y: Math.floor(referenceGrid.y),
        width: targetWidth,
        height: targetHeight,
      },
    })
    await implementationPage.screenshot({
      path: implementationPath,
      animations: 'disabled',
      caret: 'hide',
      clip: {
        x: Math.floor(implementationGrid.x),
        y: Math.floor(implementationGrid.y),
        width: targetWidth,
        height: targetHeight,
      },
    })
    await prototypePage.screenshot({
      path: pageReferencePath,
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    })
    await implementationPage.screenshot({
      path: pageImplementationPath,
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    })

    const pixelDiff = await runPixelDiff(prototypePage, referencePath, implementationPath, diffPath)
    const pagePixelDiff = await runPixelDiff(
      prototypePage,
      pageReferencePath,
      pageImplementationPath,
      pageDiffPath,
    )
    const semanticDifferences = differences(
      referenceSnapshot.semantics,
      implementationSnapshot.semantics,
    )
    const styleDifferences = differences(referenceSnapshot.styles, implementationSnapshot.styles)
    const geometryDifferences = differences(
      referenceSnapshot.relative,
      implementationSnapshot.relative,
      1,
    )
    const externalRequestDifferences = [
      ...blockedRequests.prototype.map((url) => `prototype blocked ${url}`),
      ...blockedRequests.implementation.map((url) => `implementation blocked ${url}`),
    ]
    const internalContractDifferences: string[] = []
    for (const [surface, snapshot] of [
      ['prototype', referenceSnapshot],
      ['implementation', implementationSnapshot],
    ] as const) {
      if (snapshot.styles.grid.columns !== state.columns) {
        internalContractDifferences.push(
          `${surface}.columns: expected=${state.columns} actual=${snapshot.styles.grid.columns}`,
        )
      }
      if (snapshot.styles.grid.alignItems !== 'stretch') {
        internalContractDifferences.push(
          `${surface}.alignItems: expected=stretch actual=${snapshot.styles.grid.alignItems}`,
        )
      }
      if (snapshot.overflow.grid > 1 || snapshot.overflow.cards.some((value) => value > 1)) {
        internalContractDifferences.push(
          `${surface}.overflow: ${JSON.stringify(snapshot.overflow)}`,
        )
      }
      if (
        snapshot.semantics.some((card) => card.kind === 'k12' && card.facts.includes('dingtalk'))
      ) {
        internalContractDifferences.push(`${surface}.k12Facts leaked dingtalk`)
      }
      if (snapshot.absolute.cards.some((card) => card.card.height < 146)) {
        internalContractDifferences.push(`${surface}.cardHeight below 146px`)
      }
      if (state.columns === 2) {
        for (let index = 0; index < snapshot.absolute.cards.length; index += 2) {
          const row = snapshot.absolute.cards.slice(index, index + 2)
          if (row.length === 2 && Math.abs(row[0]!.card.height - row[1]!.card.height) > 1) {
            internalContractDifferences.push(`${surface}.row${index / 2 + 1} card heights differ`)
          }
          if (row.length === 2 && Math.abs(row[0]!.footer.y - row[1]!.footer.y) > 1) {
            internalContractDifferences.push(`${surface}.row${index / 2 + 1} footer y differs`)
          }
        }
      }
    }

    const status =
      semanticDifferences.length === 0 &&
      styleDifferences.length === 0 &&
      geometryDifferences.length === 0 &&
      internalContractDifferences.length === 0 &&
      externalRequestDifferences.length === 0 &&
      pixelDiff.changed_pixel_ratio <= MAX_CHANGED_PIXEL_RATIO
        ? 'PASS'
        : 'RED'
    const report = {
      bug: 'BUG-20260723-019',
      state: state.id,
      status,
      environment: {
        viewport: state.viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
      sourceState: {
        prototypeUrl: PROTOTYPE_URL,
        implementationUrl: sourceUrl,
        splashDetachedBeforeCapture: true,
        contentFixture: 'authoritative prototype agents exact-set',
      },
      semanticDifferences,
      styleDifferences,
      geometryDifferences,
      internalContractDifferences,
      externalRequestDifferences,
      pixels: {
        target: { ...pixelDiff, maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO },
        viewportDiagnostic: pagePixelDiff,
      },
      snapshots: {
        reference: referenceSnapshot,
        implementation: implementationSnapshot,
      },
      files: {
        reference: 'reference.png',
        implementation: 'implementation.png',
        pixelDiff: 'pixel-diff.png',
        pageReference: 'page-reference.png',
        pageImplementation: 'page-implementation.png',
        pagePixelDiff: 'page-pixel-diff.png',
      },
    }
    await writeFile(
      path.join(stateDirectory, 'bbox-computed-style.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    await writeFile(
      path.join(stateDirectory, 'pixel-diff.json'),
      `${JSON.stringify(pixelDiff, null, 2)}\n`,
    )

    for (const [name, filePath, contentType] of [
      [`${state.id}-reference`, referencePath, 'image/png'],
      [`${state.id}-implementation`, implementationPath, 'image/png'],
      [`${state.id}-pixel-diff`, diffPath, 'image/png'],
      [
        `${state.id}-bbox-computed-style`,
        path.join(stateDirectory, 'bbox-computed-style.json'),
        'application/json',
      ],
    ] as const) {
      await testInfo.attach(name, { path: filePath, contentType })
    }

    return report
  } finally {
    await context.close()
  }
}

test.describe('BUG-20260723-019 · 专属智能体三槽卡片 paired visual', () => {
  test('authoritative prototype and current source stay equivalent at desktop and 900px', async ({
    browser,
  }, testInfo) => {
    const sourcePaths = {
      agentsView: path.join(ROOT, 'src/views/AgentsView.vue'),
      k12AgentCard: path.join(ROOT, 'src/features/k12/views/K12AgentCard.vue'),
      globalCss: path.join(ROOT, 'src/assets/styles/global.css'),
      pairedTest: path.join(ROOT, 'tests/e2e/browser-live-agents-card-layout.spec.ts'),
    }
    const sourceBefore = Object.fromEntries(
      await Promise.all(
        Object.entries(sourcePaths).map(async ([name, filePath]) => [name, await sha256(filePath)]),
      ),
    )
    const baseURL = String(testInfo.project.use.baseURL ?? '')
    assertLoopbackURL(baseURL, 'current-source baseURL')
    const sourceUrl = new URL('/agents', baseURL).toString()
    const reports = []

    for (const state of VISUAL_STATES) {
      reports.push(await captureState(browser, testInfo, state, sourceUrl))
    }

    const prototypeSha256 = await sha256(PROTOTYPE_PATH)
    const sourceSha256 = Object.fromEntries(
      await Promise.all(
        Object.entries(sourcePaths).map(async ([name, filePath]) => [name, await sha256(filePath)]),
      ),
    )
    const sourceStable = differences(sourceBefore, sourceSha256).length === 0
    const installedCandidate = {
      status: 'BLOCKED',
      candidate: 'src-tauri/target/release/bundle/macos/HexClaw Test.app',
      reason:
        '当前没有可复用的只读 WKWebView 截图入口能向该 Test.app 注入与权威原型完全相同的 4 卡数据并取回 DOM/computed-style；现有 native harness 均为其他业务场景专用且会改写临时 app bundle。本轮未触碰 /Applications、用户配置或用户数据。',
      applicationsTouched: false,
      userDataTouched: false,
    }
    const summary = {
      bug: 'BUG-20260723-019',
      status: reports.every((report) => report.status === 'PASS') ? 'CURRENT_SOURCE_PASS' : 'RED',
      approval: {
        prototype: '../hexclaw-docs/prototype/app.html',
        prototypeSha256,
        acceptanceId: 'AGENT-013',
      },
      sourceSha256,
      sourceStability: { stable: sourceStable, before: sourceBefore, after: sourceSha256 },
      reports,
      installedCandidate,
    }
    await writeFile(
      path.join(EVIDENCE_ROOT, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    await writeFile(
      path.join(EVIDENCE_ROOT, 'README.md'),
      `# BUG-20260723-019 current-source paired visual evidence\n\n` +
        `- Current-source status: **${summary.status}**\n` +
        `- Current-source files stable during capture: **${sourceStable}**\n` +
        `- Acceptance: \`AGENT-013\`\n` +
        `- States: ${reports.map((report) => `${report.state}=${report.status}`).join(', ')}\n` +
        `- Installed candidate: **${installedCandidate.status}** — ${installedCandidate.reason}\n` +
        `- Network: loopback-only; every non-loopback HTTP request is blocked and reported.\n` +
        `- Capture invariant: \`#splash-screen\` was detached before every implementation screenshot.\n\n` +
        `Run with one Playwright worker after starting the prototype and current-source Vite servers.\n`,
    )

    for (const report of reports) {
      expect.soft(report.semanticDifferences, `${report.state}: semantic exact-set`).toEqual([])
      expect.soft(report.styleDifferences, `${report.state}: computed-style exact-set`).toEqual([])
      expect.soft(report.geometryDifferences, `${report.state}: relative bbox <= 1px`).toEqual([])
      expect
        .soft(report.internalContractDifferences, `${report.state}: AGENT-013 invariants`)
        .toEqual([])
      expect
        .soft(report.externalRequestDifferences, `${report.state}: loopback-only network`)
        .toEqual([])
      expect
        .soft(
          report.pixels.target.changed_pixel_ratio,
          `${report.state}: target pixel ratio; inspect ${path.join(EVIDENCE_ROOT, report.state, 'pixel-diff.png')}`,
        )
        .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
    }
    expect.soft(sourceStable, 'current-source files remained unchanged during capture').toBe(true)
  })
})
