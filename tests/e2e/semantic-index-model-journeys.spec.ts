import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import type {
  EmbeddingSelection,
  KnowledgeEmbeddingPolicyProjection,
  KnowledgeEmbeddingProfile,
} from '../../src/api/knowledge-index'
import type { BackendLLMConfig } from '../../src/types/settings'

const initialOpenRouterProviderId = 'pvd_v1_11111111111111111111111111111111'
const canonicalProviderIdPattern = /^pvd_v1_[0-9a-f]{32}$/

const cloudServing: KnowledgeEmbeddingProfile = {
  profile_id: 'cloud-sf',
  model_name: 'BAAI/bge-m3',
  provider_id: 'siliconflow',
  provider_name: 'SiliconFlow',
  location: 'cloud',
  capability: 'embedding',
  dimension: 1024,
  availability: 'connected',
  display_order: 10,
}

const cloudOpenAI: KnowledgeEmbeddingProfile = {
  profile_id: 'cloud-openai',
  model_name: 'text-embedding-3-small',
  provider_id: 'openai-compatible',
  provider_name: 'OpenAI 兼容',
  location: 'cloud',
  capability: 'embedding',
  dimension: 1536,
  availability: 'connected',
  display_order: 20,
}

const localDownloadable: KnowledgeEmbeddingProfile = {
  profile_id: 'local-mxbai',
  model_name: 'mxbai-embed-large',
  provider_id: 'ollama',
  provider_name: 'Ollama',
  location: 'local',
  capability: 'embedding',
  dimension: 1024,
  availability: 'downloadable',
  display_order: 30,
}

function readyPolicy(): KnowledgeEmbeddingPolicyProjection {
  return {
    policy_version: 7,
    selection: { kind: 'auto' },
    active_revision: {
      revision_id: 'rev-serving',
      state: 'ready',
      profile: structuredClone(cloudServing),
      chunks_done: 225,
      chunks_total: 225,
    },
    desired_revision: null,
    indexing_activity: {
      state: 'idle',
      processing_documents: 0,
      chunks_done: 225,
      chunks_total: 225,
    },
    available_profiles: [
      structuredClone(cloudServing),
      structuredClone(cloudOpenAI),
      structuredClone(localDownloadable),
    ],
    recommendation: {
      profile_id: cloudServing.profile_id,
      reason_code: 'configured_embedding',
      reason_text: 'fixture text must never become UI copy',
    },
    catalog_version: 3,
  }
}

interface PullResolution {
  ok: boolean
  error?: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type AxeAnalysis = Awaited<ReturnType<AxeBuilder['analyze']>>

interface AxeAudit {
  state: string
  analysis: AxeAnalysis
}

const wcagAATags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']

async function collectAxeAudit(
  page: Page,
  testInfo: TestInfo,
  audits: AxeAudit[],
  state: string,
  include: string,
) {
  const analysis = await new AxeBuilder({ page }).include(include).withTags(wcagAATags).analyze()
  audits.push({ state, analysis })

  await testInfo.attach(`axe-${state}.json`, {
    body: JSON.stringify(
      {
        state,
        url: analysis.url,
        violations: analysis.violations,
        incomplete: analysis.incomplete,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })

  if (analysis.incomplete.length > 0) {
    console.warn(
      `[axe][${state}] incomplete (${analysis.incomplete.length}): ${analysis.incomplete
        .map(
          (item) =>
            `${item.id}(${item.nodes.length}) targets=${item.nodes
              .map((node) => node.target.join(' > '))
              .join(' | ')}`,
        )
        .join('; ')}`,
    )
  }
}

function expectNoAxeViolations(audits: AxeAudit[]) {
  const violationCount = audits.reduce(
    (total, audit) => total + audit.analysis.violations.length,
    0,
  )
  const summary = audits
    .flatMap((audit) =>
      audit.analysis.violations.map(
        (violation) =>
          `${audit.state}: ${violation.id} (${violation.impact ?? 'impact unknown'}) ` +
          `${violation.help}; targets=${violation.nodes
            .map((node) => node.target.join(' > '))
            .join(' | ')}`,
      ),
    )
    .join('\n')

  expect(violationCount, summary || 'axe WCAG A/AA violations').toBe(0)
}

class SemanticIndexBackend {
  policy = readyPolicy()
  llmConfig: BackendLLMConfig = {
    default: 'OpenRouter',
    providers: {
      OpenRouter: {
        provider_instance_id: initialOpenRouterProviderId,
        api_key: '****test',
        base_url: 'https://openrouter.ai/api/v1',
        model: 'chat-model',
        models: ['chat-model'],
        model_specs_mode: 'explicit',
        model_specs: [
          {
            id: 'chat-model',
            display_name: 'Chat Model',
            is_custom: true,
            capabilities: ['text'],
          },
        ],
        compatible: 'openai',
        locality: 'cloud',
        enabled: true,
      },
    },
    routing: { enabled: false, strategy: 'cost-aware' },
    cache: { enabled: true, similarity: 0.92, ttl: '24h', max_entries: 10000 },
  }
  readonly applyRequests: Array<{
    expected_policy_version: number
    selection: EmbeddingSelection
  }> = []
  readonly cancelledJobIds: string[] = []
  readonly pulledModels: string[] = []
  readonly llmUpdates: BackendLLMConfig[] = []
  canonicalLLMReadbacks = 0
  readonly capabilityProbeRequests: string[] = []
  readonly connectionProbeRequests: unknown[] = []
  private pull = deferred<PullResolution>()
  private nextProviderSequence = 2
  private hasUnreadLLMUpdate = false

  async install(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    })

    await page.route('http://localhost:11434/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: [], version: 'test' }),
      }),
    )

