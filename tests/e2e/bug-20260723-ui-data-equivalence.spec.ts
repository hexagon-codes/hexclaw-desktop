import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

type Gate = 'DATA_EQUIVALENT' | 'DATA_NOT_EQUIVALENT' | 'CONTRACT_GAP'
type StateGate = 'STATE_EQUIVALENT' | 'STATE_NOT_EQUIVALENT' | 'NOT_EVALUATED'

interface FixtureItem {
  key: string
  kind: string
  aliases: string[]
  statuses: string[]
}

interface FixtureCase {
  bug_id: string
  id: string
  route: string
  pane: string
  segment: [string, number]
  reference_root: string
  source_root: string
  items: FixtureItem[]
  interaction?: {
    kind: 'button' | 'tab' | 'search' | 'tab-search'
    aliases?: string[]
    value?: string
  }
  state: {
    primary: string[]
    secondary: string[]
    search: string
    dialog: string | null
    disclosure?: 'expanded' | 'collapsed'
  }
  actions: Array<{ key: string; aliases: string[] }>
  contract_gaps: Array<{ key: string; prototype_aliases: string[]; dto_path: string }>
}

interface Fixture {
  schema_version: number
  meta: {
    fixture_id: string
    locale: string
    theme: string
    viewport: { width: number; height: number }
    device_scale_factor: number
    timezone: string
    reduced_motion: boolean
  }
  source: Record<string, any>
  cases: FixtureCase[]
}

interface Projection {
  scene: string
  primaryTab: string | null
  secondaryTab: string | null
  search: string
  itemKeys: string[]
  itemKinds: string[]
  statusSemantics: string[]
  actionSemantics: string[]
  dialog: null | {
    title: string
    fieldOrder: string[]
    fieldValues: Array<{ type: string; value: string; checked: boolean | null }>
  }
  disclosures: Array<{ text: string; expanded: string | null }>
  visibleTextDigest: string
}

interface PixelDiff {
  width: number
  height: number
  threshold: number
  changedPixels: number
  totalPixels: number
  changedPixelRatio: number
  changedBbox: number[] | null
}

interface InteractionResult {
  applied: boolean
  observed: boolean
  target?: string
  observation: string
}

interface BBox {
  x: number
  y: number
  width: number
  height: number
}

interface VisualNode {
  key: string
  source: string
  bbox: BBox
  computedStyle: Record<string, string>
}

interface VisualProjection {
  nodes: VisualNode[]
  missingKeys: string[]
}

interface VisualComparison {
  comparedKeys: string[]
  missingInReference: string[]
  missingInCurrent: string[]
  maxBBoxDelta: number
  bboxMismatches: Array<{ key: string; reference: BBox; current: BBox; maxDelta: number }>
  styleMismatches: Array<{ key: string; properties: string[] }>
}

const FIXTURE_PATH = path.resolve('tests/fixtures/local/ui-bug-equivalence-v1.json')
const EVIDENCE_ROOT = path.resolve('test-results/bug-20260723-ui-data-equivalence/evidence')
const REFERENCE_URL =
  process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const SOURCE_URL = process.env.HEX_UI_SOURCE_URL?.trim() || 'http://127.0.0.1:16061'
const PIXEL_THRESHOLD = 8
const MAX_CHANGED_PIXEL_RATIO = 0.001
const MAX_BBOX_DELTA = 1
const CRITICAL_STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'gap',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'border-radius',
] as const

