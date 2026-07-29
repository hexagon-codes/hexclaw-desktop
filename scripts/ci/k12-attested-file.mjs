import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'

export function readPrivateFileBytes(pathname, { label = 'attested file' } = {}) {
  let descriptor
  try {
    descriptor = openSync(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new Error(`${label} could not be opened securely`)
  }
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`${label} must be an existing regular file`)
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`${label} permissions must be 0600`)
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function createAttestedSnapshot(raw, { expectedSHA256, label = 'attested file' } = {}) {
  if (!Buffer.isBuffer(raw)) {
    throw new Error(`${label} reader must return one byte snapshot`)
  }
  const bytes = Buffer.from(raw)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (expectedSHA256 !== undefined && sha256 !== expectedSHA256) {
    throw new Error(`${label} SHA-256 mismatch`)
  }
  return Object.freeze({ bytes, sha256 })
}

export function readAttestedFileSnapshot(
  pathname,
  { expectedSHA256, label = 'attested file', readBytes } = {},
) {
  const raw = (readBytes ?? ((path) => readPrivateFileBytes(path, { label })))(pathname)
  return createAttestedSnapshot(raw, { expectedSHA256, label })
}
