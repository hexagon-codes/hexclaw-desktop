import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test.use({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
})

const OPENROUTER_PROVIDER = 'OpenRouter'
const SMALL_PROVIDER = '智谱 AI'
const NVIDIA_PROVIDER = 'Nvidia'
const LONG_MODEL_ID = 'nvidia/very-long-free-vision-code-model'
const LONG_MODEL_NAME = 'NVIDIA: Nemotron Ultra Long Free Vision Model for Layout Regression'
const CUSTOM_MODEL_ID = 'custom-parent-tutor-model'

const openRouterCatalog = [
  {
    id: LONG_MODEL_ID,
    name: LONG_MODEL_NAME,
    prompt_price: '0',
    completion_price: '0',
    input_modalities: ['text', 'image'],
    supports_tools: true,
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `openrouter/catalog-model-${index + 1}`,
    name: `OpenRouter Catalog Model ${index + 1}`,
    prompt_price: index === 0 ? '0' : '0.000001',
    completion_price: index === 0 ? '0' : '0.000002',
    input_modalities: ['text'],
    supports_tools: index % 2 === 0,
  })),
]

const smallCatalog = Array.from({ length: 4 }, (_, index) => ({
  id: `glm-small-${index + 1}`,
  name: `GLM Small ${index + 1}`,
  prompt_price: '0.000001',
  completion_price: '0.000002',
  input_modalities: ['text'],
  supports_tools: true,
}))

const providerHeaderOpenRouterModels = Array.from({ length: 7 }, (_, index) => ({
  id: `openrouter/header-layout-${index + 1}`,
  name: `OpenRouter Header Layout ${index + 1}`,
  prompt_price: '0.000001',
  completion_price: '0.000002',
  input_modalities: ['text'],
  supports_tools: false,
}))

const providerHeaderNvidiaModels = [
  {
    id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
    name: 'NVIDIA Llama 3.1 Nemotron Ultra 253B v1',
    prompt_price: '0.000001',
    completion_price: '0.000002',
    input_modalities: ['text'],
    supports_tools: false,
  },
]

