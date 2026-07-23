import { expect, test, type Page, type Route } from '@playwright/test'

test.use({
  viewport: { width: 1536, height: 1024 },
  deviceScaleFactor: 1,
})

const now = '2026-07-23T12:00:00.000Z'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

const embeddingPolicy = {
  policy_version: 3,
  selection: { kind: 'auto' },
  active_revision: {
    revision_id: 'revision-ready',
    state: 'ready',
    profile: {
      profile_id: 'local-nomic',
      model_name: 'nomic-embed-text:latest',
      provider_id: 'ollama',
      provider_name: 'Ollama',
      location: 'local',
      capability: 'embedding',
      dimension: 768,
      availability: 'installed',
      display_order: 10,
    },
    chunks_done: 6,
    chunks_total: 6,
  },
  desired_revision: null,
  indexing_activity: {
    state: 'idle',
    processing_documents: 0,
    chunks_done: 6,
    chunks_total: 6,
  },
  available_profiles: [
    {
      profile_id: 'local-nomic',
      model_name: 'nomic-embed-text:latest',
      provider_id: 'ollama',
      provider_name: 'Ollama',
      location: 'local',
      capability: 'embedding',
      dimension: 768,
      availability: 'installed',
      display_order: 10,
    },
  ],
  recommendation: {
    profile_id: 'local-nomic',
    reason_code: 'configured_embedding',
    reason_text: 'fixture-only',
  },
  catalog_version: 1,
}

const documents = [
  {
    id: 'doc-1',
    title: '五下教材节选',
    content: '分数与小数',
    source: 'upload:五下数学.pdf',
    source_type: 'upload',
    status: 'indexed',
    chunk_count: 3,
    created_at: now,
    updated_at: now,
    vector_index_state: 'ready',
  },
  {
    id: 'doc-2',
    title: 'K12 学科规则',
    content: '年级边界',
    source: 'k12-agent:小明',
    source_type: 'agent',
    status: 'indexed',
    chunk_count: 2,
    created_at: now,
    updated_at: now,
    vector_index_state: 'ready',
  },
  {
    id: 'doc-3',
    title: '手工补充',
    content: '错题归因',
    source: 'manual:家长',
    source_type: 'manual',
    status: 'indexed',
    chunk_count: 1,
    created_at: now,
    updated_at: now,
    vector_index_state: 'ready',
  },
]

const skillMarketplace = [
  {
    name: 'agent-browser',
    display_name: 'Agent Browser',
    description: '浏览器自动化',
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
    description: '研究论文阅读与摘要',
    author: 'research-ai',
    version: '1.2.1',
    tags: ['research', 'paper'],
    downloads: 12800,
    rating: 4.5,
    category: 'research',
    type: 'skill',
  },
  {
    name: 'blog-writer',
    display_name: 'Blog Writer',
    description: '高质量博客写作',
    author: 'content-craft',
    version: '1.6.0',
    tags: ['writing', 'seo'],
    downloads: 17500,
    rating: 4.6,
    category: 'writing',
    type: 'skill',
  },
  {
    name: 'data-explorer',
    display_name: 'Data Explorer',
    description: '数据分析与可视化',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['data'],
    downloads: 500,
    rating: 4.2,
    category: 'data',
    type: 'skill',
  },
  {
    name: 'workflow-runner',
    display_name: 'Workflow Runner',
    description: '自动化工作流',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['automation'],
    downloads: 800,
    rating: 4.3,
    category: 'automation',
    type: 'skill',
  },
  {
    name: 'lesson-helper',
    display_name: 'Lesson Helper',
    description: '教育场景助手',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['education'],
    downloads: 90,
    rating: 4.1,
    category: 'education',
    type: 'skill',
  },
  {
    name: 'media-studio',
    display_name: 'Media Studio',
    description: '创作媒体内容',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['media'],
    downloads: 70,
    rating: 4.0,
    category: 'media',
    type: 'skill',
  },
  {
    name: 'car-advisor',
    display_name: 'Car Advisor',
    description: '生活与汽车建议',
    author: 'hexclaw',
    version: '1.0.0',
    tags: ['automotive'],
    downloads: 20,
    rating: 4.0,
    category: 'automotive',
    type: 'skill',
  },
]

