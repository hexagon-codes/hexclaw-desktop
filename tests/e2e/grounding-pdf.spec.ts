import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test'
import { BASE_URL, e2eMarker } from './helpers'
import { cleanupK12Child } from './live-fixture-cleanup'

/** KNOW-001..030 + E2E-PDF-001/002: immutable PDFs through visible UI and durable sidecar jobs. */
const KNOWLEDGE_LIVE = process.env.HEX_K12_KNOWLEDGE_LIVE === '1'
const SCAN_OCR_LIVE = KNOWLEDGE_LIVE && process.env.HEX_K12_SCAN_OCR_LIVE === '1'
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || resolve(process.cwd(), '../hexclaw-docs')
const CONTRACT_MANIFEST = resolve(process.cwd(), 'tests/fixtures/local/manifest.example.json')
const CONTRACT_VERIFIER = resolve(process.cwd(), 'tests/fixtures/local/verify-fixture.mjs')
const PDFS = {
  text: {
    manifestID: 'textbook_pdf', fixtureID: 'FX-PDF-G5B-TEXT-001',
    path: process.env.HEX_FIXTURE_TEXTBOOK_PDF || resolve(DOCS_ROOT, 'test/义务教育教科书·数学五年级下册.pdf'),
    sha256: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    bytes: 14_621_452, pages: 131, grade: '五年级下', query: '找次品',
  },
  scan: {
    manifestID: 'scanned_textbook_pdf', fixtureID: 'FX-PDF-G6A-SCAN-001',
    path: process.env.HEX_FIXTURE_SCANNED_TEXTBOOK_PDF || resolve(DOCS_ROOT, 'test/人教版·小学六年级上册.pdf'),
    sha256: '65bd80bd35be524bf68f66f9b67820a97176e1487db81810cb268e04e44dd8b2',
    bytes: 57_313_616, pages: 122, grade: '六年级上', query: '圆的面积',
  },
} as const

type PDFContract = (typeof PDFS)[keyof typeof PDFS]
type Json = Record<string, unknown>

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

