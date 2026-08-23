import assert from 'node:assert/strict'
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertBinaryArchitecture,
  assertBinaryArchitectureInfo,
  assertBinaryContainsTargetArchitecture,
  parseBinaryArchitecture,
  readBinaryArchitecture,
  withSecureBinarySnapshot,
  withSecureFileSnapshot,
} from '../../scripts/ci/binary-architecture.mjs'

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

async function privateTestRoot(prefix) {
  return mkdtemp(join(await realpath(tmpdir()), prefix))
}

function machO64(cpuType) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

function machO32(cpuType) {
  const header = Buffer.alloc(28)
  header.writeUInt32LE(0xfeedface, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

function fatMachO64(cpuTypes) {
  const sliceOffset = 128
  const sliceStride = 64
  const binary = Buffer.alloc(sliceOffset + cpuTypes.length * sliceStride)
  binary.writeUInt32BE(0xcafebabf, 0)
  binary.writeUInt32BE(cpuTypes.length, 4)
  for (const [index, cpuType] of cpuTypes.entries()) {
    const entryOffset = 8 + index * 32
    const currentSliceOffset = sliceOffset + index * sliceStride
    binary.writeUInt32BE(cpuType, entryOffset)
    binary.writeBigUInt64BE(BigInt(currentSliceOffset), entryOffset + 8)
    binary.writeBigUInt64BE(32n, entryOffset + 16)
    machO64(cpuType).copy(binary, currentSliceOffset)
  }
  return binary
}

function elf64(machine) {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46], 0)
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(2, 16)
  header.writeUInt16LE(machine, 18)
  header.writeUInt32LE(1, 20)
  header.writeUInt16LE(64, 52)
  return header
}

function pe64(machine) {
  const header = Buffer.alloc(512)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(0x80, 0x3c)
  header.write('PE\0\0', 0x80, 'binary')
  header.writeUInt16LE(machine, 0x84)
  header.writeUInt16LE(1, 0x86)
  header.writeUInt16LE(240, 0x94)
  header.writeUInt16LE(0x0002, 0x96)
  header.writeUInt16LE(0x020b, 0x98)
  header.writeUInt32LE(4096, 0x98 + 56)
  header.writeUInt32LE(512, 0x98 + 60)
  header.writeUInt32LE(16, 0x98 + 108)
  return header
}

function truncatedPe64(machine) {
  const header = Buffer.alloc(70)
  header.write('MZ', 0, 'ascii')
  header.writeUInt32LE(64, 0x3c)
  header.write('PE\0\0', 64, 'binary')
  header.writeUInt16LE(machine, 68)
  return header
}

test('binary parser identifies x86_64 and arm64 Mach-O headers', () => {
  assert.deepEqual(parseBinaryArchitecture(machO64(CPU_TYPE_X86_64)), {
    format: 'mach-o',
    architectures: ['x86_64'],
  })
  assert.deepEqual(parseBinaryArchitecture(machO64(CPU_TYPE_ARM64)), {
    format: 'mach-o',
    architectures: ['arm64'],
  })
  assert.throws(
    () => parseBinaryArchitecture(machO64(CPU_TYPE_X86_64).subarray(0, 8)),
    /binary header is truncated/,
  )
  assert.throws(
    () => parseBinaryArchitecture(machO32(7).subarray(0, 8)),
    /binary header is truncated/,
  )
  assert.throws(() => parseBinaryArchitecture(machO32(7)), /unsupported Mach-O architecture/)
})

test('binary parser preserves both slices of a universal2 Mach-O artifact', () => {
  const architecture = parseBinaryArchitecture(fatMachO64([CPU_TYPE_X86_64, CPU_TYPE_ARM64]))
  assert.deepEqual(architecture, {
    format: 'mach-o',
    architectures: ['x86_64', 'arm64'],
  })
  assert.deepEqual(
    assertBinaryContainsTargetArchitecture(architecture, 'x86_64-apple-darwin'),
    architecture,
  )
  assert.deepEqual(
    assertBinaryContainsTargetArchitecture(architecture, 'aarch64-apple-darwin'),
    architecture,
  )
  assert.throws(
    () => assertBinaryArchitectureInfo(architecture, 'aarch64-apple-darwin'),
    /binary architecture must match the target exactly/,
  )
})

