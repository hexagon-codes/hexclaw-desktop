import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

import {
  assertLiveRuntime,
  attachJSON,
  cleanupLiveSession,
  cleanupLiveSessionsByTitle,
  envValue,
  findLiveSessionByTitle,
  listHistory,
  liveAppURL,
  liveGateBlockers,
  liveJSON,
  liveSkipReason,
  metadataOf,
  sha256Text,
  waitForLiveAssistant,
  type HistoryMessage,
} from './k12-live-helpers'

type Json = Record<string, unknown>
type FixtureKey = 'writing' | 'homework'

const contract = JSON.parse(
  readFileSync(
    new URL('./k12-current-bug-real-matrix.contract.json', import.meta.url),
    'utf8',
  ),
) as {
  provider: { identity: string; displayName: string; model: string }
  submissions: { plannedTopLevel: number; maximumTopLevel: number }
  fixtures: Record<
    FixtureKey,
    { env: string; path: string; sha256: string; bytes: number; width: number; height: number }
  >
  forbiddenRequestPathPrefixes: string[]
}
const blockers = [
  ...liveGateBlockers({ isolatedProfile: true, model: true }),
  ...(envValue('HEX_K12_LIVE_PROVIDER') === contract.provider.identity
    ? []
    : ['HEX_K12_LIVE_PROVIDER(exact)']),
  ...(envValue('HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY') === contract.provider.displayName
    ? []
    : ['HEX_K12_LIVE_EXPECTED_PROVIDER_DISPLAY(exact)']),
  ...(envValue('HEX_K12_LIVE_MODEL') === contract.provider.model
    ? []
    : ['HEX_K12_LIVE_MODEL(exact)']),
  ...(envValue('HEX_K12_LIVE_STATE_TASKS_AUTHORIZED') === '1'
    ? []
    : ['HEX_K12_LIVE_STATE_TASKS_AUTHORIZED']),
  ...['HEX_K12_LIVE_RETRYABLE_DISPATCH_ID', 'HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID'].filter(
    (name) => !envValue(name),
  ),
]

function fixture(key: FixtureKey) {
  const frozen = contract.fixtures[key]
  return { ...frozen, path: envValue(frozen.env) || frozen.path }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyFixture(key: FixtureKey): Buffer {
  const value = fixture(key)
  const bytes = readFileSync(value.path)
  expect(statSync(value.path).isFile(), `${key} must be a regular file`).toBe(true)
  expect(bytes.length, `${key} fixture byte length drift`).toBe(value.bytes)
  expect(sha256(bytes), `${key} fixture SHA-256 drift`).toBe(value.sha256)
  expect(bytes.subarray(0, 8).toString('hex'), `${key} must remain PNG`).toBe(
    '89504e470d0a1a0a',
  )
  expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }).toEqual({
    width: value.width,
    height: value.height,
  })
  return bytes
}

function record(value: unknown, label: string): Json {
  expect(value && typeof value === 'object' && !Array.isArray(value), label).toBe(true)
  return value as Json
}

function sourceMessageID(message: Locator): Promise<string> {
  return message.getAttribute('id').then((id) => {
    expect(id, 'user bubble must expose its canonical message id').toMatch(/^msg-.+/)
    return id!.slice('msg-'.length)
  })
}

function attachmentBytes(message: HistoryMessage): Buffer {
  const attachments = metadataOf(message).attachments
  expect(Array.isArray(attachments), 'persisted user message must retain attachments').toBe(true)
  expect(attachments as unknown[]).toHaveLength(1)
  const attachment = record((attachments as unknown[])[0], 'attachment must be an object')
  expect(attachment.type).toBe('image')
  expect(typeof attachment.data).toBe('string')
  const encoded = String(attachment.data).replace(/^data:[^,]+;base64,/, '')
  return Buffer.from(encoded, 'base64')
}

async function dispatchID(shell: Locator): Promise<string> {
  let value = ''
  await expect
    .poll(
      async () => {
        value = (await shell.getByTestId('recognize-guard').getAttribute('data-dispatch-id')) ?? ''
        return value
      },
      { timeout: 60_000, message: 'one source message must acquire one durable dispatch id' },
    )
    .not.toBe('')
  return value
}