const mcpMarketplace = [
  {
    name: 'filesystem',
    display_name: 'Filesystem',
    description: '安全文件系统操作',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'system',
    tags: ['files'],
    url: 'https://example.invalid/filesystem',
    downloads: 1000,
    rating: 4.8,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    name: 'github',
    display_name: 'GitHub',
    description: 'GitHub API 集成',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'development',
    tags: ['git', 'repository'],
    url: 'https://example.invalid/github',
    downloads: 900,
    rating: 4.7,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    name: 'brave-search',
    display_name: 'Brave Search',
    description: '网页搜索',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'search',
    tags: ['search'],
    url: 'https://example.invalid/brave',
    downloads: 800,
    rating: 4.6,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
  },
  {
    name: 'postgres',
    display_name: 'PostgreSQL',
    description: '数据库查询',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'database',
    tags: ['database'],
    url: 'https://example.invalid/postgres',
    downloads: 700,
    rating: 4.5,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    name: 'playwright',
    display_name: 'Playwright',
    description: '浏览器自动化',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'automation',
    tags: ['browser'],
    url: 'https://example.invalid/playwright',
    downloads: 600,
    rating: 4.4,
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
  },
  {
    name: 'memory',
    display_name: 'Memory',
    description: '持久化记忆',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'memory',
    tags: ['knowledge'],
    url: 'https://example.invalid/memory',
    downloads: 500,
    rating: 4.3,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    name: 'fetch',
    display_name: 'Fetch',
    description: '网页内容获取',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'web',
    tags: ['web'],
    url: 'https://example.invalid/fetch',
    downloads: 400,
    rating: 4.2,
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
  {
    name: 'sqlite',
    display_name: 'SQLite',
    description: 'SQLite 数据分析',
    version: '1.0.0',
    author: 'modelcontextprotocol',
    category: 'database',
    tags: ['database'],
    url: 'https://example.invalid/sqlite',
    downloads: 300,
    rating: 4.1,
    command: 'uvx',
    args: ['mcp-server-sqlite'],
  },
]

async function installCurrentSourceMocks(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  })

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'test' }),
  )

  await page.route('**/_hexclaw/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const path = requestUrl.pathname.replace('/_hexclaw', '')
    const method = route.request().method()

    if (path === '/api/v1/config' && method === 'GET') {
      return json(route, {
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (path === '/api/v1/knowledge/documents' && method === 'GET') {
      return json(route, {
        documents,
        total: documents.length,
        limit: 50,
        offset: 0,
        sources: [
          { source: 'upload:五下数学.pdf', count: 1 },
          { source: 'k12-agent:小明', count: 1 },
          { source: 'manual:家长', count: 1 },
        ],
      })
    }
    if (path === '/api/v1/knowledge/config') {
      return json(route, {
        rerank: true,
        rerank_model: '',
        query_expand: true,
        contextual: true,
        min_score: 0.55,
        candidate_k: 50,
      })
    }
    if (path === '/api/v1/knowledge/corpora/default/embedding-policy') {
      return json(route, embeddingPolicy)
    }
    if (path === '/api/v1/memory' && method === 'GET') {
      if (requestUrl.searchParams.get('source') === 'reflect_profile') {
        return json(route, {
          entries: [],
          summary: '',
          capacity: { used: 0, max: 200, archived: 0 },
          total: 0,
          has_more: false,
          legacy_mode: false,
        })
      }
      return json(route, {
        entries: [
          {
            id: 'memory-1',
            content: '孩子喜欢用图形理解数学',
            type: 'preference',
            source: 'manual',
            created_at: now,
            updated_at: now,
            hit_count: 1,
            status: 'active',
          },
        ],
        summary: '',
        capacity: { used: 1, max: 200, archived: 0 },
        total: 1,
        has_more: false,
        legacy_mode: false,
      })
    }
    if (path === '/api/v1/config/memory') {
      return json(route, {
        enabled: true,
        auto_memory: 'inline',
        recall_min_score: 0.35,
        active_recall: true,
        profile: false,
        profile_interval_mins: 1440,
      })
    }
    if (path === '/api/v1/skills') {
      return json(route, {
        dir: '/tmp/hexclaw-skills',
        total: 2,
        skills: [
          {
            name: 'essay-grader',
            description: '中英文作文批改',
            version: '1.0.0',
            author: 'hexclaw',
            tags: ['writing'],
            triggers: [],
            enabled: true,
          },
          {
            name: 'research-helper',
            description: '研究资料整理',
            version: '1.1.0',
            author: 'hexclaw',
            tags: ['research'],
            triggers: [],
            enabled: true,
          },
        ],
      })
    }
    if (path === '/api/v1/clawhub/search') {
      const type = requestUrl.searchParams.get('type')
      const skills = type === 'mcp' ? mcpMarketplace : skillMarketplace
      return json(route, { skills, total: skills.length })
    }
    if (path === '/api/v1/mcp/servers') {
      return json(route, { servers: ['filesystem'], total: 1 })
    }
    if (path === '/api/v1/mcp/tools') {
      return json(route, {
        tools: [
          { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
          { name: 'search_web', description: 'Search the web', input_schema: { type: 'object' } },
        ],
        total: 2,
      })
    }
    if (path === '/api/v1/mcp/status') {
      return json(route, { statuses: { filesystem: 'connected' }, total: 1 })
    }

    return json(route, {})
  })
}

async function disclosureGeometry(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((root) => {
    const head = root.querySelector('.hc-settings-disclosure__head') as HTMLElement | null
    const panel = root.querySelector('.hc-settings-disclosure__panel') as HTMLElement | null
    if (!head || !panel) throw new Error('shared disclosure geometry is unavailable')
    const headStyle = getComputedStyle(head)
    const panelStyle = getComputedStyle(panel)
    const headRect = head.getBoundingClientRect()
    return {
      headHeight: Math.round(headRect.height),
      headDisplay: headStyle.display,
      headAlignItems: headStyle.alignItems,
      panelPadding: panelStyle.padding,
      panelBorderRadius: panelStyle.borderRadius,
      panelBorderWidth: panelStyle.borderTopWidth,
    }
  })
}

async function marketGeometry(page: Page) {
  return page.locator('.hc-capability-market-surface').evaluate((surface) => {
    const grid = surface.querySelector('.hc-capability-market-grid') as HTMLElement | null
    if (!grid) throw new Error('market grid is unavailable')
    const surfaceRect = (surface as HTMLElement).getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const surfaceStyle = getComputedStyle(surface)
    const contentWidth =
      surfaceRect.width -
      Number.parseFloat(surfaceStyle.paddingLeft || '0') -
      Number.parseFloat(surfaceStyle.paddingRight || '0')
    const columns = getComputedStyle(grid)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .filter(Boolean).length
    const expectedColumns =
      contentWidth >= 1280 ? 4 : contentWidth >= 960 ? 3 : contentWidth >= 640 ? 2 : 1
    return {
      surfaceWidth: surfaceRect.width,
      contentWidth,
      gridWidth: gridRect.width,
      columns,
      expectedColumns,
      overflow: grid.scrollWidth - grid.clientWidth,
    }
  })
}

test.describe('2026-07-23 current-source UI runtime regression', () => {
  test.beforeEach(async ({ page }) => {
    await installCurrentSourceMocks(page)
  })

  test('Knowledge tabs, disclosures and add-document form keep one measurable layout contract', async ({
    page,
  }) => {
    await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })

    const tabs = page.locator('.knowledge-page__tab-stack > .hc-utabs')
    const sources = page.getByTestId('knowledge-source-filters')
    const semantic = page.getByTestId('kb-semantic-index-card')
    await expect(tabs).toBeVisible()
    await expect(sources).toBeVisible()
    await expect(semantic).toBeVisible()
    await expect(page.getByTestId('kb-semantic-index-header')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(page.getByTestId('kb-semantic-index-body')).toBeHidden()

    const tabToSourcesGap = await page.evaluate(() => {
      const tabRow = document.querySelector(
        '.knowledge-page__tab-stack > .hc-utabs',
      ) as HTMLElement | null
      const sourceRow = document.querySelector(
        '[data-testid="knowledge-source-filters"]',
      ) as HTMLElement | null
      if (!tabRow || !sourceRow) throw new Error('knowledge tab/source geometry unavailable')
      return sourceRow.getBoundingClientRect().top - tabRow.getBoundingClientRect().bottom
    })
    expect(tabToSourcesGap).toBeGreaterThanOrEqual(18)

    const semanticGeometry = await disclosureGeometry(semantic)
    await page.screenshot({
      path: 'test-results/bug-20260723-knowledge-tabs-semantic-runtime.png',
      fullPage: true,
    })

    await page.getByRole('tab', { name: '检索测试' }).click()
    await expect(semantic).toHaveCount(0)
    const rag = page.getByTestId('kb-rag-panel')
    await expect(rag).toBeVisible()
    await expect(page.getByTestId('kb-rag-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('kb-rag-body')).toBeVisible()
    expect(await disclosureGeometry(rag)).toEqual(semanticGeometry)
    await page.screenshot({
      path: 'test-results/bug-20260723-knowledge-rag-disclosure-runtime.png',
      fullPage: true,
    })

    await page.goto('/knowledge/memory', { waitUntil: 'domcontentloaded' })
    const memoryDisclosure = page.locator('.hc-memset__section.hc-settings-disclosure')
    await expect(memoryDisclosure).toBeVisible()
    await expect(page.getByTestId('memset-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#memory-behavior-settings-body')).toBeHidden()
    await page.getByTestId('memset-toggle').click()
    await expect(page.locator('#memory-behavior-settings-body')).toBeVisible()
    expect(await disclosureGeometry(memoryDisclosure)).toEqual(semanticGeometry)
    await page.screenshot({
      path: 'test-results/bug-20260723-memory-disclosure-runtime.png',
      fullPage: true,
    })

    await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /添加文档/ }).click()
    const dialog = page.getByRole('heading', { name: '添加文档' }).locator('..').locator('..')
    await expect(dialog).toBeVisible()
    const formTracks = await dialog.locator('.hc-clearable-field').evaluateAll((wrappers) =>
      wrappers.map((wrapper) => {
        const control = wrapper.querySelector('input, textarea') as HTMLElement | null
        if (!control) throw new Error('add-document control missing')
        const wrapperRect = (wrapper as HTMLElement).getBoundingClientRect()
        const controlRect = control.getBoundingClientRect()
        return {
          wrapperWidth: wrapperRect.width,
          controlWidth: controlRect.width,
          leftDelta: Math.abs(wrapperRect.left - controlRect.left),
          rightDelta: Math.abs(wrapperRect.right - controlRect.right),
        }
      }),
    )
    expect(formTracks).toHaveLength(3)
    for (const track of formTracks) {
      expect(track.wrapperWidth).toBeGreaterThan(430)
      expect(Math.abs(track.wrapperWidth - track.controlWidth)).toBeLessThanOrEqual(1)
      expect(track.leftDelta).toBeLessThanOrEqual(1)
      expect(track.rightDelta).toBeLessThanOrEqual(1)
    }

    await page.screenshot({
      path: 'test-results/bug-20260723-knowledge-layout-runtime.png',
      fullPage: true,
    })
  })

  test('Skills and MCP use the toolbar as the only live marketplace search and share the grid', async ({
    page,
  }) => {
    await page.goto('/integration', { waitUntil: 'domcontentloaded' })

    const toolbarSearch = page.locator('.hc-toolbar .hc-search__input')
    await expect(toolbarSearch).toHaveCount(1)
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 Skill/)
    await page.getByRole('tab', { name: /市场/ }).click()
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 ClawHub Skill/)
    await expect(page.locator('.hc-search')).toHaveCount(1)
    await expect(page.locator('.hc-capability-market-surface .hc-search')).toHaveCount(0)

    await toolbarSearch.fill('研究')
    const skillGrid = page.locator('.hc-capability-market-grid')
    await expect(skillGrid.locator(':scope > *')).toHaveCount(1)
    await expect(skillGrid).toContainText('arXiv Reader')
    await expect(skillGrid).not.toContainText('Agent Browser')
    const skillGeometry = await marketGeometry(page)
    expect(skillGeometry.columns).toBe(skillGeometry.expectedColumns)
    expect(Math.abs(skillGeometry.gridWidth - skillGeometry.contentWidth)).toBeLessThanOrEqual(1)
    expect(skillGeometry.overflow).toBeLessThanOrEqual(1)

    await toolbarSearch.fill('')
    await expect(skillGrid.locator(':scope > *')).toHaveCount(skillMarketplace.length)
    await page.screenshot({
      path: 'test-results/bug-20260723-skills-market-runtime.png',
      fullPage: true,
    })

    await page.getByTestId('segmented-mcp').click()
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 MCP/)
    await page.getByRole('tab', { name: /市场/ }).click()
    await expect(toolbarSearch).toHaveAttribute('placeholder', /搜索 MCP 服务器/)
    await expect(page.locator('.hc-search')).toHaveCount(1)
    await expect(page.locator('.hc-capability-market-surface .hc-search')).toHaveCount(0)

    await toolbarSearch.fill('GitHub')
    const mcpGrid = page.locator('.hc-capability-market-grid')
    await expect(mcpGrid.locator(':scope > *')).toHaveCount(1)
    await expect(mcpGrid).toContainText('GitHub')
    await expect(mcpGrid).not.toContainText('Filesystem')
    const mcpGeometry = await marketGeometry(page)
    expect(mcpGeometry.columns).toBe(mcpGeometry.expectedColumns)
    expect(Math.abs(mcpGeometry.gridWidth - mcpGeometry.contentWidth)).toBeLessThanOrEqual(1)
    expect(mcpGeometry.overflow).toBeLessThanOrEqual(1)

    await toolbarSearch.fill('')
    await expect(mcpGrid.locator(':scope > *')).toHaveCount(mcpMarketplace.length)
    expect((await marketGeometry(page)).columns).toBe(skillGeometry.columns)
    await page.screenshot({
      path: 'test-results/bug-20260723-mcp-market-runtime.png',
      fullPage: true,
    })
  })
})