test('fat Mach-O parser rejects out-of-bounds and CPU-mismatched slices', () => {
  const outOfBounds = fatMachO64([CPU_TYPE_X86_64, CPU_TYPE_ARM64])
  outOfBounds.writeBigUInt64BE(BigInt(outOfBounds.length + 1), 8 + 32 + 8)
  assert.throws(() => parseBinaryArchitecture(outOfBounds), /Mach-O slice is out of bounds/)

  const mismatchedCpu = fatMachO64([CPU_TYPE_X86_64, CPU_TYPE_ARM64])
  machO64(CPU_TYPE_X86_64).copy(mismatchedCpu, 128 + 64)
  assert.throws(
    () => parseBinaryArchitecture(mismatchedCpu),
    /Mach-O slice architecture must match its fat entry/,
  )
})

test('secure binary reader rejects a symlink without disclosing its path', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-binary-architecture-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'private-binary')
  const symlinkPath = join(fixtureRoot, 'sensitive-link')
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64))
  await symlink(binaryPath, symlinkPath)

  await assert.rejects(
    readBinaryArchitecture(symlinkPath),
    (error) =>
      error instanceof Error &&
      error.message === 'unable to read binary header securely' &&
      !error.message.includes(symlinkPath),
  )
})

test('secure snapshot rejects a hard-linked source', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-hardlink-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'binary')
  const hardlinkPath = join(fixtureRoot, 'binary-hardlink')
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })
  await link(binaryPath, hardlinkPath)

  await assert.rejects(
    readBinaryArchitecture(binaryPath),
    (error) => error instanceof Error && error.message === 'unable to read binary header securely',
  )
  await assert.rejects(
    withSecureBinarySnapshot(binaryPath, { snapshotRoot: fixtureRoot }, async () => undefined),
    (error) => error instanceof Error && error.message === 'binary snapshot source is unsafe',
  )
})

test('secure snapshot rejects a source owned by another user', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-owner-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  let sourcePath = '/bin/ls'
  const currentUid = process.getuid()
  const systemIdentity = await lstat(sourcePath, { bigint: true })
  if (systemIdentity.uid === BigInt(currentUid)) {
    sourcePath = join(fixtureRoot, 'foreign-owner')
    await writeFile(sourcePath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })
    await chown(sourcePath, currentUid === 0 ? 1 : 0, process.getgid())
  }
  assert.notEqual((await lstat(sourcePath, { bigint: true })).uid, BigInt(currentUid))

  await assert.rejects(
    readBinaryArchitecture(sourcePath),
    (error) => error instanceof Error && error.message === 'unable to read binary header securely',
  )
  await assert.rejects(
    withSecureFileSnapshot(
      sourcePath,
      { kind: 'binary snapshot', snapshotRoot: fixtureRoot },
      async () => undefined,
    ),
    (error) => error instanceof Error && error.message === 'binary snapshot source is unsafe',
  )
})

test('secure snapshot rejects a group- or other-writable source', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-mode-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'binary')
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })
  await chmod(binaryPath, 0o522)

  await assert.rejects(
    readBinaryArchitecture(binaryPath),
    (error) => error instanceof Error && error.message === 'unable to read binary header securely',
  )
  await assert.rejects(
    withSecureBinarySnapshot(binaryPath, { snapshotRoot: fixtureRoot }, async () => undefined),
    (error) => error instanceof Error && error.message === 'binary snapshot source is unsafe',
  )
})

test('secure snapshot normalizes group ownership under macOS private tmp parents', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS private tmp group inheritance contract')
    return
  }
  const fixtureRoot = await mkdtemp('/private/tmp/hexclaw-snapshot-group-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const binaryPath = join(fixtureRoot, 'binary')
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })

  const evidence = await withSecureBinarySnapshot(
    binaryPath,
    { snapshotRoot: fixtureRoot },
    async (snapshot) => snapshot.evidence,
  )

  assert.equal(evidence.copyIdentity.ownerUserId, String(process.getuid()))
  assert.equal(evidence.copyIdentity.ownerGroupId, String(process.getgid()))
  assert.equal(evidence.copyIdentity.mode, '400')
  assert.equal(evidence.copyIdentity.linkCount, '1')
})

test('secure snapshot rejects a symlink in the generation-root ancestry', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-ancestor-link-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const actualParent = join(fixtureRoot, 'actual')
  const linkedParent = join(fixtureRoot, 'linked')
  const snapshotRoot = join(linkedParent, 'generation')
  const binaryPath = join(fixtureRoot, 'binary')
  await mkdir(join(actualParent, 'generation'), { mode: 0o700, recursive: true })
  await symlink(actualParent, linkedParent, 'dir')
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })

  await assert.rejects(
    withSecureBinarySnapshot(binaryPath, { snapshotRoot }, async () => undefined),
    (error) =>
      error instanceof Error && error.message === 'private generation snapshot ancestry is unsafe',
  )
})