const backendLlmConfig = {
  default: OPENROUTER_PROVIDER,
  providers: {
    [OPENROUTER_PROVIDER]: {
      provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
      api_key: '****test',
      base_url: 'https://openrouter.ai/api/v1',
      model: LONG_MODEL_ID,
      models: [LONG_MODEL_ID, CUSTOM_MODEL_ID],
      model_specs_mode: 'explicit',
      model_specs: [
        {
          id: LONG_MODEL_ID,
          display_name: LONG_MODEL_NAME,
          is_custom: false,
          capabilities: ['text', 'vision'],
        },
        {
          id: CUSTOM_MODEL_ID,
          display_name: '家长自定义辅导模型',
          is_custom: true,
          capabilities: ['text'],
        },
      ],
      compatible: 'openai',
      locality: 'cloud',
      enabled: true,
    },
    [SMALL_PROVIDER]: {
      provider_instance_id: 'pvd_v1_ffeeddccbbaa99887766554433221100',
      api_key: '****test',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-small-1',
      models: ['glm-small-1'],
      model_specs_mode: 'explicit',
      model_specs: [
        {
          id: 'glm-small-1',
          display_name: 'GLM Small 1',
          is_custom: false,
          capabilities: ['text'],
        },
      ],
      compatible: 'openai',
      locality: 'cloud',
      enabled: true,
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: false, similarity: 0.92, ttl: '24h', max_entries: 1000 },
}

const providerHeaderLayoutConfig = {
  default: OPENROUTER_PROVIDER,
  providers: {
    [OPENROUTER_PROVIDER]: {
      provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
      api_key: '****test',
      base_url: 'https://openrouter.ai/api/v1',
      model: providerHeaderOpenRouterModels[0]!.id,
      models: providerHeaderOpenRouterModels.map((model) => model.id),
      model_specs_mode: 'explicit',
      model_specs: providerHeaderOpenRouterModels.map((model) => ({
        id: model.id,
        display_name: model.name,
        is_custom: false,
        capabilities: ['text'],
      })),
      compatible: 'openai',
      locality: 'cloud',
      enabled: true,
      probe_receipt: {
        provider_instance_id: 'pvd_v1_00112233445566778899aabbccddeeff',
        outcome: 'passed',
        locality: 'cloud',
        latency_ms: 321,
        tested_at: '2026-08-06T19:33:00+08:00',
        message: '连接成功',
      },
    },
    [NVIDIA_PROVIDER]: {
      provider_instance_id: 'pvd_v1_ffeeddccbbaa99887766554433221100',
      api_key: '****test',
      base_url: 'https://integrate.api.nvidia.com/v1',
      model: providerHeaderNvidiaModels[0]!.id,
      models: providerHeaderNvidiaModels.map((model) => model.id),
      model_specs_mode: 'explicit',
      model_specs: providerHeaderNvidiaModels.map((model) => ({
        id: model.id,
        display_name: model.name,
        is_custom: false,
        capabilities: ['text'],
      })),
      compatible: 'openai',
      locality: 'cloud',
      enabled: true,
      probe_receipt: {
        provider_instance_id: 'pvd_v1_ffeeddccbbaa99887766554433221100',
        outcome: 'failed',
        locality: 'cloud',
        latency_ms: 15_000,
        tested_at: '2026-08-06T19:32:00+08:00',
        error_message:
          'openai complete request failed: Post "https://integrate.api.nvidia.com/v1/chat/completions": context deadline exceeded',
      },
    },
  },
  routing: { enabled: false, strategy: 'cost-aware' },
  cache: { enabled: false, similarity: 0.92, ttl: '24h', max_entries: 1000 },
}

const installedSkills = [
  {
    name: 'homework-checker',
    description: '拍题批改、OCR 护栏核对、分题并路由到对应学科辅导助手。',
    version: '1.5.0',
    author: 'hexclaw',
    tags: ['education'],
    triggers: [],
    enabled: true,
  },
  {
    name: 'k12-pedagogy',
    description: 'K12 各学科辅导的共享教学法基座。',
    version: '1.1.0',
    author: 'hexclaw',
    tags: ['education'],
    triggers: [],
    enabled: true,
  },
  {
    name: 'science-tutor',
    description: '事实、观察、实验与证据不足判断。',
    version: '1.0.0',
    author: 'hexclaw',
    tags: ['education'],
    triggers: [],
    enabled: true,
  },
]

const skillMarketplace = [
  {
    name: 'agent-browser',
    display_name: 'Agent Browser',
    description: '浏览器自动化场景下的安全步骤设计。',
    author: 'clawhub',
    version: '1.0.0',
    tags: ['browser', 'automation'],
    downloads: 87100,
    rating: 4.5,
    category: 'coding',
    type: 'skill',
  },
  {
    name: 'arxiv-reader',
    display_name: 'arXiv Reader',
    description: '研究论文阅读与摘要。',
    author: 'research-ai',
    version: '1.2.1',
    tags: ['research', 'paper'],
    downloads: 12800,
    rating: 4.5,
    category: 'research',
    type: 'skill',
  },
]

const mcpMarketplace = [
  {
    name: 'filesystem',
    display_name: 'Filesystem',
    description: '安全文件系统操作。',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'system',
    tags: ['files'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    name: 'github',
    display_name: 'GitHub',
    description: 'GitHub API 集成。',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'development',
    tags: ['git'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
]

const agents = [
  {
    name: 'k12-tutor-layout',
    display_name: '小明的辅导助手 · 五年级',
    description: '五年级下 · 各学科教材独立绑定 · 按年级边界讲解',
    model: '',
    provider: '',
    metadata: {
      scenario: 'k12-tutor',
      avatar: '🎓',
      'k12.child_name': '小明',
      'k12.grade_term': '五年级下',
    },
  },
  {
    name: 'translator-layout',
    display_name: '翻译官',
    description: '多语种互译 · 信达雅',
    model: '',
    provider: '',
  },
  {
    name: 'empty-layout',
    display_name: '超长名称智能体用于验证标题不会挤压右侧状态徽标',
    description: '同样很长的说明只允许在自己的信息槽内省略。',
    model: '',
    provider: '',
  },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installMocks(
  page: Page,
  fixture: {
    llmConfig?: unknown
    catalogsByProviderInstanceId?: Record<string, unknown>
  } = {},
) {
  const llmConfig = fixture.llmConfig ?? backendLlmConfig
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hc-theme', 'light')
  })

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'test' }),
  )

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path === '/api/v1/config/llm' && method === 'GET') {
      return json(route, llmConfig)
    }
    if (path === '/api/v1/config/llm' && method === 'PUT') {
      return json(route, { ok: true })
    }
    if (path === '/api/v1/config/llm/models' && method === 'POST') {
      const requestBody = route.request().postDataJSON() as {
        provider_instance_id?: string
      }
      const models =
        (requestBody.provider_instance_id
          ? fixture.catalogsByProviderInstanceId?.[requestBody.provider_instance_id]
          : undefined) ??
        (requestBody.provider_instance_id?.endsWith('1100') ? smallCatalog : openRouterCatalog)
      return json(route, { models })
    }
    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
        knowledge: { enabled: true },
        llm: llmConfig,
      })
    }
    if (path === '/api/v1/llm/capabilities') return json(route, [])
    if (path === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (path === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (path === '/api/v1/skills') {
      return json(route, {
        dir: '/Users/test/.hexclaw/skills',
        skills: installedSkills,
        total: installedSkills.length,
      })
    }
    if (path === '/api/v1/clawhub/search') {
      const items =
        requestUrl.searchParams.get('type') === 'mcp' ? mcpMarketplace : skillMarketplace
      return json(route, { skills: items, total: items.length })
    }
    if (path === '/api/v1/mcp/servers') {
      return json(route, { servers: ['filesystem', 'github', 'mysql'], total: 3 })
    }
    if (path === '/api/v1/mcp/status') {
      return json(route, {
        statuses: {
          filesystem: 'connected',
          github: 'connected',
          mysql: 'disconnected',
        },
        total: 3,
      })
    }
    if (path === '/api/v1/mcp/tools') {
      return json(route, {
        tools: [
          {
            name: 'read_text_file',
            description: 'Read the complete contents of a file as text.',
            input_schema: { type: 'object' },
          },
          {
            name: 'write_file',
            description: 'Create a file with new content.',
            input_schema: { type: 'object' },
          },
          {
            name: 'search_repositories',
            description: 'Search repositories.',
            input_schema: { type: 'object' },
          },
        ],
        total: 3,
      })
    }
    if (path === '/api/v1/agents/rules') {
      return json(route, {
        rules: [
          {
            id: 1,
            platform: 'dingtalk',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: 'k12-tutor-layout',
            priority: 0,
          },
          {
            id: 2,
            platform: 'slack',
            instance_id: '',
            user_id: '',
            chat_id: '',
            agent_name: 'translator-layout',
            priority: 0,
          },
        ],
        total: 2,
      })
    }
    if (path === '/api/v1/agents') {
      return json(route, {
        agents,
        total: agents.length,
        default: 'k12-tutor-layout',
      })
    }
    if (path === '/api/k12/mistakes') return json(route, { items: [{}, {}] })
    if (path === '/api/k12/review-queue') return json(route, { items: [{}] })
    if (path === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })

    return json(route, {})
  })
}

