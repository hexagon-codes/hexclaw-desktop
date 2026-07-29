import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'

import {
  expect,
  test,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test'

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
import { classifyOperationReceiptPoll } from './k12-operation-receipt-poll'

type Json = Record<string, unknown>
type FixtureKey = 'writing' | 'homework' | 'problem' | 'art'
type CreativeIntent = 'writing' | 'art'
type FacadeSnapshot = {
  method: string
  http_status: number
  dispatch_status: string
  progress_operation: string
  progress_state: string
  target_present: boolean
  target_type: string
  projection_kind: string
  projection_stage: string
  confirmation_state: string
  question_count: number
  conflict_count: number
  candidate_count: number
  version: number
  legal_state: boolean
}

const contract = JSON.parse(
  readFileSync(new URL('./k12-current-bug-real-matrix.contract.json', import.meta.url), 'utf8'),
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
  if (key === 'problem') {
    expect(bytes.subarray(0, 3).toString('hex'), `${key} must remain JPEG`).toBe('ffd8ff')
  } else {
    expect(bytes.subarray(0, 8).toString('hex'), `${key} must remain PNG`).toBe('89504e470d0a1a0a')
    expect({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }).toEqual({
      width: value.width,
      height: value.height,
    })
  }
  return bytes
}

function record(value: unknown, label: string): Json {
  expect(value && typeof value === 'object' && !Array.isArray(value), label).toBe(true)
  return value as Json
}

function array(value: unknown, label: string): Json[] {
  expect(Array.isArray(value), label).toBe(true)
  return value as Json[]
}

function normalizedDigest(value: unknown): string {
  return String(value ?? '').replace(/^sha256:/, '')
}

function operationReceipt(result: Json, operation: 'solve' | 'work_feedback'): Json | undefined {
  return array(result.operation_receipts, 'operation_receipts must be an array').find(
    (receipt) => receipt.operation === operation,
  )
}

function assertTaskSourceAndReceipt(
  result: Json,
  key: FixtureKey,
  operation: 'solve' | 'work_feedback',
): Json {
  const frozen = contract.fixtures[key]
  expect(normalizedDigest(result.source_digest)).toBe(frozen.sha256)
  const attachments = array(result.source_attachments, 'source_attachments must be an array')
  expect(attachments).toHaveLength(1)
  expect(normalizedDigest(attachments[0]!.digest)).toBe(frozen.sha256)
  expect(attachments[0]!.size_bytes).toBe(frozen.bytes)

  const receipt = record(operationReceipt(result, operation), `${operation} receipt`)
  expect(receipt.operation).toBe(operation)
  expect(receipt.provider).toBe(contract.provider.identity)
  expect(receipt.model).toBe(contract.provider.model)
  expect(receipt.attempt).toBe(1)
  expect(receipt.status).toBe('succeeded')
  expect(String(receipt.invocation_id ?? '')).not.toBe('')
  expect(String(receipt.result_digest ?? '')).not.toBe('')
  return receipt
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

function facadeSnapshot(response: Response, dispatch: Json): FacadeSnapshot {
  const progress =
    dispatch.progress && typeof dispatch.progress === 'object' && !Array.isArray(dispatch.progress)
      ? (dispatch.progress as Json)
      : {}
  const target =
    dispatch.target && typeof dispatch.target === 'object' && !Array.isArray(dispatch.target)
      ? (dispatch.target as Json)
      : undefined
  const projection =
    dispatch.target_projection &&
    typeof dispatch.target_projection === 'object' &&
    !Array.isArray(dispatch.target_projection)
      ? (dispatch.target_projection as Json)
      : undefined
  const recognition =
    projection?.recognition &&
    typeof projection.recognition === 'object' &&
    !Array.isArray(projection.recognition)
      ? (projection.recognition as Json)
      : undefined
  const questions = Array.isArray(recognition?.questions) ? recognition.questions : []
  const candidates = Array.isArray(dispatch.confirmation_candidates)
    ? dispatch.confirmation_candidates
    : []
  const dispatchStatus = String(dispatch.status ?? '')
  const progressOperation = String(progress.operation ?? '')
  const projectionKind = String(projection?.kind ?? '')
  const topLevelConfirmationLegal =
    dispatchStatus !== 'awaiting_confirmation' ||
    (progressOperation === 'classification' && !target && !projection && candidates.length >= 2)
  const homeworkProjectionLegal =
    projectionKind !== 'homework' ||
    (dispatchStatus === 'routed' && String(target?.type ?? '') === 'homework_submission')

  return {
    method: response.request().method(),
    http_status: response.status(),
    dispatch_status: dispatchStatus,
    progress_operation: progressOperation,
    progress_state: String(progress.state ?? ''),
    target_present: !!target,
    target_type: String(target?.type ?? ''),
    projection_kind: projectionKind,
    projection_stage: String(projection?.stage ?? ''),
    confirmation_state: String(projection?.confirmation_state ?? ''),
    question_count: questions.length,
    conflict_count: questions.filter(
      (question) =>
        question &&
        typeof question === 'object' &&
        !Array.isArray(question) &&
        (question as Json).confirmation_required === true,
    ).length,
    candidate_count: candidates.length,
    version: Number(dispatch.version ?? 0),
    legal_state: topLevelConfirmationLegal && homeworkProjectionLegal,
  }
}

function traceImageTaskFacade(page: Page) {
  const entries: Array<{ dispatchId: string; snapshot: FacadeSnapshot }> = []
  const pending = new Set<Promise<void>>()
  const onResponse = (response: Response) => {
    const request = response.request()
    const path = new URL(response.url()).pathname.replace(/^\/_hexclaw/, '')
    if (
      !['GET', 'POST'].includes(request.method()) ||
      !/^\/api\/k12\/image-tasks(?:\/[^/]+)?$/.test(path)
    ) {
      return
    }
    const capture = response
      .json()
      .then((payload: unknown) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
        const dispatch = (payload as Json).dispatch
        if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) return
        const dispatchId = String((dispatch as Json).dispatch_id ?? '')
        if (!dispatchId) return
        entries.push({
          dispatchId,
          snapshot: facadeSnapshot(response, dispatch as Json),
        })
      })
      .catch(() => undefined)
      .then(() => undefined)
    pending.add(capture)
    void capture.finally(() => pending.delete(capture))
  }
  page.on('response', onResponse)
  return {
    async snapshots(dispatchId: string): Promise<FacadeSnapshot[]> {
      await Promise.allSettled([...pending])
      return entries
        .filter((entry) => entry.dispatchId === dispatchId)
        .map((entry) => entry.snapshot)
    },
    stop() {
      page.off('response', onResponse)
    },
  }
}

