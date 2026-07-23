import { readFileSync, statSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  assertLiveRuntime,
  cleanupLiveChild,
  liveGateBlockers,
  liveJSON,
  liveSidecarURL,
  liveSkipReason,
} from '../live/k12-live-helpers'

/** ROT-001..014 / WF-K12-003..015 / E2E-WF-K12-001. */
const blockers = liveGateBlockers({ isolatedProfile: true, model: true })
const TRIGGERS = ['ui', 'http', 'cron', 'webhook', 'direct'] as const
const REQUIRED_ROTATIONS = [
  'success',
  'forbidden',
  'replay',
  'retryable_failure',
  'non_retryable_failure',
  'pause_resume',
  'cancel',
  'restart',
  'version_cutover',
  'two_learners',
  'outcome_unknown',
  'deletion_race',
] as const

type Trigger = (typeof TRIGGERS)[number]
type Rotation = (typeof REQUIRED_ROTATIONS)[number]
type Json = Record<string, unknown>

interface SideEffects {
  domain_objects: number
  artifacts: number
  outbox: number
  model_calls: number
  receipts: number
}

interface TriggerCase {
  id: string
  workflow_id: string
  workflow_version: string
  trigger: Trigger
  rotation: Rotation
  allowed: boolean
  owner_id: string
  learner_id: string
  object_id: string
  input_digest: string
  idempotency_key: string
  request_id: string
  execution_id?: string
  trace_id: string
  http_status: number
  terminal: string
  result_projection_digest?: string
  definition_digest: string
  receipt_ids: string[]
  node_attempts: Array<{
    node_id: string
    attempt: number
    status: string
    checkpoint_digest?: string
  }>
  state_history?: string[]
  fault_step_id?: string
  learner_display_name?: string
  blind_resends?: number
  side_effects: SideEffects
  replay_of?: string
  prior_execution_id?: string
  error_code?: string
}

interface WorkflowEvidence {
  id: string
  definition_versions: Array<{ version: string; digest: string }>
  eligible_triggers: Trigger[]
  forbidden_triggers: Trigger[]
  steps: string[]
  states: string[]
  terminals: string[]
}

interface RotationManifest {
  schema_version: string
  source: 'real'
  generated_at: string
  profile_id: string
  workflows: WorkflowEvidence[]
  cases: TriggerCase[]
  residual: {
    definitions: string[]
    jobs: string[]
    bindings: string[]
    runs: string[]
    outbox: string[]
    receipts: string[]
  }
}

function zeros(effects: SideEffects): boolean {
  return Object.values(effects).every((value) => value === 0)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function loadManifest(path: string): RotationManifest {
  expect(statSync(path).isFile(), 'rotation evidence must be a regular JSON file').toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as RotationManifest
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
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '五年级' }).click()
  await page.locator('.k12pf .hc-select__trigger').nth(1).click()
  await page.locator('.hc-select__dropdown .hc-select__option', { hasText: '下学期' }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.k12pf')).toHaveCount(0, { timeout: 30_000 })
  const payload = await liveJSON<Json>(page.request, 'GET', '/api/v1/agents')
  const agents = Array.isArray(payload.agents) ? (payload.agents as Json[]) : []
  const owned = agents.filter(
    (agent) => (agent.metadata as Json | undefined)?.['k12.child_name'] === childName,
  )
  expect(owned).toHaveLength(1)
  const agentID = String(owned[0]!.name || '')
  const metadata = owned[0]!.metadata as Json
  const learnerID = String(metadata['k12.learner_id'] || metadata['k12.child_id'] || '')
  expect(agentID).not.toBe('')
  expect(learnerID).not.toBe('')
  return { agentID, learnerID }
}

async function deleteWorkflow(
  request: APIRequestContext,
  workflowID: string,
  owner: { agentID: string; learnerID: string } | undefined,
): Promise<void> {
  if (!workflowID) return
  const query = owner
    ? `?user_id=desktop-user&scenario=k12&agent_id=${encodeURIComponent(owner.agentID)}&learner_id=${encodeURIComponent(owner.learnerID)}`
    : ''
  const response = await request.delete(
    liveSidecarURL(`/api/v1/canvas/workflows/${encodeURIComponent(workflowID)}${query}`),
  )
  expect(
    [200, 204, 404],
    `DELETE /api/v1/canvas/workflows/:id => HTTP ${response.status()} (body redacted)`,
  ).toContain(response.status())
}