    await page.route('**/_hexclaw/**', (route) => this.handle(route))
  }

  completePull() {
    this.pull.resolve({ ok: true })
  }

  failPull(error = '磁盘空间不足') {
    this.pull.resolve({ ok: false, error })
  }

  setRetryWaiting() {
    this.policy = {
      ...readyPolicy(),
      policy_version: 8,
      selection: { kind: 'profile', profile_id: cloudOpenAI.profile_id },
      desired_revision: {
        revision_id: 'rev-cloud-waiting',
        job_id: 'job-cloud-waiting',
        state: 'retry_wait',
        profile: structuredClone(cloudOpenAI),
        chunks_done: 41,
        chunks_total: 225,
      },
      indexing_activity: {
        state: 'retry_wait',
        processing_documents: 1,
        chunks_done: 41,
        chunks_total: 225,
      },
    }
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  }

  private nextProviderInstanceId() {
    const suffix = this.nextProviderSequence.toString(16).padStart(32, '0')
    this.nextProviderSequence += 1
    return `pvd_v1_${suffix}`
  }

  private maskApiKey(apiKey: string, previousMaskedKey = '') {
    const trimmed = apiKey.trim()
    if (!trimmed) return ''
    if (trimmed.includes('*')) return previousMaskedKey || trimmed
    return `****${trimmed.slice(-4)}`
  }

  /**
   * 与真实后端保持同一身份语义：map key / provider_instance_id 一经创建不可由后续
   * display name 或客户端临时 ID 改写；新项由服务端生成 canonical instance ID。
   */
  private persistLLMUpdate(body: BackendLLMConfig): BackendLLMConfig {
    const existingEntries = Object.entries(this.llmConfig.providers)
    const canonicalKeyByIncomingKey = new Map<string, string>()
    const providers: BackendLLMConfig['providers'] = {}

    for (const [incomingKey, incomingProvider] of Object.entries(body.providers)) {
      const existingByInstanceId = incomingProvider.provider_instance_id
        ? existingEntries.find(
            ([, provider]) =>
              provider.provider_instance_id === incomingProvider.provider_instance_id,
          )
        : undefined
      const existingByKey = existingEntries.find(([key]) => key === incomingKey)
      const existing = existingByInstanceId ?? existingByKey
      const canonicalKey = existing?.[0] ?? incomingKey
      const previousProvider = existing?.[1]
      const providerInstanceId =
        previousProvider?.provider_instance_id ?? this.nextProviderInstanceId()

      canonicalKeyByIncomingKey.set(incomingKey, canonicalKey)
      providers[canonicalKey] = {
        ...structuredClone(incomingProvider),
        provider_instance_id: providerInstanceId,
        api_key: this.maskApiKey(
          incomingProvider.api_key,
          previousProvider?.api_key ?? '',
        ),
        model_specs_mode: 'explicit',
      }
    }

    return {
      ...structuredClone(body),
      default: canonicalKeyByIncomingKey.get(body.default) ?? body.default,
      providers,
    }
  }

  private readLLMConfig(): BackendLLMConfig {
    const snapshot = structuredClone(this.llmConfig)
    for (const provider of Object.values(snapshot.providers)) {
      provider.api_key = this.maskApiKey(provider.api_key)
    }
    return snapshot
  }

  private async handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (path === '/api/v1/config/llm' && method === 'GET') {
      if (this.hasUnreadLLMUpdate) {
        this.canonicalLLMReadbacks += 1
        this.hasUnreadLLMUpdate = false
      }
      return this.json(route, this.readLLMConfig())
    }
    if (path === '/api/v1/config/llm' && method === 'PUT') {
      const body = request.postDataJSON() as BackendLLMConfig
      this.llmUpdates.push(structuredClone(body))
      this.llmConfig = this.persistLLMUpdate(body)
      this.hasUnreadLLMUpdate = true
      return this.json(route, { status: 'ok' })
    }
    if (path === '/api/v1/config/llm/test' && method === 'POST') {
      this.connectionProbeRequests.push(request.postDataJSON())
      return this.json(route, { ok: true, message: 'ok' })
    }
    if (path === '/api/v1/config/llm/models' && method === 'POST') {
      return this.json(route, { models: [] })
    }
    if (path === '/api/v1/llm/capabilities' && method === 'GET') {
      return this.json(route, [])
    }
    if (path === '/api/v1/llm/capabilities/probe' && method === 'POST') {
      this.capabilityProbeRequests.push(`${url.searchParams.get('provider')}:${url.searchParams.get('model')}`)
      return this.json(route, {
        provider_name: url.searchParams.get('provider') ?? '',
        model_name: url.searchParams.get('model') ?? '',
        tool_call: 0,
        tool_call_text: 'unknown',
        last_probe: '0001-01-01T00:00:00Z',
      })
    }

    if (path === '/api/v1/config') {
      return this.json(route, {
        server: { host: '127.0.0.1', port: 16060, mode: 'desktop' },
        general: { welcomeCompleted: true },
        llm: { default: 'openai', providers: [{ id: 'openai', enabled: true }] },
        knowledge: { enabled: true },
        mcp: {},
        cron: {},
        webhook: {},
        canvas: {},
        voice: {},
        sandbox: {},
        security: {},
      })
    }

    if (path === '/api/v1/knowledge/documents' && method === 'GET') {
      return this.json(route, { documents: [], total: 0, limit: 20, offset: 0, sources: [] })
    }
    if (path === '/api/v1/knowledge/config' && method === 'GET') {
      return this.json(route, {
        rerank: true,
        rerank_model: '',
        query_expand: true,
        contextual: true,
        min_score: 0.55,
        candidate_k: 50,
      })
    }

    const policyPath = '/api/v1/knowledge/corpora/default/embedding-policy'
    if (path === policyPath && method === 'GET') {
      return this.json(route, structuredClone(this.policy))
    }
    if (path === `${policyPath}:apply` && method === 'POST') {
      const body = request.postDataJSON() as {
        expected_policy_version: number
        selection: EmbeddingSelection
      }
      this.applyRequests.push(structuredClone(body))
      const target =
        body.selection.kind === 'profile'
          ? this.policy.available_profiles.find(
              (profile) => profile.profile_id === body.selection.profile_id,
            )
          : null
      const jobId = target ? `job-${target.profile_id}` : 'job-auto'
      this.policy = {
        ...this.policy,
        policy_version: this.policy.policy_version + 1,
        selection: structuredClone(body.selection),
        desired_revision: target
          ? {
              revision_id: `rev-${target.profile_id}`,
              job_id: jobId,
              state: 'building',
              profile: structuredClone(target),
              chunks_done: 0,
              chunks_total: 225,
            }
          : null,
        indexing_activity: target
          ? {
              state: 'building',
              processing_documents: 1,
              chunks_done: 0,
              chunks_total: 225,
            }
          : this.policy.indexing_activity,
      }
      return this.json(route, {
        policy_version: this.policy.policy_version,
        selection: body.selection,
        active_revision_id: this.policy.active_revision?.revision_id ?? null,
        desired_revision_id: this.policy.desired_revision?.revision_id ?? null,
        job_id: this.policy.desired_revision?.job_id ?? null,
      })
    }

    const cancelMatch = path.match(/^\/api\/v1\/knowledge\/jobs\/([^/]+)\/cancel$/)
    if (cancelMatch && method === 'POST') {
      const jobId = decodeURIComponent(cancelMatch[1]!)
      this.cancelledJobIds.push(jobId)
      this.policy = {
        ...this.policy,
        policy_version: this.policy.policy_version + 1,
        selection: { kind: 'auto' },
        desired_revision: null,
        indexing_activity: {
          state: 'idle',
          processing_documents: 0,
          chunks_done: 225,
          chunks_total: 225,
        },
      }
      return this.json(route, {
        job_id: jobId,
        state: 'cancelled',
        stage: 'embedding',
        pages_done: null,
        pages_total: null,
        chunks_done: 0,
        chunks_total: 225,
      })
    }

    const jobMatch = path.match(/^\/api\/v1\/knowledge\/jobs\/([^/]+)$/)
    if (jobMatch && method === 'GET') {
      return this.json(route, {
        job_id: decodeURIComponent(jobMatch[1]!),
        state: 'running',
        stage: 'embedding',
        pages_done: null,
        pages_total: null,
        chunks_done: this.policy.desired_revision?.chunks_done ?? 0,
        chunks_total: 225,
      })
    }

    if (path === '/api/v1/ollama/pull' && method === 'POST') {
      const body = request.postDataJSON() as { model: string }
      this.pulledModels.push(body.model)
      const result = await this.pull.promise
      if (!result.ok) return this.json(route, { error: result.error }, 507)

      this.policy = {
        ...this.policy,
        catalog_version: this.policy.catalog_version + 1,
        available_profiles: this.policy.available_profiles.map((profile) =>
          profile.profile_id === localDownloadable.profile_id
            ? { ...profile, availability: 'installed' as const }
            : profile,
        ),
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'data: {"status":"pulling manifest","completed":0,"total":100}',
          'data: {"status":"downloading","completed":42,"total":100}',
          'data: {"status":"success","completed":100,"total":100}',
          '',
        ].join('\n'),
      })
    }

    return this.json(route, {})
  }
}