async function confirmRecognizedRowsIfRequired(
  page: Page,
  shell: Locator,
  testInfo: TestInfo,
  evidenceLabel: string,
  trace: ReturnType<typeof traceImageTaskFacade>,
  timeout = 8 * 60_000,
): Promise<Locator> {
  const guard = shell.getByTestId('recognize-guard')
  const dispatchId = await dispatchID(shell)
  const startedAt = Date.now()
  let hydratedAt = 0
  let snapshots: FacadeSnapshot[] = []
  try {
    while (Date.now() - startedAt < timeout) {
      snapshots = await trace.snapshots(dispatchId)
      expect(
        snapshots.every((snapshot) => snapshot.legal_state),
        `${evidenceLabel} facade must preserve the top-level intent/homework state invariant`,
      ).toBe(true)
      const latest = snapshots.at(-1)
      const firstRow = guard.getByTestId('rq-item').first()
      if (await firstRow.isVisible().catch(() => false)) break
      if (
        await guard
          .locator('.rec-panel__err')
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error(
          `real image task failed before producing questions: ${await guard.locator('.rec-panel__err').innerText()}`,
        )
      }
      if (
        latest &&
        (['failed', 'cancelled'].includes(latest.dispatch_status) ||
          ['recovering', 'failed_retryable', 'failed_terminal', 'cancelled'].includes(
            latest.projection_stage,
          ))
      ) {
        throw new Error(
          `real image task reached ${latest.dispatch_status}/${latest.projection_stage} before visible questions`,
        )
      }
      if ((latest?.question_count ?? 0) > 0) hydratedAt ||= Date.now()
      if (hydratedAt && Date.now() - hydratedAt > 10_000) {
        throw new Error(
          'facade exposed hydrated recognition for 10 seconds without projecting a visible question row',
        )
      }
      await page.waitForTimeout(250)
    }
    await expect(guard.getByTestId('rq-item').first()).toBeVisible({ timeout: 1 })
  } finally {
    snapshots = await trace.snapshots(dispatchId)
    trace.stop()
    await attachJSON(testInfo, `${evidenceLabel}-facade-projection-trace`, {
      dispatch_id_sha256: sha256Text(dispatchId),
      request_count: snapshots.length,
      snapshots,
      ui_question_count: await guard.getByTestId('rq-item').count(),
      ui_first_question_visible: await guard
        .getByTestId('rq-item')
        .first()
        .isVisible()
        .catch(() => false),
    })
  }
  await expect(guard.locator('.rec-panel__err')).toHaveCount(0)

  const subject = guard.getByTestId('recognize-subject')
  if (await subject.isVisible().catch(() => false)) {
    await subject.locator('.hc-select__trigger').click()
    await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '数学' }).click()
  }
  for (const checkbox of await guard.locator('input[data-testid^="rq-confirm-"]').all()) {
    if (!(await checkbox.isChecked())) await checkbox.check()
  }
  const confirmAll = guard.getByTestId('recognize-confirm-all')
  if (await confirmAll.isVisible().catch(() => false)) {
    await expect(confirmAll).toBeEnabled()
    await confirmAll.click()
  }
  return guard
}