test.describe.serial('visible K12 Workflow save and UI trigger', () => {
  test.setTimeout(8 * 60_000)
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real model'),
  )

  let childName = ''
  let workflowID = ''
  let owner: { agentID: string; learnerID: string } | undefined

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test.afterEach(async ({ request }) => {
    const cleanupFailures: unknown[] = []
    try {
      await deleteWorkflow(request, workflowID, owner)
    } catch (error) {
      cleanupFailures.push(error)
    } finally {
      workflowID = ''
    }
    try {
      await cleanupLiveChild(request, childName)
    } catch (error) {
      cleanupFailures.push(error)
    } finally {
      childName = ''
      owner = undefined
    }
    if (cleanupFailures.length) {
      throw new AggregateError(cleanupFailures, 'K12 workflow cleanup did not reach zero residue')
    }
  })

  test('save immutable v1 owner scope and expose a real completed UI run', async ({ page }) => {
    childName = `工作流${Date.now().toString(36)}`
    owner = await createTutor(page, childName)
    await page.goto(
      `/automation/workflows?scenario=k12&agent_id=${encodeURIComponent(owner.agentID)}&learner_id=${encodeURIComponent(owner.learnerID)}`,
      {
        waitUntil: 'domcontentloaded',
      },
    )
    await page.getByRole('button', { name: '新建工作流', exact: true }).first().click()
    const workflowName = `K12拍照批改-${Date.now().toString(36)}`
    await page.locator('.wfp-name-input').fill(workflowName)

    const modelNode = page.locator('.wf-node--agent, .wf-node').filter({ hasText: '模型' }).first()
    await modelNode.getByTitle(/编辑/).click()
    const editDialog = page.locator('.wfp-modal-overlay')
    await editDialog
      .locator('textarea')
      .first()
      .fill('仅处理已确认的 K12 作业输入，并返回结构化批改结果。')
    await editDialog.getByRole('button', { name: /保存|确定/ }).click()

    const saveRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith('/api/v1/canvas/workflows'),
    )
    await page
      .locator('.wfp-head__actions')
      .getByRole('button', { name: '保存', exact: true })
      .click()
    const saveRequest = await saveRequestPromise
    const definition = saveRequest.postDataJSON() as Json
    workflowID = String(definition.id || '')
    expect(workflowID).not.toBe('')
    const data = definition.data as Json | undefined
    expect(
      data,
      'K12 UI save must freeze versioned owner metadata instead of creating a generic workflow',
    ).toMatchObject({
      scenario: 'k12',
      agent_id: owner.agentID,
      learner_id: owner.learnerID,
      version: 'v1',
    })
    const saveResponse = await saveRequest.response()
    expect(saveResponse?.ok(), 'save must reach the durable workflow registry').toBe(true)
    await expect(page.getByText('工作流已保存', { exact: false })).toBeVisible()

    const runRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith(
          `/api/v1/canvas/workflows/${encodeURIComponent(workflowID)}/run`,
        ),
    )
    await page
      .locator('.wfp-head__actions')
      .getByRole('button', { name: /试运行/ })
      .click()
    const runRequest = await runRequestPromise
    const runBody = runRequest.postDataJSON() as Json
    expect(runBody.input, 'UI trigger must send a canonical non-empty input').not.toBe('')
    expect(runBody.metadata).toMatchObject({
      scenario: 'k12',
      agent_id: owner.agentID,
      learner_id: owner.learnerID,
      workflow_version: 'v1',
      trigger_key: 'ui',
    })
    await expect(page.locator('.wfp-run--completed')).toBeVisible({ timeout: 5 * 60_000 })
    const runResponse = await runRequest.response()
    expect(runResponse?.ok()).toBe(true)
    const accepted = (await runResponse!.json()) as Json
    expect(String(accepted.id || ''), 'UI execution must return a durable execution id').not.toBe(
      '',
    )
    expect(String(accepted.status || '')).toMatch(/^(?:pending|running|completed)$/)
  })
})