async function waitForCreativeResult(
  shell: Locator,
  intent: 'writing',
): Promise<{ dispatchId: string; workId: string; generationId: string; feedbackId: string }> {
  const surface = shell.getByTestId(`${intent}-result-surface`)
  const conflict = shell.getByTestId('creative-conflict-guard')
  await expect
    .poll(
      async () => Number(await surface.isVisible().catch(() => false)) + Number(await conflict.isVisible().catch(() => false)),
      { timeout: 10 * 60_000, message: 'writing must reach feedback or the explicit OCR conflict stop' },
    )
    .toBeGreaterThan(0)
  if (await conflict.isVisible().catch(() => false)) {
    for (const item of await conflict.getByTestId('creative-conflict-item').all()) {
      const edit = item.getByTestId('creative-conflict-edit')
      if (await edit.isVisible().catch(() => false)) await edit.click()
      const confirm = item.getByTestId('creative-conflict-confirm')
      if (await confirm.isVisible().catch(() => false)) await confirm.click()
    }
    await expect(conflict.getByTestId('creative-confirm-all')).toBeEnabled()
    await conflict.getByTestId('creative-confirm-all').click()
  }
  await expect(surface).toBeVisible({ timeout: 10 * 60_000 })
  const renderer = surface.locator('[data-generation-id][data-feedback-id]').first()
  await expect(renderer).toBeVisible()
  const workId = (await surface.getAttribute('data-work-id')) ?? ''
  const generationId = (await renderer.getAttribute('data-generation-id')) ?? ''
  const feedbackId = (await renderer.getAttribute('data-feedback-id')) ?? ''
  expect(workId).not.toBe('')
  expect(generationId).not.toBe('')
  expect(feedbackId).not.toBe('')
  return { dispatchId: await dispatchID(shell), workId, generationId, feedbackId }
}

async function submitImage(page: Page, key: FixtureKey): Promise<{ source: Locator; sourceId: string; shell: Locator }> {
  const before = await page.getByTestId('chat-message-user').count()
  await page.locator('.hc-composer input[type="file"]').setInputFiles(fixture(key).path)
  await expect(page.getByTestId('chat-message-user')).toHaveCount(before + 1, { timeout: 30_000 })
  const source = page.getByTestId('chat-message-user').last()
  const sourceId = await sourceMessageID(source)
  const shell = page
    .getByTestId('k12-photo-assistant-message')
    .filter({ has: page.locator(`[data-source-message-id="${sourceId}"]`) })
    .last()
  await expect(shell, 'processing feedback must appear in the same open conversation').toBeVisible({
    timeout: 30_000,
  })
  return { source, sourceId, shell }
}

async function assertCanonicalWork(
  page: Page,
  testInfo: TestInfo,
  evidence: Awaited<ReturnType<typeof waitForCreativeResult>>,
): Promise<void> {
  const result = await liveJSON<Json>(
    page.request,
    'GET',
    `/api/k12/image-tasks/${encodeURIComponent(evidence.dispatchId)}/result?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
  )
  const payload = record(record(result.result, 'creative result').payload, 'creative payload')
  const feedback = record(payload.feedback, 'creative feedback')
  const structured = record(feedback.structured_feedback, 'structured feedback')
  expect(feedback.generation_id).toBe(evidence.generationId)
  expect(structured.feedback_id).toBe(evidence.feedbackId)
  expect(feedback.projection_markdown).toBe(structured.projection_markdown)

  const work = await liveJSON<Json>(
    page.request,
    'GET',
    `/api/k12/creative-works/${encodeURIComponent(evidence.workId)}?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
  )
  const latest = record(work.latest_feedback ?? work.initial_feedback, 'work feedback generation')
  const archivedFeedback = record(latest.feedback, 'archived feedback')
  expect(latest.generation_id).toBe(evidence.generationId)
  expect(archivedFeedback.feedback_id).toBe(evidence.feedbackId)
  expect(archivedFeedback.projection_markdown).toBe(feedback.projection_markdown)

  const chatRenderer = page
    .getByTestId('writing-result-surface')
    .locator(`[data-generation-id="${evidence.generationId}"]`)
  const chatProjection = await chatRenderer.innerText()
  await page.locator('#k12-enh-tab-records').click()
  await page.getByTestId('subtab-works').click()
  const card = page.locator(`[data-work-id="${evidence.workId}"]`)
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByTestId('cw-detail-toggle').click()
  const archiveRenderer = page
    .getByTestId('cw-detail-modal')
    .locator(`[data-generation-id="${evidence.generationId}"][data-feedback-id="${evidence.feedbackId}"]`)
  await expect(archiveRenderer).toBeVisible()
  expect(await archiveRenderer.innerText()).toBe(chatProjection)
  await attachJSON(testInfo, 'creative-work-same-source-evidence', {
    work_id_sha256: sha256Text(evidence.workId),
    generation_id_sha256: sha256Text(evidence.generationId),
    feedback_id_sha256: sha256Text(evidence.feedbackId),
    projection_sha256: sha256Text(String(feedback.projection_markdown)),
    chat_archive_same_renderer_text: true,
  })
  await page.getByTestId('cw-detail-close').click()
  await page.locator('#k12-enh-tab-chat').click()
}

