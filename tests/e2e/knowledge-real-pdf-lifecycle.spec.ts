import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test'
import {
  assertLiveRuntime,
  cleanupLiveChild,
  liveGateBlockers,
  liveJSON,
  liveSidecarURL,
  liveSkipReason,
} from '../live/k12-live-helpers'

/** KNOW-001..030: two immutable real PDFs, real UI upload, retrieval and zero-residue delete. */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const DOCS_ROOT = process.env.HEXCLAW_DOCS_ROOT || '/Users/guoyanjun/work/hexclaw-docs'
const PDFS = {
  text: {
    id: 'FX-PDF-MATH-D5-TEXT-001',
    path:
      process.env.HEX_FIXTURE_TEXTBOOK_PDF ||
      resolve(DOCS_ROOT, 'test/义务教育教科书·数学五年级下册.pdf'),
    sha256: '657e1547074668dbb50f2bf37f13c20f292127be64c26c5334190aa34d06de83',
    bytes: 14_621_452,
    pages: 131,
    grade: '五年级下',
    query: '找次品',
  },
  scan: {
    id: 'FX-PDF-MATH-D6-SCAN-001',
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

type PDFKey = keyof typeof PDFS
type PDFContract = (typeof PDFS)[PDFKey]
type Json = Record<string, unknown>

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertPDF(fixture: PDFContract): void {
  const bytes = readFileSync(fixture.path)
  expect(statSync(fixture.path).isFile(), `${fixture.id} is missing`).toBe(true)
  expect(bytes.length, `${fixture.id} byte length drift`).toBe(fixture.bytes)
  expect(bytes.subarray(0, 5).toString(), `${fixture.id} must retain PDF magic`).toBe('%PDF-')
  expect(sha256(fixture.path), `${fixture.id} source SHA drift`).toBe(fixture.sha256)
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
): Promise<{ agentID: string; learnerID: string }> {
  await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
  await page.goto('/agents', { waitUntil: 'domcontentloaded' })
  const skip = page.getByRole('button', { name: '跳过' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  await page.getByText('模板库', { exact: false }).first().click()
  await page.getByText('作业辅导助手', { exact: false }).first().click()
  await page.locator('.k12pf__input').first().fill(childName)
  await page.locator('.k12pf .hc-select__trigger').nth(0).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级下' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })

  const payload = await liveJSON<Json>(page.request, 'GET', '/api/v1/agents')
  const agents = Array.isArray(payload.agents) ? (payload.agents as Json[]) : []
  const matches = agents.filter((agent) => {
    const metadata = agent.metadata as Json | undefined
    return metadata?.['k12.child_name'] === childName
  })
  expect(matches, 'isolated child must map to one TutorAgent owner').toHaveLength(1)
  const metadata = matches[0]!.metadata as Json
  const agentID = String(matches[0]!.name || '')
  const learnerID = String(metadata['k12.learner_id'] || metadata['k12.child_id'] || '')
  expect(agentID).not.toBe('')
  expect(
    learnerID,
    'K12 corpus binding requires a stable learner_id, not the display name',
  ).not.toBe('')
  return { agentID, learnerID }
}

function isDocumentUpload(request: Request): boolean {
  const url = new URL(request.url())
  return (
    request.method() === 'POST' && /\/api\/v1\/knowledge\/(?:documents|upload)$/.test(url.pathname)
  )
}

async function uploadFromVisibleChooser(
  page: Page,
  fixture: PDFContract,
  owner: { agentID: string; learnerID: string },
  onCreated: (id: string) => void,
): Promise<{ id: string; request: Request }> {
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /添加文档|Add Document/ }).click()
  const requestPromise = page.waitForRequest(isDocumentUpload, { timeout: 90_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByText('上传文件', { exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixture.path)
  const uploadRequest = await requestPromise
  const response = await uploadRequest.response()
  expect(response, 'upload must reach a real server response').not.toBeNull()
  const payload = (await response!.json()) as Json
  const id = String(payload.id || nested(payload, 'document_id', 'doc_id') || '')
  if (id) onCreated(id)

  const url = new URL(uploadRequest.url())
  expect(
    url.pathname,
    'new uploads must use the durable document/job API; legacy /knowledge/upload is retired',
  ).toMatch(/\/api\/v1\/knowledge\/documents$/)

  const multipart = uploadRequest.postDataBuffer()
  expect(multipart, 'visible chooser must transmit the real multipart bytes').not.toBeNull()
  expect(multipart!.length, 'multipart must include the complete immutable PDF').toBeGreaterThan(
    fixture.bytes,
  )
  const body = multipart!.toString('latin1')
  for (const [field, value] of [
    ['agent_id', owner.agentID],
    ['learner_id', owner.learnerID],
    ['subject', '数学'],
    ['grade', fixture.grade],
  ] as const) {
    expect(body, `multipart is missing ${field}=${value}`).toContain(`name="${field}"`)
    expect(body).toContain(value)
  }

  expect(response!.status(), 'durable parse/index job creation must return 202').toBe(202)
  expect(id, 'upload response must return the created document id for exact cleanup').not.toBe('')
  return { id, request: uploadRequest }
}

async function documentDetail(request: APIRequestContext, id: string): Promise<Json> {
  const response = await request.get(
    liveSidecarURL(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`),
  )
  if (!response.ok()) return { _status: response.status() }
  try {
    return (await response.json()) as Json
  } catch {
    throw new Error(
      `GET /api/v1/knowledge/documents/:id returned non-JSON evidence (body redacted)`,
    )
  }
}

async function deleteDocument(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(
    liveSidecarURL(`/api/v1/knowledge/documents/${encodeURIComponent(id)}`),
  )
  expect(
    [200, 204, 404],
    `DELETE /api/v1/knowledge/documents/:id => HTTP ${response.status()} (body redacted)`,
  ).toContain(response.status())
}

async function waitForIndexed(
  request: APIRequestContext,
  id: string,
  fixture: PDFContract,
): Promise<Json> {
  await expect
    .poll(
      async () => {
        const detail = await documentDetail(request, id)
        return String(nested(detail, 'status', 'state') || '')
      },
      {
        timeout: 20 * 60_000,
        intervals: [2_000, 4_000, 8_000],
        message: `${fixture.id} must reach a persisted indexed terminal`,
      },
    )
    .toMatch(/^(?:indexed|ready|completed)$/)
  const detail = await documentDetail(request, id)
  expect(
    Number(nested(detail, 'pages_total', 'page_count')),
    'page total must come from the PDF, not chunk count',
  ).toBe(fixture.pages)
  expect(Number(nested(detail, 'pages_done'))).toBe(fixture.pages)
  expect(Number(nested(detail, 'chunks_total', 'chunk_count'))).toBeGreaterThan(0)
  expect(Number(nested(detail, 'chunks_done', 'chunk_count'))).toBeGreaterThan(0)
  expect(String(nested(detail, 'sha256', 'source_digest'))).toBe(fixture.sha256)
  expect(String(nested(detail, 'agent_id', 'owner_id'))).not.toBe('')
  expect(String(nested(detail, 'learner_id'))).not.toBe('')
  expect(String(nested(detail, 'subject'))).toBe('数学')
  expect(String(nested(detail, 'grade'))).toBe(fixture.grade)
  return detail
}

async function searchAndAssertSource(page: Page, fixture: PDFContract, id: string): Promise<void> {
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /检索测试/ }).click()
  const input = page.getByPlaceholder('输入查询语句，测试知识库检索...')
  await input.fill(fixture.query)
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/knowledge/search') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const payload = (await response.json()) as { result?: Json[]; results?: Json[] }
  const hits = payload.results || payload.result || []
  const ownHits = hits.filter((hit) => String(hit.doc_id || '') === id)
  expect(ownHits.length, `${fixture.query} must recall the uploaded document`).toBeGreaterThan(0)
  for (const hit of ownHits) {
    expect(
      Number(nested(hit, 'page', 'page_number')),
      'a textbook citation without a page anchor is not reproducible',
    ).toBeGreaterThan(0)
    expect(String(nested(hit, 'source_digest', 'sha256'))).toBe(fixture.sha256)
  }
  await expect(page.getByText(fixture.query, { exact: false }).first()).toBeVisible()
}

async function deleteThroughUI(page: Page, title: string, id: string): Promise<void> {
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' })
  const card = page.getByTestId('knowledge-doc-card').filter({ hasText: title })
  await expect(card).toBeVisible({ timeout: 60_000 })
  const remove = card.getByTitle('删除')
  await remove.click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(card, 'cancel must not optimistically remove the document').toBeVisible()
  await remove.click()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname.endsWith(
        `/api/v1/knowledge/documents/${encodeURIComponent(id)}`,
      ),
  )
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  expect((await responsePromise).ok(), 'confirmed delete must reach a real terminal').toBe(true)
  await expect(card).toHaveCount(0)
}

test('KNOW-001 fixed textbook PDFs have the frozen bytes, magic and SHA', () => {
  for (const fixture of Object.values(PDFS)) assertPDF(fixture)
})

test.describe.serial('K12 real textbook knowledge lifecycle', () => {
  test.setTimeout(40 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(
      blockers,
      'installed RC + isolated profile + authorized real OCR/embedding model',
    ),
  )

  let childName = ''
  const createdDocumentIDs = new Set<string>()

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test.afterEach(async ({ request }) => {
    const cleanupFailures: unknown[] = []
    for (const id of createdDocumentIDs) {
      try {
        await deleteDocument(request, id)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    createdDocumentIDs.clear()
    try {
      await cleanupLiveChild(request, childName)
    } catch (error) {
      cleanupFailures.push(error)
    } finally {
      childName = ''
      for (const fixture of Object.values(PDFS)) assertPDF(fixture)
    }
    if (cleanupFailures.length) {
      throw new AggregateError(cleanupFailures, 'K12 knowledge cleanup did not reach zero residue')
    }
  })

  test('text PDF and scanned PDF upload, bind, search, cancel/resume and delete with zero residue', async ({
    page,
    request,
  }) => {
    childName = `教材库${Date.now().toString(36)}`
    const owner = await createTutor(page, childName)

    const textUpload = await uploadFromVisibleChooser(page, PDFS.text, owner, (id) =>
      createdDocumentIDs.add(id),
    )
    await waitForIndexed(request, textUpload.id, PDFS.text)
    await searchAndAssertSource(page, PDFS.text, textUpload.id)

    const scanUpload = await uploadFromVisibleChooser(page, PDFS.scan, owner, (id) =>
      createdDocumentIDs.add(id),
    )
    await expect(page.getByTestId('upload-processing')).toBeVisible({ timeout: 60_000 })
    const scanRow = page
      .locator('[data-testid="knowledge-upload-job"]')
      .filter({ hasText: PDFS.scan.path.split('/').pop()! })
    await expect(
      scanRow,
      '122-page OCR job must expose persisted controls, not a permanent spinner',
    ).toBeVisible()
    const cancelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/cancel'),
    )
    await scanRow.getByRole('button', { name: '取消', exact: true }).click()
    expect((await cancelResponse).ok()).toBe(true)
    await expect(scanRow).toContainText(/已取消|可恢复/)
    const resumeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/resume'),
    )
    await scanRow.getByRole('button', { name: /恢复|继续/ }).click()
    expect((await resumeResponse).ok()).toBe(true)
    await waitForIndexed(request, scanUpload.id, PDFS.scan)
    await searchAndAssertSource(page, PDFS.scan, scanUpload.id)

    await deleteThroughUI(page, PDFS.text.path.split('/').pop()!, textUpload.id)
    createdDocumentIDs.delete(textUpload.id)
    expect(Number((await documentDetail(request, textUpload.id))._status)).toBe(404)
    const deletedHits = await liveJSON<{ result?: Json[]; results?: Json[] }>(
      request,
      'POST',
      '/api/v1/knowledge/search',
      { query: PDFS.text.query, top_k: 50, document_id: textUpload.id },
    )
    expect(
      [...(deletedHits.result || []), ...(deletedHits.results || [])].some(
        (hit) => hit.doc_id === textUpload.id,
      ),
    ).toBe(false)

    await deleteThroughUI(page, PDFS.scan.path.split('/').pop()!, scanUpload.id)
    createdDocumentIDs.delete(scanUpload.id)
    expect(Number((await documentDetail(request, scanUpload.id))._status)).toBe(404)
  })

  test('native sidecar restart preserves document, chunks, binding and page anchors', async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.HEX_K12_NATIVE_RESTART !== '1',
      'NOT RUN: requires a packaged Desktop whose sidebar restart button controls the tested sidecar',
    )
    childName = `教材重启${Date.now().toString(36)}`
    const owner = await createTutor(page, childName)
    const upload = await uploadFromVisibleChooser(page, PDFS.text, owner, (id) =>
      createdDocumentIDs.add(id),
    )
    const before = await waitForIndexed(request, upload.id, PDFS.text)
    await page.getByTitle(/重启引擎|Restart engine/).click()
    await expect
      .poll(
        async () =>
          await liveJSON<{ status?: string }>(request, 'GET', '/health')
            .then((health) => health.status === 'healthy')
            .catch(() => false),
        {
          timeout: 120_000,
          message: 'sidecar must return after a real restart',
        },
      )
      .toBe(true)
    const after = await waitForIndexed(request, upload.id, PDFS.text)
    expect(String(nested(after, 'sha256', 'source_digest'))).toBe(
      String(nested(before, 'sha256', 'source_digest')),
    )
    expect(Number(nested(after, 'chunk_count', 'chunks_total'))).toBe(
      Number(nested(before, 'chunk_count', 'chunks_total')),
    )
    await searchAndAssertSource(page, PDFS.text, upload.id)
  })
})