async function waitForCreativeResult(
  shell: Locator,
  intent: CreativeIntent,
): Promise<{ dispatchId: string; workId: string; generationId: string; feedbackId: string }> {
  const surface = shell.getByTestId(`${intent}-result-surface`)
  const conflict = shell.getByTestId('creative-conflict-guard')
  await expect
    .poll(
      async () =>
        Number(await surface.isVisible().catch(() => false)) +
        Number(await conflict.isVisible().catch(() => false)),
      {
        timeout: 10 * 60_000,
        message: `${intent} must reach feedback or the explicit OCR conflict stop`,
      },
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

async function waitForTaskOperation(
  page: Page,
  dispatchId: string,
  operation: 'solve' | 'work_feedback',
): Promise<Json> {
  const deadline = Date.now() + 10 * 60_000
  const intervals = [100, 250, 500, 1_000]
  let intervalIndex = 0

  while (true) {
    const result = await liveJSON<Json>(
      page.request,
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(dispatchId)}/result?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
    )
    const decision = classifyOperationReceiptPoll(operationReceipt(result, operation)?.status)
    if (decision.kind === 'succeeded') return result
    if (decision.kind === 'terminal_failure') {
      throw new Error(`${operation} operation receipt reached terminal status ${decision.status}`)
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`${operation} must expose one succeeded immutable operation receipt`)
    }
    const interval = intervals[Math.min(intervalIndex, intervals.length - 1)]!
    intervalIndex += 1
    await page.waitForTimeout(Math.min(interval, remaining))
  }
}

async function resolveFixtureAgent(
  request: Page['request'],
  retryableID: string,
  outcomeUnknownID: string,
): Promise<string> {
  try {
    const catalog = await liveJSON<{ agents?: Json[] }>(request, 'GET', '/api/v1/agents')
    const candidates = Array.isArray(catalog.agents)
      ? [
          ...new Set(
            catalog.agents
              .map((candidate) => {
                const agent = record(candidate, 'fixture agent candidate')
                return typeof agent.name === 'string' ? agent.name.trim() : ''
              })
              .filter(Boolean),
          ),
        ]
      : []
    const owners: string[] = []

    for (const agent of candidates) {
      const [retryable, outcomeUnknown] = await Promise.all([
        request.get(
          liveAppURL(
            `/_hexclaw/api/k12/image-tasks/${encodeURIComponent(retryableID)}?agent=${encodeURIComponent(agent)}`,
          ),
        ),
        request.get(
          liveAppURL(
            `/_hexclaw/api/k12/image-tasks/${encodeURIComponent(outcomeUnknownID)}?agent=${encodeURIComponent(agent)}`,
          ),
        ),
      ])
      if (retryable.ok() && outcomeUnknown.ok()) owners.push(agent)
    }

    if (owners.length !== 1) throw new Error('fixture ownership resolution failed')
    return owners[0]!
  } catch {
    throw new Error('fixture ownership resolution failed')
  }
}

async function submitImage(
  page: Page,
  key: FixtureKey,
  traceFacade = false,
): Promise<{
  source: Locator
  sourceId: string
  shell: Locator
  trace?: ReturnType<typeof traceImageTaskFacade>
}> {
  const trace = traceFacade ? traceImageTaskFacade(page) : undefined
  await expect(
    page.locator('.k12enh-seg'),
    'K12 scenario must be mounted before image upload',
  ).toBeVisible({ timeout: 30_000 })
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
  return { source, sourceId, shell, trace }
}

