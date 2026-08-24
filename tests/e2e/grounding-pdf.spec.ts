import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'
import {
  advanceKnowledgeLineage,
  readKnowledgeLineage,
  writeC07KnowledgeLineage,
} from '../../scripts/ci/k12-knowledge-lineage.mjs'
import { auditC09ContentOracleHit } from '../../scripts/ci/k12-c09-content-oracle.mjs'

/** KNOW-001..030 + E2E-PDF-001/002: immutable PDFs through visible UI and durable sidecar jobs. */
const KNOWLEDGE_LIVE = process.env.HEX_K12_KNOWLEDGE_LIVE === '1'
const SCAN_OCR_LIVE = KNOWLEDGE_LIVE && process.env.HEX_K12_SCAN_OCR_LIVE === '1'
const REAL_10X_CYCLE = process.env.HEX_K12_REAL_10X_CYCLE_ID
const PRESERVE_REAL_10X_KNOWLEDGE =
  REAL_10X_CYCLE === 'C07' || REAL_10X_CYCLE === 'C08' || REAL_10X_CYCLE === 'C09'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const CONTRACT_MANIFEST = resolve(process.cwd(), 'tests/fixtures/local/manifest.example.json')
const CONTRACT_VERIFIER = resolve(process.cwd(), 'tests/fixtures/local/verify-fixture.mjs')
const RAG_ORACLE_SOURCE = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'tests/fixtures/local/k12-textbook-rag-oracle.v1.json'),
    'utf8',
  ),
) as {
  pdfSha256: string
  query: string
  citation: {
    physicalPage: number
    normalizedTextSha256: string
    normalizedLength: number
    wholePdfExactOccurrences: number
  }
  extraction: { normalization: string }
}
const RAG_ORACLE = {
  ...RAG_ORACLE_SOURCE,
  embeddingModel: 'qwen3-embedding:8b',
} as const
const PDFS = {
  text: {
    manifestID: 'textbook_pdf',
    fixtureID: 'FX-PDF-G5B-TEXT-001',
    path:
      process.env.HEX_FIXTURE_TEXTBOOK_PDF ||
      resolve(DOCS_ROOT, 'test/义务教育教科书·数学五年级下册.pdf'),
    sha256: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    bytes: 14_621_452,
    pages: 131,
    grade: '五年级下',
    query: RAG_ORACLE.query,
  },
  scan: {
    manifestID: 'scanned_textbook_pdf',
    fixtureID: 'FX-PDF-G6A-SCAN-001',
    path:
      process.env.HEX_FIXTURE_SCANNED_TEXTBOOK_PDF ||
      resolve(DOCS_ROOT, 'test/人教版·小学六年级上册.pdf'),
    sha256: '65bd80bd35be524bf68f66f9b67820a97176e1487db81810cb268e04e44dd8b2',
    bytes: 57_313_616,
    pages: 122,
    grade: '六年级上',
    query: '圆的面积',
  },
} as const

type PDFContract = (typeof PDFS)[keyof typeof PDFS]
type Json = Record<string, unknown>

function real10xKnowledgeLineage() {
  expect(
    PRESERVE_REAL_10X_KNOWLEDGE,
    'only C07-C09 may consume the private knowledge lineage',
  ).toBe(true)
  const path = process.env.HEX_K12_REAL_10X_KNOWLEDGE_LINEAGE_PATH || ''
  const parentRunID = process.env.HEX_K12_REAL_10X_PARENT_RUN_ID || ''
  expect(isAbsolute(path), 'parent-owned knowledge lineage path must be absolute').toBe(true)
  expect(parentRunID, 'parent-owned knowledge lineage must bind one run').not.toBe('')
  return {
    root: dirname(path),
    path,
    parentRunSha256: createHash('sha256').update(parentRunID).digest('hex'),
  }
}

function record(value: unknown, label: string): Json {
  expect(value && typeof value === 'object' && !Array.isArray(value), label).toBe(true)
  return value as Json
}

function fileSHA(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifySource(fixture: PDFContract): void {
  const bytes = readFileSync(fixture.path)
  expect(statSync(fixture.path).isFile()).toBe(true)
  expect(bytes.length, `${fixture.fixtureID} byte count drift`).toBe(fixture.bytes)
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  expect(fileSHA(fixture.path), `${fixture.fixtureID} SHA drift`).toBe(fixture.sha256)
}

function nested(payload: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key]
    const metadata = payload.metadata
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const value = (metadata as Json)[key]
      if (value !== undefined) return value
    }
  }
  return undefined
}