const sourceLabels = [
  '一、1',
  '一、2',
  '一、3',
  '一、4',
  '一、5',
  '一、6',
  '一、7',
  '一、8',
  '一、9',
  '二、1',
  '二、2',
  '二、3',
  '三、1',
  '三、2',
  '四、1',
  '五、1',
]

test('fixture manifest freezes the two user-supplied source images and the submission budget', () => {
  expect(existsSync(fixture('writing').path)).toBe(true)
  expect(existsSync(fixture('homework').path)).toBe(true)
  verifyFixture('writing')
  verifyFixture('homework')
  expect(contract.submissions.plannedTopLevel).toBe(4)
  expect(contract.submissions.plannedTopLevel).toBeLessThanOrEqual(
    contract.submissions.maximumTopLevel,
  )
})

test.describe.serial('LIVE current K12 bug acceptance matrix', () => {
  test.skip(blockers.length > 0, liveSkipReason(blockers, 'frozen app + real provider + state fixtures'))

  let sessionID = ''
  let sessionTitle = ''
  const createdWorkIDs: string[] = []

  test.afterEach(async ({ request }) => {
    const agent = envValue('HEX_K12_LIVE_AGENT')
    for (const workID of createdWorkIDs.splice(0)) {
      await liveJSON<Json>(
        request,
        'DELETE',
        `/api/k12/creative-works/${encodeURIComponent(workID)}?agent=${encodeURIComponent(agent)}`,
      ).catch(() => undefined)
    }
    if (sessionID) await cleanupLiveSession(request, sessionID)
    else if (sessionTitle) await cleanupLiveSessionsByTitle(request, sessionTitle)
    sessionID = ''
    sessionTitle = ''
  })

  test('four real submissions preserve creative identity, attachment, source order and provider display', async ({
    page,
    request,
  }, testInfo: TestInfo) => {
    await assertLiveRuntime(page, request, testInfo)
    const llm = await liveJSON<{ providers?: Record<string, Json> }>(
      request,
      'GET',
      '/api/v1/config/llm',
    )
    const configured = llm.providers?.[contract.provider.identity]
    expect(configured?.display_name).toBe(contract.provider.displayName)
    expect(
      [configured?.model, ...(Array.isArray(configured?.models) ? configured.models : [])],
    ).toContain(contract.provider.model)

    sessionTitle = `LIVE-K12-BUG-${randomUUID().slice(0, 8)}`
    await page.goto(
      liveAppURL(
        `/chat?role=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}&roleTitle=${encodeURIComponent(sessionTitle)}&model=${encodeURIComponent(contract.provider.model)}`,
      ),
      { waitUntil: 'domcontentloaded' },
    )
    expect(new URL(page.url()).pathname, 'authorized installed profile must not fall into onboarding').not.toBe(
      '/welcome',
    )
    await expect(page.getByTestId('chat-input')).toBeVisible()
    sessionID = await findLiveSessionByTitle(request, sessionTitle)

    const forbiddenRequests: string[] = []
    page.on('request', (outgoing) => {
      const path = new URL(outgoing.url()).pathname.replace(/^\/_hexclaw/, '')
      if (contract.forbiddenRequestPathPrefixes.some((prefix) => path.startsWith(prefix))) {
        forbiddenRequests.push(`${outgoing.method()} ${path}`)
      }
    })

    const writing = await submitImage(page, 'writing')
    await expect(
      writing.shell.locator('[role="status"]').first(),
      'the first image must expose processing feedback without reopening the conversation',
    ).toBeVisible({ timeout: 30_000 })
    const firstCreative = await waitForCreativeResult(writing.shell, 'writing')
    createdWorkIDs.push(firstCreative.workId)
    await assertCanonicalWork(page, testInfo, firstCreative)

    await writing.source.hover()
    await writing.source.getByRole('button', { name: '编辑消息' }).click()
    const editingImage = writing.source.locator('.hc-msg__edit-att-img')
    await expect(editingImage).toBeVisible()
    const editMarker = `作文图片编辑重发验收-${randomUUID().slice(0, 8)}`
    await writing.source.locator('[contenteditable="true"]').fill(editMarker)
    await writing.source.getByRole('button', { name: '发送', exact: true }).click()
    const resent = page.getByTestId('chat-message-user').filter({ hasText: editMarker }).last()
    await expect(resent.locator('.hc-msg__attachment-img')).toBeVisible()
    const resentID = await sourceMessageID(resent)
    const history = await listHistory(request, sessionID)
    const resentRecord = history.find(
      (message) => message.role === 'user' && message.content.includes(editMarker),
    )
    expect(resentRecord).toBeTruthy()
    const resentBytes = attachmentBytes(resentRecord!)
    expect(resentBytes.length).toBe(contract.fixtures.writing.bytes)
    expect(sha256(resentBytes)).toBe(contract.fixtures.writing.sha256)
    const resentShell = page
      .getByTestId('k12-photo-assistant-message')
      .filter({ has: page.locator(`[data-source-message-id="${resentID}"]`) })
      .last()
    const secondCreative = await waitForCreativeResult(resentShell, 'writing')
    createdWorkIDs.push(secondCreative.workId)
    expect(secondCreative.dispatchId).not.toBe(firstCreative.dispatchId)

    const homework = await submitImage(page, 'homework')
    const orderMarker = `LIVE-LATER-MATH-${randomUUID().slice(0, 8)}`
    await page
      .getByTestId('chat-input')
      .fill(`逐字保留标记 ${orderMarker}，再回答：8 的 1/4 的 4/5 是多少？`)
    await page.getByTestId('chat-send').click()
    const laterUser = page.getByTestId('chat-message-user').filter({ hasText: orderMarker }).last()
    await expect(laterUser).toBeVisible()
    const laterAssistantRecord = await waitForLiveAssistant(request, sessionID, orderMarker)
    expect(metadataOf(laterAssistantRecord).provider).toBe(contract.provider.identity)
    expect(metadataOf(laterAssistantRecord).model).toBe(contract.provider.model)
    const laterAssistant = page
      .getByTestId('chat-message-assistant')
      .filter({ hasText: orderMarker })
      .last()
    await expect(laterAssistant).toBeVisible({ timeout: 30_000 })
    await expect(laterAssistant.locator('.hc-msg__meta')).toContainText(
      `${contract.provider.displayName} · ${contract.provider.model}`,
    )

    const guard = homework.shell.getByTestId('recognize-guard')
    await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 8 * 60_000 })
    const rows = guard.getByTestId('rq-item')
    await expect(rows).toHaveCount(sourceLabels.length)
    const rowText = await rows.locator('.rec-row__qtext').allInnerTexts()
    expect(rowText.map((text) => sourceLabels.find((label) => text.trim().startsWith(`${label}.`)) ?? '')).toEqual(
      sourceLabels,
    )
    const subject = guard.getByTestId('recognize-subject')
    if (await subject.isVisible().catch(() => false)) {
      await subject.locator('.hc-select__trigger').click()
      await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '数学' }).click()
    }
    for (const checkbox of await guard.locator('input[data-testid^="rq-confirm-"]').all()) {
      await checkbox.check()
    }
    const confirmAll = guard.getByTestId('recognize-confirm-all')
    if (await confirmAll.isVisible().catch(() => false)) {
      await expect(confirmAll).toBeEnabled()
      await confirmAll.click()
    }
    const gradeAll = guard.getByTestId('recognize-grade-all')
    if (await gradeAll.isVisible().catch(() => false)) await gradeAll.click()
    await expect(guard.getByTestId('photo-grade-overlay')).toBeVisible({ timeout: 12 * 60_000 })

    const taskNode = await homework.shell.elementHandle()
    const laterNode = await laterUser.elementHandle()
    expect(taskNode && laterNode).toBeTruthy()
    expect(
      await taskNode!.evaluate(
        (node, later) => Boolean(node.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING),
        laterNode,
      ),
      'the source-anchored homework result must remain before the later math turn',
    ).toBe(true)

    const homeworkResult = await liveJSON<Json>(
      request,
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(await dispatchID(homework.shell))}/result?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
    )
    const homeworkPayload = record(record(homeworkResult.result, 'homework result').payload, 'homework payload')
    const resultItems = Array.isArray(homeworkPayload.items) ? homeworkPayload.items : []
    expect(
      resultItems.map((item) => String(record(record(item, 'result item').question, 'result question').display_label)),
    ).toEqual(sourceLabels)
    expect(forbiddenRequests).toEqual([])
    expect(
      (await listHistory(request, sessionID)).filter((message) => message.role === 'user'),
    ).toHaveLength(contract.submissions.plannedTopLevel)
    await attachJSON(testInfo, 'current-bug-real-matrix-evidence', {
      top_level_submissions: contract.submissions.plannedTopLevel,
      provider_identity: contract.provider.identity,
      provider_display_name: contract.provider.displayName,
      model: contract.provider.model,
      writing_fixture_sha256: contract.fixtures.writing.sha256,
      homework_fixture_sha256: contract.fixtures.homework.sha256,
      exact_source_labels: sourceLabels,
      source_anchored_order: true,
      forbidden_delivery_requests: forbiddenRequests,
    })
  })

  test('real durable task fixtures distinguish retryable from outcome_unknown without duplicate POST', async ({
    request,
  }, testInfo: TestInfo) => {
    const agent = envValue('HEX_K12_LIVE_AGENT')
    const retryableID = envValue('HEX_K12_LIVE_RETRYABLE_DISPATCH_ID')
    const unknownID = envValue('HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID')
    const retryable = await liveJSON<{ dispatch: Json }>(
      request,
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(retryableID)}?agent=${encodeURIComponent(agent)}`,
    )
    expect(retryable.dispatch.status).toBe('failed')
    expect(retryable.dispatch.retryable).toBe(true)
    const retried = await liveJSON<{ dispatch: Json }>(
      request,
      'POST',
      `/api/k12/image-tasks/${encodeURIComponent(retryableID)}/retry`,
      { agent, version: retryable.dispatch.version },
    )
    expect(retried.dispatch.dispatch_id).toBe(retryableID)

    const unknown = await liveJSON<{ dispatch: Json }>(
      request,
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(unknownID)}?agent=${encodeURIComponent(agent)}`,
    )
    expect(unknown.dispatch.retryable).not.toBe(true)
    expect(JSON.stringify(unknown.dispatch)).toMatch(/outcome_unknown|recovering/)
    const rejected = await request.post(
      liveAppURL(
        `/_hexclaw/api/k12/image-tasks/${encodeURIComponent(unknownID)}/retry`,
      ),
      { data: { agent, version: unknown.dispatch.version } },
    )
    expect([409, 422]).toContain(rejected.status())
    await attachJSON(testInfo, 'task-state-evidence', {
      retryable_dispatch_sha256: sha256Text(retryableID),
      outcome_unknown_dispatch_sha256: sha256Text(unknownID),
      retry_reused_same_dispatch: true,
      outcome_unknown_retry_rejected_before_provider: true,
    })
  })
})