test('secure snapshot rejects a writable generation-root ancestor', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-ancestor-mode-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const unsafeParent = join(fixtureRoot, 'unsafe-parent')
  const snapshotRoot = join(unsafeParent, 'generation')
  const binaryPath = join(fixtureRoot, 'binary')
  await mkdir(snapshotRoot, { mode: 0o700, recursive: true })
  await chmod(unsafeParent, 0o777)
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })

  await assert.rejects(
    withSecureBinarySnapshot(binaryPath, { snapshotRoot }, async () => undefined),
    (error) =>
      error instanceof Error && error.message === 'private generation snapshot ancestry is unsafe',
  )
})

test('secure snapshot detects a generation root exchanged A to B and back to A', async (t) => {
  const fixtureRoot = await privateTestRoot('hexclaw-snapshot-root-swap-')
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }))
  const snapshotRoot = join(fixtureRoot, 'generation')
  const replacementRoot = join(fixtureRoot, 'replacement')
  const parkedRoot = join(fixtureRoot, 'parked')
  const binaryPath = join(fixtureRoot, 'binary')
  await mkdir(snapshotRoot, { mode: 0o700 })
  await mkdir(replacementRoot, { mode: 0o700 })
  await writeFile(binaryPath, machO64(CPU_TYPE_X86_64), { mode: 0o500 })

  await assert.rejects(
    withSecureBinarySnapshot(binaryPath, { snapshotRoot }, async () => {
      await rename(snapshotRoot, parkedRoot)
      await rename(replacementRoot, snapshotRoot)
      await rename(snapshotRoot, replacementRoot)
      await rename(parkedRoot, snapshotRoot)
    }),
    (error) =>
      error instanceof Error && error.message === 'private generation snapshot ancestry changed',
  )
})

test('binary parser identifies x86_64 and arm64 ELF headers', () => {
  assert.deepEqual(parseBinaryArchitecture(elf64(62)), {
    format: 'elf',
    architectures: ['x86_64'],
  })
  assert.deepEqual(parseBinaryArchitecture(elf64(183)), {
    format: 'elf',
    architectures: ['arm64'],
  })
})

test('ELF64 parser rejects truncated and structurally invalid headers', () => {
  assert.throws(
    () => parseBinaryArchitecture(elf64(62).subarray(0, 20)),
    /binary header is truncated/,
  )

  const invalidIdentVersion = elf64(62)
  invalidIdentVersion[6] = 0
  assert.throws(() => parseBinaryArchitecture(invalidIdentVersion), /invalid ELF version/)

  const invalidHeaderSize = elf64(62)
  invalidHeaderSize.writeUInt16LE(20, 52)
  assert.throws(() => parseBinaryArchitecture(invalidHeaderSize), /invalid ELF header size/)
})

test('binary parser identifies x86_64 and arm64 PE headers', () => {
  assert.deepEqual(parseBinaryArchitecture(pe64(0x8664)), {
    format: 'pe',
    architectures: ['x86_64'],
  })
  assert.deepEqual(parseBinaryArchitecture(pe64(0xaa64)), {
    format: 'pe',
    architectures: ['arm64'],
  })
})

test('PE parser rejects truncated and structurally invalid headers', () => {
  assert.throws(() => parseBinaryArchitecture(truncatedPe64(0x8664)), /binary header is truncated/)

  const invalidOptionalHeader = pe64(0x8664)
  invalidOptionalHeader.writeUInt16LE(0, 0x94)
  assert.throws(
    () => parseBinaryArchitecture(invalidOptionalHeader),
    /invalid PE optional header size/,
  )

  const invalidOptionalMagic = pe64(0x8664)
  invalidOptionalMagic.writeUInt16LE(0x010b, 0x98)
  assert.throws(
    () => parseBinaryArchitecture(invalidOptionalMagic),
    /unsupported PE optional header/,
  )
})

test('target assertion rejects a target name whose binary header has another architecture', () => {
  assert.throws(
    () => assertBinaryArchitecture(machO64(CPU_TYPE_X86_64), 'aarch64-apple-darwin'),
    /binary architecture must match the target/,
  )
  assert.throws(
    () => assertBinaryArchitecture(elf64(62), 'x86_64-apple-darwin'),
    /binary format must match the target/,
  )
})

test('binary parser fails closed for malformed, truncated, and unsupported headers', () => {
  assert.throws(() => parseBinaryArchitecture(Buffer.alloc(3)), /binary header is truncated/)
  assert.throws(
    () => parseBinaryArchitecture(Buffer.from('not-a-binary')),
    /unsupported binary format/,
  )

  const unsupportedElf = elf64(3)
  assert.throws(() => parseBinaryArchitecture(unsupportedElf), /unsupported ELF architecture/)
})