async function createTutor(
  page: Page,
  childName: string,
  grade: string,
): Promise<{ agentID: string; learnerID: string }> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.k12pf__input').fill(childName)
  await dialog.locator('.hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: grade }).click()
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  const response = await page.request.get('/_hexclaw/api/v1/agents')
  expect(response.ok()).toBe(true)
  const payload = (await response.json()) as { agents?: Json[] }
  const matches = (payload.agents || []).filter(
    (agent) => (agent.metadata as Json | undefined)?.['k12.child_name'] === childName,
  )
  expect(matches).toHaveLength(1)
  const metadata = matches[0]!.metadata as Json
  const agentID = String(matches[0]!.name || '')
  const learnerID = String(metadata['k12.learner_id'] || metadata['k12.child_id'] || '')
  expect(agentID).not.toBe('')
  expect(learnerID).not.toBe('')
  return { agentID, learnerID }
}

async function visibleUpload(
  page: Page,
  fixture: PDFContract,
  track: (documentID: string, jobID: string) => void,
): Promise<{ request: Request; payload: Json; documentID: string; jobID: string }> {
  verifySource(fixture)
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /添加文档|Add Document/ }).click()
  const requestPromise = page.waitForRequest(
    (request) => {
      const path = new URL(request.url()).pathname
      return request.method() === 'POST' && /\/api\/v1\/knowledge\/(?:documents|upload)$/.test(path)
    },
    { timeout: 90_000 },
  )
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByText('上传文件', { exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixture.path)
  const upload = await requestPromise
  expect(
    new URL(upload.url()).pathname,
    'legacy filename-only upload is not the durable K12 grounding contract',
  ).toBe('/api/v1/knowledge/documents')
  expect(upload.method()).toBe('POST')
  expect(upload.headers()['content-type']).toMatch(/^multipart\/form-data;\s*boundary=/i)
  const response = await upload.response()
  expect(response).not.toBeNull()
  expect(response!.status(), 'durable upload must create an async job').toBe(202)
  const payload = (await response!.json()) as Json
  const documentID = String(nested(payload, 'id', 'document_id', 'doc_id') || '')
  const jobID = String(nested(payload, 'job_id') || '')
  expect(documentID).not.toBe('')
  expect(jobID).not.toBe('')
  track(documentID, jobID)

  const persisted = await detail(page.request, documentID)
  expect(Number(nested(persisted, 'size_bytes'))).toBe(fixture.bytes)
  expect(String(nested(persisted, 'sha256', 'source_digest'))).toBe(fixture.sha256)
  return { request: upload, payload, documentID, jobID }
}

async function detail(request: APIRequestContext, id: string): Promise<Json> {
  const response = await request.get(
    `${BASE_URL}/api/v1/knowledge/documents/${encodeURIComponent(id)}`,
  )
  const body = await response.text()
  return response.ok() ? (JSON.parse(body) as Json) : { _status: response.status(), _body: body }
}

async function waitIndexed(
  request: APIRequestContext,
  id: string,
  fixture: PDFContract,
): Promise<Json> {
  await expect
    .poll(async () => String(nested(await detail(request, id), 'status', 'state') || ''), {
      timeout: 20 * 60_000,
      intervals: [2_000, 4_000, 8_000],
      message: `${fixture.fixtureID} must reach a persisted indexed terminal`,
    })
    .toMatch(/^(?:indexed|ready|completed)$/)
  const value = await detail(request, id)
  expect(Number(nested(value, 'pages_total', 'page_count'))).toBe(fixture.pages)
  expect(Number(nested(value, 'pages_done'))).toBe(fixture.pages)
  expect(Number(nested(value, 'chunks_total', 'chunk_count'))).toBeGreaterThan(0)
  expect(String(nested(value, 'sha256', 'source_digest'))).toBe(fixture.sha256)
  return value
}

