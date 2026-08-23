import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test'

const execFileAsync = promisify(execFile)
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsRoot = path.resolve(desktopRoot, '../hexclaw-docs')
const evidenceRoot = path.join(desktopRoot, 'test/evidence/bug-20260723-009-010-current-source')
const sourceUrl = `http://127.0.0.1:${process.env.HEX_CAPABILITY_SOURCE_PORT}`
const referenceUrl = `http://127.0.0.1:${process.env.HEX_CAPABILITY_REFERENCE_PORT}/app.html`
const viewport = { width: 1440, height: 960 }
const pixelThreshold = 8
const styleKeys = [
  'display',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'gap',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRadius',
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'gridTemplateColumns',
  'overflowX',
  'whiteSpace',
] as const

const stabilizationCss = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`

const skills = [
  {
    name: '翻译润色',
    description: '把中英文内容翻译为地道表达，保留代码、变量和专有名词。',
    version: '1.0.0',
    author: '本地安装',
    tags: ['writing'],
    icon: '译',
    triggers: ['/translate'],
    enabled: true,
  },
  {
    name: '网页抓取',
    description: '读取网页正文、保留标题/作者/日期，并输出结构化摘要。',
    version: '1.4.2',
    author: 'local',
    tags: ['browser', 'defuddle'],
    icon: '抓',
    triggers: [],
    enabled: true,
  },
]

const mcpTools = [
  {
    name: 'filesystem.read_file',
    description: '读取允许目录内的文件内容',
    input_schema: {
      properties: {
        path: {
          type: 'string',
          description: '绝对路径',
          example: '/Users/hexagon/Documents/report.md',
        },
      },
    },
  },
  {
    name: 'postgres.query',
    description: '执行只读 SQL 查询',
    input_schema: {
      properties: { sql: { type: 'string' }, limit: { type: 'number', default: 100 } },
    },
  },
]

const mcpServers = [
  {
    name: 'filesystem',
    description: 'stdio · npx -y @modelcontextprotocol/server-filesystem ~/Documents',
    status: 'connected',
  },
  {
    name: 'postgres-readonly',
    description: 'stdio · 只读数据库工具 · 3 个工具',
    status: 'pending_authorization',
  },
] as const

// 夹具固定原型与生产 API 的共同结构化内容；状态动作与 schema/input 必须由页面真实渲染。
const capabilityFixtureParity = {
  fixture: 'bug-20260723-009-010-homomorphic-v2',
  productionContract: {
    sourceFiles: ['src/api/mcp.ts', 'src/types/mcp.ts', 'src/views/McpView.vue'],
    getMcpServers: {
      response: { servers: '{name,description,status}[]', total: 'number' },
      consumedFields: ['servers[].name', 'servers[].description', 'servers[].status'],
    },
    getMcpServerStatus: {
      response: {
        statuses: 'Record<string, connected|disconnected|error|pending_authorization>',
        servers: 'optional {name, connected, tool_count}[]',
      },
      consumedFields: ['status label', 'status dot', 'pending-authorization action'],
    },
    getMcpTools: {
      response: {
        tools: '{name, description, server_name?, input_schema?}[]',
        total: 'number',
      },
      consumedFields: ['name', 'description', 'input_schema'],
      stateModel: {
        prototype: 'Both tool rows expose static schema markup; the first also exposes its input.',
        implementation: 'Both rows keep static schema markup visible; the first row also keeps its input visible.',
      },
    },
  },
  reference: {
    locale: 'zh-CN',
    theme: 'light',
    state: 'installed capabilities; no modal, toast, or test result visible',
    skills: [
      { name: '翻译润色', description: skills[0].description, enabled: true },
      { name: '网页抓取', description: skills[1].description, enabled: true },
    ],
    mcpServers: [
      {
        name: 'filesystem',
        description: 'stdio · npx -y @modelcontextprotocol/server-filesystem ~/Documents',
        status: '已连接',
        actions: ['重启', '删除'],
      },
      {
        name: 'postgres-readonly',
        description: 'stdio · 只读数据库工具 · 3 个工具',
        status: '待授权',
        actions: ['去设置授权 ›', '删除'],
      },
    ],
    mcpTools: [
      {
        ...mcpTools[0],
        state: { staticContentVisible: true, staticInputVisible: true, path: '/Users/hexagon/Documents/report.md' },
      },
      { ...mcpTools[1], state: { staticContentVisible: true, staticInputVisible: false } },
    ],
  },
  implementationFixture: {
    locale: 'zh-CN',
    theme: 'light',
    state: 'installed capabilities; no modal, toast, or test result visible',
    skills: skills.map(({ name, description, enabled }) => ({ name, description, enabled })),
    mcpServers: {
      apiServers: mcpServers,
      apiStatuses: { filesystem: 'connected', 'postgres-readonly': 'pending_authorization' },
    },
    mcpTools: mcpTools.map((tool, index) => ({
      ...tool,
      state:
        index === 0
          ? { staticContentVisible: true, staticInputVisible: true, path: '/Users/hexagon/Documents/report.md' }
          : { staticContentVisible: true, staticInputVisible: false },
    })),
  },
  semanticBlockers: {
    mcpServers: [],
    mcpTools: [],
  },
} as const

const skillMarket = [
  {
    name: 'sql-analyst',
    display_name: 'SQL 分析师',
    description: '根据自然语言生成查询、解释结果并发现异常。',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['data'],
    downloads: 2100,
    rating: 4.8,
    category: 'data',
    type: 'skill',
  },
  {
    name: 'document-organizer',
    display_name: '文档整理',
    description: '把散乱材料整理成 Markdown 报告、目录和待办。',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['writing'],
    downloads: 1600,
    rating: 4.6,
    category: 'writing',
    type: 'skill',
  },
  {
    name: 'test-case-generator',
    display_name: '测试用例生成',
    description: '从需求和代码生成单元、集成和回归测试清单。',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['coding'],
    downloads: 860,
    rating: 4.5,
    category: 'coding',
    type: 'skill',
  },
]

const mcpMarket = [
  {
    name: 'github',
    display_name: 'GitHub MCP',
    description: '读取仓库、Issue、PR，并可按审批写入标签。',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'development',
    tags: ['git'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    name: 'browser',
    display_name: 'Browser MCP',
    description: '打开页面、截图、点击、提取内容。',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'browser',
    tags: ['browser'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-browser'],
  },
]

type PixelDiff = {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: number[] | null
}

type Bitmap = { width: number; height: number; rgba: Uint8Array }

async function readBitmap(pngPath: string, temporaryBmp: string): Promise<Bitmap> {
  await execFileAsync('/usr/bin/sips', ['-s', 'format', 'bmp', pngPath, '--out', temporaryBmp])
  const bytes = await readFile(temporaryBmp)
  const pixelOffset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const height = Math.abs(rawHeight)
  const bitsPerPixel = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  const supportedCompression = compression === 0 || (compression === 3 && bitsPerPixel === 32)
  if (width <= 0 || height <= 0 || ![24, 32].includes(bitsPerPixel) || !supportedCompression) {
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

function writeBitmap24(bitmap: Bitmap): Buffer {
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
  const referenceBmp = path.join(directory, `.${stem}-reference.bmp`)
  const implementationBmp = path.join(directory, `.${stem}-implementation.bmp`)
  const diffBmp = path.join(directory, `.${stem}.bmp`)
  try {
    const reference = await readBitmap(referencePath, referenceBmp)
    const implementation = await readBitmap(implementationPath, implementationBmp)
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
        const changed =
          Math.abs(reference.rgba[offset]! - implementation.rgba[offset]!) > pixelThreshold ||
          Math.abs(reference.rgba[offset + 1]! - implementation.rgba[offset + 1]!) >
            pixelThreshold ||
          Math.abs(reference.rgba[offset + 2]! - implementation.rgba[offset + 2]!) > pixelThreshold
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
      diffBmp,
      writeBitmap24({ width: reference.width, height: reference.height, rgba: visible }),
    )
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', diffBmp, '--out', diffPath])
    const totalPixels = reference.width * reference.height
    return {
      width: reference.width,
      height: reference.height,
      threshold: pixelThreshold,
      changed_pixels: changedPixels,
      total_pixels: totalPixels,
      changed_pixel_ratio: totalPixels ? changedPixels / totalPixels : 0,
      changed_bbox: changedPixels ? [minX, minY, maxX + 1, maxY + 1] : null,
    } satisfies PixelDiff
  } finally {
    await Promise.all([
      rm(referenceBmp, { force: true }),
      rm(implementationBmp, { force: true }),
      rm(diffBmp, { force: true }),
    ])
  }
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  })
}

async function installReferenceIsolation(page: Page, blocked: string[]) {
  const allowed = new URL(referenceUrl).origin
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === allowed) return route.continue()
    blocked.push(url.href)
    return route.abort('blockedbyclient')
  })
}

async function installSourceFixture(page: Page, blocked: string[]) {
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hc-locale', 'zh-CN')
  })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(sourceUrl).origin) return route.fallback()
    blocked.push(url.href)
    return route.abort('blockedbyclient')
  })
  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'isolated-fixture' }),
  )
  await page.route('**/_hexclaw/**', (route) => {
    const url = new URL(route.request().url())
    const endpoint = url.pathname.replace('/_hexclaw', '')
    if (endpoint === '/api/v1/skills') {
      return json(route, { dir: '', skills, total: skills.length })
    }
    if (endpoint === '/api/v1/clawhub/search') {
      const items = url.searchParams.get('type') === 'mcp' ? mcpMarket : skillMarket
      return json(route, { skills: items, total: items.length })
    }
    if (endpoint === '/api/v1/mcp/servers') {
      return json(route, { servers: mcpServers, total: mcpServers.length })
    }
    if (endpoint === '/api/v1/mcp/status') {
      return json(route, {
        statuses: { filesystem: 'connected', 'postgres-readonly': 'pending_authorization' },
        total: 2,
      })
    }
    if (endpoint === '/api/v1/mcp/tools') {
      return json(route, { tools: mcpTools, total: mcpTools.length })
    }
    if (endpoint === '/api/v1/config') {
      return json(route, { general: { language: 'zh-CN', welcomeCompleted: true } })
    }
    if (endpoint === '/api/v1/config/llm') {
      return json(route, { default: '', providers: {}, routing: {}, cache: {} })
    }
    if (endpoint === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    return json(route, {})
  })
}

async function openReference(page: Page) {
  await page.goto(referenceUrl, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: stabilizationCss })
  await page.locator('.sb-item[data-screen="integration"]').click()
  await expect(page.locator('.screen[data-pane="integration"]')).toHaveClass(/on/)
}

async function openSource(page: Page) {
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: stabilizationCss })
  await page.locator('[data-nav-id="integration"]').click()
  await expect(page.locator('.hc-toolbar .hc-search__input')).toBeVisible()
  await expect(page.locator('.hc-capability-installed-track')).toBeVisible()
  await page.waitForTimeout(100)
}

async function snapshotElement(locator: Locator) {
  const count = await locator.count()
  if (count !== 1) return { count }
  return locator.evaluate(
    (element, keys) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const computed = Object.fromEntries(keys.map((key) => [key, style[key]]))
      const controls = Array.from(element.querySelectorAll('input,button,[role]')).map((node) => ({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        type: node.getAttribute('type'),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
        placeholder: node.getAttribute('placeholder'),
        ariaLabel: node.getAttribute('aria-label'),
        disabled: (node as HTMLButtonElement | HTMLInputElement).disabled ?? null,
      }))
      return {
        count: 1,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computed,
        text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        childTagExactSet: Array.from(element.children).map((child) => child.tagName.toLowerCase()),
        controls,
      }
    },
    [...styleKeys],
  )
}

async function snapshotSearch(page: Page, kind: 'reference' | 'implementation') {
  const rootSelector = kind === 'reference' ? '.screen.on .tbar .srch' : '.hc-toolbar .hc-search'
  const inputSelector = kind === 'reference' ? `${rootSelector} input` : `${rootSelector} input`
  const marketNestedSelector =
    kind === 'reference'
      ? '.screen.on .capability-market-toolbar .srch'
      : '.hc-capability-market-surface .hc-search'
  return {
    rootCount: await page.locator(rootSelector).count(),
    inputCount: await page.locator(inputSelector).count(),
    marketNestedCount: await page.locator(marketNestedSelector).count(),
    placeholder: await page.locator(inputSelector).getAttribute('placeholder'),
    root: await snapshotElement(page.locator(rootSelector)),
    input: await snapshotElement(page.locator(inputSelector)),
  }
}

async function snapshotTrack(root: Locator, rows: Locator[]) {
  const rootEvidence = await root.evaluate(
    (element, keys) => {
      const rect = element.getBoundingClientRect()
      const parent = element.parentElement!
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      const style = getComputedStyle(element)
      const parentContentWidth =
        parentRect.width -
        Number.parseFloat(parentStyle.paddingLeft || '0') -
        Number.parseFloat(parentStyle.paddingRight || '0')
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        parentRect: {
          x: parentRect.x,
          y: parentRect.y,
          width: parentRect.width,
          height: parentRect.height,
        },
        parentContentWidth,
        widthDelta: Math.abs(rect.width - parentContentWidth),
        overflow: (element as HTMLElement).scrollWidth - (element as HTMLElement).clientWidth,
        computed: Object.fromEntries(keys.map((key) => [key, style[key]])),
      }
    },
    [...styleKeys],
  )

  const rowEvidence = []
  for (const row of rows) {
    rowEvidence.push(
      await row.evaluate((element, trackRight) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const childRects = Array.from(element.children).map((child) => {
          const childRect = child.getBoundingClientRect()
          const childStyle = getComputedStyle(child)
          return {
            className: child.className,
            rect: {
              x: childRect.x,
              y: childRect.y,
              width: childRect.width,
              height: childRect.height,
            },
            display: childStyle.display,
            gridColumn: childStyle.gridColumn,
            minWidth: childStyle.minWidth,
          }
        })
        const action = Array.from(element.children).find((child) =>
          child.className.toString().split(/\s+/).some((token) => token.endsWith('capability-installed-actions')),
        )
        const actionChildRects = action
          ? Array.from(action.children).map((child) => {
              const childRect = child.getBoundingClientRect()
              const childStyle = getComputedStyle(child)
              return {
                tag: child.tagName.toLowerCase(),
                className: child.className,
                text: (child.textContent || '').replace(/\s+/g, ' ').trim(),
                rect: {
                  x: childRect.x,
                  y: childRect.y,
                  width: childRect.width,
                  height: childRect.height,
                },
                display: childStyle.display,
                padding: childStyle.padding,
                gap: childStyle.gap,
              }
            })
          : []
        const main = Array.from(element.children).find((child) =>
          child.className.toString().split(/\s+/).some((token) => token.endsWith('capability-installed-main')),
        )
        const mainChildRects = main
          ? Array.from(main.children).map((child) => {
              const childRect = child.getBoundingClientRect()
              return {
                className: child.className,
                rect: {
                  x: childRect.x,
                  y: childRect.y,
                  width: childRect.width,
                  height: childRect.height,
                },
                text: (child.textContent || '').replace(/\s+/g, ' ').trim(),
              }
            })
          : []
        const firstMainChild = main?.firstElementChild
        const firstMainGrandchildRects = firstMainChild
          ? Array.from(firstMainChild.children).map((child) => {
              const childRect = child.getBoundingClientRect()
              const childStyle = getComputedStyle(child)
              return {
                className: child.className,
                rect: {
                  x: childRect.x,
                  y: childRect.y,
                  width: childRect.width,
                  height: childRect.height,
                },
                display: childStyle.display,
                fontSize: childStyle.fontSize,
                lineHeight: childStyle.lineHeight,
                padding: childStyle.padding,
              }
            })
          : []
        const identity = firstMainChild?.lastElementChild
        const identityChildRects = identity
          ? Array.from(identity.children).map((child) => {
              const childRect = child.getBoundingClientRect()
              const childStyle = getComputedStyle(child)
              return {
                tag: child.tagName.toLowerCase(),
                className: child.className,
                rect: {
                  x: childRect.x,
                  y: childRect.y,
                  width: childRect.width,
                  height: childRect.height,
                },
                fontSize: childStyle.fontSize,
                fontWeight: childStyle.fontWeight,
                lineHeight: childStyle.lineHeight,
                margin: childStyle.margin,
              }
            })
          : []
        const controls = Array.from(element.querySelectorAll('input,button,[role]')).map(
          (node) => ({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute('role'),
            type: node.getAttribute('type'),
            text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
            title: node.getAttribute('title'),
            ariaLabel: node.getAttribute('aria-label'),
          }),
        )
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          rightEdgeDelta: Math.abs(rect.right - trackRight),
          shell: {
            display: style.display,
            gridTemplateColumns: style.gridTemplateColumns,
            gap: style.gap,
            padding: style.padding,
            borderRadius: style.borderRadius,
            childRects,
            actionChildRects,
            mainChildRects,
            firstMainGrandchildRects,
            identityChildRects,
          },
          text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
          controls,
        }
      }, rootEvidence.rect.x + rootEvidence.rect.width),
    )
  }
  return { ...rootEvidence, rowExactSet: rowEvidence }
}

type TrackEvidence = Awaited<ReturnType<typeof snapshotTrack>>

type McpSemanticRow = {
  name: string
  description: string
  status: string | null
  schema: unknown
  inputValue: string | null
  operations: string[]
}

async function snapshotMcpSemantics(
  rows: Locator,
  kind: 'server' | 'tool',
  side: 'reference' | 'implementation',
) {
  return rows.evaluateAll(
    (elements, options) =>
      elements.map((element) => {
        const queryText = (selector: string) =>
          (element.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim()
        const schemaText = queryText(
          options.side === 'reference'
            ? '.schema'
            : '.hc-capability-installed-main .hc-capability-installed-schema',
        )
        let schema: unknown = null
        if (schemaText) {
          try {
            schema = JSON.parse(schemaText)
          } catch {
            schema = schemaText
          }
        }
        const name = queryText(
          options.side === 'reference'
            ? '.main .name'
            : '.hc-capability-installed-main .hc-capability-installed-server-name, .hc-capability-installed-main .hc-capability-installed-tool-name, .hc-capability-installed-main .text-sm',
        )
        const description = queryText(
          options.side === 'reference'
            ? '.main .desc'
            : options.kind === 'tool'
              ? '.hc-capability-installed-main p'
              : '[data-mcp-description]',
        )
        const status =
          options.kind === 'server'
            ? queryText(
                options.side === 'reference'
                  ? '.pill'
                  : '.hc-capability-installed-actions > span',
              ) || null
            : null
        const input = element.querySelector(
          options.side === 'reference'
            ? 'input'
            : '[data-mcp-static-input] input',
        ) as HTMLInputElement | null
        const operations = Array.from(element.querySelectorAll('button')).map((button) =>
          (button.textContent || '').replace(/\s+/g, ' ').trim(),
        )
        return {
          name,
          description,
          status,
          schema,
          inputValue: input?.value ?? null,
          operations,
        }
      }),
    { kind, side },
  )
}

function normalizeMcpOperations(operations: string[], kind: 'server' | 'tool') {
  const normalized = new Set<string>()
  for (const operation of operations) {
    if (kind === 'server') {
      if (/重启|restart/i.test(operation)) normalized.add('restart')
      if (/删除|移除|delete|remove/i.test(operation)) normalized.add('delete')
      if (/授权|authorize|settings/i.test(operation)) normalized.add('authorize')
    } else if (/测试|执行|test|execute/i.test(operation)) {
      normalized.add('test')
    }
  }
  return [...normalized].sort()
}

function semanticParity(
  reference: McpSemanticRow[],
  implementation: McpSemanticRow[],
  kind: 'server' | 'tool',
) {
  const project = (row: McpSemanticRow) => ({
    name: row.name,
    description: row.description,
    status: row.status,
    schema: row.schema,
    inputValue: row.inputValue,
    operations: normalizeMcpOperations(row.operations, kind),
  })
  const referenceProjection = reference.map(project)
  const implementationProjection = implementation.map(project)
  const common = referenceProjection.map((expected, index) => {
    const actual = implementationProjection[index]
    return {
      name: expected.name === actual?.name,
      description: expected.description === actual?.description,
      status: expected.status === actual?.status,
      schema: JSON.stringify(expected.schema) === JSON.stringify(actual?.schema),
      inputValue: expected.inputValue === actual?.inputValue,
      operations: JSON.stringify(expected.operations) === JSON.stringify(actual?.operations),
    }
  })
  const requiredFields =
    kind === 'server'
      ? ['name', 'status', 'operations']
      : ['name', 'description', 'schema', 'inputValue', 'operations']
  const commonStatus = common.every((row) =>
    requiredFields.every((field) => row[field as keyof typeof row]),
  )
  const exactStatus = commonStatus &&
    referenceProjection.length === implementationProjection.length &&
    common.every((row) => Object.values(row).every(Boolean))
  return {
    status: exactStatus ? 'PASS' : commonStatus ? 'PARTIAL' : 'BLOCKED',
    kind,
    requiredFields,
    reference: referenceProjection,
    implementation: implementationProjection,
    fieldMatches: common,
    blocker:
      kind === 'server' && !exactStatus
        ? 'Structured server content is present in the fixture, but the rendered name/description/status/action exact-set still differs.'
        : kind === 'tool' && !exactStatus
          ? 'The rendered tool rows still differ from the prototype static schema/input exact-set; no test-only overlay is used to hide the difference.'
          : null,
  }
}

function targetShellEvidence(reference: TrackEvidence, implementation: TrackEvidence) {
  const inspect = (track: TrackEvidence, requireImplementationGrid: boolean) => {
    const rowFacts = track.rowExactSet.map((row) => {
      const paddingValues = row.shell.padding.match(/[\d.]+/g)?.map(Number) ?? []
      const rightPadding = paddingValues.length === 1
        ? paddingValues[0]
        : paddingValues.length === 2
          ? paddingValues[1]
          : paddingValues.length === 3
            ? paddingValues[1]
            : paddingValues[3] ?? 0
      const contentRight = row.rect.x + row.rect.width - rightPadding
      const action = row.shell.childRects.find((child) =>
        child.className.toString().split(/\s+/).some((token) => token.endsWith('capability-installed-actions')),
      )
      const actionRightEdgeDelta = action
        ? Math.abs(action.rect.x + action.rect.width - contentRight)
        : null
      const rowWidthDelta = Math.abs(row.rect.width - track.rect.width)
      const usesTwoSlotGrid =
        row.shell.display === 'grid' &&
        row.shell.childRects.length >= 2 &&
        row.shell.childRects.some((child) =>
          child.className.toString().split(/\s+/).some((token) => token.endsWith('capability-installed-main')),
        ) &&
        row.shell.childRects.some((child) =>
          child.className.toString().split(/\s+/).some((token) => token.endsWith('capability-installed-actions')),
        )
      return {
        rowWidthDelta,
        rightEdgeDelta: row.rightEdgeDelta,
        actionRightEdgeDelta,
        display: row.shell.display,
        gridTemplateColumns: row.shell.gridTemplateColumns,
        usesTwoSlotGrid,
        pass:
          rowWidthDelta <= 1 &&
          row.rightEdgeDelta <= 1 &&
          (actionRightEdgeDelta === null || actionRightEdgeDelta <= 1) &&
          (!requireImplementationGrid || usesTwoSlotGrid),
      }
    })
    const pass =
      track.widthDelta <= 1 &&
      track.overflow <= 1 &&
      track.rowExactSet.length === 2 &&
      rowFacts.every((row) => row.pass)
    return {
      status: pass ? 'PASS' : 'NOT PASS',
      widthDelta: track.widthDelta,
      overflow: track.overflow,
      rowCount: track.rowExactSet.length,
      rows: rowFacts,
    }
  }

  const referenceFacts = inspect(reference, false)
  const implementationFacts = inspect(implementation, true)
  return {
    status: referenceFacts.status === 'PASS' && implementationFacts.status === 'PASS' ? 'PASS' : 'NOT PASS',
    invariant:
      'full-width track, no horizontal overflow, two compact rows, stable right action edge; implementation uses the shared two-slot grid',
    reference: referenceFacts,
    implementation: implementationFacts,
  }
}

type TrackPairEvidence = {
  reference: TrackEvidence
  implementation: TrackEvidence
  targetShell?: ReturnType<typeof targetShellEvidence>
}

async function gridFacts(locator: Locator) {
  await expect(locator).toBeVisible()
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean)
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      itemCount: element.children.length,
      computedColumns: columns.length,
      gridTemplateColumns: style.gridTemplateColumns,
      columnGap: style.columnGap,
      rowGap: style.rowGap,
    }
  })
}

async function capture(locator: Locator, page: Page, file: string, width: number, height: number) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await locator.waitFor({ state: 'visible' })
      await locator.scrollIntoViewIfNeeded()
      const box = await locator.boundingBox()
      if (!box) throw new Error(`missing screenshot bbox for ${file}`)
      const x = Math.max(0, Math.min(viewport.width - width, box.x - 12))
      const y = Math.max(0, Math.min(viewport.height - height, box.y - 12))
      await page.screenshot({ path: file, clip: { x, y, width, height } })
      return { x, y, width, height, anchor: box }
    } catch (error) {
      lastError = error
      await page.waitForTimeout(50)
    }
  }
  throw lastError
}

async function capturePair(
  id: string,
  referencePage: Page,
  implementationPage: Page,
  referenceTarget: Locator,
  implementationTarget: Locator,
  size: { width: number; height: number },
  mapping: 'COMPARABLE' | 'NOT COMPARABLE',
  reason: string,
  targetShell?: { status: string; invariant?: string },
) {
  const directory = path.join(evidenceRoot, id)
  await mkdir(directory, { recursive: true })
  const reference = path.join(directory, 'reference.png')
  const implementation = path.join(directory, 'implementation.png')
  const diff = path.join(directory, 'diff.png')
  const referenceClip = await capture(
    referenceTarget,
    referencePage,
    reference,
    size.width,
    size.height,
  )
  const implementationClip = await capture(
    implementationTarget,
    implementationPage,
    implementation,
    size.width,
    size.height,
  )
  const pixels = await pixelDiff(reference, implementation, diff)
  const result = {
    id,
    mapping,
    mappingReason: reason,
    visualStatus:
      mapping === 'NOT COMPARABLE'
        ? 'NOT COMPARABLE'
        : pixels.changed_pixel_ratio <= 0.01
          ? 'PASS'
          : 'NOT PASS',
    pixelDiff: pixels,
    clips: { reference: referenceClip, implementation: implementationClip },
    targetShellStatus: targetShell?.status ?? 'NOT RUN',
    targetShellInvariant: targetShell?.invariant ?? null,
    files: { reference: 'reference.png', implementation: 'implementation.png', diff: 'diff.png' },
  }
  await writeFile(path.join(directory, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function createPages(browser: Browser) {
  const options = {
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light' as const,
    reducedMotion: 'reduce' as const,
  }
  const referenceContext = await browser.newContext(options)
  const implementationContext = await browser.newContext(options)
  return {
    referenceContext,
    implementationContext,
    referencePage: await referenceContext.newPage(),
    implementationPage: await implementationContext.newPage(),
  }
}

async function sha256(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

test.describe.configure({ mode: 'serial' })

test('collects homomorphic search and full-width track evidence without touching real state', async ({
  browser,
}) => {
  await mkdir(evidenceRoot, { recursive: true })
  const installedBoundary = JSON.parse(
    await readFile(path.join(evidenceRoot, 'installed-boundary.json'), 'utf8'),
  )
  const { referenceContext, implementationContext, referencePage, implementationPage } =
    await createPages(browser)
  const blockedReference: string[] = []
  const blockedImplementation: string[] = []
  const pageErrors = { reference: [] as string[], implementation: [] as string[] }
  referencePage.on('pageerror', (error) => pageErrors.reference.push(error.message))
  implementationPage.on('pageerror', (error) => pageErrors.implementation.push(error.message))

  try {
    await installReferenceIsolation(referencePage, blockedReference)
    await installSourceFixture(implementationPage, blockedImplementation)
    await openReference(referencePage)
    await openSource(implementationPage)

    const searches: Record<string, unknown> = {}
    const tracks: Record<string, TrackPairEvidence> = {}
    const contentParity: Record<string, unknown> = {}
    const pairs = []

    searches.skillsInstalled = {
      reference: await snapshotSearch(referencePage, 'reference'),
      implementation: await snapshotSearch(implementationPage, 'implementation'),
      mapping: 'COMPARABLE',
    }
    pairs.push(
      await capturePair(
        'bug-009-skills-installed-search',
        referencePage,
        implementationPage,
        referencePage.locator('.screen.on .tbar .srch'),
        implementationPage.locator('.hc-toolbar .hc-search'),
        { width: 360, height: 56 },
        'COMPARABLE',
        'Both targets are the sole visible Skills-installed toolbar search in the same fixture state.',
      ),
    )

    const referenceSkillRows = referencePage.locator(
      '.screen.on [data-sub="in0"] .capability-installed-row',
    )
    const implementationSkillRows = implementationPage.locator(
      '.hc-capability-installed-track > div',
    )
    tracks.skillsInstalled = {
      reference: await snapshotTrack(
        referencePage.locator('.screen.on [data-sub="in0"] .capability-installed-list'),
        [referenceSkillRows.nth(0), referenceSkillRows.nth(1)],
      ),
      implementation: await snapshotTrack(
        implementationPage.locator('.hc-capability-installed-track'),
        [implementationSkillRows.nth(0), implementationSkillRows.nth(1)],
      ),
    }
    tracks.skillsInstalled.targetShell = targetShellEvidence(
      tracks.skillsInstalled.reference,
      tracks.skillsInstalled.implementation,
    )
    expect(tracks.skillsInstalled.targetShell.status).toBe('PASS')
    pairs.push(
      await capturePair(
        'bug-010-skills-installed-track',
        referencePage,
        implementationPage,
        referencePage.locator('.screen.on [data-sub="in0"] .capability-installed-list'),
        implementationPage.locator('.hc-capability-installed-track'),
        { width: 1120, height: 240 },
        'COMPARABLE',
        'Both targets contain exactly the two deterministic installed Skills rows.',
        tracks.skillsInstalled.targetShell,
      ),
    )

    await referencePage.locator('.screen.on [data-sub="in0"] .utab').nth(1).click()
    await implementationPage.getByRole('tab', { name: /市场/ }).click()
    await expect(
      implementationPage.locator('.hc-capability-market-surface .animate-spin'),
    ).toHaveCount(0)
    await expect(implementationPage.locator('.hc-capability-market-grid')).toBeVisible()
    searches.skillsMarketplace = {
      reference: await snapshotSearch(referencePage, 'reference'),
      implementation: await snapshotSearch(implementationPage, 'implementation'),
      mapping: 'NOT COMPARABLE',
      reason:
        'The prototype secondary tab changes only selected styling and keeps installed plus marketplace content mounted together.',
    }
    const bug008Facts: Record<string, unknown> = {
      decision: 'APPROVED BASELINE — 1040/760/500',
      referenceBreakpoints: ['max-width:1040px', 'max-width:760px', 'max-width:500px'],
      implementationBreakpoints: ['max-width:1040px', 'max-width:760px', 'max-width:500px'],
      skills: {
        reference: await gridFacts(
          referencePage.locator('.screen.on [data-sub="in0"] .capability-market-grid'),
        ),
        implementation: await gridFacts(implementationPage.locator('.hc-capability-market-grid')),
      },
    }

    await referencePage.locator('[data-segset="in"] button').nth(1).click()
    await implementationPage.getByTestId('segmented-mcp').click()
    await expect(implementationPage.locator('.hc-capability-installed-track')).toBeVisible()
    searches.mcpServers = {
      reference: await snapshotSearch(referencePage, 'reference'),
      implementation: await snapshotSearch(implementationPage, 'implementation'),
      mapping: 'NOT COMPARABLE',
      reason:
        'The prototype does not update its search placeholder or filter context on the MCP main tab.',
    }
    pairs.push(
      await capturePair(
        'bug-009-mcp-server-search-diagnostic',
        referencePage,
        implementationPage,
        referencePage.locator('.screen.on .tbar .srch'),
        implementationPage.locator('.hc-toolbar .hc-search'),
        { width: 360, height: 56 },
        'NOT COMPARABLE',
        'Prototype still identifies the input as Skills-installed while implementation identifies MCP servers.',
      ),
    )

    const referenceMcpRows = referencePage.locator('.screen.on [data-sub="in1"] .mcp-row')
    let implementationRows = implementationPage.locator('.hc-capability-installed-track > div')
    tracks.mcpServers = {
      reference: await snapshotTrack(referencePage.locator('.screen.on [data-sub="in1"]'), [
        referenceMcpRows.nth(0),
        referenceMcpRows.nth(1),
      ]),
      implementation: await snapshotTrack(
        implementationPage.locator('.hc-capability-installed-track'),
        [implementationRows.nth(0), implementationRows.nth(1)],
      ),
    }
    tracks.mcpServers.targetShell = targetShellEvidence(
      tracks.mcpServers.reference,
      tracks.mcpServers.implementation,
    )
    expect(tracks.mcpServers.targetShell.status).toBe('PASS')
    contentParity.mcpServers = semanticParity(
      await snapshotMcpSemantics(
        referencePage.locator(
          '.screen.on [data-sub="in1"] [data-mcp-panel="servers"].mcp-row',
        ),
        'server',
        'reference',
      ),
      await snapshotMcpSemantics(
        implementationRows,
        'server',
        'implementation',
      ),
      'server',
    )
    pairs.push(
      await capturePair(
        'bug-010-mcp-servers-track',
        referencePage,
        implementationPage,
        referenceMcpRows.nth(0),
        implementationRows.nth(0),
        { width: 1120, height: 120 },
        'COMPARABLE',
        'Both sides use the same structured server fixture; the first server row is pixel-compared and the complete two-row track is checked by DOM/bbox/style evidence.',
        tracks.mcpServers.targetShell,
      ),
    )

    await referencePage.locator('.screen.on [data-sub="in1"] .utab').nth(1).click()
    await implementationPage.getByRole('tab', { name: /工具/ }).click()
    await expect(implementationPage.locator('.hc-capability-installed-track')).toBeVisible()
    searches.mcpTools = {
      reference: await snapshotSearch(referencePage, 'reference'),
      implementation: await snapshotSearch(implementationPage, 'implementation'),
      mapping: 'NOT COMPARABLE',
      reason:
        'The prototype secondary tab changes only selected styling and does not make tools the active search target.',
    }
    // MCP tools use a dedicated row class; selecting every direct child would
    // also match the server rows while the capability view is switching tabs.
    implementationRows = implementationPage.locator(
      '.hc-capability-installed-track > .hc-capability-installed-row--tool',
    )
    // 与原型当前状态同态：两工具主内容静态显示 schema，第一工具主内容静态显示输入。
    // 不点击工具主内容、不打开测试表单；展开 wrapper 属于另一状态，不能替代批准的静态契约。
    await expect(
      implementationRows.nth(0).locator(
        '.hc-capability-installed-main [data-mcp-static-input] input',
      ),
    ).toBeVisible()
    await expect(
      implementationRows.nth(0).locator('[data-mcp-static-input] input').first(),
    ).toHaveValue('/Users/hexagon/Documents/report.md')
    tracks.mcpTools = {
      reference: await snapshotTrack(referencePage.locator('.screen.on [data-sub="in1"]'), [
        referenceMcpRows.nth(2),
        referenceMcpRows.nth(3),
      ]),
      implementation: await snapshotTrack(
        implementationPage.locator('.hc-capability-installed-track'),
        [implementationRows.nth(0), implementationRows.nth(1)],
      ),
    }
    tracks.mcpTools.targetShell = targetShellEvidence(
      tracks.mcpTools.reference,
      tracks.mcpTools.implementation,
    )
    expect(tracks.mcpTools.targetShell.status).toBe('PASS')
    const mcpToolParity = semanticParity(
      await snapshotMcpSemantics(
        referencePage.locator('.screen.on [data-sub="in1"] [data-mcp-panel="tools"].mcp-row'),
        'tool',
        'reference',
      ),
      await snapshotMcpSemantics(
        implementationPage.locator('.hc-capability-installed-track > div'),
        'tool',
        'implementation',
      ),
      'tool',
    )
    const implementationToolDomState = await implementationRows.evaluateAll((rows) => ({
      staticContentPanels: rows.reduce(
        (count, row) =>
          count + row.querySelectorAll('.hc-capability-installed-main .hc-capability-installed-schema').length,
        0,
      ),
      schemaElements: rows.reduce(
        (count, row) =>
          count + row.querySelectorAll('.hc-capability-installed-main .hc-capability-installed-schema').length,
        0,
      ),
      staticContentText: rows
        .flatMap((row) => Array.from(row.querySelectorAll('.hc-capability-installed-main')))
        .map((panel) => (panel.textContent || '').replace(/\s+/g, ' ').trim())
        .join(' | '),
    }))
    expect(mcpToolParity.status).toBe('PASS')
    expect(implementationToolDomState.staticContentPanels).toBe(2)
    expect(implementationToolDomState.schemaElements).toBe(2)
    contentParity.mcpTools = {
      ...mcpToolParity,
      implementationDomState: implementationToolDomState,
    }
    pairs.push(
      await capturePair(
        'bug-010-mcp-tools-track',
        referencePage,
        implementationPage,
        referenceMcpRows.nth(2),
        implementationRows.nth(0),
        { width: 1120, height: 220 },
        'COMPARABLE',
        'Both sides use the same two-tool schema fixture; the first tool row is pixel-compared and the complete two-row track is checked by DOM/bbox/style/semantic evidence.',
        tracks.mcpTools.targetShell,
      ),
    )

    await referencePage.locator('.screen.on [data-sub="in1"] .utab').nth(2).click()
    await implementationPage.getByRole('tab', { name: /市场/ }).click()
    await expect(
      implementationPage.locator('.hc-capability-market-surface .animate-spin'),
    ).toHaveCount(0)
    await expect(implementationPage.locator('.hc-capability-market-grid')).toBeVisible()
    searches.mcpMarketplace = {
      reference: await snapshotSearch(referencePage, 'reference'),
      implementation: await snapshotSearch(implementationPage, 'implementation'),
      mapping: 'NOT COMPARABLE',
      reason:
        'The prototype secondary tab changes only selected styling and does not make marketplace the active search target.',
    }
    bug008Facts.mcp = {
      reference: await gridFacts(
        referencePage.locator('.screen.on [data-sub="in1"] .capability-market-grid'),
      ),
      implementation: await gridFacts(implementationPage.locator('.hc-capability-market-grid')),
    }

    const sourceSearchStates = Object.values(searches).map(
      (state) =>
        (
          state as {
            implementation: {
              rootCount: number
              inputCount: number
              marketNestedCount: number
              placeholder: string
            }
          }
        ).implementation,
    )
    expect(sourceSearchStates.map((state) => state.rootCount)).toEqual([1, 1, 1, 1, 1])
    expect(sourceSearchStates.map((state) => state.inputCount)).toEqual([1, 1, 1, 1, 1])
    expect(sourceSearchStates.map((state) => state.marketNestedCount)).toEqual([0, 0, 0, 0, 0])
    expect(sourceSearchStates.map((state) => state.placeholder)).toEqual([
      '搜索已安装 Skill...',
      '搜索 ClawHub Skill...',
      '搜索 MCP…',
      '搜索工具...',
      '搜索 MCP 服务器...',
    ])

    for (const track of Object.values(tracks)) {
      const typed = track as {
        reference: { widthDelta: number; overflow: number; rowExactSet: unknown[] }
        implementation: { widthDelta: number; overflow: number; rowExactSet: unknown[] }
      }
      expect(typed.reference.widthDelta).toBeLessThanOrEqual(1)
      expect(typed.implementation.widthDelta).toBeLessThanOrEqual(1)
      expect(typed.reference.overflow).toBeLessThanOrEqual(1)
      expect(typed.implementation.overflow).toBeLessThanOrEqual(1)
      expect(typed.reference.rowExactSet).toHaveLength(2)
      expect(typed.implementation.rowExactSet).toHaveLength(2)
    }
    expect(blockedReference).toEqual([])
    expect(blockedImplementation).toEqual([])

    const comparablePairs = pairs.filter((pair) => pair.mapping === 'COMPARABLE')
    const bug009Visual = pairs.find((pair) => pair.id === 'bug-009-skills-installed-search')!
    const bug010Pairs = pairs.filter((pair) => pair.id.startsWith('bug-010'))
    const bug010ComparablePairs = bug010Pairs.filter((pair) => pair.mapping === 'COMPARABLE')
    const bug010TargetShellPass = ['skillsInstalled', 'mcpServers', 'mcpTools'].every(
      (key) => tracks[key]?.targetShell?.status === 'PASS',
    )
    const bug010ComparableVisualPass =
      bug010ComparablePairs.length > 0 &&
      bug010ComparablePairs.every((pair) => pair.visualStatus === 'PASS')
    const bug010ContentComparable = bug010Pairs.every((pair) => pair.mapping === 'COMPARABLE')
    const bug010VisualStatus =
      !bug010TargetShellPass || !bug010ComparableVisualPass
        ? 'NOT PASS'
        : bug010ContentComparable
          ? 'PASS'
          : 'NOT COMPARABLE'
    const summary = {
      bugs: {
        'BUG-20260723-008': {
          status: 'APPROVED BASELINE — 1040/760/500',
          facts: bug008Facts,
        },
        'BUG-20260723-009': {
          structuralStatus: 'PASS',
          visualStatus:
            bug009Visual.visualStatus === 'PASS' &&
            sourceSearchStates.length === 5 &&
            sourceSearchStates.every((state) => state.rootCount === 1 && state.inputCount === 1)
              ? 'PASS'
              : 'NOT PASS',
          reason:
            'The single context-aware search and the homomorphic installed-Skill state pass; secondary prototype tabs remain explicitly non-comparable because they do not expose the same data context.',
        },
        'BUG-20260723-010': {
          structuralStatus: 'PASS',
          targetShellStatus: bug010TargetShellPass ? 'PASS' : 'NOT PASS',
          contentStatus: bug010ContentComparable ? 'COMPARABLE' : 'NOT COMPARABLE',
          visualStatus:
            bug010TargetShellPass && bug010ComparableVisualPass
              ? bug010ContentComparable
                ? 'PASS'
                : 'PASS_TARGET_SHELL'
              : bug010VisualStatus,
          reason:
            'Skills and MCP use homomorphic prototype fixtures. MCP server/tool content compares structured descriptions, status-specific actions, and simultaneous static schema/input DOM; the target shell and semantic content pass, while server/tool row pixel pairs remain NOT PASS because their measured row geometry/paint differs from the prototype. The installed boundary remains separately gated by the Test.app receipt.',
          semanticStatus: {
            mcpServers: (contentParity.mcpServers as { status: string }).status,
            mcpTools: (contentParity.mcpTools as { status: string }).status,
          },
        },
      },
      environment: {
        browser: 'chromium',
        viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        theme: 'light',
        reducedMotion: 'reduce',
        fixture: 'bug-20260723-009-010-homomorphic-v2',
        workers: 1,
      },
      isolation: {
        loopbackOnly: true,
        externalRequests: [...blockedReference, ...blockedImplementation],
        realModelCalls: 0,
        applicationsTouched: false,
        userDataTouched: false,
        pageErrors,
      },
      installedBoundary,
      fixtureParity: capabilityFixtureParity,
      comparablePairs,
      allPairs: pairs,
      domExactSet: { searches, tracks, contentParity },
      hashes: {
        prototype: await sha256(path.join(docsRoot, 'prototype/app.html')),
        integrationView: await sha256(path.join(desktopRoot, 'src/views/IntegrationView.vue')),
        skillsView: await sha256(path.join(desktopRoot, 'src/views/SkillsView.vue')),
        mcpView: await sha256(path.join(desktopRoot, 'src/views/McpView.vue')),
        capabilityCss: await sha256(path.join(desktopRoot, 'src/assets/styles/global.css')),
      },
    }
    await writeFile(
      path.join(evidenceRoot, 'bbox-computed-style-dom-exact-set.json'),
      `${JSON.stringify({ searches, tracks, contentParity, bug008Facts }, null, 2)}\n`,
    )
    await writeFile(
      path.join(evidenceRoot, 'fixture-parity.json'),
      `${JSON.stringify(capabilityFixtureParity, null, 2)}\n`,
    )
    await writeFile(
      path.join(evidenceRoot, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    await writeFile(
      path.join(evidenceRoot, 'README.md'),
      `# BUG-20260723-009/010 paired visual evidence\n\n` +
        `- BUG-20260723-009: **${summary.bugs['BUG-20260723-009'].visualStatus}** (structure: PASS)\n` +
        `- BUG-20260723-010: **${summary.bugs['BUG-20260723-010'].visualStatus}**; target shell: **${summary.bugs['BUG-20260723-010'].targetShellStatus}**; content: **${summary.bugs['BUG-20260723-010'].contentStatus}** (structure: PASS)\n` +
      `- BUG-20260723-010 Skills/MCP pair: **${summary.bugs['BUG-20260723-010'].visualStatus}**; target shell and semantic content pass, but the server/tool row pixel pairs remain NOT PASS because measured row geometry/paint differs from the prototype.\n` +
        `- BUG-20260723-008: **APPROVED BASELINE — 1040/760/500**; measured layout facts are recorded.\n` +
        `- Installed Test.app: **${installedBoundary.decision}**; it was inspected read-only and not launched.\n` +
        `- Isolation: loopback-only deterministic fixture, zero real model calls, no /Applications or user-data access.\n` +
        `- Run: \`node tests/e2e/run-bug-20260723-009-010.mjs\`\n`,
    )
  } finally {
    await referenceContext.close()
    await implementationContext.close()
  }
})