const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Fixture

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function sourceResponse(apiPath: string, method: string, requestURL: URL): unknown {
  const source = fixture.source
  if (apiPath === '/health') return { status: 'healthy' }
  if (apiPath === '/api/v1/config') return source.config
  if (apiPath === '/api/v1/config/llm') return source.config.llm
  if (apiPath === '/api/v1/ollama/status') return { running: false, associated: false, models: [] }
  if (apiPath === '/api/v1/assistant/soul') {
    return { system_prompt: '', is_custom: false, default_prompt: '' }
  }
  if (apiPath === '/api/v1/agents' && method === 'GET') {
    return { agents: source.agents, total: source.agents.length, default: source.agents[0].name }
  }
  if (apiPath === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (apiPath === '/api/v1/roles') return { roles: [], total: 0 }
  if (apiPath === '/api/v1/sessions') return { sessions: [], total: 0 }
  if (apiPath === '/api/v1/streams/active') return { streams: [], total: 0 }
  if (apiPath === '/api/v1/platforms/instances') return { instances: [] }
  if (apiPath === '/api/v1/knowledge/documents') {
    return {
      documents: source.knowledge.documents,
      total: source.knowledge.documents.length,
      limit: 50,
      offset: 0,
      sources: [],
    }
  }
  if (apiPath === '/api/v1/knowledge/config') return source.knowledge.config
  if (apiPath === '/api/v1/knowledge/embedding-status') return source.knowledge.embedding_status
  if (apiPath.endsWith('/embedding-policy')) return source.knowledge.embedding_policy
  if (apiPath === '/api/v1/knowledge/operations') return { operations: [] }
  if (apiPath === '/api/v1/webhooks') {
    if (requestURL.searchParams.has('binding_name')) return { receipts: [], total: 0 }
    if (requestURL.searchParams.has('agent_id')) {
      return { k12_bindings: source.k12_bindings, total: source.k12_bindings.length }
    }
    return { webhooks: source.webhooks, total: source.webhooks.length }
  }
  if (apiPath === '/api/v1/cronjob' && method === 'POST') {
    return { action: 'list', jobs: [], total: 0, quota: { used: 0, limit: 100 } }
  }
  if (apiPath === '/api/v1/autonomy/summary') {
    return {
      profile: 'balanced',
      counts: { tasks: 0, ready: 0, pending: 0, grants: 0 },
      pending: [],
      tasks: [],
    }
  }
  if (apiPath === '/api/v1/skills') {
    return { dir: '/tmp/hexclaw-skills', skills: source.skills.installed, total: source.skills.installed.length }
  }
  if (apiPath === '/api/v1/skills/disabled') return { disabled: [] }
  if (apiPath === '/api/v1/clawhub/search') {
    const skills = requestURL.searchParams.get('type') === 'mcp'
      ? source.mcp.marketplace
      : source.skills.marketplace
    return { skills, total: skills.length }
  }
  if (apiPath === '/api/v1/mcp/servers') {
    return { servers: source.mcp.servers, total: source.mcp.servers.length }
  }
  if (apiPath === '/api/v1/mcp/status') {
    return { statuses: source.mcp.statuses, servers: [], total: source.mcp.servers.length }
  }
  if (apiPath === '/api/v1/mcp/tools') {
    return { tools: source.mcp.tools, total: source.mcp.tools.length }
  }
  if (apiPath === '/api/v1/prompts' || apiPath === '/api/v1/prompts/all') {
    return { prompts: source.prompts, total: source.prompts.length }
  }
  if (apiPath.startsWith('/api/k12/')) return { items: [], total: 0 }
  if (apiPath.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

async function installSourceFixture(page: Page, unknownRequests: Set<string>) {
  await page.addInitScript((config) => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('app_config', JSON.stringify(config))

    const callbacks = new Map<number, (payload: unknown) => unknown>()
    let nextCallbackID = 1
    const desktopWindow = window as typeof window & {
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
    }
    const unregisterCallback = (id: number) => callbacks.delete(id)
    const transformCallback = (callback?: (payload: unknown) => unknown, once = false) => {
      const id = nextCallbackID++
      callbacks.set(id, (payload) => {
        if (once) unregisterCallback(id)
        return callback?.(payload)
      })
      return id
    }
    desktopWindow.__TAURI_INTERNALS__ = {
      callbacks,
      transformCallback,
      unregisterCallback,
      runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'check_engine_health') return true
        if (command === 'plugin:event|listen') return Number(args.handler ?? 0)
        if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null
        if (command === 'proxy_api_request') {
          const apiPath = String(args.path ?? '')
          const response = await fetch(`/_hexclaw${apiPath}`, {
            method: String(args.method ?? 'GET'),
            body: typeof args.body === 'string' ? args.body : undefined,
            headers: { 'content-type': 'application/json' },
          })
          if (!response.ok) throw new Error(`fixture request failed: ${response.status} ${apiPath}`)
          return response.text()
        }
        if (command === 'get_disabled_skills') return []
        return null
      },
    }
    desktopWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => unregisterCallback(id),
    }
  }, fixture.source.config)

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: fixture.meta.fixture_id }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const requestURL = new URL(route.request().url())
    const apiPath = requestURL.pathname.replace(/^\/_hexclaw/, '')
    const known = [
      '/health', '/api/v1/config', '/api/v1/ollama/status', '/api/v1/assistant/soul',
      '/api/v1/agents', '/api/v1/roles', '/api/v1/sessions', '/api/v1/streams/active',
      '/api/v1/knowledge/', '/api/v1/platforms/instances', '/api/v1/webhooks', '/api/v1/cronjob', '/api/v1/autonomy/',
      '/api/v1/skills', '/api/v1/clawhub/search', '/api/v1/mcp/', '/api/v1/prompts', '/api/k12/',
    ]
    if (!known.some((prefix) => apiPath.startsWith(prefix))) unknownRequests.add(apiPath)
    return json(route, sourceResponse(apiPath, route.request().method(), requestURL))
  })
}