async function assertCanonicalWork(
  page: Page,
  testInfo: TestInfo,
  evidence: Awaited<ReturnType<typeof waitForCreativeResult>>,
  intent: CreativeIntent,
  key: 'writing' | 'art',
): Promise<void> {
  const result = await liveJSON<Json>(
    page.request,
    'GET',
    `/api/k12/image-tasks/${encodeURIComponent(evidence.dispatchId)}/result?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
  )
  assertTaskSourceAndReceipt(result, key, 'work_feedback')
  const payload = record(record(result.result, 'creative result').payload, 'creative payload')
  const resultWork = record(payload.work, 'creative result work')
  const feedback = record(payload.feedback, 'creative feedback')
  const structured = record(feedback.structured_feedback, 'structured feedback')
  expect(resultWork.work_id).toBe(evidence.workId)
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
    .getByTestId(`${intent}-result-surface`)
    .locator(`[data-generation-id="${evidence.generationId}"]`)
  const chatProjection = await chatRenderer.innerText()
  await page.locator('#k12-enh-tab-records').click()
  await page.getByTestId('subtab-works').click()
  const card = page.locator(`[data-work-id="${evidence.workId}"]`)
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByTestId('cw-detail-toggle').click()
  const archiveRenderer = page
    .getByTestId('cw-detail-modal')
    .locator(
      `[data-generation-id="${evidence.generationId}"][data-feedback-id="${evidence.feedbackId}"]`,
    )
  await expect(archiveRenderer).toBeVisible()
  expect(await archiveRenderer.innerText()).toBe(chatProjection)
  await attachJSON(testInfo, `${intent}-creative-work-same-source-evidence`, {
    work_id_sha256: sha256Text(evidence.workId),
    generation_id_sha256: sha256Text(evidence.generationId),
    feedback_id_sha256: sha256Text(evidence.feedbackId),
    projection_sha256: sha256Text(String(feedback.projection_markdown)),
    chat_archive_same_renderer_text: true,
  })
  await page.getByTestId('cw-detail-close').click()
  await page.locator('#k12-enh-tab-chat').click()
}

const homeworkGroundTruth = [
  { label: '一、1', question: '4/0.5', answer: ['8'], status: 'correct' },
  { label: '一、2', question: '10*0.01', answer: ['0.1'], status: 'correct' },
  { label: '一、3', question: '4.7+2.3', answer: ['7'], status: 'correct' },
  { label: '一、4', question: '1.8*50', answer: ['90'], status: 'correct' },
  { label: '一、5', question: '3.25+0.75', answer: ['4'], status: 'correct' },
  { label: '一、6', question: '5/7-1/5', answer: ['18/35'], status: 'correct' },
  { label: '一、7', question: '7-5/7', answer: ['44/7', '6又2/7'], status: 'correct' },
  { label: '一、8', question: '0.5+1/3', answer: ['5/6'], status: 'correct' },
  { label: '一、9', question: '4/5+2/5', answer: ['6/5', '1又1/5'], status: 'correct' },
  { label: '二、1', question: '8.7*17.4-8.7*7.4', answer: ['87'], status: 'correct' },
  { label: '二、2', question: '15.02-6.8-1.02', answer: ['7.2'], status: 'correct' },
  {
    label: '二、3',
    question: '0.25+11/15+4/15+3/4',
    answer: ['2'],
    status: 'correct',
  },
  { label: '三、1', question: '3/8是24', answer: ['64'], status: 'correct' },
  { label: '三、2', question: '8的1/4的4/5', answer: ['8/5', '1又3/5'], status: 'correct' },
  { label: '四、1', question: '周长是300米', answer: ['11250'], status: 'correct' },
  { label: '五、1', question: '5,6,12,14,23,29', answer: ['29'], status: 'wrong' },
] as const

const sourceLabels = homeworkGroundTruth.map((item) => item.label)

type ProblemKind = 'standalone' | 'compound_parent' | 'subproblem'
type ProblemOracle = {
  label: string
  path: string[]
  kind: ProblemKind
  question: string
  answers?: string[]
  parentLabel?: '四' | '五'
}

const problemGroundTruth: ProblemOracle[] = [
  { label: '一、1', path: ['一', '1'], kind: 'standalone', question: '4.5*2', answers: ['9'] },
  {
    label: '一、2',
    path: ['一', '2'],
    kind: 'standalone',
    question: '15-5.7',
    answers: ['9.3'],
  },
  {
    label: '一、3',
    path: ['一', '3'],
    kind: 'standalone',
    question: '4.5/0.01',
    answers: ['450'],
  },
  { label: '一、4', path: ['一', '4'], kind: 'standalone', question: '2/5', answers: ['0.4'] },
  { label: '一、5', path: ['一', '5'], kind: 'standalone', question: '2*4.3', answers: ['8.6'] },
  {
    label: '一、6',
    path: ['一', '6'],
    kind: 'standalone',
    question: '7.2+12.8',
    answers: ['20'],
  },
  {
    label: '一、7',
    path: ['一', '7'],
    kind: 'standalone',
    question: '0.48*0.2',
    answers: ['0.096'],
  },
  {
    label: '一、8',
    path: ['一', '8'],
    kind: 'standalone',
    question: '7.2*0.8',
    answers: ['5.76'],
  },
  { label: '一、9', path: ['一', '9'], kind: 'standalone', question: '6.4-4', answers: ['2.4'] },
  {
    label: '一、10',
    path: ['一', '10'],
    kind: 'standalone',
    question: '0.24/0.3',
    answers: ['0.8'],
  },
  {
    label: '二、1',
    path: ['二', '1'],
    kind: 'standalone',
    question: '0.4*0.8',
    answers: ['0.32'],
  },
  {
    label: '二、2',
    path: ['二', '2'],
    kind: 'standalone',
    question: '0.25*32*0.125',
    answers: ['1'],
  },
  {
    label: '二、3',
    path: ['二', '3'],
    kind: 'standalone',
    question: '194-64.8/1.8*0.9',
    answers: ['161.6'],
  },
  {
    label: '二、4',
    path: ['二', '4'],
    kind: 'standalone',
    question: '135/0.5',
    answers: ['270'],
  },
  {
    label: '二、5',
    path: ['二', '5'],
    kind: 'standalone',
    question: '21*(9.3-3.7)-5.6',
    answers: ['112'],
  },
  {
    label: '二、6',
    path: ['二', '6'],
    kind: 'standalone',
    question: '68-7.5+32-2.5',
    answers: ['90'],
  },
  {
    label: '三、1',
    path: ['三', '1'],
    kind: 'standalone',
    question: '75.9-9.8+4x=66.14',
    answers: ['x=0.01', '0.01'],
  },
  {
    label: '三、2',
    path: ['三', '2'],
    kind: 'standalone',
    question: '4x+3*0.7=6.5',
    answers: ['x=1.1', '1.1'],
  },
  {
    label: '三、3',
    path: ['三', '3'],
    kind: 'standalone',
    question: '0.75x-0.95*4=8.5',
    answers: ['x=16.4', '16.4'],
  },
  {
    label: '三、4',
    path: ['三', '4'],
    kind: 'standalone',
    question: '2x/2.8=8.2',
    answers: ['x=11.48', '11.48'],
  },
  {
    label: '三、5',
    path: ['三', '5'],
    kind: 'standalone',
    question: '2.7+4x=12.7',
    answers: ['x=2.5', '2.5'],
  },
  {
    label: '三、6',
    path: ['三', '6'],
    kind: 'standalone',
    question: '6x+15*7=141',
    answers: ['x=6', '6'],
  },
  {
    label: '四',
    path: ['四'],
    kind: 'compound_parent',
    question: '棱长是6dm的正方体鱼缸',
  },
  {
    label: '四、1',
    path: ['四', '1'],
    kind: 'subproblem',
    parentLabel: '四',
    question: '至少需要玻璃多少平方米',
    answers: ['1.8平方米', '1.8m2'],
  },
  {
    label: '四、2',
    path: ['四', '2'],
    kind: 'subproblem',
    parentLabel: '四',
    question: '水面高度是多少分米',
    answers: ['4分米', '4dm'],
  },
  {
    label: '五',
    path: ['五'],
    kind: 'compound_parent',
    question: '最大公约数是13',
  },
  {
    label: '五、1',
    path: ['五', '1'],
    kind: 'subproblem',
    parentLabel: '五',
    question: '排',
    answers: ['无解', '不存在', '题目矛盾', '条件矛盾'],
  },
  {
    label: '五、2',
    path: ['五', '2'],
    kind: 'subproblem',
    parentLabel: '五',
    question: '号',
    answers: ['无解', '不存在', '题目矛盾', '条件矛盾'],
  },
]

const parentGuideKeys = [
  'answer',
  'full_solution_steps',
  'grade_level_method',
  'likely_mistakes',
  'parent_teaching_sequence',
  'follow_up_questions',
  'checking_method',
] as const

function normalizeSemantic(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d+)\\frac/g, '$1又\\frac')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/[×x*]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/[−－–—]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[＝]/g, '=')
    .replace(/平方/g, '2')
    .replace(/[（）(){}，,。；;：:\s^]/g, '')
}

function expectSemanticAlternative(value: unknown, alternatives: readonly string[], label: string) {
  const normalized = normalizeSemantic(value)
  expect(
    alternatives.some((candidate) => normalized.includes(normalizeSemantic(candidate))),
    `${label}: ${JSON.stringify(alternatives)} must match normalized semantic text`,
  ).toBe(true)
}

function assertParentGuide(value: unknown, label: string): Json {
  const guide = record(value, `${label} parent guide`)
  expect(
    Object.keys(guide).sort(),
    `${label} must expose exactly seven parent-guide fields`,
  ).toEqual([...parentGuideKeys].sort())
  expect(String(guide.answer ?? '').trim(), `${label} answer`).not.toBe('')
  for (const key of [
    'full_solution_steps',
    'likely_mistakes',
    'parent_teaching_sequence',
    'follow_up_questions',
  ] as const) {
    const entries = array(guide[key], `${label}.${key}`)
    expect(
      entries.length,
      `${label}.${key} must retain at least one ordered entry`,
    ).toBeGreaterThan(0)
    expect(
      entries.every((entry) => typeof entry === 'string' && entry.trim().length > 0),
      `${label}.${key} entries must be non-empty strings`,
    ).toBe(true)
  }
  for (const key of ['grade_level_method', 'checking_method'] as const) {
    expect(String(guide[key] ?? '').trim(), `${label}.${key}`).not.toBe('')
  }
  return guide
}

function recognizedQuestions(dispatch: Json, label: string): Json[] {
  const projection = record(dispatch.target_projection, `${label} target projection`)
  const recognition = record(projection.recognition, `${label} recognition`)
  return array(recognition.questions, `${label} recognition questions`)
}

async function loadDispatch(page: Page, dispatchId: string): Promise<Json> {
  const response = await liveJSON<{ dispatch: Json }>(
    page.request,
    'GET',
    `/api/k12/image-tasks/${encodeURIComponent(dispatchId)}?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
  )
  return record(response.dispatch, 'image task dispatch')
}