async function createTutor(page: Page, childName: string, grade: string): Promise<{ agentID: string; learnerID: string }> {
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
  const payload = await response.json() as { agents?: Json[] }
  const matches = (payload.agents || []).filter((agent) => (agent.metadata as Json | undefined)?.['k12.child_name'] === childName)
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
  const requestPromise = page.waitForRequest((request) => {
    const path = new URL(request.url()).pathname
    return request.method() === 'POST' && /\/api\/v1\/knowledge\/(?:documents|upload)$/.test(path)
  }, { timeout: 90_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByText('上传文件', { exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixture.path)
  const upload = await requestPromise
  expect(new URL(upload.url()).pathname, 'legacy filename-only upload is not the durable K12 grounding contract').toBe('/api/v1/knowledge/documents')
  expect(upload.method()).toBe('POST')
  expect(upload.headers()['content-type']).toMatch(/^multipart\/form-data;\s*boundary=/i)
  const response = await upload.response()
  expect(response).not.toBeNull()
  expect(response!.status(), 'durable upload must create an async job').toBe(202)
  const payload = await response!.json() as Json
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
  const response = await request.get(`${BASE_URL}/api/v1/knowledge/documents/${encodeURIComponent(id)}`)
  const body = await response.text()
  return response.ok() ? JSON.parse(body) as Json : { _status: response.status(), _body: body }
}

async function waitIndexed(request: APIRequestContext, id: string, fixture: PDFContract): Promise<Json> {
  await expect.poll(async () => String(nested(await detail(request, id), 'status', 'state') || ''), {
    timeout: 20 * 60_000,
    intervals: [2_000, 4_000, 8_000],
    message: `${fixture.fixtureID} must reach a persisted indexed terminal`,
  }).toMatch(/^(?:indexed|ready|completed)$/)
  const value = await detail(request, id)
  expect(Number(nested(value, 'pages_total', 'page_count'))).toBe(fixture.pages)
  expect(Number(nested(value, 'pages_done'))).toBe(fixture.pages)
  expect(Number(nested(value, 'chunks_total', 'chunk_count'))).toBeGreaterThan(0)
  expect(String(nested(value, 'sha256', 'source_digest'))).toBe(fixture.sha256)
  return value
}

test('§1.2 tracked PDF manifest and verifier match both immutable sources', () => {
  const missing = Object.values(PDFS).filter((fixture) => !existsSync(fixture.path)).map((fixture) => fixture.fixtureID)
  test.skip(missing.length > 0, `NOT RUN: private textbook fixture(s) absent: ${missing.join(', ')}`)
  const manifest = JSON.parse(readFileSync(CONTRACT_MANIFEST, 'utf8')) as { schema_version?: number; fixtures?: Json[] }
  expect(manifest.schema_version).toBe(1)
  expect(manifest.fixtures).toHaveLength(2)
  expect(manifest.fixtures?.some((fixture) => String(fixture.path).includes('.DS_Store'))).toBe(false)
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
  const verified = spawnSync(process.execPath, [CONTRACT_VERIFIER, '--manifest', CONTRACT_MANIFEST], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      HEX_FIXTURE_TEXTBOOK_PDF: PDFS.text.path,
      HEX_FIXTURE_SCANNED_TEXTBOOK_PDF: PDFS.scan.path,
    },
  })
  expect(verified.status, verified.stderr || verified.stdout).toBe(0)
  const evidence = JSON.parse(verified.stdout) as { fixtures?: Json[] }
  expect(evidence.fixtures?.map((item) => item.sha256)).toEqual([PDFS.text.sha256, PDFS.scan.sha256])
})

test.describe('real K12 grounding PDF lifecycle', () => {
  test.setTimeout(40 * 60_000)
  test.skip(!KNOWLEDGE_LIVE, 'NOT RUN: set HEX_K12_KNOWLEDGE_LIVE=1 with isolated durable parser/index/embedding services')
  let childName = ''
  const created = new Map<string, string>()

  test.afterEach(async ({ request }) => {
    for (const [id, jobID] of created) {
      const cancel = await request.post(`${BASE_URL}/api/v1/knowledge/jobs/${encodeURIComponent(jobID)}/cancel`)
      expect([200, 404, 409]).toContain(cancel.status())
      const response = await request.delete(`${BASE_URL}/api/v1/knowledge/documents/${encodeURIComponent(id)}`)
      expect([200, 204, 404]).toContain(response.status())
    }
    created.clear()
    await cleanupK12Child(request, childName)
    childName = ''
    for (const fixture of Object.values(PDFS)) verifySource(fixture)
  })

  test('131-page text PDF enters through the visible chooser with owner, subject and page-grounded retrieval', async ({ page, request }) => {
    childName = `五下教材-${e2eMarker('child')}`
    const owner = await createTutor(page, childName, PDFS.text.grade)
    const accepted = await visibleUpload(page, PDFS.text, (id, jobID) => created.set(id, jobID))
    const id = accepted.documentID
    const indexed = await waitIndexed(request, id, PDFS.text)
    expect(String(nested(indexed, 'agent_id', 'owner_id'))).toBe(owner.agentID)
    expect(String(nested(indexed, 'learner_id'))).toBe(owner.learnerID)
    expect(String(nested(indexed, 'subject'))).toBe('数学')
    expect(String(nested(indexed, 'grade'))).toBe(PDFS.text.grade)

    await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
    await page.getByText('检索测试', { exact: false }).click()
    const search = page.getByPlaceholder('输入查询语句，测试知识库检索...')
    await search.fill(PDFS.text.query)
    const searchResponse = page.waitForResponse((value) =>
      value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/api/v1/knowledge/search'),
    )
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const results = await (await searchResponse).json() as { results?: Json[]; result?: Json[] }
    const ownHits = [...(results.results || []), ...(results.result || [])].filter((hit) => hit.doc_id === id)
    expect(ownHits.length).toBeGreaterThan(0)
    for (const hit of ownHits) {
      expect(Number(nested(hit, 'page', 'page_number')), '教材引用必须带可复核页码').toBeGreaterThan(0)
      expect(String(nested(hit, 'source_digest', 'sha256'))).toBe(PDFS.text.sha256)
    }
  })

  test('122-page scanned PDF exposes OCR progress and a persisted cancel/resume boundary', async ({ page, request }) => {
    test.skip(!SCAN_OCR_LIVE, 'NOT RUN: set HEX_K12_SCAN_OCR_LIVE=1 only with authorized full-document OCR capacity')
    childName = `六上扫描-${e2eMarker('child')}`
    await createTutor(page, childName, PDFS.scan.grade)
    const accepted = await visibleUpload(page, PDFS.scan, (id, jobID) => created.set(id, jobID))
    const id = accepted.documentID
    await expect(page.getByTestId('upload-processing'), '57MB scanned PDF must not masquerade as immediately indexed text').toBeVisible({ timeout: 60_000 })
    const job = page.locator('[data-testid="knowledge-upload-job"]').filter({ hasText: '人教版·小学六年级上册.pdf' })
    await expect(job, 'OCR job must expose durable controls').toBeVisible()
    const cancelResponse = page.waitForResponse((value) => value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/cancel'))
    await job.getByRole('button', { name: '取消', exact: true }).click()
    expect((await cancelResponse).ok()).toBe(true)
    await expect(job).toContainText(/已取消|可恢复/)
    const resumeResponse = page.waitForResponse((value) => value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/resume'))
    await job.getByRole('button', { name: /恢复|继续/ }).click()
    expect((await resumeResponse).ok()).toBe(true)
    await waitIndexed(request, id, PDFS.scan)
  })
})