async function stableHover(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.evaluate((node) => {
    ;(node as HTMLElement).dataset.hoverEvidence = 'stable-node'
  })
  const before = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      transform: getComputedStyle(node).transform,
    }
  })
  await locator.hover()
  for (let index = 0; index < 5; index += 1) {
    await locator.page().waitForTimeout(80)
    await expect(locator).toHaveAttribute('data-hover-evidence', 'stable-node')
    expect(
      await locator.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          transform: getComputedStyle(node).transform,
        }
      }),
    ).toEqual(before)
    expect(await locator.evaluate((node) => node.matches(':hover'))).toBe(true)
  }
}

test.describe('Settings / Agents / Capability current-source contracts', () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page)
  })

  test('provider catalogs keep the 10/11 threshold and long model labels remain unsqueezed', async ({
    page,
  }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })

    const openRouterCard = page
      .locator('.hc-provider__card')
      .filter({ has: page.locator('.hc-provider__card-name', { hasText: OPENROUTER_PROVIDER }) })
    await expect(openRouterCard).toBeVisible({ timeout: 20_000 })
    await openRouterCard.locator('.hc-provider__card-head').click()

    const manageModels = openRouterCard.locator('.hc-model-chip--manage')
    await expect(manageModels).toBeVisible({ timeout: 20_000 })
    await expect(openRouterCard.locator('.hc-model-enabled-summary')).toContainText('2 / 11')

    const longModel = openRouterCard
      .locator('button.hc-model-chip')
      .filter({ has: page.locator('.hc-model-chip__name', { hasText: LONG_MODEL_NAME }) })
    await expect(longModel).toBeVisible()
    await expect(longModel.locator('.hc-model-chip__free-label')).toHaveText('免费')
    await expect(longModel.locator('.hc-model-chip__cap')).toHaveCount(2)

    const longModelGeometry = await longModel.evaluate((node) => {
      const chip = node.getBoundingClientRect()
      const name = node.querySelector('.hc-model-chip__name') as HTMLElement
      const nameRect = name.getBoundingClientRect()
      const badges = Array.from(
        node.querySelectorAll('.hc-model-chip__free-label, .hc-model-chip__cap'),
      ) as HTMLElement[]
      return {
        chipOverflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
        name: {
          width: nameRect.width,
          minWidth: getComputedStyle(name).minWidth,
          overflow: getComputedStyle(name).overflow,
          textOverflow: getComputedStyle(name).textOverflow,
          whiteSpace: getComputedStyle(name).whiteSpace,
        },
        badges: badges.map((badge) => {
          const rect = badge.getBoundingClientRect()
          const style = getComputedStyle(badge)
          return {
            flexShrink: style.flexShrink,
            whiteSpace: style.whiteSpace,
            width: rect.width,
            insideChip: rect.left >= chip.left - 0.5 && rect.right <= chip.right + 0.5,
            afterName: rect.left >= nameRect.left - 0.5,
          }
        }),
      }
    })
    expect(longModelGeometry.chipOverflow).toBeLessThanOrEqual(1)
    expect(longModelGeometry.name).toMatchObject({
      minWidth: '0px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    expect(longModelGeometry.name.width).toBeGreaterThan(24)
    for (const badge of longModelGeometry.badges) {
      expect(badge.flexShrink).toBe('0')
      expect(badge.whiteSpace).toBe('nowrap')
      expect(badge.width).toBeGreaterThan(0)
      expect(badge.insideChip).toBe(true)
      expect(badge.afterName).toBe(true)
    }

    const customRemove = openRouterCard.locator('.hc-model-chip--custom .hc-model-chip__remove')
    await expect(customRemove).toHaveCount(1)
    await openRouterCard.locator('.hc-model-chip--custom').hover()
    await expect(customRemove).toBeVisible()

    await openRouterCard.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-settings-model-labels-runtime.png',
    })

    await manageModels.click()
    const manager = page.getByRole('dialog', { name: '管理模型' })
    await expect(manager).toBeVisible()
    await expect(manager).toContainText('11')
    await page.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-settings-model-manager-runtime.png',
      fullPage: true,
    })
    await page.getByTestId('model-manager-cancel').click()

    const smallCard = page
      .locator('.hc-provider__card')
      .filter({ has: page.locator('.hc-provider__card-name', { hasText: SMALL_PROVIDER }) })
    await expect(smallCard.locator('.hc-provider__model-count')).toContainText('4', {
      timeout: 20_000,
    })
    await smallCard.locator('.hc-provider__card-head').click()
    await expect(smallCard.locator('.hc-model-chip--manage')).toHaveCount(0)
    await expect(
      smallCard.locator('.hc-model-chips > .hc-model-chip:not(.hc-model-chip--add)'),
    ).toHaveCount(4)
  })

  test('agent cards keep equal three-slot rows and never expose the K12 dingtalk binding', async ({
    page,
  }) => {
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })

    const cards = page.locator('.hc-cxcard--dedicated')
    await expect(cards).toHaveCount(3)
    const k12Card = cards.filter({ hasText: '小明的辅导助手' })
    const translatorCard = cards.filter({ hasText: '翻译官' })
    await expect(k12Card).not.toContainText('dingtalk')
    await expect(translatorCard).toContainText('slack')
    await expect(cards.nth(2).locator('.hc-agent-card__facts')).toBeEmpty()

    const geometry = await cards.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect()
        const footer = node.querySelector('.hc-agent-card__footer')!.getBoundingClientRect()
        return {
          y: rect.y,
          height: rect.height,
          footerY: footer.y,
          slots: [
            node.querySelector('.hc-agent-card__header') !== null,
            node.querySelector('.hc-agent-card__facts') !== null,
            node.querySelector('.hc-agent-card__footer') !== null,
          ],
        }
      }),
    )
    expect(Math.abs(geometry[0]!.y - geometry[1]!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry[0]!.height - geometry[1]!.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry[0]!.footerY - geometry[1]!.footerY)).toBeLessThanOrEqual(1)
    expect(geometry.every((card) => card.height >= 146)).toBe(true)
    expect(geometry.every((card) => card.slots.every(Boolean))).toBe(true)

    await page.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-agents-card-layout-runtime.png',
      fullPage: true,
    })
  })

  test('installed Skills and MCP share a full-width compact track, one search, and stable hover', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/integration', { waitUntil: 'domcontentloaded' })

    const toolbarSearch = page.locator('.hc-toolbar .hc-search__input')
    await expect(toolbarSearch).toHaveCount(1)
    await expect(page.locator('.hc-search')).toHaveCount(1)
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 Skill/)

    const skillTrack = page.locator('.hc-capability-installed-track')
    await expect(skillTrack).toBeVisible()
    const skillTrackGeometry = await skillTrack.evaluate((track) => {
      const parent = track.parentElement!
      const trackRect = track.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      const parentContentWidth =
        parentRect.width -
        Number.parseFloat(parentStyle.paddingLeft || '0') -
        Number.parseFloat(parentStyle.paddingRight || '0')
      const rows = Array.from(track.children).slice(1) as HTMLElement[]
      return {
        widthDelta: Math.abs(trackRect.width - parentContentWidth),
        overflow: (track as HTMLElement).scrollWidth - (track as HTMLElement).clientWidth,
        maxWidth: getComputedStyle(track).maxWidth,
        rowRightEdges: rows.map((row) =>
          Math.abs(row.getBoundingClientRect().right - trackRect.right),
        ),
      }
    })
    expect(skillTrackGeometry.widthDelta).toBeLessThanOrEqual(1)
    expect(skillTrackGeometry.overflow).toBeLessThanOrEqual(1)
    expect(skillTrackGeometry.maxWidth).toBe('none')
    expect(skillTrackGeometry.rowRightEdges.every((delta) => delta <= 1)).toBe(true)
    await page.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-skills-installed-runtime.png',
      fullPage: true,
    })

    const splitButton = page.locator('.hc-split-btn')
    await stableHover(splitButton)
    await page.getByRole('tab', { name: /市场/ }).click()
    await expect(page.locator('.hc-search')).toHaveCount(1)
    await expect(page.locator('.hc-capability-market-surface .hc-search')).toHaveCount(0)
    await stableHover(page.getByRole('button', { name: '安装', exact: true }).first())

    await page.getByTestId('segmented-mcp').click()
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 MCP/)
    await expect(page.locator('.hc-search')).toHaveCount(1)
    const serverTrack = page.locator('.hc-capability-installed-track')
    await expect(serverTrack).toBeVisible()
    const serverTrackGeometry = await serverTrack.evaluate((track) => {
      const parent = track.parentElement!
      const trackRect = track.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      const parentContentWidth =
        parentRect.width -
        Number.parseFloat(parentStyle.paddingLeft || '0') -
        Number.parseFloat(parentStyle.paddingRight || '0')
      const rows = Array.from(track.children) as HTMLElement[]
      return {
        widthDelta: Math.abs(trackRect.width - parentContentWidth),
        overflow: (track as HTMLElement).scrollWidth - (track as HTMLElement).clientWidth,
        rowRightEdges: rows.map((row) =>
          Math.abs(row.getBoundingClientRect().right - trackRect.right),
        ),
        rowHeights: rows.map((row) => row.getBoundingClientRect().height),
      }
    })
    expect(serverTrackGeometry.widthDelta).toBeLessThanOrEqual(1)
    expect(serverTrackGeometry.overflow).toBeLessThanOrEqual(1)
    expect(serverTrackGeometry.rowRightEdges.every((delta) => delta <= 1)).toBe(true)
    expect(serverTrackGeometry.rowHeights.every((height) => height < 80)).toBe(true)
    await page.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-mcp-servers-runtime.png',
      fullPage: true,
    })

    await page.getByRole('tab', { name: /工具/ }).click()
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索工具/)
    await expect(page.locator('.hc-search')).toHaveCount(1)
    const toolTrack = page.locator('.hc-capability-installed-track')
    await expect(toolTrack).toBeVisible()
    const toolTrackGeometry = await toolTrack.evaluate((track) => {
      const parent = track.parentElement!
      const parentRect = parent.getBoundingClientRect()
      const parentStyle = getComputedStyle(parent)
      const parentContentWidth =
        parentRect.width -
        Number.parseFloat(parentStyle.paddingLeft || '0') -
        Number.parseFloat(parentStyle.paddingRight || '0')
      const trackRect = track.getBoundingClientRect()
      const rows = Array.from(track.children) as HTMLElement[]
      return {
        widthDelta: Math.abs(trackRect.width - parentContentWidth),
        overflow: (track as HTMLElement).scrollWidth - (track as HTMLElement).clientWidth,
        rowHeights: rows.map((row) => row.getBoundingClientRect().height),
      }
    })
    expect(toolTrackGeometry.widthDelta).toBeLessThanOrEqual(1)
    expect(toolTrackGeometry.overflow).toBeLessThanOrEqual(1)
    expect(toolTrackGeometry.rowHeights.every((height) => height < 96)).toBe(true)
    await page.screenshot({
      path: 'tests/e2e/screenshots/current-source/bug-20260723-mcp-tools-runtime.png',
      fullPage: true,
    })
  })
})