async function openReference(page: Page, scene: FixtureCase) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ pane, segment }) => {
    const nav = document.querySelector<HTMLElement>(`.sb-item[data-screen="${pane}"]`)
    if (!nav) throw new Error(`prototype pane is missing: ${pane}`)
    nav.click()
    const api = window as typeof window & { seg?: (set: string, index: number) => void }
    if (!api.seg) throw new Error('prototype segment API is unavailable')
    api.seg(segment[0], segment[1])
  }, { pane: scene.pane, segment: scene.segment })
  await expect(page.locator(`.screen[data-pane="${scene.pane}"].on`)).toBeVisible()
  await expect(page.locator(scene.reference_root)).toBeVisible()
}

async function openSource(page: Page, scene: FixtureCase) {
  await page.goto(`${SOURCE_URL}${scene.route}`, { waitUntil: 'domcontentloaded' })
  await page.locator('#splash-screen').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
  await expect(page.locator(scene.source_root)).toBeVisible()
  await page.waitForLoadState('networkidle').catch(() => undefined)
}

async function clickAlias(page: Page, aliases: string[]): Promise<{ applied: boolean; target?: string }> {
  for (const alias of aliases) {
    const target = page.getByRole('button', { name: new RegExp(alias, 'i') }).filter({ visible: true }).first()
    if (await target.count()) {
      await target.click()
      return { applied: true, target: alias }
    }
  }
  return { applied: false }
}

async function fillVisibleSearch(page: Page, value: string): Promise<{ applied: boolean; target?: string }> {
  const candidates = page.locator('input').filter({ visible: true })
  for (let index = 0; index < await candidates.count(); index++) {
    const input = candidates.nth(index)
    const placeholder = (await input.getAttribute('placeholder')) ?? ''
    const type = (await input.getAttribute('type')) ?? 'text'
    if (type === 'search' || /搜索|search/i.test(placeholder)) {
      await input.fill(value)
      return { applied: (await input.inputValue()) === value, target: placeholder || type }
    }
  }
  return { applied: false }
}