test('§1.2 tracked PDF manifest and verifier match both immutable sources', () => {
  const missing = Object.values(PDFS)
    .filter((fixture) => !existsSync(fixture.path))
    .map((fixture) => fixture.fixtureID)
  test.skip(
    missing.length > 0,
    `NOT RUN: private textbook fixture(s) absent: ${missing.join(', ')}`,
  )
  const manifest = JSON.parse(readFileSync(CONTRACT_MANIFEST, 'utf8')) as {
    schema_version?: number
    fixtures?: Json[]
  }
  expect(manifest.schema_version).toBe(1)
  expect(manifest.fixtures).toHaveLength(2)
  expect(manifest.fixtures?.some((fixture) => String(fixture.path).includes('.DS_Store'))).toBe(
    false,
  )
  for (const fixture of Object.values(PDFS)) {
    verifySource(fixture)
    const contract = manifest.fixtures!.find((item) => item.id === fixture.manifestID)!
    expect(contract).toBeTruthy()
    expect(contract.sha256).toBe(fixture.sha256)
    expect(contract.bytes).toBe(fixture.bytes)
    expect(contract.pages).toBe(fixture.pages)
    expect(contract.source).toBe('private-local')
    expect(contract.redistributable).toBe(false)
  }
  const verified = spawnSync(
    process.execPath,
    [CONTRACT_VERIFIER, '--manifest', CONTRACT_MANIFEST],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HEX_FIXTURE_TEXTBOOK_PDF: PDFS.text.path,
        HEX_FIXTURE_SCANNED_TEXTBOOK_PDF: PDFS.scan.path,
      },
    },
  )
  expect(verified.status, verified.stderr || verified.stdout).toBe(0)
  const evidence = JSON.parse(verified.stdout) as { fixtures?: Json[] }
  expect(evidence.fixtures?.map((item) => item.sha256)).toEqual([
    PDFS.text.sha256,
    PDFS.scan.sha256,
  ])
})