function assertProblemStructure(questions: Json[]): void {
  expect(questions, 'blank worksheet must expose 28 structural nodes').toHaveLength(28)
  expect(questions.map((question) => question.display_label)).toEqual(
    problemGroundTruth.map((item) => item.label),
  )
  expect(questions.map((question) => question.source_number_path)).toEqual(
    problemGroundTruth.map((item) => item.path),
  )
  expect(questions.map((question) => question.problem_kind)).toEqual(
    problemGroundTruth.map((item) => item.kind),
  )
  expect(new Set(questions.map((question) => question.problem_id)).size).toBe(28)
  const parentIDs = new Map<string, string>()
  questions.forEach((question, index) => {
    const oracle = problemGroundTruth[index]!
    expectSemanticAlternative(question.question, [oracle.question], `${oracle.label} question`)
    if (oracle.kind === 'compound_parent') {
      expect(String(question.attempt_id ?? ''), `${oracle.label} parent has no attempt`).toBe('')
      parentIDs.set(oracle.label, String(question.problem_id))
      return
    }
    expect(question.answer_state, `${oracle.label} blank answer state`).toBe('blank')
    expect(
      String(question.student_answer ?? '').trim(),
      `${oracle.label} has no student answer`,
    ).toBe('')
    if (oracle.parentLabel) {
      expect(question.parent_problem_id, `${oracle.label} parent identity`).toBe(
        parentIDs.get(oracle.parentLabel),
      )
    }
  })
}

