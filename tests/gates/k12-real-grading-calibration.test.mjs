import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

async function loadRunner() {
  return import(repoFile('scripts/ci/k12-real-grading-calibration.mjs'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function receipt(bucket, index, overrides = {}) {
  return {
    attempt_digest: sha256(`attempt:${bucket}:${index}`),
    bucket,
    latency_ms: bucket * 100 + index * 10,
    logical_operations: bucket,
    model: 'gpt-5.6-sol',
    origin: 'real',
    physical_provider_calls: 1,
    provider: 'hexclaw-gpt',
    result_digest: sha256(`result:${bucket}:${index}`),
    status: 'succeeded',
    ...overrides,
  }
}

function completeReceipts() {
  return [1, 8, 16, 32].flatMap((bucket) => [receipt(bucket, 1), receipt(bucket, 2)])
}

test('K12-LIVE-BUDGET-REAL-002 compiles an order-independent four-bucket candidate without approval or budget fields', async () => {
  const { buildCalibrationCandidate } = await loadRunner()
  const forward = buildCalibrationCandidate(completeReceipts())
  const reverse = buildCalibrationCandidate(completeReceipts().reverse())

  assert.equal(forward.evidenceBytes.equals(reverse.evidenceBytes), true)
  assert.equal(forward.summaryBytes.equals(reverse.summaryBytes), true)
  assert.equal(forward.evidenceSHA256, sha256(forward.evidenceBytes))
  assert.equal(forward.summary.evidence_sha256, forward.evidenceSHA256)
  assert.deepEqual(
    forward.summary.measurements,
    [1, 8, 16, 32].map((bucket) => ({
      max_problems: bucket,
      sample_count: 2,
      success_count: 2,
      p50_ms: bucket * 100 + 10,
      p95_ms: bucket * 100 + 20,
      logical_operations: bucket * 2,
      physical_provider_calls: 2,
    })),
  )

  const serialized = `${forward.evidenceBytes}\n${forward.summaryBytes}`
  assert.doesNotMatch(serialized, /approval_status|approval_ref|grading_budget/i)
  assert.doesNotMatch(serialized, /prompt|dingtalk|secret|response_body/i)
})

test('K12-LIVE-BUDGET-REAL-002 rejects incomplete, duplicate, non-real and invalid measurement receipts', async () => {
  const { buildCalibrationCandidate } = await loadRunner()
  const base = completeReceipts()
  const malformed = [
    { name: 'missing bucket', receipts: base.filter(({ bucket }) => bucket !== 32), reason: /1\/8\/16\/32/i },
    {
      name: 'duplicate attempt',
      receipts: [...base, { ...base[0] }],
      reason: /duplicate attempt/i,
    },
    {
      name: 'failed terminal',
      receipts: base.map((item, index) => (index === 0 ? { ...item, status: 'failed' } : item)),
      reason: /terminal/i,
    },
    {
      name: 'mock origin',
      receipts: base.map((item, index) => (index === 0 ? { ...item, origin: 'mock' } : item)),
      reason: /origin/i,
    },
    {
      name: 'provider drift',
      receipts: base.map((item, index) =>
        index === 0 ? { ...item, provider: 'not-hexclaw-gpt' } : item,
      ),
      reason: /provider/i,
    },
    {
      name: 'non-positive latency',
      receipts: base.map((item, index) => (index === 0 ? { ...item, latency_ms: 0 } : item)),
      reason: /latency/i,
    },
  ]

  for (const mutation of malformed) {
    assert.throws(() => buildCalibrationCandidate(mutation.receipts), mutation.reason, mutation.name)
  }
})

test('K12-LIVE-BUDGET-REAL-002 writes only private new candidate files and never overwrites an existing output', async () => {
  const { buildCalibrationCandidate, writeCalibrationCandidate } = await loadRunner()
  const directory = mkdtempSync(join(tmpdir(), 'hexclaw-grading-calibration-'))
  chmodSync(directory, 0o700)
  const evidencePath = join(directory, 'candidate-evidence.json')
  const summaryPath = join(directory, 'candidate-summary.json')
  try {
    const candidate = buildCalibrationCandidate(completeReceipts())
    const result = await writeCalibrationCandidate({ evidencePath, summaryPath, candidate })

    assert.equal(statSync(evidencePath).mode & 0o777, 0o600)
    assert.equal(statSync(summaryPath).mode & 0o777, 0o600)
    assert.equal(sha256(readFileSync(evidencePath)), result.evidenceSHA256)
    assert.equal(sha256(readFileSync(summaryPath)), result.summarySHA256)

    writeFileSync(join(directory, 'existing.json'), 'keep')
    assert.rejects(
      () =>
        writeCalibrationCandidate({
          evidencePath: join(directory, 'existing.json'),
          summaryPath: join(directory, 'other.json'),
          candidate,
        }),
      /must not already exist/i,
    )
    assert.equal(readFileSync(join(directory, 'existing.json'), 'utf8'), 'keep')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('K12-LIVE-BUDGET-REAL-002 refuses real execution without caller-owned authority before any hook spawn', async () => {
  const { assertRealExecutionAuthority } = await loadRunner()
  let spawned = 0
  assert.throws(
    () =>
      assertRealExecutionAuthority({
        executeReal: true,
        env: {
          HEX_K12_LIVE_PROVIDER: 'hexclaw-gpt',
          HEX_K12_LIVE_MODEL: 'gpt-5.6-sol',
        },
        spawn: () => {
          spawned += 1
        },
      }),
    /HEX_K12_CALIBRATION_REAL_AUTHORIZED/i,
  )
  assert.equal(spawned, 0)
})
