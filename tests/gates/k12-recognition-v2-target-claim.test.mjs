import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeRecognitionV2TargetClaim } from '../../scripts/ci/k12-recognition-v2-target-claim.mjs'

const sourceDigest = 'a'.repeat(64)

test('K12-LIVE-RECOGNITION-PLAN-V2-EVIDENCE writes one exact 0600 private target claim', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hexclaw-k12-v2-claim-'))
  await chmod(profile, 0o700)
  t.after(() => rm(profile, { recursive: true, force: true }))
  const claimPath = join(profile, 'recognition-v2-target-claim.json')

  const receipt = await writeRecognitionV2TargetClaim({
    profilePath: profile,
    claimPath,
    targetAgent: 'target-agent-private',
    dispatchID: 'dispatch-private',
    sourceSessionID: 'session-private',
    sourceDigest,
  })

  assert.deepEqual(Object.keys(receipt).sort(), ['claim_sha256', 'created', 'schema_version'])
  assert.equal(receipt.schema_version, 1)
  assert.equal(receipt.created, true)
  assert.match(receipt.claim_sha256, /^[a-f0-9]{64}$/)
  assert.equal((await lstat(claimPath)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(claimPath, 'utf8')), {
    schema_version: 1,
    target_agent: 'target-agent-private',
    dispatch_id: 'dispatch-private',
    source_session_id: 'session-private',
    source_digest: `sha256:${sourceDigest}`,
  })
  await assert.rejects(
    writeRecognitionV2TargetClaim({
      profilePath: profile,
      claimPath,
      targetAgent: 'target-agent-private',
      dispatchID: 'dispatch-private',
      sourceSessionID: 'session-private',
      sourceDigest,
    }),
    /already exists|exclusive/i,
  )
})

test('K12-LIVE-RECOGNITION-PLAN-V2-EVIDENCE rejects paths, symlinks and invalid identities', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hexclaw-k12-v2-claim-'))
  await chmod(profile, 0o700)
  const outside = await mkdtemp(join(tmpdir(), 'hexclaw-k12-v2-claim-outside-'))
  await chmod(outside, 0o700)
  t.after(() => rm(profile, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))

  const target = join(profile, 'target.json')
  const link = join(profile, 'claim.json')
  await symlink(target, link)
  for (const options of [
    {
      profilePath: profile,
      claimPath: join(outside, 'claim.json'),
      targetAgent: 'agent',
      dispatchID: 'dispatch',
      sourceSessionID: 'session',
      sourceDigest,
    },
    {
      profilePath: profile,
      claimPath: link,
      targetAgent: 'agent',
      dispatchID: 'dispatch',
      sourceSessionID: 'session',
      sourceDigest,
    },
    {
      profilePath: profile,
      claimPath: join(profile, 'invalid.json'),
      targetAgent: '',
      dispatchID: 'dispatch',
      sourceSessionID: 'session',
      sourceDigest,
    },
  ]) {
    await assert.rejects(writeRecognitionV2TargetClaim(options), /claim|identity|profile/i)
  }
})