test.describe('BUG-20260723-021 Provider card-header layout', () => {
  test.use({
    viewport: { width: 1226, height: 1548 },
    deviceScaleFactor: 1,
  })

  test.beforeEach(async ({ page }) => {
    await installMocks(page, {
      llmConfig: providerHeaderLayoutConfig,
      catalogsByProviderInstanceId: {
        pvd_v1_00112233445566778899aabbccddeeff: providerHeaderOpenRouterModels,
        pvd_v1_ffeeddccbbaa99887766554433221100: providerHeaderNvidiaModels,
      },
    })
  })

  test('keeps verified OpenRouter and failed Nvidia header facts horizontally readable', async ({
    page,
  }, testInfo) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    const layoutEvidence: Array<Record<string, unknown>> = []

    const providers = [
      { name: OPENROUTER_PROVIDER, expectedModels: '7', expectsFailureDetail: false },
      { name: NVIDIA_PROVIDER, expectedModels: '1', expectsFailureDetail: true },
    ]

    for (const provider of providers) {
      const card = page
        .locator('.hc-provider__card')
        .filter({ has: page.locator('.hc-provider__card-name', { hasText: provider.name }) })
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card.locator('.hc-provider__model-count')).toContainText(provider.expectedModels)

      const geometry = await card.evaluate((node) => {
        const header = node.querySelector<HTMLElement>('.hc-provider__card-head')!
        const getBox = (selector: string) => {
          const element = node.querySelector<HTMLElement>(selector)!
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            display: style.display,
            minWidth: style.minWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            flexShrink: style.flexShrink,
            flexWrap: style.flexWrap,
            justifyContent: style.justifyContent,
          }
        }
        const headerRect = header.getBoundingClientRect()
        const cardRect = node.getBoundingClientRect()
        const headerStyle = getComputedStyle(header)
        return {
          cardOverflow: node.scrollWidth - node.clientWidth,
          header: {
            left: headerRect.left,
            right: headerRect.right,
            top: headerRect.top,
            bottom: headerRect.bottom,
            width: headerRect.width,
            height: headerRect.height,
            display: headerStyle.display,
            gridTemplateColumns: headerStyle.gridTemplateColumns,
            alignItems: headerStyle.alignItems,
          },
          info: getBox('.hc-provider__card-info'),
          actions: getBox('.hc-provider__card-actions'),
          modelCount: getBox('.hc-provider__model-count'),
          connectionStatus: getBox('.hc-provider__connection-status'),
          deleteButton: getBox('.hc-provider__delete-btn'),
          failureDetail: node.querySelector<HTMLElement>('.hc-provider__connection-detail')
            ? getBox('.hc-provider__connection-detail')
            : undefined,
          card: { left: cardRect.left, right: cardRect.right },
        }
      })

      expect(geometry.cardOverflow).toBeLessThanOrEqual(1)
      expect(geometry.header.height).toBeLessThanOrEqual(100)
      expect(geometry.actions.height).toBeLessThanOrEqual(32)
      expect(geometry.modelCount.height).toBeLessThanOrEqual(24)
      expect(geometry.deleteButton.height).toBeLessThanOrEqual(32)
      expect(geometry.modelCount.whiteSpace).toBe('nowrap')
      expect(geometry.deleteButton.whiteSpace).toBe('nowrap')
      if (geometry.header.width < 960) {
        expect(geometry.actions.top).toBeGreaterThanOrEqual(geometry.info.bottom - 1)
      } else {
        expect(Math.abs(geometry.actions.top - geometry.info.top)).toBeLessThanOrEqual(1)
      }
      for (const box of [
        geometry.info,
        geometry.actions,
        geometry.modelCount,
        geometry.connectionStatus,
        geometry.deleteButton,
      ]) {
        expect(box.left).toBeGreaterThanOrEqual(geometry.header.left - 1)
        expect(box.right).toBeLessThanOrEqual(geometry.header.right + 1)
      }
      if (provider.expectsFailureDetail) {
        expect(geometry.failureDetail).toBeDefined()
        expect(geometry.failureDetail!.top).toBeGreaterThanOrEqual(geometry.header.bottom - 1)
        expect(geometry.failureDetail!.left).toBeGreaterThanOrEqual(geometry.card.left - 1)
        expect(geometry.failureDetail!.right).toBeLessThanOrEqual(geometry.card.right + 1)
      }
      layoutEvidence.push({ provider: provider.name, narrowLayout: geometry })
    }

    const section = page.locator('.hc-settings__section')
    await section.evaluate((node) => {
      const element = node as HTMLElement
      element.style.maxWidth = 'none'
      element.style.width = '968px'
    })
    const wideOpenRouterCard = page
      .locator('.hc-provider__card')
      .filter({ has: page.locator('.hc-provider__card-name', { hasText: OPENROUTER_PROVIDER }) })
    const wideGeometry = await wideOpenRouterCard.evaluate((node) => {
      const header = node.querySelector<HTMLElement>('.hc-provider__card-head')!
      const info = node.querySelector<HTMLElement>('.hc-provider__card-info')!
      const actions = node.querySelector<HTMLElement>('.hc-provider__card-actions')!
      const modelCount = node.querySelector<HTMLElement>('.hc-provider__model-count')!
      const deleteButton = node.querySelector<HTMLElement>('.hc-provider__delete-btn')!
      const card = node.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      const infoRect = info.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      const headerStyle = getComputedStyle(header)
      const actionsStyle = getComputedStyle(actions)
      return {
        cardOverflow: node.scrollWidth - node.clientWidth,
        headerWidth: headerRect.width,
        infoCenter: (infoRect.top + infoRect.bottom) / 2,
        actionsCenter: (actionsRect.top + actionsRect.bottom) / 2,
        modelCountHeight: modelCount.getBoundingClientRect().height,
        deleteButtonHeight: deleteButton.getBoundingClientRect().height,
        actionsRight: actionsRect.right,
        cardRight: card.right,
        headerDisplay: headerStyle.display,
        headerGridTemplateColumns: headerStyle.gridTemplateColumns,
        actionsFlexWrap: actionsStyle.flexWrap,
      }
    })
    expect(wideGeometry.cardOverflow).toBeLessThanOrEqual(1)
    expect(wideGeometry.headerWidth).toBeGreaterThanOrEqual(960)
    expect(Math.abs(wideGeometry.actionsCenter - wideGeometry.infoCenter)).toBeLessThanOrEqual(1)
    expect(wideGeometry.modelCountHeight).toBeLessThanOrEqual(24)
    expect(wideGeometry.deleteButtonHeight).toBeLessThanOrEqual(32)
    expect(wideGeometry.actionsRight).toBeLessThanOrEqual(wideGeometry.cardRight + 1)
    layoutEvidence.push({ provider: OPENROUTER_PROVIDER, wideLayout: wideGeometry })

    await page.screenshot({
      path: testInfo.outputPath('provider-card-header-layout-1226x1548.png'),
      fullPage: true,
    })
    await page.locator('.hc-provider__list').screenshot({
      path: testInfo.outputPath('provider-card-header-layout-wide.png'),
    })
    await testInfo.attach('provider-card-header-layout-geometry.json', {
      body: JSON.stringify(layoutEvidence, null, 2),
      contentType: 'application/json',
    })
    await writeFile(
      testInfo.outputPath('provider-card-header-layout-geometry.json'),
      JSON.stringify(layoutEvidence, null, 2),
    )
  })
})
