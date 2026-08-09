import { createHash } from 'node:crypto'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const sha256Pattern = /^[a-f0-9]{64}$/

function fail(message) {
  throw new Error(`K12 recognition v2 target claim: ${message}`)
}

function privateIdentity(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export async function writeRecognitionV2TargetClaim({
  profilePath,
  claimPath,
  targetAgent,
  dispatchID,
  sourceSessionID,
  sourceDigest,
}) {
  if (
    !privateIdentity(targetAgent) ||
    !privateIdentity(dispatchID) ||
    !privateIdentity(sourceSessionID) ||
    typeof sourceDigest !== 'string' ||
    !sha256Pattern.test(sourceDigest)
  ) {
    fail('claim identity is invalid')
  }

  let canonicalProfile
  let canonicalParent
  try {
    canonicalProfile = await realpath(profilePath)
    canonicalParent = await realpath(dirname(claimPath))
    const profile = await lstat(canonicalProfile)
    if (!profile.isDirectory() || (profile.mode & 0o777) !== 0o700) {
      fail('profile is not a private directory')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('K12 recognition v2 target claim:')) {
      throw error
    }
    fail('profile cannot be verified')
  }
  const canonicalClaim = resolve(canonicalParent, basename(claimPath))
  if (!isInside(canonicalProfile, canonicalClaim)) fail('claim must remain inside the profile')
  try {
    await lstat(canonicalClaim)
    fail('claim already exists; exclusive create is required')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('K12 recognition v2 target claim:')) {
      throw error
    }
    if (error?.code !== 'ENOENT') fail('claim target cannot be verified')
  }

  const claim = {
    schema_version: 1,
    target_agent: targetAgent,
    dispatch_id: dispatchID,
    source_session_id: sourceSessionID,
    source_digest: `sha256:${sourceDigest}`,
  }
  const bytes = Buffer.from(`${JSON.stringify(claim)}\n`)
  let file
  let created = false
  try {
    file = await open(canonicalClaim, 'wx', 0o600)
    created = true
    const metadata = await file.stat()
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      fail('claim target is not a private regular file')
    }
    await file.writeFile(bytes)
    await file.sync()
  } catch (error) {
    if (created) await rm(canonicalClaim, { force: true }).catch(() => undefined)
    if (error instanceof Error && error.message.startsWith('K12 recognition v2 target claim:')) {
      throw error
    }
    if (error?.code === 'EEXIST') fail('claim already exists; exclusive create is required')
    fail('claim cannot be written')
  } finally {
    await file?.close().catch(() => undefined)
  }

  return Object.freeze({
    schema_version: 1,
    created: true,
    claim_sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