async function observeInteraction(page: Page, scene: FixtureCase): Promise<{ observed: boolean; observation: string }> {
  const interaction = scene.interaction
  if (!interaction) return { observed: true, observation: 'no interaction required' }

  const poll = async (predicate: () => Promise<boolean>, observation: string) => {
    try {
      await expect.poll(predicate, { timeout: 3_000 }).toBe(true)
      return { observed: true, observation }
    } catch {
      return { observed: false, observation: `${observation}: postcondition was not observed` }
    }
  }

  if (scene.state.dialog) {
    return poll(async () => {
      const visibleDialogText = await page
        .locator('[role="dialog"],body > div.fixed.inset-0,.modal')
        .evaluateAll((nodes) => nodes
          .filter((node) => {
            const element = node as HTMLElement
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          })
          .map((node) => (node as HTMLElement).innerText || '')
          .join(' '))
      return visibleDialogText.includes(scene.state.dialog)
    }, `dialog "${scene.state.dialog}" is visible`)
  }

  const selectedTabMatches = async () => {
    const selectedText = await page
      .locator('[aria-selected="true"],.utab.on,.seg.on,.segment.on')
      .evaluateAll((nodes) => nodes
        .filter((node) => {
          const element = node as HTMLElement
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        })
        .map((node) => (node as HTMLElement).innerText || '')
        .join(' | '))
    return (interaction.aliases ?? []).some((alias) => selectedText.includes(alias))
  }

  const searchMatches = async () => page.locator('input').evaluateAll((nodes, expected) => {
    const visibleInput = nodes
      .map((node) => node as HTMLInputElement)
      .find((input) => {
        const rect = input.getBoundingClientRect()
        const style = getComputedStyle(input)
        return (input.type === 'search' || /搜索|search/i.test(input.placeholder || '')) &&
          rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
    return visibleInput?.value === expected
  }, interaction.value ?? '')

  if (interaction.kind === 'search') {
    return poll(searchMatches, `search value is "${interaction.value ?? ''}"`)
  }
  if (interaction.kind === 'tab') {
    return poll(selectedTabMatches, `tab "${(interaction.aliases ?? []).join(' / ')}" is selected`)
  }
  if (interaction.kind === 'tab-search') {
    return poll(
      async () => (await selectedTabMatches()) && (await searchMatches()),
      `tab "${(interaction.aliases ?? []).join(' / ')}" is selected and search value is "${interaction.value ?? ''}"`,
    )
  }

  return { observed: true, observation: 'button click completed' }
}

async function applyInteraction(page: Page, scene: FixtureCase): Promise<InteractionResult> {
  const interaction = scene.interaction
  if (!interaction) return { applied: true, observed: true, observation: 'no interaction required' }

  const action = interaction.kind === 'search'
    ? await fillVisibleSearch(page, interaction.value ?? '')
    : interaction.kind === 'tab-search'
      ? await clickAlias(page, interaction.aliases ?? [])
      : await clickAlias(page, interaction.aliases ?? [])
  if (!action.applied) {
    return {
      applied: false,
      observed: false,
      target: action.target,
      observation: 'interaction target was not found or could not be applied',
    }
  }

  if (interaction.kind === 'tab-search') {
    const searchAction = await fillVisibleSearch(page, interaction.value ?? '')
    if (!searchAction.applied) {
      return {
        applied: false,
        observed: false,
        target: searchAction.target,
        observation: 'tab was selected but search value could not be applied',
      }
    }
  }

  const observed = await observeInteraction(page, scene)
  return { applied: true, target: action.target, ...observed }
}

async function freeze(page: Page) {
  await page.addStyleTag({
    content: `
      *,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
      html{scroll-behavior:auto!important}
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await page.mouse.move(1, 1)
}

function normalizeSpace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

async function extractVisualProjection(page: Page, scene: FixtureCase, rootSelector: string): Promise<VisualProjection> {
  return page.evaluate(({ definition, selector, styleKeys }) => {
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
    const visible = (node: Element) => {
      const element = node as HTMLElement
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const round = (value: number) => Math.round(value * 100) / 100
    const snapshot = (key: string, source: string, node: HTMLElement): VisualNode => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        key,
        source,
        bbox: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        },
        computedStyle: Object.fromEntries(styleKeys.map((property) => [property, style.getPropertyValue(property)])),
      }
    }
    const findByAliases = (scope: ParentNode, aliases: string[]) => {
      const candidates = Array.from(scope.querySelectorAll<HTMLElement>('*'))
        .filter(visible)
        .map((node) => ({ node, text: clean(node.innerText || node.textContent || '') }))
        .filter(({ text }) => aliases.some((alias) => text.includes(alias)))
        .sort((left, right) => {
          const leftExact = aliases.some((alias) => left.text === alias) ? 0 : 1
          const rightExact = aliases.some((alias) => right.text === alias) ? 0 : 1
          if (leftExact !== rightExact) return leftExact - rightExact
          if (left.text.length !== right.text.length) return left.text.length - right.text.length
          return left.node.getBoundingClientRect().width * left.node.getBoundingClientRect().height -
            right.node.getBoundingClientRect().width * right.node.getBoundingClientRect().height
        })
      return candidates[0]?.node ?? null
    }
    const root = document.querySelector<HTMLElement>(selector)
    if (!root || !visible(root)) throw new Error(`visual projection root is missing: ${definition.id}`)

    const nodes: VisualNode[] = [snapshot('root', selector, root)]
    const missingKeys: string[] = []
    const add = (key: string, source: string, node: HTMLElement | null) => {
      if (!node) {
        missingKeys.push(key)
        return
      }
      nodes.push(snapshot(key, source, node))
    }

    for (const item of definition.items) {
      add(`item:${item.key}`, item.aliases.join(' | '), findByAliases(root, item.aliases))
    }
    if (definition.interaction) {
      add(
        'interaction',
        (definition.interaction.aliases ?? []).join(' | '),
        findByAliases(document, definition.interaction.aliases ?? []),
      )
    }
    if (definition.state.dialog) {
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],body > div.fixed.inset-0,.modal'))
        .find((node) => visible(node) && clean(node.innerText || '').includes(definition.state.dialog!))
      add('dialog', definition.state.dialog, dialog ?? null)
    }
    return { nodes, missingKeys }
  }, { definition: scene, selector: rootSelector, styleKeys: [...CRITICAL_STYLE_KEYS] })
}

function compareVisualProjections(reference: VisualProjection, current: VisualProjection): VisualComparison {
  const referenceByKey = new Map(reference.nodes.map((node) => [node.key, node]))
  const currentByKey = new Map(current.nodes.map((node) => [node.key, node]))
  const allKeys = [...new Set([...referenceByKey.keys(), ...currentByKey.keys()])].sort()
  const missingInReference = allKeys.filter((key) => !referenceByKey.has(key))
  const missingInCurrent = allKeys.filter((key) => !currentByKey.has(key))
  const comparedKeys = allKeys.filter((key) => referenceByKey.has(key) && currentByKey.has(key))
  const bboxMismatches: VisualComparison['bboxMismatches'] = []
  const styleMismatches: VisualComparison['styleMismatches'] = []
  let maxBBoxDelta = 0

  for (const key of comparedKeys) {
    const referenceNode = referenceByKey.get(key)!
    const currentNode = currentByKey.get(key)!
    const deltas = (['x', 'y', 'width', 'height'] as const).map((property) =>
      Math.abs(referenceNode.bbox[property] - currentNode.bbox[property]))
    const nodeMaxBBoxDelta = Math.max(...deltas)
    maxBBoxDelta = Math.max(maxBBoxDelta, nodeMaxBBoxDelta)
    if (nodeMaxBBoxDelta > MAX_BBOX_DELTA) {
      bboxMismatches.push({
        key,
        reference: referenceNode.bbox,
        current: currentNode.bbox,
        maxDelta: nodeMaxBBoxDelta,
      })
    }
    const properties = CRITICAL_STYLE_KEYS.filter((property) =>
      referenceNode.computedStyle[property] !== currentNode.computedStyle[property])
    if (properties.length) styleMismatches.push({ key, properties: [...properties] })
  }

  return { comparedKeys, missingInReference, missingInCurrent, maxBBoxDelta, bboxMismatches, styleMismatches }
}

async function extractProjection(page: Page, scene: FixtureCase): Promise<Projection> {
  return page.evaluate(({ definition }) => {
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
    const visible = (node: Element) => {
      const element = node as HTMLElement
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const root = document.querySelector<HTMLElement>(
      location.host.includes('16070') ? definition.reference_root : definition.source_root,
    )
    if (!root) throw new Error(`projection root is missing: ${definition.id}`)
    const text = clean(root.innerText || '')
    const bodyText = clean(document.body.innerText || '')
    const orderedItems = definition.items
      .map((item) => {
        const indexes = item.aliases.map((alias) => text.indexOf(alias)).filter((index) => index >= 0)
        return { item, index: indexes.length ? Math.min(...indexes) : -1 }
      })
      .filter((entry) => entry.index >= 0)
      .sort((left, right) => left.index - right.index)

    const statusSemantics = orderedItems.map(({ item, index }, itemIndex) => {
      if (item.statuses.length === 0) return `${item.key}:not-applicable`
      const nextIndex = orderedItems[itemIndex + 1]?.index ?? text.length
      const itemText = text.slice(index, nextIndex)
      const matched = item.statuses.find((alias) => itemText.includes(alias))
      return `${item.key}:${matched ? 'matched' : 'missing'}`
    })
    const actionSemantics = definition.actions
      .filter((action) => action.aliases.some((alias) => bodyText.includes(alias)))
      .map((action) => action.key)

    const selectedCandidates = Array.from(
      root.querySelectorAll<HTMLElement>('[aria-selected="true"],.utab.on,.seg.on,.segment.on'),
    ).filter(visible)
    const selectedText = selectedCandidates.map((node) => clean(node.innerText || '')).join(' | ')
    const findSemantic = (aliases: string[], haystack: string) =>
      aliases.find((alias) => haystack.includes(alias)) ?? null

    const searchInput = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
      .filter(visible)
      .find((input) => input.type === 'search' || /搜索|search/i.test(input.placeholder || ''))

    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"],body > div.fixed.inset-0,.modal'),
    ).filter(visible)
    const dialogNode = overlays.find((node) => {
      const dialogText = clean(node.innerText || '')
      return definition.state.dialog ? dialogText.includes(definition.state.dialog) : false
    })
    const dialog = dialogNode
      ? {
          title: clean(dialogNode.querySelector('h1,h2,h3,.modal-title')?.textContent || ''),
          fieldOrder: Array.from(dialogNode.querySelectorAll('label')).filter(visible).map((node) => clean(node.textContent || '')),
          fieldValues: Array.from(dialogNode.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'))
            .filter(visible)
            .map((field) => ({
              type: field instanceof HTMLTextAreaElement ? 'textarea' : field.type || 'text',
              value: field.value,
              checked: field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type) ? field.checked : null,
            })),
        }
      : null

    const disclosures = Array.from(root.querySelectorAll<HTMLElement>('[aria-expanded]'))
      .filter(visible)
      .map((node) => ({ text: clean(node.innerText || '').slice(0, 120), expanded: node.getAttribute('aria-expanded') }))

    let digest = 2166136261
    for (let index = 0; index < text.length; index++) {
      digest ^= text.charCodeAt(index)
      digest = Math.imul(digest, 16777619)
    }
    return {
      scene: definition.id,
      primaryTab: findSemantic(definition.state.primary, bodyText),
      secondaryTab: findSemantic(definition.state.secondary, selectedText || text),
      search: searchInput?.value ?? '',
      itemKeys: orderedItems.map(({ item }) => item.key),
      itemKinds: orderedItems.map(({ item }) => item.kind),
      statusSemantics,
      actionSemantics,
      dialog,
      disclosures,
      visibleTextDigest: (digest >>> 0).toString(16).padStart(8, '0'),
    }
  }, { definition: scene })
}

function dataProjection(projection: Projection) {
  return {
    itemKeys: projection.itemKeys,
    itemKinds: projection.itemKinds,
    statusSemantics: projection.statusSemantics,
  }
}

function stateProjection(projection: Projection) {
  return {
    primaryTab: projection.primaryTab,
    secondaryTab: projection.secondaryTab,
    search: projection.search,
    actionSemantics: projection.actionSemantics,
    dialog: projection.dialog,
    disclosures: projection.disclosures,
  }
}

function valueAtPath(root: unknown, pathValue: string): unknown {
  return pathValue.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, root)
}

async function contractGapEvidence(page: Page, scene: FixtureCase) {
  const text = normalizeSpace(await page.locator('body').innerText())
  return scene.contract_gaps.map((gap) => ({
    key: gap.key,
    prototypeObserved: gap.prototype_aliases.some((alias) => text.includes(alias)),
    dtoExpressible: valueAtPath(fixture.source, gap.dto_path) !== undefined,
    dtoPath: gap.dto_path,
  }))
}

async function createPixelDiff(page: Page, referencePath: string, sourcePath: string, diffPath: string): Promise<PixelDiff> {
  const [reference, source] = await Promise.all([readFile(referencePath), readFile(sourcePath)])
  const result = await page.evaluate(async ({ referenceData, sourceData, threshold }) => {
    const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('screenshot decode failed'))
      image.src = `data:image/png;base64,${data}`
    })
    const [left, right] = await Promise.all([load(referenceData), load(sourceData)])
    if (left.naturalWidth !== right.naturalWidth || left.naturalHeight !== right.naturalHeight) {
      throw new Error(`screenshot size mismatch: ${left.naturalWidth}x${left.naturalHeight} vs ${right.naturalWidth}x${right.naturalHeight}`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = left.naturalWidth
    canvas.height = left.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(left, 0, 0)
    const leftPixels = context.getImageData(0, 0, canvas.width, canvas.height)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(right, 0, 0)
    const rightPixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const output = context.createImageData(canvas.width, canvas.height)
    let changedPixels = 0
    let minX = canvas.width
    let minY = canvas.height
    let maxX = -1
    let maxY = -1
    for (let offset = 0; offset < leftPixels.data.length; offset += 4) {
      const changed =
        Math.abs(leftPixels.data[offset]! - rightPixels.data[offset]!) > threshold ||
        Math.abs(leftPixels.data[offset + 1]! - rightPixels.data[offset + 1]!) > threshold ||
        Math.abs(leftPixels.data[offset + 2]! - rightPixels.data[offset + 2]!) > threshold
      const pixel = offset / 4
      const x = pixel % canvas.width
      const y = Math.floor(pixel / canvas.width)
      if (changed) {
        changedPixels++
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        output.data.set([255, 35, 35, 255], offset)
      } else {
        const gray = Math.round((leftPixels.data[offset]! + leftPixels.data[offset + 1]! + leftPixels.data[offset + 2]!) / 8)
        output.data.set([gray, gray, gray, 255], offset)
      }
    }
    context.putImageData(output, 0, 0)
    return {
      width: canvas.width,
      height: canvas.height,
      threshold,
      changedPixels,
      totalPixels: canvas.width * canvas.height,
      changedPixelRatio: changedPixels / (canvas.width * canvas.height),
      changedBbox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
      png: canvas.toDataURL('image/png').split(',')[1],
    }
  }, {
    referenceData: reference.toString('base64'),
    sourceData: source.toString('base64'),
    threshold: PIXEL_THRESHOLD,
  })
  await writeFile(diffPath, Buffer.from(result.png, 'base64'))
  return {
    width: result.width,
    height: result.height,
    threshold: result.threshold,
    changedPixels: result.changedPixels,
    totalPixels: result.totalPixels,
    changedPixelRatio: result.changedPixelRatio,
    changedBbox: result.changedBbox,
  }
}

async function attachFile(testInfo: TestInfo, name: string, filePath: string, contentType: string) {
  await testInfo.attach(name, { body: await readFile(filePath), contentType })
}

test.use({
  viewport: fixture.meta.viewport,
  deviceScaleFactor: fixture.meta.device_scale_factor,
  locale: fixture.meta.locale,
  timezoneId: fixture.meta.timezone,
  colorScheme: 'light',
  reducedMotion: 'reduce',
})

test('九个 UI bug 先通过数据/状态等价门禁，再生成可比较视觉证据', async ({ browser }, testInfo) => {
  const results: Array<Record<string, unknown>> = []
  for (const scene of fixture.cases) {
    const referencePage = await browser.newPage()
    const sourcePage = await browser.newPage()
    const unknownRequests = new Set<string>()
    const outputDir = path.join(EVIDENCE_ROOT, testInfo.project.name, scene.id)
    await mkdir(outputDir, { recursive: true })
    await installSourceFixture(sourcePage, unknownRequests)
    try {
      await Promise.all([openReference(referencePage, scene), openSource(sourcePage, scene)])
      const [referenceInteraction, sourceInteraction] = await Promise.all([
        applyInteraction(referencePage, scene),
        applyInteraction(sourcePage, scene),
      ])
      await Promise.all([freeze(referencePage), freeze(sourcePage)])

      const referencePath = path.join(outputDir, 'reference.png')
      const sourcePath = path.join(outputDir, 'current-source.png')
      const diffPath = path.join(outputDir, 'pixel-diff.png')
      const projectionPath = path.join(outputDir, 'normalized-projections.json')
      const reportPath = path.join(outputDir, 'gate-report.json')
      await Promise.all([
        referencePage.screenshot({ path: referencePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
        sourcePage.screenshot({ path: sourcePath, animations: 'disabled', caret: 'hide', scale: 'css' }),
      ])
      const [referenceProjection, sourceProjection, referenceVisual, sourceVisual, gaps, pixels] = await Promise.all([
        extractProjection(referencePage, scene),
        extractProjection(sourcePage, scene),
        extractVisualProjection(referencePage, scene, scene.reference_root),
        extractVisualProjection(sourcePage, scene, scene.source_root),
        contractGapEvidence(referencePage, scene),
        createPixelDiff(referencePage, referencePath, sourcePath, diffPath),
      ])

      const effectiveGaps = gaps.filter((gap) => gap.prototypeObserved && !gap.dtoExpressible)
      const dataEquivalent = JSON.stringify(dataProjection(referenceProjection)) === JSON.stringify(dataProjection(sourceProjection))
      const interactionEquivalent = [referenceInteraction, sourceInteraction]
        .every((interaction) => interaction.applied && interaction.observed)
      const stateEquivalent =
        interactionEquivalent &&
        JSON.stringify(stateProjection(referenceProjection)) === JSON.stringify(stateProjection(sourceProjection)) &&
        unknownRequests.size === 0
      const dataGate: Gate = effectiveGaps.length > 0
        ? 'CONTRACT_GAP'
        : dataEquivalent
          ? 'DATA_EQUIVALENT'
          : 'DATA_NOT_EQUIVALENT'
      const stateGate: StateGate = dataGate === 'DATA_EQUIVALENT'
        ? stateEquivalent
          ? 'STATE_EQUIVALENT'
          : 'STATE_NOT_EQUIVALENT'
        : 'NOT_EVALUATED'
      const notComparableReasons = [
        ...(effectiveGaps.length ? ['CONTRACT_GAP'] : []),
        ...(!dataEquivalent ? ['DATA_NOT_EQUIVALENT'] : []),
        ...(!interactionEquivalent ? ['INTERACTION_NOT_CONFIRMED'] : []),
        ...(stateGate === 'STATE_NOT_EQUIVALENT' ? ['STATE_NOT_EQUIVALENT'] : []),
        ...(unknownRequests.size ? ['UNKNOWN_REQUESTS'] : []),
      ]
      const visualGate = notComparableReasons.length === 0 ? 'VISUAL_COMPARABLE' : 'NOT_COMPARABLE'
      const pixelGate = visualGate === 'VISUAL_COMPARABLE'
        ? pixels.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO
          ? 'PIXEL_WITHIN_THRESHOLD'
          : 'PIXEL_OVER_THRESHOLD'
        : 'NOT_EVALUATED'
      const visualComparison = compareVisualProjections(referenceVisual, sourceVisual)

      await writeFile(projectionPath, `${JSON.stringify({ reference: referenceProjection, currentSource: sourceProjection }, null, 2)}\n`)
      const result = {
        bugId: scene.bug_id,
        scene: scene.id,
        route: scene.route,
        fixture: fixture.meta.fixture_id,
        dataGate,
        stateGate,
        visualGate,
        pixelGate,
        notComparableReasons,
        interaction: { reference: referenceInteraction, currentSource: sourceInteraction },
        contractGaps: gaps,
        unknownRequests: [...unknownRequests].sort(),
        pixels,
        visual: {
          reference: referenceVisual,
          currentSource: sourceVisual,
          comparison: visualComparison,
        },
        evidence: { referencePath, sourcePath, diffPath, projectionPath, reportPath },
      }
      await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`)
      await Promise.all([
        attachFile(testInfo, `${scene.id}-reference`, referencePath, 'image/png'),
        attachFile(testInfo, `${scene.id}-current-source`, sourcePath, 'image/png'),
        attachFile(testInfo, `${scene.id}-pixel-diff`, diffPath, 'image/png'),
        attachFile(testInfo, `${scene.id}-projections`, projectionPath, 'application/json'),
        attachFile(testInfo, `${scene.id}-gate-report`, reportPath, 'application/json'),
      ])
      results.push(result)
    } catch (error) {
      const failure = {
        bugId: scene.bug_id,
        scene: scene.id,
        status: 'CAPTURE_ERROR',
        error: error instanceof Error ? error.stack || error.message : String(error),
      }
      await writeFile(path.join(outputDir, 'capture-error.json'), `${JSON.stringify(failure, null, 2)}\n`)
      results.push(failure)
    } finally {
      await Promise.all([referencePage.close(), sourcePage.close()])
    }
  }

  const summaryPath = path.join(EVIDENCE_ROOT, testInfo.project.name, 'summary.json')
  await mkdir(path.dirname(summaryPath), { recursive: true })
  const bugIds = [...new Set(results.map((result) => result.bugId))].sort()
  await writeFile(summaryPath, `${JSON.stringify({
    fixture: fixture.meta.fixture_id,
    bugIds,
    visualPolicy: {
      pixelThreshold: PIXEL_THRESHOLD,
      maxChangedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      maxBBoxDelta: MAX_BBOX_DELTA,
      criticalStyleKeys: [...CRITICAL_STYLE_KEYS],
    },
    results,
  }, null, 2)}\n`)
  await attachFile(testInfo, 'ui-data-equivalence-summary', summaryPath, 'application/json')

  expect(fixture.schema_version).toBe(1)
  expect(bugIds).toEqual([
    'BUG-20260723-001',
    'BUG-20260723-003',
    'BUG-20260723-005',
    'BUG-20260723-020',
    'BUG-20260723-024',
    'BUG-20260723-025',
    'BUG-20260723-031',
    'BUG-20260723-033',
    'BUG-20260723-035',
  ])
  expect(results).toHaveLength(fixture.cases.length)
  expect(results.filter((result) => result.status === 'CAPTURE_ERROR')).toEqual([])
  for (const result of results) {
    const interaction = result.interaction as {
      reference: InteractionResult
      currentSource: InteractionResult
    }
    expect(interaction.reference.applied, `${result.scene}: reference interaction was not applied`).toBe(true)
    expect(interaction.reference.observed, `${result.scene}: reference interaction was not observed`).toBe(true)
    expect(interaction.currentSource.applied, `${result.scene}: source interaction was not applied`).toBe(true)
    expect(interaction.currentSource.observed, `${result.scene}: source interaction was not observed`).toBe(true)

    const visual = result.visual as {
      reference: VisualProjection
      currentSource: VisualProjection
      comparison: VisualComparison
    }
    expect(visual.reference.missingKeys, `${result.scene}: reference critical visual anchors are missing`).not.toContain('root')
    expect(visual.currentSource.missingKeys, `${result.scene}: source critical visual anchors are missing`).not.toContain('root')

    if (result.dataGate === 'CONTRACT_GAP') {
      const gaps = result.contractGaps as Array<{ prototypeObserved: boolean; dtoExpressible: boolean }>
      expect(gaps.some((gap) => gap.prototypeObserved && !gap.dtoExpressible)).toBe(true)
    }

    if (result.visualGate === 'VISUAL_COMPARABLE') {
      expect(result.stateGate, `${result.scene}: comparable visual evidence requires equivalent state`).toBe('STATE_EQUIVALENT')
      expect(result.pixelGate, `${result.scene}: pixel diff exceeded the permitted gate`).toBe('PIXEL_WITHIN_THRESHOLD')
      const pixels = result.pixels as PixelDiff
      expect(pixels.threshold).toBe(PIXEL_THRESHOLD)
      expect(pixels.changedPixelRatio, `${result.scene}: changed pixel ratio exceeded ${MAX_CHANGED_PIXEL_RATIO}`)
        .toBeLessThanOrEqual(MAX_CHANGED_PIXEL_RATIO)
      expect(visual.comparison.missingInReference, `${result.scene}: reference visual anchors are missing`).toEqual([])
      expect(visual.comparison.missingInCurrent, `${result.scene}: source visual anchors are missing`).toEqual([])
      expect(visual.comparison.bboxMismatches, `${result.scene}: critical bbox mismatch`).toEqual([])
      expect(visual.comparison.styleMismatches, `${result.scene}: critical computed-style mismatch`).toEqual([])
    } else {
      expect(result.visualGate, `${result.scene}: non-equivalent state must not be visually comparable`).toBe('NOT_COMPARABLE')
      expect(result.pixelGate, `${result.scene}: NOT_COMPARABLE must not be evaluated by pixel threshold`).toBe('NOT_EVALUATED')
      const reasons = result.notComparableReasons as string[]
      expect(reasons.length, `${result.scene}: NOT_COMPARABLE has no evidence-backed reason`).toBeGreaterThan(0)
      expect(
        reasons.some((reason) => [
          'CONTRACT_GAP',
          'DATA_NOT_EQUIVALENT',
          'INTERACTION_NOT_CONFIRMED',
          'STATE_NOT_EQUIVALENT',
          'UNKNOWN_REQUESTS',
        ].includes(reason)),
        `${result.scene}: NOT_COMPARABLE reason is not an allowed gate failure`,
      ).toBe(true)
    }
  }
})