test.describe('real K12 grounding PDF lifecycle', () => {
  test.setTimeout(40 * 60_000)
  test.skip(
    !KNOWLEDGE_LIVE,
    'NOT RUN: set HEX_K12_KNOWLEDGE_LIVE=1 with isolated durable parser/index/embedding services',
  )
  let childName = ''
  const created = new Map<string, string>()

  test.afterEach(async ({ request }) => {
    if (PRESERVE_REAL_10X_KNOWLEDGE) {
      created.clear()
      childName = ''
      for (const fixture of Object.values(PDFS)) verifySource(fixture)
      return
    }
    for (const [id, jobID] of created) {
      const cancel = await request.post(
        `${BASE_URL}/api/v1/knowledge/jobs/${encodeURIComponent(jobID)}/cancel`,
      )
      expect([200, 404, 409]).toContain(cancel.status())
      const response = await request.delete(
        `${BASE_URL}/api/v1/knowledge/documents/${encodeURIComponent(id)}`,
      )
      expect([200, 204, 404]).toContain(response.status())
    }
    created.clear()
    await cleanupK12Child(request, childName)
    childName = ''
    for (const fixture of Object.values(PDFS)) verifySource(fixture)
  })

  if (PRESERVE_REAL_10X_KNOWLEDGE) {
    test('C07 accepts the frozen 131-page textbook once and persists its private lineage', async ({
      page,
    }) => {
      const lineage = real10xKnowledgeLineage()
      childName = `五下教材-${e2eMarker('child')}`
      await createTutor(page, childName, PDFS.text.grade)
      const accepted = await visibleUpload(page, PDFS.text, (id, jobID) => created.set(id, jobID))
      await writeC07KnowledgeLineage(lineage, {
        documentId: accepted.documentID,
        jobId: accepted.jobID,
        source: { digest: PDFS.text.sha256, bytes: PDFS.text.bytes, pages: PDFS.text.pages },
      })
    })

    test('C08 indexes exactly the C07 textbook lineage and persists active revision', async ({
      request,
    }) => {
      const lineage = real10xKnowledgeLineage()
      const c07 = await readKnowledgeLineage(lineage, { expectedPhase: 'C07' })
      const indexed = await waitIndexed(request, c07.document_id, PDFS.text)
      expect(String(nested(indexed, 'sha256', 'source_digest'))).toBe(c07.source_digest)
      const documentGeneration = Number(
        nested(indexed, 'document_generation', 'content_generation'),
      )
      expect(Number.isSafeInteger(documentGeneration)).toBe(true)
      expect(documentGeneration).toBeGreaterThan(0)

      const policyResponse = await request.get(
        `${BASE_URL}/api/v1/knowledge/corpora/default/embedding-policy?user_id=desktop-user`,
      )
      expect(policyResponse.ok()).toBe(true)
      const policy = (await policyResponse.json()) as Json
      const activeRevision = record(policy.active_revision, 'active_revision')
      const activeProfile = record(activeRevision.profile, 'active embedding profile')
      expect(activeProfile.model_name).toBe(RAG_ORACLE.embeddingModel)
      expect(activeProfile.dimension).toBe(4096)
      await advanceKnowledgeLineage(lineage, {
        expectedPhase: 'C07',
        nextPhase: 'C08',
        next: {
          document_generation: documentGeneration,
          active_revision_id: String(activeRevision.revision_id || ''),
          profile_id: String(activeProfile.profile_id || ''),
          profile_config_hash: String(activeRevision.profile_config_hash || ''),
        },
      })
    })

    test('C09 retrieves the C08 textbook lineage through the frozen oracle', async ({
      page,
      request,
    }) => {
      const lineage = real10xKnowledgeLineage()
      const c08 = await readKnowledgeLineage(lineage, { expectedPhase: 'C08' })
      await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
      await page.getByText('检索测试', { exact: false }).click()
      const search = page.getByPlaceholder('输入查询语句，测试知识库检索...')
      await search.fill(PDFS.text.query)
      const searchResponse = page.waitForResponse(
        (value) =>
          value.request().method() === 'POST' &&
          new URL(value.url()).pathname.endsWith('/api/v1/knowledge/search'),
      )
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      const results = (await (await searchResponse).json()) as {
        results?: Json[]
        total?: number
        query_receipts?: Json[]
      }
      const sourceDocument = await detail(request, c08.document_id)
      expect(String(nested(sourceDocument, 'id', 'document_id'))).toBe(c08.document_id)
      expect(String(nested(sourceDocument, 'sha256', 'source_digest'))).toBe(c08.source_digest)
      expect(Number(nested(sourceDocument, 'document_generation', 'content_generation'))).toBe(
        c08.document_generation,
      )
      expect(typeof sourceDocument.content, 'C09 must reconstruct the raw source span').toBe(
        'string',
      )
      const oracleEvidence = auditC09ContentOracleHit(results.results || [], {
        oracle: RAG_ORACLE_SOURCE,
        expectedDocumentId: c08.document_id,
        expectedDocumentGeneration: c08.document_generation,
        expectedSourceDigest: c08.source_digest,
        expectedRevisionId: c08.active_revision_id,
        expectedProfileId: c08.profile_id,
        expectedProfileConfigHash: c08.profile_config_hash,
        expectedQueryModel: RAG_ORACLE.embeddingModel,
        expectedQueryDimension: 4096,
        queryReceipts: results.query_receipts || [],
        sourceContent: sourceDocument.content as string,
      })
      const oracleHit = oracleEvidence.hit as Json
      expect(oracleEvidence.normalizedLength).toBe(RAG_ORACLE.citation.normalizedLength)
      expect(oracleEvidence.normalizedTextSha256).toBe(RAG_ORACLE.citation.normalizedTextSha256)
      expect(String(oracleHit.doc_id)).toBe(c08.document_id)
      expect(Number(oracleHit.document_generation)).toBe(c08.document_generation)
      expect(String(oracleHit.revision_id)).toBe(c08.active_revision_id)
      expect(String(oracleHit.source_digest)).toBe(c08.source_digest)
      expect(String(oracleHit.chunk_id)).not.toBe('')
      expect(String(oracleHit.citation_digest)).not.toBe('')
      const receipt = record(oracleEvidence.queryEmbeddingReceipt, 'query embedding receipt')
      expect(receipt.status).toBe('succeeded')
      expect(receipt.model).toBe(RAG_ORACLE.embeddingModel)
      expect(String(receipt.revision_id)).toBe(c08.active_revision_id)
      expect(String(receipt.profile_id)).toBe(c08.profile_id)
      expect(String(receipt.profile_config_hash)).toBe(c08.profile_config_hash)
      await advanceKnowledgeLineage(lineage, {
        expectedPhase: 'C08',
        nextPhase: 'C09',
        next: {
          hit_revision_id: String(oracleHit.revision_id),
          chunk_id: String(oracleHit.chunk_id),
          citation_digest: String(oracleHit.citation_digest),
          query_digest: String(receipt.query_digest),
          query_model: String(receipt.model),
          source_offset_start: oracleEvidence.sourceOffsetStart,
          source_offset_end: oracleEvidence.sourceOffsetEnd,
          raw_source_span_normalized_length: oracleEvidence.normalizedLength,
          raw_source_span_normalized_sha256: oracleEvidence.normalizedTextSha256,
        },
      })
    })
  }

  if (!REAL_10X_CYCLE)
    test('131-page text PDF enters through the visible chooser with vector retrieval and page/citation oracle', async ({
      page,
      request,
    }) => {
      const accepted = await visibleUpload(page, PDFS.text, (id, jobID) => created.set(id, jobID))
      const id = accepted.documentID
      await waitIndexed(request, id, PDFS.text)

      await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
      await page.getByText('检索测试', { exact: false }).click()
      const search = page.getByPlaceholder('输入查询语句，测试知识库检索...')
      await search.fill(PDFS.text.query)
      const searchResponse = page.waitForResponse(
        (value) =>
          value.request().method() === 'POST' &&
          new URL(value.url()).pathname.endsWith('/api/v1/knowledge/search'),
      )
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      const results = (await (await searchResponse).json()) as {
        results?: Json[]
        total?: number
        query_receipts?: Json[]
      }
      const ownHits = (results.results || []).filter((hit) => hit.doc_id === id)
      expect(ownHits.length).toBeGreaterThan(0)
      expect(Number(results.total)).toBeGreaterThanOrEqual(ownHits.length)
      const oracleHit = ownHits.find((hit) => {
        const pageStart = Number(hit.page_start)
        const pageEnd = Number(hit.page_end)
        return (
          pageStart <= RAG_ORACLE.citation.physicalPage &&
          pageEnd >= RAG_ORACLE.citation.physicalPage
        )
      })
      expect(oracleHit, '固定 query 必须命中离线 oracle 的 physical page').toBeTruthy()
      expect(String(oracleHit!.doc_id)).toBe(id)
      expect(String(oracleHit!.chunk_id)).not.toBe('')
      expect(String(oracleHit!.citation_digest)).not.toBe('')
      expect(String(oracleHit!.source_digest)).toBe(RAG_ORACLE.pdfSha256)

      const receipt = record(
        (results.query_receipts || []).find((item) => item.operation === 'query_embedding'),
        'query embedding receipt',
      )
      expect(receipt.operation).toBe('query_embedding')
      expect(receipt.status).toBe('succeeded')
      expect(receipt.model).toBe(RAG_ORACLE.embeddingModel)
      expect(String(receipt.provider_id ?? '')).not.toBe('')
      expect(String(receipt.profile_id ?? '')).not.toBe('')
      expect(String(receipt.profile_config_hash ?? '')).not.toBe('')
      expect(Number(receipt.dimension)).toBe(4096)
      expect(String(receipt.revision_id ?? '')).not.toBe('')
      expect(String(receipt.query_digest ?? '')).not.toBe('')

      const policyResponse = await request.get(
        `${BASE_URL}/api/v1/knowledge/corpora/default/embedding-policy?user_id=desktop-user`,
      )
      expect(policyResponse.ok()).toBe(true)
      const policy = (await policyResponse.json()) as Json
      const activeRevision = record(policy.active_revision, 'active_revision')
      const activeProfile = record(activeRevision.profile, 'active embedding profile')
      expect(activeRevision.revision_id).toBe(receipt.revision_id)
      expect(activeRevision.profile_config_hash).toBe(receipt.profile_config_hash)
      expect(activeProfile.profile_id).toBe(receipt.profile_id)
      expect(activeProfile.provider_id).toBe(receipt.provider_id)
      expect(activeProfile.model_name).toBe(RAG_ORACLE.embeddingModel)
      expect(activeProfile.dimension).toBe(receipt.dimension)
    })

  if (!REAL_10X_CYCLE)
    test('122-page scanned PDF exposes OCR progress and a persisted cancel/resume boundary', async ({
      page,
      request,
    }) => {
      test.skip(
        !SCAN_OCR_LIVE,
        'NOT RUN: set HEX_K12_SCAN_OCR_LIVE=1 only with authorized full-document OCR capacity',
      )
      childName = `六上扫描-${e2eMarker('child')}`
      await createTutor(page, childName, PDFS.scan.grade)
      const accepted = await visibleUpload(page, PDFS.scan, (id, jobID) => created.set(id, jobID))
      const id = accepted.documentID
      await expect(
        page.getByTestId('upload-processing'),
        '57MB scanned PDF must not masquerade as immediately indexed text',
      ).toBeVisible({ timeout: 60_000 })
      const job = page
        .locator('[data-testid="knowledge-upload-job"]')
        .filter({ hasText: '人教版·小学六年级上册.pdf' })
      await expect(job, 'OCR job must expose durable controls').toBeVisible()
      const cancelResponse = page.waitForResponse(
        (value) =>
          value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/cancel'),
      )
      await job.getByRole('button', { name: '取消', exact: true }).click()
      expect((await cancelResponse).ok()).toBe(true)
      await expect(job).toContainText(/已取消|可恢复/)
      const resumeResponse = page.waitForResponse(
        (value) =>
          value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/resume'),
      )
      await job.getByRole('button', { name: /恢复|继续/ }).click()
      expect((await resumeResponse).ok()).toBe(true)
      await waitIndexed(request, id, PDFS.scan)
    })
})