class SemanticIndexPage {
  constructor(readonly page: Page) {}

  get card() {
    return this.page.getByTestId('kb-semantic-index-card')
  }

  get header() {
    return this.page.getByTestId('kb-semantic-index-header')
  }

  get modelPicker() {
    return this.page.getByTestId('kb-index-model-trigger')
  }

  async goto() {
    await this.page.goto('/knowledge')
    await expect(this.card).toBeVisible()
  }

  async expand() {
    if ((await this.header.getAttribute('aria-expanded')) !== 'true') await this.header.click()
    await expect(this.page.getByTestId('kb-semantic-index-body')).toBeVisible()
  }

  async openModels() {
    await this.modelPicker.click()
    await expect(this.page.getByRole('listbox', { name: '索引模型' })).toBeVisible()
  }
}

test.describe('知识库语义索引：云端与本地模型用户旅程', () => {
  test('云端模型：显式选择 → 重建锁定 → Escape 放弃取消 → 确认精确取消', async ({
    page,
  }, testInfo) => {
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await semantic.expand()
    await semantic.openModels()

    await expect(page.getByTestId('kb-index-provider-notice')).toContainText('第三方 Provider')
    await page.getByRole('option', { name: /text-embedding-3-small/ }).click()

    await expect.poll(() => backend.applyRequests.length).toBe(1)
    expect(backend.applyRequests[0]).toEqual({
      expected_policy_version: 7,
      selection: { kind: 'profile', profile_id: 'cloud-openai' },
    })
    await expect(semantic.modelPicker).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('kb-semantic-index-actual')).toContainText(
      'SiliconFlow · BAAI/bge-m3',
    )
    await expect(page.getByTestId('kb-semantic-index-summary')).toContainText(
      'text-embedding-3-small',
    )

    await page.getByTestId('kb-semantic-index-cancel').click()
    const dialog = page.getByRole('dialog', { name: '取消本次重建？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toBeFocused()
    await expect(page.locator('.kb-rebuild-dialog__overlay')).toHaveCSS('opacity', '1')
    await expect(dialog).toHaveCSS('transform', 'none')
    await page.screenshot({
      path: testInfo.outputPath('cloud-cancel-dialog.png'),
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    expect(backend.cancelledJobIds).toEqual([])
    await expect(semantic.header).toBeFocused()

    await page.getByTestId('kb-semantic-index-cancel').click()
    await page
      .getByRole('dialog', { name: '取消本次重建？' })
      .getByRole('button', { name: '取消重建', exact: true })
      .click()
    await expect.poll(() => backend.cancelledJobIds).toEqual(['job-cloud-openai'])
    await expect(page.getByTestId('kb-semantic-index-cancel')).toHaveCount(0)
    await expect(semantic.header).toBeFocused()
  })

  test('云端模型：retry_wait 保留当前索引，用户仍可取消等待中的重建', async ({ page }) => {
    const backend = new SemanticIndexBackend()
    backend.setRetryWaiting()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await semantic.expand()

    await expect(page.getByTestId('kb-semantic-index-status')).toHaveText('等待重试')
    await expect(page.getByTestId('kb-semantic-index-hint')).toContainText(
      'SiliconFlow · BAAI/bge-m3 继续服务',
    )
    await expect(page.getByTestId('kb-semantic-index-actual')).toContainText(
      '当前索引可用 · 等待重试',
    )
    await page.getByTestId('kb-semantic-index-cancel').click()
    await page
      .getByRole('dialog', { name: '取消本次重建？' })
      .getByRole('button', { name: '取消重建', exact: true })
      .click()

    await expect.poll(() => backend.cancelledJobIds).toEqual(['job-cloud-waiting'])
    await expect(page.getByTestId('kb-semantic-index-status')).toHaveText('已就绪')
  })

  test('本地模型：下载跨页面保持单任务，目录确认安装后仍需用户显式应用', async ({
    page,
  }, testInfo) => {
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await semantic.expand()
    await semantic.openModels()

    const localOption = page.getByRole('option', { name: /mxbai-embed-large/ })
    await expect(page.getByTestId('kb-index-model-download-local-mxbai')).toHaveText('下载')
    await localOption.click()
    await expect.poll(() => backend.pulledModels).toEqual(['mxbai-embed-large'])
    await expect(page.getByRole('listbox', { name: '索引模型' })).toBeVisible()
    await expect(page.getByTestId('kb-index-model-download-local-mxbai')).toContainText('下载中')
    await page.screenshot({
      path: testInfo.outputPath('local-download-in-progress.png'),
      animations: 'disabled',
    })
    expect(backend.applyRequests).toEqual([])

    await page.locator('a[href="/chat"]').click()
    await expect(page).toHaveURL(/\/chat$/)
    await page.locator('a[href="/knowledge"]').click()
    await expect(page).toHaveURL(/\/knowledge$/)
    await expect(semantic.card).toBeVisible()
    await semantic.expand()
    await semantic.openModels()
    await expect(page.getByTestId('kb-index-model-download-local-mxbai')).toContainText('下载中')
    expect(backend.pulledModels).toEqual(['mxbai-embed-large'])

    backend.completePull()
    await expect(page.getByRole('option', { name: /mxbai-embed-large/ })).toContainText('已安装')
    expect(backend.applyRequests).toEqual([])

    await page.getByRole('option', { name: /mxbai-embed-large/ }).click()
    await expect.poll(() => backend.applyRequests.length).toBe(1)
    expect(backend.applyRequests[0]).toEqual({
      expected_policy_version: 7,
      selection: { kind: 'profile', profile_id: 'local-mxbai' },
    })
    expect(backend.pulledModels).toEqual(['mxbai-embed-large'])
  })

  test('本地模型：下载失败不应用策略，模型保持可下载供用户后续重试', async ({ page }) => {
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await semantic.expand()
    await semantic.openModels()

    await page.getByRole('option', { name: /mxbai-embed-large/ }).click()
    await expect.poll(() => backend.pulledModels).toEqual(['mxbai-embed-large'])
    backend.failPull()

    await expect(semantic.card).toContainText('磁盘空间不足')
    await expect(page.getByTestId('kb-index-model-download-local-mxbai')).toHaveText('下载')
    expect(backend.applyRequests).toEqual([])
    expect(
      backend.policy.available_profiles.find((profile) => profile.profile_id === 'local-mxbai'),
    ).toMatchObject({ availability: 'downloadable' })
  })

  test('@a11y 折叠/展开卡片、模型 listbox 与下载中 option 暴露稳定语义', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
    const audits: AxeAudit[] = []
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()

    await expect(semantic.header).toHaveAttribute('aria-expanded', 'false')
    const collapsedSnapshot = await semantic.header.ariaSnapshot()
    expect(collapsedSnapshot).toContain('button "语义索引')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-card-collapsed',
      '[data-testid="kb-semantic-index-card"]',
    )

    await semantic.header.focus()
    await page.keyboard.press('Enter')
    await expect(semantic.header).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('kb-semantic-index-body')).toBeVisible()

    const liveRegion = semantic.card.locator('[aria-live="polite"]')
    await expect(liveRegion).toHaveAttribute('aria-atomic', 'true')
    await expect(liveRegion).toHaveText(/\S/)
    const expandedSnapshot = await semantic.card.ariaSnapshot()
    expect(expandedSnapshot).toContain('combobox "索引模型:')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-card-expanded',
      '[data-testid="kb-semantic-index-card"]',
    )

    await semantic.modelPicker.focus()
    await page.keyboard.press('ArrowDown')
    const listbox = page.getByRole('listbox', { name: '索引模型' })
    await expect(listbox).toBeVisible()
    await expect(semantic.modelPicker).toHaveAttribute('aria-expanded', 'true')

    const selectedAuto = page.getByRole('option', { name: /^自动/ })
    await expect(selectedAuto).toHaveAttribute('aria-selected', 'true')
    const selectedAutoId = await selectedAuto.getAttribute('id')
    expect(selectedAutoId).toBeTruthy()
    await expect(semantic.modelPicker).toHaveAttribute('aria-activedescendant', selectedAutoId!)

    const listboxSnapshot = await listbox.ariaSnapshot()
    expect(listboxSnapshot).toContain('listbox "索引模型"')
    expect(listboxSnapshot).toContain('option "自动')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-model-listbox',
      '.kb-profile-select__popover',
    )

    const localOption = page.getByRole('option', { name: /mxbai-embed-large/ })
    await localOption.click()
    await expect.poll(() => backend.pulledModels).toEqual(['mxbai-embed-large'])
    await expect(listbox).toBeVisible()
    await expect(semantic.modelPicker).toHaveAttribute('aria-expanded', 'true')
    await expect(localOption).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('kb-index-model-download-local-mxbai')).toContainText('下载中')
    const downloadingSnapshot = await localOption.ariaSnapshot()
    expect(downloadingSnapshot).toContain('option "mxbai-embed-large')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-model-downloading',
      '.kb-profile-select__popover',
    )

    backend.completePull()
    await expect(localOption).toContainText('已安装')
    await expect(liveRegion).toContainText('mxbai-embed-large')
    const liveSnapshot = await liveRegion.ariaSnapshot()
    expect(liveSnapshot).toContain('mxbai-embed-large')

    await page.keyboard.press('Escape')
    await expect(listbox).toBeHidden()
    await expect(semantic.modelPicker).toHaveAttribute('aria-expanded', 'false')
    await expect(semantic.modelPicker).not.toHaveAttribute('aria-activedescendant', /.+/)
    await expect(semantic.modelPicker).toBeFocused()

    expectNoAxeViolations(audits)
  })

  test('@a11y 取消重建弹窗提供命名、描述、焦点圈闭与关闭后焦点返回', async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
    const audits: AxeAudit[] = []
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await semantic.expand()
    await semantic.openModels()

    await page.getByRole('option', { name: /text-embedding-3-small/ }).click()
    await expect.poll(() => backend.applyRequests.length).toBe(1)

    const liveRegion = semantic.card.locator('[aria-live="polite"]')
    await expect(liveRegion).toContainText('索引模型设置已更新')
    await page.getByTestId('kb-semantic-index-cancel').click()

    const dialog = page.getByRole('dialog', { name: '取消本次重建？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toBeFocused()
    await expect(page.locator('.kb-rebuild-dialog__overlay')).toHaveCSS('opacity', '1')
    await expect(dialog).toHaveCSS('transform', 'none')
    const descriptionId = await dialog.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    await expect(page.locator(`[id="${descriptionId}"]`)).toContainText('当前索引不会受影响')

    const dialogSnapshot = await dialog.ariaSnapshot()
    expect(dialogSnapshot).toContain('dialog "取消本次重建？"')
    expect(dialogSnapshot).toContain('button "关闭"')
    expect(dialogSnapshot).toContain('button "取消重建"')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-cancel-dialog',
      '.kb-rebuild-dialog__overlay',
    )

    const closeButton = dialog.getByRole('button', { name: '关闭' })
    const confirmButton = dialog.getByRole('button', { name: '取消重建', exact: true })
    await page.keyboard.press('Tab')
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(confirmButton).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(closeButton).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(semantic.header).toBeFocused()
    expect(backend.cancelledJobIds).toEqual([])

    expectNoAxeViolations(audits)
  })

  test('@a11y Settings 添加两个 OpenRouter Embedding 模型：契约持久化、聊天隔离与键盘语义', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
    const audits: AxeAudit[] = []
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    await page.goto('/settings')

    const providerCard = page.locator('.hc-provider__card').filter({ hasText: 'OpenRouter' })
    await expect(providerCard).toBeVisible()
    await providerCard.locator('.hc-provider__card-head').click()
    const addTrigger = providerCard.locator('.hc-model-chip--add')
    await expect(addTrigger).toBeVisible()

    const activeChatChip = providerCard.locator('.hc-model-chip--active')
    const defaultModel = page.locator('[data-testid="llm-default-model-select"] .hc-select__trigger')
    await expect(activeChatChip).toContainText('Chat Model')
    await expect(defaultModel).toContainText('Chat Model')

    await addTrigger.click()
    let dialog = page.getByRole('dialog', { name: '添加自定义模型' })
    await expect(dialog).toBeVisible()
    const modelIdInput = dialog.getByRole('textbox', { name: '模型 ID' })
    await expect(modelIdInput).toBeFocused()
    await expect(page.locator('.hc-settings')).toHaveAttribute('inert', '')
    const dialogSnapshot = await dialog.ariaSnapshot()
    expect(dialogSnapshot).toContain('dialog "添加自定义模型"')
    expect(dialogSnapshot).toContain('textbox "模型 ID *"')
    expect(dialogSnapshot).toContain('group "核心能力"')
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'settings-custom-model-dialog',
      '.hc-dialog-overlay',
    )

    // 空 ID 时提交按钮禁用；Shift+Tab/Tab 只能在弹窗内循环。
    await expect(dialog.getByRole('button', { name: '添加', exact: true })).toBeDisabled()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(modelIdInput).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(addTrigger).toBeFocused()
    await expect(page.locator('.hc-settings')).not.toHaveAttribute('inert', '')

    const modelIds = [
      'nvidia/nemotron-3-embed-1b:free',
      'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    ]
    for (const [index, modelId] of modelIds.entries()) {
      await addTrigger.click()
      dialog = page.getByRole('dialog', { name: '添加自定义模型' })
      await expect(dialog).toBeVisible()
      // 第一个故意保留默认“文本”，验证受管 exact ID 不能绕过 embedding-only canonicalization。
      if (index > 0) {
        await dialog.getByRole('combobox').click()
        await page.getByRole('option', { name: 'Embedding', exact: true }).click()
      }
      await dialog.getByRole('textbox', { name: '模型 ID' }).fill(modelId)
      await dialog.getByRole('button', { name: '添加', exact: true }).click()
      await expect(dialog).toBeHidden()
    }

    for (const modelId of modelIds) {
      const embeddingChip = providerCard.locator('.hc-model-chip--embedding').filter({ hasText: modelId })
      await expect(embeddingChip).toBeVisible()
      expect(await embeddingChip.evaluate((element) => element.tagName)).toBe('DIV')
      await expect(embeddingChip).not.toHaveAttribute('role', /.+/)
      await expect(embeddingChip).not.toHaveAttribute('tabindex', /.+/)
      await expect(embeddingChip.locator('.hc-model-chip__probe')).toHaveCount(0)
      await expect(embeddingChip.locator('.hc-model-chip__reliability')).toHaveCount(0)
      await expect(embeddingChip.locator('button')).toHaveCount(1)
      await expect(embeddingChip.getByRole('button', { name: `删除 ${modelId}` })).toBeVisible()
      const chipSnapshot = await embeddingChip.ariaSnapshot()
      expect(chipSnapshot).toContain(`button "删除 ${modelId}"`)
      expect(chipSnapshot).not.toContain(`button "${modelId}"`)
    }

    await expect(activeChatChip).toContainText('Chat Model')
    await expect(defaultModel).toContainText('Chat Model')
    expect(backend.capabilityProbeRequests).toEqual([])
    expect(backend.connectionProbeRequests).toEqual([])

    await expect.poll(() => backend.llmUpdates.length).toBeGreaterThan(0)
    const update = backend.llmUpdates.at(-1)!
    const openRouter = update.providers.OpenRouter!
    expect(update.default).toBe('OpenRouter')
    expect(openRouter.model).toBe('chat-model')
    expect(openRouter).not.toHaveProperty('model_specs_mode')
    expect(openRouter.provider_instance_id).toBe(initialOpenRouterProviderId)
    expect(openRouter.model_specs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: modelIds[0],
        display_name: modelIds[0],
        capabilities: ['embedding'],
        embedding: {
          protocol: 'openai_embeddings',
          dimension: 2048,
          normalization: 'l2',
        },
      }),
      expect.objectContaining({
        id: modelIds[1],
        display_name: modelIds[1],
        capabilities: ['embedding'],
        embedding: {
          protocol: 'openai_embeddings',
          dimension: 2048,
          normalization: 'l2',
        },
      }),
    ]))

    // 保存后的 GET 回读只提供 canonical identity + masked key。重命名是纯展示字段，
    // 第二次 PUT 必须继续使用同一 backend map key / provider_instance_id。
    const updatesBeforeRename = backend.llmUpdates.length
    await providerCard.locator('[data-provider-field="name"]').fill('OpenRouter Display Renamed')
    await expect.poll(() => backend.llmUpdates.length).toBeGreaterThan(updatesBeforeRename)
    const renamedUpdate = backend.llmUpdates.at(-1)!
    expect(Object.keys(renamedUpdate.providers)).toContain('OpenRouter')
    expect(renamedUpdate.providers).not.toHaveProperty('OpenRouter Display Renamed')
    expect(renamedUpdate.providers.OpenRouter!.provider_instance_id).toBe(
      initialOpenRouterProviderId,
    )
    expect(backend.llmConfig.providers.OpenRouter).toMatchObject({
      provider_instance_id: initialOpenRouterProviderId,
      api_key: '****test',
    })
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'settings-embedding-model-chips',
      '.hc-provider__card',
    )

    for (const modelId of modelIds) {
      await providerCard
        .locator('.hc-model-chip--embedding')
        .filter({ hasText: modelId })
        .getByRole('button', { name: `删除 ${modelId}` })
        .click()
    }
    await expect(providerCard.locator('.hc-model-chip--embedding')).toHaveCount(0)
    await expect(activeChatChip).toContainText('Chat Model')
    await expect(defaultModel).toContainText('Chat Model')
    expect(backend.capabilityProbeRequests).toEqual([])
    expect(backend.connectionProbeRequests).toEqual([])

    expectNoAxeViolations(audits)
  })

  test('Settings 新 Provider：服务端分配 canonical identity，回读后再次保存不漂移', async ({
    page,
  }) => {
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    await page.goto('/settings')

    await page.getByRole('button', { name: '添加服务商' }).click()
    const addPanel = page.locator('.hc-provider__add-panel')
    await expect(addPanel).toBeVisible()
    await addPanel.getByRole('combobox').click()
    await page.getByRole('option', { name: 'DeepSeek', exact: true }).click()
    await addPanel.getByRole('button', { name: '确认', exact: true }).click()

    const providerCard = page.locator('.hc-provider__card[data-provider-type="deepseek"]')
    await expect(providerCard).toBeVisible()

    await expect
      .poll(() => backend.llmUpdates.find((update) => update.providers.DeepSeek))
      .toBeTruthy()
    const createUpdate = backend.llmUpdates.find((update) => update.providers.DeepSeek)!
    expect(createUpdate.providers.DeepSeek!.provider_instance_id).toBeUndefined()
    expect(createUpdate.providers.DeepSeek!.api_key).toBe('')
    await expect.poll(() => backend.canonicalLLMReadbacks).toBeGreaterThan(0)

    const assignedProviderId = backend.llmConfig.providers.DeepSeek!.provider_instance_id
    expect(assignedProviderId).toMatch(canonicalProviderIdPattern)
    expect(assignedProviderId).not.toBe(initialOpenRouterProviderId)

    const updatesAfterCanonicalReadback = backend.llmUpdates.length
    await providerCard.locator('[data-provider-field="api-key"]').fill('sk-e2e-provider-secret')
    await expect.poll(() => backend.llmUpdates.length).toBeGreaterThan(updatesAfterCanonicalReadback)
    const keyUpdate = backend.llmUpdates.at(-1)!
    expect(keyUpdate.providers.DeepSeek!.provider_instance_id).toBe(assignedProviderId)
    expect(keyUpdate.providers.DeepSeek!.api_key).toBe('sk-e2e-provider-secret')
    expect(backend.llmConfig.providers.DeepSeek!.api_key).toBe('****cret')

    const updatesAfterMaskedReadback = backend.llmUpdates.length
    await providerCard
      .locator('[data-provider-field="base-url"]')
      .fill('https://api.deepseek.com/v1/compatible')
    await expect.poll(() => backend.llmUpdates.length).toBeGreaterThan(updatesAfterMaskedReadback)

    const secondUpdate = backend.llmUpdates.at(-1)!
    expect(Object.keys(secondUpdate.providers)).toContain('DeepSeek')
    expect(secondUpdate.providers.DeepSeek!.provider_instance_id).toBe(assignedProviderId)
    expect(backend.llmConfig.providers.DeepSeek).toMatchObject({
      provider_instance_id: assignedProviderId,
      api_key: '****cret',
      base_url: 'https://api.deepseek.com/v1/compatible',
    })
    expect(backend.llmConfig.default).toBe('OpenRouter')
  })

  test('@a11y 深色主题下卡片、模型 listbox 与取消弹窗满足同一 WCAG 门禁', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('hc-theme', 'dark'))
    const audits: AxeAudit[] = []
    const backend = new SemanticIndexBackend()
    await backend.install(page)
    const semantic = new SemanticIndexPage(page)
    await semantic.goto()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await semantic.expand()

    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-card-expanded-dark',
      '[data-testid="kb-semantic-index-card"]',
    )

    await semantic.openModels()
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-model-listbox-dark',
      '.kb-profile-select__popover',
    )

    await page.getByRole('option', { name: /text-embedding-3-small/ }).click()
    await expect.poll(() => backend.applyRequests.length).toBe(1)
    await page.getByTestId('kb-semantic-index-cancel').click()
    const dialog = page.getByRole('dialog', { name: '取消本次重建？' })
    await expect(dialog).toBeFocused()
    await collectAxeAudit(
      page,
      testInfo,
      audits,
      'semantic-cancel-dialog-dark',
      '.kb-rebuild-dialog__overlay',
    )

    expectNoAxeViolations(audits)
  })
})
