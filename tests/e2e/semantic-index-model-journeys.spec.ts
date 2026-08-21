import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import type {
  EmbeddingSelection,
  KnowledgeEmbeddingPolicyProjection,
  KnowledgeEmbeddingProfile,
} from '../../src/api/knowledge-index'
import type { BackendLLMConfig } from '../../src/types/settings'

const initialOpenRouterProviderId = 'pvd_v1_11111111111111111111111111111111'
const canonicalProviderIdPattern = /^pvd_v1_[0-9a-f]{32}$/
const knowledgeReferenceURL =
  process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const loopbackHosts = new Set(['127.0.0.1', 'localhost'])

function isLoopbackHTTPURL(url: URL) {
  return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHosts.has(url.hostname)
}

function assertLoopbackHTTPURL(value: string, label: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a loopback HTTP(S) URL, received ${value}`)
  }
  if (!isLoopbackHTTPURL(url)) {
    throw new Error(`${label} must be a loopback HTTP(S) URL, received ${value}`)
  }
}

async function installLoopbackOnlyNetworkGuard(page: Page, externalAttempts: string[]) {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (isLoopbackHTTPURL(url)) return route.fallback()
    externalAttempts.push(url.toString())
    return route.abort('blockedbyclient')
  })
}

assertLoopbackHTTPURL(knowledgeReferenceURL, 'HEX_UI_REFERENCE_URL')

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

test('语义索引视觉网络护栏只接受 loopback HTTP(S) 端点', async ({ page }) => {
  expect(() =>
    assertLoopbackHTTPURL('http://127.0.0.1:5187/knowledge', 'implementation'),
  ).not.toThrow()
  expect(() => assertLoopbackHTTPURL('https://localhost:16070/app.html', 'reference')).not.toThrow()
  expect(() => assertLoopbackHTTPURL('https://example.invalid/app.html', 'reference')).toThrow(
    /loopback HTTP\(S\)/,
  )
  expect(() => assertLoopbackHTTPURL('file:///tmp/app.html', 'reference')).toThrow(
    /loopback HTTP\(S\)/,
  )

  const externalAttempts: string[] = []
  await installLoopbackOnlyNetworkGuard(page, externalAttempts)
  await expect(page.goto('https://example.invalid/semantic-index-visual-guard')).rejects.toThrow(
    /ERR_/,
  )
  expect(externalAttempts).toEqual(['https://example.invalid/semantic-index-visual-guard'])
})

class SemanticIndexBackend {
  policy = readyPolicy()
  documents: Array<Record<string, unknown>> = []
  operations: Array<Record<string, unknown>> = []
  readonly reindexRequests: string[] = []
  documentReindexJobState: 'queued' | 'succeeded' = 'queued'
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
  readonly externalAttempts: string[] = []
  private pull = deferred<PullResolution>()
  private reindexAcceptance = deferred<void>()
  private nextProviderSequence = 2
  private retryJobSequence = 0
  private hasUnreadLLMUpdate = false

  async install(page: Page) {
    await installLoopbackOnlyNetworkGuard(page, this.externalAttempts)
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

  acceptDocumentReindex() {
    this.reindexAcceptance.resolve()
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

  setFailedDesired(selection: EmbeddingSelection) {
    this.policy = {
      ...readyPolicy(),
      policy_version: 8,
      selection: structuredClone(selection),
      desired_revision: {
        revision_id: 'rev-cloud-failed',
        job_id: 'job-cloud-failed',
        state: 'failed',
        profile: structuredClone(cloudOpenAI),
        chunks_done: 41,
        chunks_total: 225,
      },
      indexing_activity: {
        state: 'failed',
        processing_documents: 0,
        chunks_done: 41,
        chunks_total: 225,
      },
    }
  }

  setReindexableDocument() {
    this.reindexAcceptance = deferred<void>()
    this.documents = [
      {
        id: 'doc-reindex',
        title: '产品 FAQ.md',
        content: '产品知识库正文',
        source: 'manual:fixture',
        source_type: 'manual',
        status: 'indexed',
        chunk_count: 8,
        created_at: '2026-08-20T09:00:00.000Z',
        updated_at: '2026-08-20T09:00:00.000Z',
        vector_index_state: 'ready',
      },
    ]
    this.documentReindexJobState = 'queued'
  }

  setCancellableUpload() {
    this.operations = [
      {
        operation_id: 'operation-upload-cancel',
        job_id: 'job-upload-cancel',
        document_id: 'doc-upload-cancel',
        title: '白板流程图.png',
        display_name: '白板流程图.png',
        state: 'running',
        stage: 'embedding',
        terminal: false,
        created_at: '2026-08-20T09:00:00.000Z',
        updated_at: '2026-08-20T09:00:00.000Z',
      },
    ]
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
        api_key: this.maskApiKey(incomingProvider.api_key, previousProvider?.api_key ?? ''),
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
      this.capabilityProbeRequests.push(
        `${url.searchParams.get('provider')}:${url.searchParams.get('model')}`,
      )
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
      return this.json(route, {
        documents: structuredClone(this.documents),
        total: this.documents.length,
        limit: 20,
        offset: 0,
        sources: [],
      })
    }
    if (path === '/api/v1/knowledge/operations' && method === 'GET') {
      return this.json(route, { operations: structuredClone(this.operations) })
    }
    const documentMatch = path.match(/^\/api\/v1\/knowledge\/documents\/([^/]+)$/)
    if (documentMatch && method === 'GET') {
      const documentId = decodeURIComponent(documentMatch[1]!)
      const document = this.documents.find((candidate) => candidate.id === documentId)
      return this.json(route, document ?? { error: 'not found' }, document ? 200 : 404)
    }
    const reindexMatch = path.match(/^\/api\/v1\/knowledge\/documents\/([^/]+)\/reindex$/)
    if (reindexMatch && method === 'POST') {
      const documentId = decodeURIComponent(reindexMatch[1]!)
      this.reindexRequests.push(documentId)
      this.documents = this.documents.map((document) =>
        document.id === documentId
          ? {
              ...document,
              vector_index_state: 'pending',
              vector_job_id: 'job-document-reindex',
              vector_job_state: 'queued',
            }
          : document,
      )
      this.documentReindexJobState = 'queued'
      await this.reindexAcceptance.promise
      return this.json(route, { status: 'indexed' })
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
      const retrySuffix =
        this.policy.desired_revision?.state === 'failed' ? `-retry-${++this.retryJobSequence}` : ''
      const jobId = target ? `job-${target.profile_id}${retrySuffix}` : 'job-auto'
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
      this.operations = this.operations.map((operation) =>
        operation.job_id === jobId
          ? {
              ...operation,
              state: 'cancelled',
              terminal: true,
              updated_at: '2026-08-20T09:00:01.000Z',
            }
          : operation,
      )
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
      const jobId = decodeURIComponent(jobMatch[1]!)
      if (jobId === 'job-document-reindex') {
        this.documentReindexJobState = 'succeeded'
        this.documents = this.documents.map((document) =>
          document.id === 'doc-reindex'
            ? {
                ...document,
                vector_index_state: 'ready',
                vector_job_state: 'succeeded',
              }
            : document,
        )
        return this.json(route, {
          job_id: jobId,
          state: this.documentReindexJobState,
          stage: 'embedding',
          pages_done: null,
          pages_total: null,
          chunks_done: 8,
          chunks_total: 8,
        })
      }
      return this.json(route, {
        job_id: jobId,
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
  test('文档重建：先显示读取权威状态，再以同文档 Job 投影显示后台语义增强', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const backend = new SemanticIndexBackend()
    backend.setReindexableDocument()
    await backend.install(page)
    await page.goto('/knowledge')
    await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 10_000 })

    const documentRail = page.locator('.knowledge-page__scroll')
    await expect(documentRail).toHaveCSS('padding-left', '26px')
    await expect(documentRail).toHaveCSS('padding-right', '26px')

    const documentCard = page.getByTestId('knowledge-doc-card')
    const actions = documentCard.getByTestId('knowledge-doc-actions')
    const reindexButton = actions.getByRole('button', { name: '重建', exact: true })
    await expect(reindexButton).toBeEnabled()

    await reindexButton.click()
    await expect.poll(() => backend.reindexRequests).toEqual(['doc-reindex'])
    await expect(documentCard.getByTestId('knowledge-vector-status')).toContainText(
      '正在读取权威状态…',
    )
    await expect(documentCard.getByTestId('knowledge-document-badge')).toContainText('同步中')
    await expect(reindexButton).toHaveAttribute('aria-busy', 'true')
    await documentCard.screenshot({
      path: testInfo.outputPath('implementation-reindex-reading.png'),
    })
    const readingGeometry = await documentCard.evaluate((element) => {
      const button = Array.from(
        element.querySelectorAll<HTMLButtonElement>('[data-testid="knowledge-doc-actions"] button'),
      ).find((candidate) => candidate.textContent?.trim() === '重建')
      const status = element.querySelector('[data-testid="knowledge-vector-status"]')
      const badge = element.querySelector('[data-testid="knowledge-document-badge"]')
      const box = element.getBoundingClientRect()
      const styles = getComputedStyle(element)
      const part = (selector: string) => {
        const node = element.querySelector<HTMLElement>(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const computed = getComputedStyle(node)
        return {
          x: rect.x - box.x,
          y: rect.y - box.y,
          width: rect.width,
          height: rect.height,
          padding: computed.padding,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
        }
      }
      return {
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        status: status?.textContent?.trim() ?? '',
        badge: badge?.textContent?.trim() ?? '',
        buttonDisabled: button?.disabled ?? false,
        ariaBusy: button?.getAttribute('aria-busy') ?? '',
        display: styles.display,
        background: styles.backgroundColor,
        borderRadius: styles.borderRadius,
        padding: styles.padding,
        fontSize: styles.fontSize,
        parts: {
          file: part('.knowledge-page__resource-file'),
          title: part('.knowledge-page__resource-title'),
          status: part('[data-testid="knowledge-vector-status"]'),
          badge: part('[data-testid="knowledge-document-badge"]'),
          actions: part('[data-testid="knowledge-doc-actions"]'),
          reindex: part('[data-testid="knowledge-doc-actions"] button:nth-of-type(2)'),
        },
      }
    })
    const readingGeometryJSON = JSON.stringify(readingGeometry, null, 2)
    await writeFile(testInfo.outputPath('reindex-reading-geometry.json'), readingGeometryJSON)
    await testInfo.attach('reindex-reading-geometry.json', {
      body: readingGeometryJSON,
      contentType: 'application/json',
    })

    const referencePage = await page.context().newPage()
    await referencePage.setViewportSize({ width: 1440, height: 1000 })
    await referencePage.goto(knowledgeReferenceURL)
    await referencePage.locator('.sb-item[data-screen="knowledge"]').click()
    const referenceButton = referencePage.locator('[data-kb-reindex-button]')
    await expect(referenceButton).toBeVisible()
    await referenceButton.click()
    const referenceRow = referenceButton.locator(
      'xpath=ancestor::*[contains(@class,"resource-row")]',
    )
    await expect(referenceRow.locator('[data-kb-reindex-status]')).toHaveText('正在读取权威状态…')
    await expect(referenceRow.locator('[data-kb-reindex-badge]')).toHaveText('同步中')

    const referencePath = testInfo.outputPath('reference-reindex-reading.png')
    const implementationPath = testInfo.outputPath('implementation-reindex-reading.png')
    const pixelDiffPath = testInfo.outputPath('pixel-diff-reindex-reading.png')
    await referenceRow.screenshot({ path: referencePath, animations: 'disabled' })
    const referenceGeometry = await referenceRow.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const status = element.querySelector<HTMLElement>('[data-kb-reindex-status]')
      const badge = element.querySelector<HTMLElement>('[data-kb-reindex-badge]')
      const button = element.querySelector<HTMLButtonElement>('[data-kb-reindex-button]')
      const badgeStyle = badge ? getComputedStyle(badge) : null
      const buttonStyle = button ? getComputedStyle(button) : null
      return {
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        status: status?.textContent?.trim() ?? '',
        badge: badge?.textContent?.trim() ?? '',
        badgeColor: badgeStyle?.color ?? '',
        badgeBackground: badgeStyle?.backgroundColor ?? '',
        buttonColor: buttonStyle?.color ?? '',
        buttonOpacity: buttonStyle?.opacity ?? '',
      }
    })
    const implementationStyle = await documentCard.evaluate((element) => {
      const badge = element.querySelector<HTMLElement>('[data-testid="knowledge-document-badge"]')
      const buttons = Array.from(
        element.querySelectorAll<HTMLButtonElement>('[data-testid="knowledge-doc-actions"] button'),
      )
      const button = buttons.find((candidate) => candidate.textContent?.trim() === '重建')
      const badgeStyle = badge ? getComputedStyle(badge) : null
      const buttonStyle = button ? getComputedStyle(button) : null
      return {
        badgeColor: badgeStyle?.color ?? '',
        badgeBackground: badgeStyle?.backgroundColor ?? '',
        buttonColor: buttonStyle?.color ?? '',
        buttonOpacity: buttonStyle?.opacity ?? '',
      }
    })
    const referencePNG = await readFile(referencePath)
    const implementationPNG = await readFile(implementationPath)
    const pixelDiff = await referencePage.evaluate(
      async ({ reference, implementation, threshold }) => {
        const loadImage = (source: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => reject(new Error('Unable to decode screenshot'))
            image.src = source
          })
        const [referenceImage, implementationImage] = await Promise.all([
          loadImage(reference),
          loadImage(implementation),
        ])
        if (
          referenceImage.width !== implementationImage.width ||
          referenceImage.height !== implementationImage.height
        ) {
          throw new Error(
            `Screenshot size mismatch: reference=${referenceImage.width}x${referenceImage.height}, implementation=${implementationImage.width}x${implementationImage.height}`,
          )
        }
        const width = referenceImage.width
        const height = referenceImage.height
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas 2D context is unavailable')
        context.drawImage(referenceImage, 0, 0)
        const referencePixels = context.getImageData(0, 0, width, height)
        context.clearRect(0, 0, width, height)
        context.drawImage(implementationImage, 0, 0)
        const implementationPixels = context.getImageData(0, 0, width, height)
        const diff = context.createImageData(width, height)
        let changedPixels = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let index = 0; index < referencePixels.data.length; index += 4) {
          const changed =
            Math.abs(referencePixels.data[index] - implementationPixels.data[index]) > threshold ||
            Math.abs(referencePixels.data[index + 1] - implementationPixels.data[index + 1]) >
              threshold ||
            Math.abs(referencePixels.data[index + 2] - implementationPixels.data[index + 2]) >
              threshold
          const pixel = index / 4
          const x = pixel % width
          const y = Math.floor(pixel / width)
          if (changed) {
            changedPixels += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
            diff.data[index] = 255
            diff.data[index + 1] = 35
            diff.data[index + 2] = 35
          } else {
            const gray = Math.round(
              referencePixels.data[index] * 0.299 +
                referencePixels.data[index + 1] * 0.587 +
                referencePixels.data[index + 2] * 0.114,
            )
            const dimmed = Math.round(gray * 0.45)
            diff.data[index] = dimmed
            diff.data[index + 1] = dimmed
            diff.data[index + 2] = dimmed
          }
          diff.data[index + 3] = 255
        }
        context.putImageData(diff, 0, 0)
        return {
          width,
          height,
          threshold,
          changed_pixels: changedPixels,
          total_pixels: width * height,
          changed_pixel_ratio: width * height ? changedPixels / (width * height) : 0,
          changed_bbox: maxX >= 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
          diff_data_url: canvas.toDataURL('image/png'),
        }
      },
      {
        reference: `data:image/png;base64,${referencePNG.toString('base64')}`,
        implementation: `data:image/png;base64,${implementationPNG.toString('base64')}`,
        threshold: 8,
      },
    )
    await writeFile(
      pixelDiffPath,
      Buffer.from(pixelDiff.diff_data_url.replace(/^data:image\/png;base64,/, ''), 'base64'),
    )
    const { diff_data_url: diffDataURL, ...pixelDiffSummary } = pixelDiff
    void diffDataURL
    const comparisonJSON = JSON.stringify(
      {
        reference: referenceGeometry,
        implementation: { ...readingGeometry, ...implementationStyle },
        pixelDiff: pixelDiffSummary,
      },
      null,
      2,
    )
    await writeFile(testInfo.outputPath('reference-reindex-reading-geometry.json'), comparisonJSON)
    for (const [name, file] of [
      ['reference-reindex-reading', referencePath],
      ['implementation-reindex-reading', implementationPath],
      ['pixel-diff-reindex-reading', pixelDiffPath],
    ] as const) {
      await testInfo.attach(name, { body: await readFile(file), contentType: 'image/png' })
    }
    await testInfo.attach('reference-reindex-reading-geometry', {
      body: comparisonJSON,
      contentType: 'application/json',
    })
    expect(referenceGeometry.box.width).toBe(readingGeometry.box.width)
    expect(referenceGeometry.box.height).toBe(readingGeometry.box.height)
    expect(implementationStyle).toEqual({
      badgeColor: referenceGeometry.badgeColor,
      badgeBackground: referenceGeometry.badgeBackground,
      buttonColor: referenceGeometry.buttonColor,
      buttonOpacity: referenceGeometry.buttonOpacity,
    })
    expect(pixelDiffSummary.changed_pixel_ratio).toBeLessThanOrEqual(0.001)
    await referencePage.close()

    backend.acceptDocumentReindex()
    await expect(documentCard.getByTestId('knowledge-vector-status')).toContainText(
      '语义增强等待中',
    )
    await expect(documentCard.getByTestId('knowledge-document-badge')).toContainText('增强中')
    await expect(actions.getByTestId('knowledge-vector-cancel')).toBeVisible()
    await expect(reindexButton).toBeDisabled()

    await documentCard.screenshot({
      path: testInfo.outputPath('implementation-reindex-pending.png'),
    })
    const geometry = await documentCard.evaluate((element) => {
      const button = Array.from(
        element.querySelectorAll<HTMLButtonElement>('[data-testid="knowledge-doc-actions"] button'),
      ).find((candidate) => candidate.textContent?.trim() === '重建')
      const status = element.querySelector('[data-testid="knowledge-vector-status"]')
      const box = element.getBoundingClientRect()
      return {
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        status: status?.textContent?.trim() ?? '',
        buttonDisabled: button?.disabled ?? false,
        display: getComputedStyle(element).display,
      }
    })
    const geometryJSON = JSON.stringify(geometry, null, 2)
    await writeFile(testInfo.outputPath('reindex-pending-geometry.json'), geometryJSON)
    await testInfo.attach('reindex-pending-geometry.json', {
      body: geometryJSON,
      contentType: 'application/json',
    })
    expect(geometry.box.height).toBeLessThanOrEqual(54)

    await page.waitForTimeout(4_100)
    await expect.poll(() => backend.documentReindexJobState).toBe('succeeded')
    await expect(reindexButton).toBeEnabled()
  })

  test('临时上传进行中可取消，取消后不会残留在队列', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const backend = new SemanticIndexBackend()
    backend.setCancellableUpload()
    await backend.install(page)
    await page.goto('/knowledge')
    await expect(page.locator('#splash-screen')).toHaveCount(0, { timeout: 10_000 })

    const uploadRow = page.getByTestId('knowledge-upload-job')
    const uploadCancel = uploadRow.getByTestId('knowledge-upload-cancel')
    await expect(uploadRow).toBeVisible()
    await expect(uploadRow).toContainText('白板流程图.png')
    await expect(uploadRow).toContainText('增强中')
    await expect(uploadCancel).toHaveText('取消')

    const implementationPath = testInfo.outputPath('implementation-upload-processing.png')
    await uploadRow.screenshot({ path: implementationPath, animations: 'disabled' })
    const implementation = await uploadRow.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const badge = element.querySelector<HTMLElement>('.knowledge-page__resource-badge')
      const action = element.querySelector<HTMLButtonElement>(
        '[data-testid="knowledge-upload-cancel"]',
      )
      const snapshotStyle = (node: HTMLElement | null) => {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          box: { x: rect.x - box.x, y: rect.y - box.y, width: rect.width, height: rect.height },
          color: style.color,
          background: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          opacity: style.opacity,
        }
      }
      return {
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        badge: {
          text: badge?.textContent?.trim() ?? '',
          style: snapshotStyle(badge),
        },
        action: {
          text: action?.textContent?.trim() ?? '',
          style: snapshotStyle(action),
        },
      }
    })

    const referencePage = await page.context().newPage()
    await referencePage.setViewportSize({ width: 1440, height: 1000 })
    await referencePage.goto(knowledgeReferenceURL)
    await referencePage.locator('.sb-item[data-screen="knowledge"]').click()
    const referenceRow = referencePage.locator('[data-kb-upload-temporary]')
    const referenceActions = referenceRow.locator('button')
    await expect(referenceRow).toBeVisible()
    await expect(referenceRow).toContainText('增强中')
    expect(await referenceActions.allTextContents()).toEqual(['取消'])
    const referencePath = testInfo.outputPath('reference-upload-processing.png')
    await referenceRow.screenshot({ path: referencePath, animations: 'disabled' })
    const reference = await referenceRow.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const badge = element.querySelector<HTMLElement>('.pill')
      const action = Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === '取消',
      )
      const snapshotStyle = (node: HTMLElement | null) => {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          box: { x: rect.x - box.x, y: rect.y - box.y, width: rect.width, height: rect.height },
          color: style.color,
          background: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          padding: style.padding,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          opacity: style.opacity,
        }
      }
      return {
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        badge: {
          text: badge?.textContent?.trim() ?? '',
          style: snapshotStyle(badge),
        },
        action: {
          text: action?.textContent?.trim() ?? '',
          style: snapshotStyle(action),
        },
      }
    })
    const pixelDiffPath = testInfo.outputPath('pixel-diff-upload-processing.png')
    const referencePNG = await readFile(referencePath)
    const implementationPNG = await readFile(implementationPath)
    const pixelDiff = await referencePage.evaluate(
      async ({ reference, implementation, threshold }) => {
        const loadImage = (source: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = () => reject(new Error('Unable to decode screenshot'))
            image.src = source
          })
        const [referenceImage, implementationImage] = await Promise.all([
          loadImage(reference),
          loadImage(implementation),
        ])
        if (
          referenceImage.width !== implementationImage.width ||
          referenceImage.height !== implementationImage.height
        ) {
          throw new Error(
            `Screenshot size mismatch: reference=${referenceImage.width}x${referenceImage.height}, implementation=${implementationImage.width}x${implementationImage.height}`,
          )
        }
        const width = referenceImage.width
        const height = referenceImage.height
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas 2D context is unavailable')
        context.drawImage(referenceImage, 0, 0)
        const referencePixels = context.getImageData(0, 0, width, height)
        context.clearRect(0, 0, width, height)
        context.drawImage(implementationImage, 0, 0)
        const implementationPixels = context.getImageData(0, 0, width, height)
        const diff = context.createImageData(width, height)
        let changedPixels = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let index = 0; index < referencePixels.data.length; index += 4) {
          const changed =
            Math.abs(referencePixels.data[index] - implementationPixels.data[index]) > threshold ||
            Math.abs(referencePixels.data[index + 1] - implementationPixels.data[index + 1]) >
              threshold ||
            Math.abs(referencePixels.data[index + 2] - implementationPixels.data[index + 2]) >
              threshold
          const pixel = index / 4
          const x = pixel % width
          const y = Math.floor(pixel / width)
          if (changed) {
            changedPixels += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
            diff.data[index] = 255
            diff.data[index + 1] = 35
            diff.data[index + 2] = 35
          } else {
            const gray = Math.round(
              referencePixels.data[index] * 0.299 +
                referencePixels.data[index + 1] * 0.587 +
                referencePixels.data[index + 2] * 0.114,
            )
            const dimmed = Math.round(gray * 0.45)
            diff.data[index] = dimmed
            diff.data[index + 1] = dimmed
            diff.data[index + 2] = dimmed
          }
          diff.data[index + 3] = 255
        }
        context.putImageData(diff, 0, 0)
        return {
          width,
          height,
          threshold,
          changed_pixels: changedPixels,
          total_pixels: width * height,
          changed_pixel_ratio: width * height ? changedPixels / (width * height) : 0,
          changed_bbox: maxX >= 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
          diff_data_url: canvas.toDataURL('image/png'),
        }
      },
      {
        reference: `data:image/png;base64,${referencePNG.toString('base64')}`,
        implementation: `data:image/png;base64,${implementationPNG.toString('base64')}`,
        threshold: 8,
      },
    )
    await writeFile(
      pixelDiffPath,
      Buffer.from(pixelDiff.diff_data_url.replace(/^data:image\/png;base64,/, ''), 'base64'),
    )
    const { diff_data_url: diffDataURL, ...pixelDiffSummary } = pixelDiff
    void diffDataURL

    // 临时上传行只暴露可安全执行的取消操作；同态文本、badge、操作与像素均需一致。
    const comparison = {
      state: 'upload-processing-cancellable',
      viewport: { width: 1440, height: 1000, dpr: 1, locale: 'zh-CN', theme: 'light' },
      comparable: 'full',
      reference,
      implementation,
      pixelDiff: pixelDiffSummary,
    }
    const comparisonJSON = JSON.stringify(comparison, null, 2)
    await writeFile(testInfo.outputPath('comparison-upload-processing.json'), comparisonJSON)
    for (const [name, file] of [
      ['reference-upload-processing', referencePath],
      ['implementation-upload-processing', implementationPath],
      ['pixel-diff-upload-processing', pixelDiffPath],
    ] as const) {
      await testInfo.attach(name, { body: await readFile(file), contentType: 'image/png' })
    }
    await testInfo.attach('comparison-upload-processing', {
      body: comparisonJSON,
      contentType: 'application/json',
    })
    expect(implementation.box.width).toBe(reference.box.width)
    expect(implementation.box.height).toBe(reference.box.height)
    expect(implementation.text).toBe(reference.text)
    expect(implementation.badge).toEqual(reference.badge)
    expect(implementation.action).toEqual(reference.action)
    expect(pixelDiffSummary.changed_pixel_ratio).toBeLessThanOrEqual(0.001)

    await uploadCancel.click()
    await expect.poll(() => backend.cancelledJobIds).toEqual(['job-upload-cancel'])
    await expect(page.getByTestId('knowledge-upload-job')).toHaveCount(0)

    await referencePage.evaluate(() => {
      const projection = (
        window as Window & {
          applyKnowledgeUploadQueueProjection?: (entries: Array<Record<string, unknown>>) => void
        }
      ).applyKnowledgeUploadQueueProjection
      if (!projection) throw new Error('Missing prototype upload queue projection')
      projection([{ id: 'kb-upload-whiteboard-001', terminal: 'cancelled' }])
    })
    await expect(referencePage.locator('[data-kb-upload-temporary]')).toHaveCount(0)
    const cancellationJSON = JSON.stringify(
      {
        state: 'upload-cancelled',
        implementationTemporaryRows: await page.getByTestId('knowledge-upload-job').count(),
        referenceTemporaryRows: await referencePage.locator('[data-kb-upload-temporary]').count(),
      },
      null,
      2,
    )
    await writeFile(testInfo.outputPath('upload-cancelled-queue.json'), cancellationJSON)
    await testInfo.attach('upload-cancelled-queue', {
      body: cancellationJSON,
      contentType: 'application/json',
    })
    await referencePage.close()
  })

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

  test('语义索引重试：三种权威状态的按钮 exact-set、键盘与成对视觉证据', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.addInitScript(() => localStorage.setItem('hc-theme', 'light'))
    const backend = new SemanticIndexBackend()
    await backend.install(page)

    const states = [
      {
        id: 'failed-profile-match',
        setup: () => backend.setFailedDesired({ kind: 'profile', profile_id: 'cloud-openai' }),
        prototype: {
          selectionKind: 'profile',
          selectedProfileId: 'cloud-fast',
          vectorState: 'failed',
        },
        actions: ['取消重建', '重试'],
        capturedAction: '重试',
        retries: 1,
      },
      {
        id: 'retry-wait',
        setup: () => backend.setRetryWaiting(),
        prototype: {
          selectionKind: 'profile',
          selectedProfileId: 'cloud-fast',
          vectorState: 'retry_wait',
        },
        actions: ['取消重建'],
        capturedAction: '取消重建',
        retries: 0,
      },
      {
        id: 'failed-auto',
        setup: () => backend.setFailedDesired({ kind: 'auto' }),
        prototype: { selectionKind: 'auto', selectedProfileId: null, vectorState: 'failed' },
        actions: ['取消重建'],
        capturedAction: '取消重建',
        retries: 0,
      },
    ] as const
    const visualResiduals: Array<Record<string, unknown>> = []

    const captureContext = async (
      targetPage: Page,
      rowSelector: string,
      stateSelector: string,
      selectorSelector: string,
    ) =>
      targetPage.evaluate(
        ({ rowSelector, stateSelector, selectorSelector }) => {
          const row = document.querySelector<HTMLElement>(rowSelector)
          const state = document.querySelector<HTMLElement>(stateSelector)
          const selector = document.querySelector<HTMLElement>(selectorSelector)
          if (!row || !state || !selector) throw new Error('Missing semantic visual target')
          const rowBox = row.getBoundingClientRect()
          const selectorBox = selector.getBoundingClientRect()
          const stateBox = state.getBoundingClientRect()
          const toBox = (rect: DOMRect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })
          const actionStyle = (button: HTMLButtonElement) => {
            const rect = button.getBoundingClientRect()
            const style = getComputedStyle(button)
            return {
              text: button.textContent?.trim() ?? '',
              tagName: button.tagName,
              box: {
                x: rect.x - rowBox.x,
                y: rect.y - rowBox.y,
                width: rect.width,
                height: rect.height,
              },
              style: {
                color: style.color,
                background: style.backgroundColor,
                borderColor: style.borderColor,
                borderRadius: style.borderRadius,
                padding: style.padding,
                margin: style.margin,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                opacity: style.opacity,
              },
            }
          }
          return {
            row: toBox(rowBox),
            state: { text: state.textContent?.trim() ?? '', box: toBox(stateBox) },
            selector: {
              text: selector.textContent?.replace(/\s+/g, ' ').trim() ?? '',
              disabled:
                selector.getAttribute('aria-disabled') === 'true' ||
                (selector instanceof HTMLButtonElement && selector.disabled),
              box: toBox(selectorBox),
            },
            actions: Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
              .filter((button) => !button.hidden && getComputedStyle(button).display !== 'none')
              .map(actionStyle),
          }
        },
        { rowSelector, stateSelector, selectorSelector },
      )

    const createPixelDiff = async (
      referencePage: Page,
      referencePath: string,
      implementationPath: string,
      pixelDiffPath: string,
    ) => {
      const [referencePNG, implementationPNG] = await Promise.all([
        readFile(referencePath),
        readFile(implementationPath),
      ])
      const pixelDiff = await referencePage.evaluate(
        async ({ reference, implementation }) => {
          const loadImage = (source: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image()
              image.onload = () => resolve(image)
              image.onerror = () => reject(new Error('Unable to decode screenshot'))
              image.src = source
            })
          const [referenceImage, implementationImage] = await Promise.all([
            loadImage(reference),
            loadImage(implementation),
          ])
          const width = Math.max(referenceImage.width, implementationImage.width)
          const height = Math.max(referenceImage.height, implementationImage.height)
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (!context) throw new Error('Canvas 2D context is unavailable')
          context.drawImage(referenceImage, 0, 0)
          const referencePixels = context.getImageData(0, 0, width, height)
          context.clearRect(0, 0, width, height)
          context.drawImage(implementationImage, 0, 0)
          const implementationPixels = context.getImageData(0, 0, width, height)
          const diff = context.createImageData(width, height)
          let changedPixels = 0
          let minX = width
          let minY = height
          let maxX = -1
          let maxY = -1
          for (let index = 0; index < referencePixels.data.length; index += 4) {
            const changed =
              Math.abs(referencePixels.data[index] - implementationPixels.data[index]) > 8 ||
              Math.abs(referencePixels.data[index + 1] - implementationPixels.data[index + 1]) >
                8 ||
              Math.abs(referencePixels.data[index + 2] - implementationPixels.data[index + 2]) > 8
            const pixel = index / 4
            const x = pixel % width
            const y = Math.floor(pixel / width)
            if (changed) {
              changedPixels += 1
              minX = Math.min(minX, x)
              minY = Math.min(minY, y)
              maxX = Math.max(maxX, x)
              maxY = Math.max(maxY, y)
              diff.data[index] = 255
              diff.data[index + 1] = 35
              diff.data[index + 2] = 35
            } else {
              const gray = Math.round(
                referencePixels.data[index] * 0.299 +
                  referencePixels.data[index + 1] * 0.587 +
                  referencePixels.data[index + 2] * 0.114,
              )
              const dimmed = Math.round(gray * 0.45)
              diff.data[index] = dimmed
              diff.data[index + 1] = dimmed
              diff.data[index + 2] = dimmed
            }
            diff.data[index + 3] = 255
          }
          context.putImageData(diff, 0, 0)
          return {
            reference_size: { width: referenceImage.width, height: referenceImage.height },
            implementation_size: {
              width: implementationImage.width,
              height: implementationImage.height,
            },
            changed_pixels: changedPixels,
            total_pixels: width * height,
            changed_pixel_ratio: width * height ? changedPixels / (width * height) : 0,
            changed_bbox: maxX >= 0 ? [minX, minY, maxX + 1, maxY + 1] : null,
            diff_data_url: canvas.toDataURL('image/png'),
          }
        },
        {
          reference: `data:image/png;base64,${referencePNG.toString('base64')}`,
          implementation: `data:image/png;base64,${implementationPNG.toString('base64')}`,
        },
      )
      await writeFile(
        pixelDiffPath,
        Buffer.from(pixelDiff.diff_data_url.replace(/^data:image\/png;base64,/, ''), 'base64'),
      )
      const { diff_data_url: diffDataURL, ...summary } = pixelDiff
      void diffDataURL
      return summary
    }

    for (const state of states) {
      state.setup()
      const implementationNetworkStart = backend.externalAttempts.length
      await page.goto('/knowledge')
      const semantic = new SemanticIndexPage(page)
      await expect(semantic.card).toBeVisible()
      await semantic.expand()

      const implementationRow = page.getByTestId('kb-semantic-index-actual')
      const visibleActionTexts = async (locator: ReturnType<Page['locator']>) =>
        locator.evaluateAll((buttons) =>
          buttons
            .filter(
              (button) =>
                !button.hidden &&
                getComputedStyle(button).display !== 'none' &&
                getComputedStyle(button).visibility !== 'hidden',
            )
            .map((button) => button.textContent?.trim() ?? ''),
        )
      const implementationActions = await visibleActionTexts(implementationRow.locator('button'))
      await expect(page.getByTestId('kb-semantic-index-retry-rebuild')).toHaveCount(state.retries)
      if (JSON.stringify(implementationActions) !== JSON.stringify(state.actions)) {
        visualResiduals.push({
          state: state.id,
          surface: 'implementation-actions',
          expected: state.actions,
          actual: implementationActions,
        })
      }

      const referencePage = await page.context().newPage()
      const referenceExternalAttempts: string[] = []
      await installLoopbackOnlyNetworkGuard(referencePage, referenceExternalAttempts)
      await referencePage.setViewportSize({ width: 1440, height: 1000 })
      await referencePage.goto(knowledgeReferenceURL)
      await referencePage.locator('.sb-item[data-screen="knowledge"]').click()
      const prototypeProjection = await referencePage.evaluate((prototype) => {
        const state = globalThis.eval('KB_EMBEDDING_STATE') as {
          selectionKind: string
          selectedProfileId: string | null
          pendingSelectionKind: string | null
          pendingProfileId: string | null
          vectorIndexState: string
          activeProfileId: string | null
          rebuild: { current: number; total: number }
        }
        state.selectionKind = prototype.selectionKind
        state.selectedProfileId = prototype.selectedProfileId
        state.pendingSelectionKind = prototype.selectionKind
        state.pendingProfileId = 'cloud-fast'
        state.vectorIndexState = prototype.vectorState
        state.activeProfileId = 'cloud-bge'
        state.rebuild.current = 41
        state.rebuild.total = 225
        const render = globalThis.eval('renderKbEmbeddingState') as () => void
        const expand = globalThis.eval('toggleKbIndexPanel') as (force: boolean) => void
        render()
        expand(true)
        return {
          selectionKind: state.selectionKind,
          selectedProfileId: state.selectedProfileId,
          pendingSelectionKind: state.pendingSelectionKind,
          pendingProfileId: state.pendingProfileId,
          vectorIndexState: state.vectorIndexState,
        }
      }, state.prototype)

      const referenceRow = referencePage.locator('.kb-active-line')
      const referenceActions = await visibleActionTexts(referenceRow.locator('button'))
      if (JSON.stringify(referenceActions) !== JSON.stringify(state.actions)) {
        visualResiduals.push({
          state: state.id,
          surface: 'reference-actions',
          expected: state.actions,
          actual: referenceActions,
          prototypeProjection,
        })
      }

      const referenceAction = referencePage.getByRole('button', {
        name: state.capturedAction,
        exact: true,
      })
      const implementationAction = page.getByRole('button', {
        name: state.capturedAction,
        exact: true,
      })
      await expect(referenceAction).toBeVisible()
      await expect(implementationAction).toBeVisible()

      const referencePath = testInfo.outputPath(`reference-semantic-retry-${state.id}.png`)
      const implementationPath = testInfo.outputPath(
        `implementation-semantic-retry-${state.id}.png`,
      )
      const pixelDiffPath = testInfo.outputPath(`pixel-diff-semantic-retry-${state.id}.png`)
      await referenceAction.screenshot({ path: referencePath, animations: 'disabled' })
      await implementationAction.screenshot({ path: implementationPath, animations: 'disabled' })
      const pixelDiff = await createPixelDiff(
        referencePage,
        referencePath,
        implementationPath,
        pixelDiffPath,
      )
      const [reference, implementation] = await Promise.all([
        captureContext(
          referencePage,
          '.kb-active-line',
          '#kbIndexStateLabel',
          '#kbModelSelectorButton',
        ),
        captureContext(
          page,
          '[data-testid="kb-semantic-index-actual"]',
          '.kb-index-card__actual-state',
          '[data-testid="kb-index-model-trigger"]',
        ),
      ])
      const implementationExternalAttempts = backend.externalAttempts.slice(
        implementationNetworkStart,
      )
      const comparisonJSON = JSON.stringify(
        {
          state: state.id,
          viewport: { width: 1440, height: 1000, dpr: 1, locale: 'zh-CN', theme: 'light' },
          comparable: 'semantic-action-control',
          prototypeProjection,
          network: {
            implementationExternalAttempts,
            referenceExternalAttempts,
          },
          reference,
          implementation,
          pixelDiff,
        },
        null,
        2,
      )
      await writeFile(
        testInfo.outputPath(`comparison-semantic-retry-${state.id}.json`),
        comparisonJSON,
      )
      for (const [name, file] of [
        [`reference-semantic-retry-${state.id}`, referencePath],
        [`implementation-semantic-retry-${state.id}`, implementationPath],
        [`pixel-diff-semantic-retry-${state.id}`, pixelDiffPath],
      ] as const) {
        await testInfo.attach(name, { body: await readFile(file), contentType: 'image/png' })
      }
      await testInfo.attach(`comparison-semantic-retry-${state.id}`, {
        body: comparisonJSON,
        contentType: 'application/json',
      })

      const implementationActionNames = implementation.actions.map((action) => action.text)
      const referenceActionNames = reference.actions.map((action) => action.text)
      if (JSON.stringify(implementationActionNames) !== JSON.stringify(state.actions)) {
        visualResiduals.push({
          state: state.id,
          surface: 'implementation-action-snapshot',
          expected: state.actions,
          actual: implementationActionNames,
        })
      }
      if (JSON.stringify(referenceActionNames) !== JSON.stringify(state.actions)) {
        visualResiduals.push({
          state: state.id,
          surface: 'reference-action-snapshot',
          expected: state.actions,
          actual: referenceActionNames,
          prototypeProjection,
        })
      }
      if (implementationExternalAttempts.length > 0 || referenceExternalAttempts.length > 0) {
        visualResiduals.push({
          state: state.id,
          surface: 'network',
          implementationExternalAttempts,
          referenceExternalAttempts,
        })
      }
      const implementationActionStyle = implementation.actions.find(
        (action) => action.text === state.capturedAction,
      )?.style
      const referenceActionStyle = reference.actions.find(
        (action) => action.text === state.capturedAction,
      )?.style
      if (JSON.stringify(implementationActionStyle) !== JSON.stringify(referenceActionStyle)) {
        visualResiduals.push({
          state: state.id,
          surface: 'action-computed-style',
          action: state.capturedAction,
          reference: referenceActionStyle,
          implementation: implementationActionStyle,
        })
      }
      if (pixelDiff.changed_pixel_ratio > 0.001) {
        visualResiduals.push({
          state: state.id,
          surface: 'pixel-diff',
          referenceSize: pixelDiff.reference_size,
          implementationSize: pixelDiff.implementation_size,
          changedPixelRatio: pixelDiff.changed_pixel_ratio,
          changedBBox: pixelDiff.changed_bbox,
        })
      }

      if (state.retries === 1) {
        await expect(implementationAction).toHaveAccessibleName('重试')
        await implementationAction.focus()
        await expect(implementationAction).toBeFocused()
        await implementationAction.press('Enter')
        await expect
          .poll(() => backend.applyRequests)
          .toEqual([
            {
              expected_policy_version: 8,
              selection: { kind: 'profile', profile_id: 'cloud-openai' },
            },
          ])
        expect(backend.cancelledJobIds).toEqual([])
        await expect(page.getByTestId('kb-semantic-index-retry-rebuild')).toHaveCount(0)
        await expect(page.getByTestId('kb-semantic-index-actual')).toContainText(
          '当前索引可用 · 新索引 0/225',
        )
      }
      await referencePage.close()
    }

    const visualSummary = JSON.stringify(
      {
        status: visualResiduals.length === 0 ? 'pass' : 'not-pass',
        comparable: 'semantic-action-control',
        residuals: visualResiduals,
      },
      null,
      2,
    )
    await writeFile(testInfo.outputPath('semantic-retry-visual-summary.json'), visualSummary)
    await testInfo.attach('semantic-retry-visual-summary', {
      body: visualSummary,
      contentType: 'application/json',
    })
    expect(visualResiduals, visualSummary).toEqual([])
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
    const defaultModel = page.locator(
      '[data-testid="llm-default-model-select"] .hc-select__trigger',
    )
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
      const embeddingChip = providerCard
        .locator('.hc-model-chip--embedding')
        .filter({ hasText: modelId })
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
    expect(openRouter.model_specs).toEqual(
      expect.arrayContaining([
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
      ]),
    )

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
    await expect
      .poll(() => backend.llmUpdates.length)
      .toBeGreaterThan(updatesAfterCanonicalReadback)
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