test.describe('machine-generated K12 workflow × trigger × transition rotation', () => {
  test.skip(
    blockers.length > 0,
    liveSkipReason(blockers, 'installed RC + isolated profile + authorized real model'),
  )

  test.beforeEach(async ({ page, request }, testInfo) => {
    await assertLiveRuntime(page, request, testInfo)
  })

  test('all allowed and forbidden leaves have real terminals, stable projections and zero residue', () => {
    const manifestPath = process.env.HEX_K12_WORKFLOW_ROTATION_MANIFEST
    test.skip(
      !manifestPath,
      'NOT RUN: HEX_K12_WORKFLOW_ROTATION_MANIFEST is required; UI-only dry-run evidence cannot cover HTTP/Cron/Webhook/direct',
    )
    const manifest = loadManifest(manifestPath!)
    expect(manifest.schema_version).toBe('k12-workflow-rotation/v1')
    expect(manifest.source).toBe('real')
    expect(manifest.profile_id).not.toBe('')
    expect(Date.parse(manifest.generated_at)).not.toBeNaN()
    expect(
      manifest.workflows.length,
      'the current Manifest must enumerate at least one K12 workflow',
    ).toBeGreaterThan(0)

    const workflowIDs = manifest.workflows.map((workflow) => workflow.id)
    expect(new Set(workflowIDs).size).toBe(workflowIDs.length)
    for (const workflow of manifest.workflows) {
      expect(workflow.definition_versions.length).toBeGreaterThanOrEqual(2)
      expect(new Set(workflow.definition_versions.map((item) => item.version)).size).toBe(
        workflow.definition_versions.length,
      )
      expect(
        new Set(workflow.definition_versions.map((item) => item.digest)).size,
        `${workflow.id} immutable versions need distinct definitions`,
      ).toBe(workflow.definition_versions.length)
      for (const version of workflow.definition_versions) {
        expect(version.version).toMatch(/^v\d+$/)
        expect(version.digest).toMatch(/^[a-f0-9]{64}$/)
      }
      expect(
        [...workflow.eligible_triggers, ...workflow.forbidden_triggers].sort(),
        `${workflow.id} trigger eligibility exact-set`,
      ).toEqual([...TRIGGERS].sort())
      expect(new Set([...workflow.eligible_triggers, ...workflow.forbidden_triggers]).size).toBe(
        TRIGGERS.length,
      )
      expect(workflow.steps.length).toBeGreaterThan(0)
      expect(workflow.states).toEqual(expect.arrayContaining(['pending', 'running']))
      expect(workflow.terminals).toEqual(
        expect.arrayContaining(['completed', 'failed', 'cancelled']),
      )

      for (const trigger of TRIGGERS) {
        const leaves = manifest.cases.filter(
          (leaf) => leaf.workflow_id === workflow.id && leaf.trigger === trigger,
        )
        expect(leaves.length, `${workflow.id}/${trigger} has no generated leaf`).toBeGreaterThan(0)
        const expectedAllowed = workflow.eligible_triggers.includes(trigger)
        expect(
          leaves.every((leaf) => leaf.allowed === expectedAllowed),
          `${workflow.id}/${trigger} eligibility drift`,
        ).toBe(true)
        if (expectedAllowed) {
          for (const rotation of REQUIRED_ROTATIONS.filter((item) => item !== 'forbidden')) {
            expect(
              leaves.some((leaf) => leaf.rotation === rotation),
              `${workflow.id}/${trigger}/${rotation} missing`,
            ).toBe(true)
          }
          for (const step of workflow.steps) {
            for (const rotation of ['retryable_failure', 'non_retryable_failure'] as const) {
              expect(
                leaves.some((leaf) => leaf.rotation === rotation && leaf.fault_step_id === step),
                `${workflow.id}/${trigger}/${rotation}/${step} fault leaf missing`,
              ).toBe(true)
            }
          }
        } else {
          expect(
            leaves.every((leaf) => leaf.rotation === 'forbidden'),
            `${workflow.id}/${trigger} must stop at the authorization boundary`,
          ).toBe(true)
        }
      }
    }

    const seenIDs = new Set<string>()
    for (const leaf of manifest.cases) {
      expect(seenIDs.has(leaf.id), `duplicate leaf id ${leaf.id}`).toBe(false)
      seenIDs.add(leaf.id)
      expect(workflowIDs).toContain(leaf.workflow_id)
      expect(leaf.owner_id).not.toBe('')
      expect(leaf.learner_id).not.toBe('')
      expect(leaf.object_id).not.toBe('')
      expect(leaf.input_digest).toMatch(/^[a-f0-9]{64}$/)
      expect(leaf.definition_digest).toMatch(/^[a-f0-9]{64}$/)
      const workflow = manifest.workflows.find((item) => item.id === leaf.workflow_id)!
      expect(
        workflow.definition_versions.find((item) => item.version === leaf.workflow_version)?.digest,
        `${leaf.id} must execute the immutable definition named by workflow_version`,
      ).toBe(leaf.definition_digest)
      expect(leaf.idempotency_key).not.toBe('')
      expect(leaf.request_id).not.toBe('')
      expect(leaf.trace_id).not.toBe('')
      if (leaf.allowed && leaf.rotation === 'success') {
        expect(leaf.http_status).toBeGreaterThanOrEqual(200)
        expect(leaf.http_status).toBeLessThan(300)
        expect(leaf.terminal).toBe('completed')
        expect(leaf.execution_id).not.toBe('')
        expect(leaf.result_projection_digest).toMatch(/^[a-f0-9]{64}$/)
        expect(leaf.node_attempts.length).toBeGreaterThan(0)
      }
      if (!leaf.allowed) {
        expect(leaf.http_status).toBeGreaterThanOrEqual(400)
        expect(leaf.http_status).toBeLessThan(500)
        expect(leaf.execution_id || '').toBe('')
        expect(leaf.result_projection_digest || '').toBe('')
        expect(leaf.receipt_ids).toEqual([])
        expect(zeros(leaf.side_effects), `${leaf.id} forbidden request produced side effects`).toBe(
          true,
        )
        expect(leaf.error_code).not.toBe('')
      }
      if (leaf.allowed && leaf.rotation === 'non_retryable_failure') {
        expect(leaf.terminal).toBe('failed')
        expect(leaf.error_code).not.toBe('')
      }
      if (leaf.allowed && leaf.rotation === 'cancel') expect(leaf.terminal).toBe('cancelled')
    }

    const successGroups = new Map<string, TriggerCase[]>()
    for (const leaf of manifest.cases.filter(
      (item) => item.allowed && item.rotation === 'success',
    )) {
      const key = [
        leaf.workflow_id,
        leaf.workflow_version,
        leaf.owner_id,
        leaf.learner_id,
        leaf.object_id,
        leaf.input_digest,
      ].join('|')
      successGroups.set(key, [...(successGroups.get(key) || []), leaf])
    }
    for (const [key, group] of successGroups) {
      expect(
        group.map((leaf) => leaf.trigger).sort(),
        `${key} must run through all eligible triggers`,
      ).toEqual(
        [
          ...manifest.workflows.find((workflow) => workflow.id === group[0]!.workflow_id)!
            .eligible_triggers,
        ].sort(),
      )
      expect(
        new Set(group.map((leaf) => leaf.result_projection_digest)).size,
        `${key} ResultProjection drift across triggers`,
      ).toBe(1)
      expect(
        new Set(group.map((leaf) => leaf.definition_digest)).size,
        `${key} definition snapshot drift across triggers`,
      ).toBe(1)
    }

    for (const replay of manifest.cases.filter((leaf) => leaf.rotation === 'replay')) {
      expect(replay.replay_of).not.toBe('')
      const original = manifest.cases.find((leaf) => leaf.id === replay.replay_of)
      expect(original, `${replay.id} replay target missing`).toBeTruthy()
      expect(replay.execution_id).toBe(original!.execution_id)
      expect(replay.result_projection_digest).toBe(original!.result_projection_digest)
      expect(replay.side_effects).toEqual(original!.side_effects)
    }
    for (const resume of manifest.cases.filter((leaf) => leaf.rotation === 'retryable_failure')) {
      expect(resume.prior_execution_id).not.toBe('')
      expect(resume.fault_step_id).not.toBe('')
      const attemptsByNode = new Map<string, number[]>()
      for (const node of resume.node_attempts)
        attemptsByNode.set(node.node_id, [
          ...(attemptsByNode.get(node.node_id) || []),
          node.attempt,
        ])
      expect(
        [...attemptsByNode.values()].every(
          (attempts) => new Set(attempts).size === attempts.length,
        ),
        `${resume.id} rewrote an attempt`,
      ).toBe(true)
      expect(
        attemptsByNode.get(resume.fault_step_id!)?.length || 0,
        `${resume.id} did not retry the injected step`,
      ).toBeGreaterThan(1)
    }

    for (const unknown of manifest.cases.filter(
      (leaf) => leaf.allowed && leaf.rotation === 'outcome_unknown',
    )) {
      expect(
        unknown.state_history,
        `${unknown.id} must prove outcome_unknown was persisted before reconciliation`,
      ).toContain('outcome_unknown')
      expect(
        unknown.blind_resends,
        `${unknown.id} must not blindly resend an accepted external operation`,
      ).toBe(0)
      expect(uniqueStrings(unknown.receipt_ids), `${unknown.id} duplicate Receipt ids`).toEqual(
        unknown.receipt_ids,
      )
      expect(
        unknown.receipt_ids,
        `${unknown.id} must reconcile to exactly one Receipt`,
      ).toHaveLength(1)
      expect(unknown.side_effects.receipts).toBe(1)
    }

    for (const workflow of manifest.workflows) {
      for (const trigger of workflow.eligible_triggers) {
        const twoLearners = manifest.cases.filter(
          (leaf) =>
            leaf.workflow_id === workflow.id &&
            leaf.trigger === trigger &&
            leaf.rotation === 'two_learners',
        )
        expect(
          new Set(twoLearners.map((leaf) => `${leaf.owner_id}|${leaf.learner_id}`)).size,
          `${workflow.id}/${trigger} needs two isolated learners`,
        ).toBeGreaterThanOrEqual(2)
        expect(
          new Set(twoLearners.map((leaf) => leaf.object_id)).size,
          `${workflow.id}/${trigger} crossed learner-owned objects`,
        ).toBe(twoLearners.length)
        expect(
          new Set(twoLearners.map((leaf) => leaf.execution_id)).size,
          `${workflow.id}/${trigger} shared an Execution across learners`,
        ).toBe(twoLearners.length)
        expect(
          twoLearners.every((leaf) => Boolean(leaf.learner_display_name)),
          `${workflow.id}/${trigger} must retain display-name collision evidence`,
        ).toBe(true)
        expect(
          new Set(twoLearners.map((leaf) => leaf.learner_display_name)).size,
          `${workflow.id}/${trigger} fixture must use two same-name learners`,
        ).toBe(1)

        const cutover = manifest.cases.filter(
          (leaf) =>
            leaf.workflow_id === workflow.id &&
            leaf.trigger === trigger &&
            leaf.rotation === 'version_cutover',
        )
        expect(
          new Set(cutover.map((leaf) => leaf.workflow_version)).size,
          `${workflow.id}/${trigger} v1→v2 cutover evidence`,
        ).toBeGreaterThanOrEqual(2)
        for (const leaf of cutover) {
          const expectedDigest = workflow.definition_versions.find(
            (item) => item.version === leaf.workflow_version,
          )?.digest
          expect(
            leaf.definition_digest,
            `${leaf.id} changed its frozen definition during cutover`,
          ).toBe(expectedDigest)
        }
      }
    }
    expect(manifest.residual).toEqual({
      definitions: [],
      jobs: [],
      bindings: [],
      runs: [],
      outbox: [],
      receipts: [],
    })
  })
})