function assertBlankWorksheetResult(payload: Json): void {
  expect(payload.mode).toBe('solve')
  expect(payload.task_intent).toBe('blank_worksheet')
  expect(payload.result_surface).toBe('parent_teaching_guide')
  const items = array(payload.items, 'blank worksheet result items')
  const answerable = problemGroundTruth.filter((item) => item.kind !== 'compound_parent')
  expect(items, '28 structural nodes must project exactly 26 answerable results').toHaveLength(26)
  expect(items.map((item) => record(item.question, 'blank result question').display_label)).toEqual(
    answerable.map((item) => item.label),
  )
  items.forEach((item, index) => {
    const oracle = answerable[index]!
    expect(item.status, `${oracle.label} status`).toBe('blank_solved')
    expect(item.result_kind, `${oracle.label} result kind`).toBe('parent_teaching_guide')
    const guide = assertParentGuide(item.parent_guide, oracle.label)
    expectSemanticAlternative(guide.answer, oracle.answers!, `${oracle.label} ground-truth answer`)
  })
}

function assertHomeworkResult(payload: Json): void {
  expect(payload.mode).toBe('grade')
  expect(payload.task_intent).toBe('completed_homework')
  expect(payload.result_surface).toBe('annotated_homework')
  expect(typeof payload.image_warning).toBe('string')
  const items = array(payload.items, 'homework result items')
  expect(items).toHaveLength(homeworkGroundTruth.length)
  expect(
    items.map((item) => record(item.question, 'homework result question').display_label),
  ).toEqual(sourceLabels)
  items.forEach((item, index) => {
    const oracle = homeworkGroundTruth[index]!
    const question = record(item.question, `${oracle.label} question`)
    const grade = record(item.grade, `${oracle.label} grade`)
    expectSemanticAlternative(question.question, [oracle.question], `${oracle.label} question`)
    expectSemanticAlternative(
      question.student_answer,
      oracle.answer,
      `${oracle.label} student answer`,
    )
    expect(item.result_kind, `${oracle.label} assessment kind`).toBe('assessment')
    expect(item.status, `${oracle.label} judgment`).toBe(oracle.status)
    expect(grade.solve_only, `${oracle.label} must remain grading, not solve-only`).toBe(false)
    expect(grade.out_of_scope, `${oracle.label} must remain in-scope`).toBe(false)
    expect(grade.verdict, `${oracle.label} verdict`).toBe(
      oracle.status === 'correct' ? 'agree' : 'disagree',
    )
    expectSemanticAlternative(grade.solution, oracle.answer, `${oracle.label} canonical solution`)
    if (oracle.status === 'correct') {
      expect(
        item.parent_guide,
        `${oracle.label} correct item must not invent parent guide`,
      ).toBeUndefined()
      return
    }
    const diagnostic = normalizeSemantic(
      `${String(grade.wrong_step ?? '')} ${String(grade.error_cause ?? '')}`,
    )
    for (const token of ['42', '18', '2']) {
      expect(diagnostic, `${oracle.label} process diagnosis must preserve ${token}`).toContain(
        token,
      )
    }
    const guide = assertParentGuide(item.parent_guide, oracle.label)
    expectSemanticAlternative(guide.answer, ['29'], `${oracle.label} correct final answer`)
    const teaching = normalizeSemantic(
      [
        ...(guide.parent_teaching_sequence as string[]),
        ...(guide.follow_up_questions as string[]),
        String(guide.checking_method),
      ].join(' '),
    )
    expect(teaching, `${oracle.label} guide must teach the valid 40=20×2 partition`).toContain('40')
    expect(teaching, `${oracle.label} guide must teach the valid 40=20×2 partition`).toContain('20')
  })
  if (payload.annotated_image !== undefined) {
    const annotated = record(payload.annotated_image, 'annotated homework image')
    expect(annotated.mime).toBe('image/png')
    const encoded = String(annotated.data_base64 ?? '')
    expect(encoded).not.toBe('')
    expect(String(annotated.digest ?? '')).toMatch(/^sha256:/)
    const annotatedBytes = Buffer.from(encoded, 'base64')
    expect(annotatedBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(
      normalizedDigest(annotated.digest),
      'annotated image digest must bind the exact visible PNG bytes',
    ).toBe(sha256(annotatedBytes))
  }
}

test('fixture manifest freezes four user-supplied source images and the submission budget', () => {
  for (const key of ['writing', 'homework', 'problem', 'art'] as const) {
    expect(existsSync(fixture(key).path)).toBe(true)
    verifyFixture(key)
  }
  expect(contract.submissions.plannedTopLevel).toBe(6)
  expect(contract.submissions.plannedTopLevel).toBeLessThanOrEqual(
    contract.submissions.maximumTopLevel,
  )
})

test.describe.serial('LIVE current K12 bug acceptance matrix', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'frozen app + real provider + state fixtures'),
  )

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

  test('six real submissions preserve solve/creative receipts, attachment, source order and provider display', async ({
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
    expect([
      configured?.model,
      ...(Array.isArray(configured?.models) ? configured.models : []),
    ]).toContain(contract.provider.model)

    sessionTitle = `LIVE-K12-BUG-${randomUUID().slice(0, 8)}`
    await page.goto(
      liveAppURL(
        `/chat?role=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}&roleTitle=${encodeURIComponent(sessionTitle)}&model=${encodeURIComponent(contract.provider.model)}`,
      ),
      { waitUntil: 'domcontentloaded' },
    )
    expect(
      new URL(page.url()).pathname,
      'authorized installed profile must not fall into onboarding',
    ).not.toBe('/welcome')
    await expect(page.getByTestId('chat-input')).toBeVisible()
    sessionID = await findLiveSessionByTitle(request, sessionTitle)

    const forbiddenRequests: string[] = []
    page.on('request', (outgoing) => {
      const path = new URL(outgoing.url()).pathname.replace(/^\/_hexclaw/, '')
      if (contract.forbiddenRequestPathPrefixes.some((prefix) => path.startsWith(prefix))) {
        forbiddenRequests.push(`${outgoing.method()} ${path}`)
      }
    })

    const problem = await submitImage(page, 'problem', true)
    const problemDispatchId = await dispatchID(problem.shell)
    await confirmRecognizedRowsIfRequired(page, problem.shell, testInfo, 'problem', problem.trace!)
    const problemResult = await waitForTaskOperation(page, problemDispatchId, 'solve')
    const problemDispatch = await loadDispatch(page, problemDispatchId)
    assertProblemStructure(recognizedQuestions(problemDispatch, 'blank worksheet'))
    const solveReceipt = assertTaskSourceAndReceipt(problemResult, 'problem', 'solve')
    const problemPayload = record(
      record(problemResult.result, 'solve terminal result').payload,
      'blank worksheet payload',
    )
    assertBlankWorksheetResult(problemPayload)
    const problemHistory = (await listHistory(request, sessionID)).find(
      (message) => record(message, 'history message').id === problem.sourceId,
    )
    expect(problemHistory).toBeTruthy()
    const persistedProblemBytes = attachmentBytes(problemHistory!)
    expect(persistedProblemBytes.length).toBe(contract.fixtures.problem.bytes)
    expect(sha256(persistedProblemBytes)).toBe(contract.fixtures.problem.sha256)

    const writing = await submitImage(page, 'writing')
    await expect(
      writing.shell.locator('[role="status"]').first(),
      'the first image must expose processing feedback without reopening the conversation',
    ).toBeVisible({ timeout: 30_000 })
    const firstCreative = await waitForCreativeResult(writing.shell, 'writing')
    createdWorkIDs.push(firstCreative.workId)
    await assertCanonicalWork(page, testInfo, firstCreative, 'writing', 'writing')

    const art = await submitImage(page, 'art')
    const artCreative = await waitForCreativeResult(art.shell, 'art')
    createdWorkIDs.push(artCreative.workId)
    await assertCanonicalWork(page, testInfo, artCreative, 'art', 'art')

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

    const homework = await submitImage(page, 'homework', true)
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

    const guard = await confirmRecognizedRowsIfRequired(
      page,
      homework.shell,
      testInfo,
      'homework',
      homework.trace!,
    )
    const homeworkDispatchId = await dispatchID(homework.shell)
    const homeworkDispatch = await loadDispatch(page, homeworkDispatchId)
    const homeworkQuestions = recognizedQuestions(homeworkDispatch, 'completed homework')
    expect(homeworkQuestions).toHaveLength(homeworkGroundTruth.length)
    expect(homeworkQuestions.map((question) => question.display_label)).toEqual(sourceLabels)
    homeworkQuestions.forEach((question, index) => {
      const oracle = homeworkGroundTruth[index]!
      expect(question.problem_kind).toBe('standalone')
      expect(question.source_number_path).toEqual(oracle.label.split('、'))
      expect(question.answer_state).toBe('present')
      expectSemanticAlternative(question.question, [oracle.question], `${oracle.label} recognition`)
      expectSemanticAlternative(
        question.student_answer,
        oracle.answer,
        `${oracle.label} recognized answer`,
      )
    })
    const rows = guard.getByTestId('rq-item')
    await expect(rows).toHaveCount(sourceLabels.length)
    const rowText = await rows.locator('.rec-row__qtext').allInnerTexts()
    expect(
      rowText.map(
        (text) => sourceLabels.find((label) => text.trim().startsWith(`${label}.`)) ?? '',
      ),
    ).toEqual(sourceLabels)
    const gradeAll = guard.getByTestId('recognize-grade-all')
    if (await gradeAll.isVisible().catch(() => false)) await gradeAll.click()
    const overlay = guard.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 12 * 60_000 })
    expect(
      await overlay
        .locator('[data-testid^="overlay-mark-"], [data-testid^="overlay-degraded-"]')
        .count(),
      'every answered source item must expose one visible positioned or degraded annotation',
    ).toBe(homeworkGroundTruth.length)

    const taskNode = await homework.shell.elementHandle()
    const laterNode = await laterUser.elementHandle()
    expect(taskNode && laterNode).toBeTruthy()
    expect(
      await taskNode!.evaluate(
        (node, later) =>
          Boolean(node.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING),
        laterNode,
      ),
      'the source-anchored homework result must remain before the later math turn',
    ).toBe(true)

    const homeworkResult = await liveJSON<Json>(
      request,
      'GET',
      `/api/k12/image-tasks/${encodeURIComponent(homeworkDispatchId)}/result?agent=${encodeURIComponent(envValue('HEX_K12_LIVE_AGENT'))}`,
    )
    const homeworkPayload = record(
      record(homeworkResult.result, 'homework result').payload,
      'homework payload',
    )
    const resultItems = Array.isArray(homeworkPayload.items) ? homeworkPayload.items : []
    assertHomeworkResult(homeworkPayload)
    expect(
      resultItems.map((item) =>
        String(record(record(item, 'result item').question, 'result question').display_label),
      ),
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
      problem_fixture_sha256: contract.fixtures.problem.sha256,
      writing_fixture_sha256: contract.fixtures.writing.sha256,
      art_fixture_sha256: contract.fixtures.art.sha256,
      homework_fixture_sha256: contract.fixtures.homework.sha256,
      solve_invocation_sha256: sha256Text(String(solveReceipt.invocation_id)),
      solve_result_digest: solveReceipt.result_digest,
      problem_structural_nodes: problemGroundTruth.length,
      problem_answerable_items: problemGroundTruth.filter((item) => item.kind !== 'compound_parent')
        .length,
      problem_compound_parents: problemGroundTruth.filter((item) => item.kind === 'compound_parent')
        .length,
      problem_source_labels: problemGroundTruth.map((item) => item.label),
      problem_parent_guide_fields: parentGuideKeys,
      exact_source_labels: sourceLabels,
      homework_answerable_items: homeworkGroundTruth.length,
      homework_expected_correct: homeworkGroundTruth.filter((item) => item.status === 'correct')
        .length,
      homework_expected_process_wrong: homeworkGroundTruth.filter((item) => item.status === 'wrong')
        .length,
      homework_annotation_count: homeworkGroundTruth.length,
      source_anchored_order: true,
      forbidden_delivery_requests: forbiddenRequests,
    })
  })

  test('real durable task fixtures distinguish retryable from outcome_unknown without duplicate POST', async ({
    request,
  }, testInfo: TestInfo) => {
    const retryableID = envValue('HEX_K12_LIVE_RETRYABLE_DISPATCH_ID')
    const unknownID = envValue('HEX_K12_LIVE_OUTCOME_UNKNOWN_DISPATCH_ID')
    const agent = await resolveFixtureAgent(request, retryableID, unknownID)
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
      liveAppURL(`/_hexclaw/api/k12/image-tasks/${encodeURIComponent(unknownID)}/retry`),
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
