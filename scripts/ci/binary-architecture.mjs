import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const MAX_BINARY_HEADER_BYTES = 1024 * 1024
const MAX_MACH_O_ARCHITECTURES = 32
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024 * 1024

const MACH_O_MAGIC = 0xfeedface
const MACH_O_CIGAM = 0xcefaedfe
const MACH_O_MAGIC_64 = 0xfeedfacf
const MACH_O_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_CIGAM = 0xbebafeca
const FAT_MAGIC_64 = 0xcafebabf
const FAT_CIGAM_64 = 0xbfbafeca

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const ELF_MACHINE_X86_64 = 62
const ELF_MACHINE_ARM64 = 183
const PE_MACHINE_X86_64 = 0x8664
const PE_MACHINE_ARM64 = 0xaa64
const ELF64_HEADER_BYTES = 64
const ELF64_PROGRAM_HEADER_BYTES = 56
const ELF64_SECTION_HEADER_BYTES = 64
const PE_COFF_HEADER_BYTES = 20
const PE_SECTION_HEADER_BYTES = 40
const PE32_PLUS_STANDARD_BYTES = 112
const PE_MAX_DATA_DIRECTORIES = 16
const PE_MAX_SECTIONS = 96

function requireBytes(buffer, size) {
  if (buffer.length < size) {
    throw new Error('binary header is truncated')
  }
}

function readUint32(buffer, offset, littleEndian) {
  requireBytes(buffer, offset + 4)
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

function readUint16(buffer, offset, littleEndian) {
  requireBytes(buffer, offset + 2)
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
}

function readUint64(buffer, offset, littleEndian) {
  requireBytes(buffer, offset + 8)
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
}

function architectureFromMachOCpuType(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return 'x86_64'
  if (cpuType === CPU_TYPE_ARM64) return 'arm64'
  throw new Error('unsupported Mach-O architecture')
}

function architectureFromElfMachine(machine) {
  if (machine === ELF_MACHINE_X86_64) return 'x86_64'
  if (machine === ELF_MACHINE_ARM64) return 'arm64'
  throw new Error('unsupported ELF architecture')
}

function architectureFromPeMachine(machine) {
  if (machine === PE_MACHINE_X86_64) return 'x86_64'
  if (machine === PE_MACHINE_ARM64) return 'arm64'
  throw new Error('unsupported PE architecture')
}

function parseThinMachOArchitecture(buffer) {
  requireBytes(buffer, 8)
  const magic = buffer.readUInt32BE(0)
  const is64Bit = magic === MACH_O_MAGIC_64 || magic === MACH_O_CIGAM_64
  const is32Bit = magic === MACH_O_MAGIC || magic === MACH_O_CIGAM
  if (!is64Bit && !is32Bit) throw new Error('Mach-O slice must contain a Mach-O header')
  requireBytes(buffer, is64Bit ? 32 : 28)
  if (!is64Bit) throw new Error('unsupported Mach-O architecture')
  const littleEndian = magic === MACH_O_CIGAM_64
  const cpuType = readUint32(buffer, 4, littleEndian)
  return { cpuType, architecture: architectureFromMachOCpuType(cpuType) }
}

function parseFatMachOEntries(buffer, magic, fileSize) {
  const fat64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64
  const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64
  const architectureCount = readUint32(buffer, 4, littleEndian)
  if (architectureCount < 1 || architectureCount > MAX_MACH_O_ARCHITECTURES) {
    throw new Error('invalid Mach-O architecture count')
  }

  const entrySize = fat64 ? 32 : 20
  const tableEnd = 8 + architectureCount * entrySize
  requireBytes(buffer, tableEnd)
  const entries = []
  for (let index = 0; index < architectureCount; index += 1) {
    const entryOffset = 8 + index * entrySize
    const cpuType = readUint32(buffer, entryOffset, littleEndian)
    const offset = fat64
      ? readUint64(buffer, entryOffset + 8, littleEndian)
      : BigInt(readUint32(buffer, entryOffset + 8, littleEndian))
    const size = fat64
      ? readUint64(buffer, entryOffset + 16, littleEndian)
      : BigInt(readUint32(buffer, entryOffset + 12, littleEndian))
    const end = offset + size
    if (offset < BigInt(tableEnd) || size < 32n || end > fileSize || end < offset) {
      throw new Error('Mach-O slice is out of bounds')
    }
    entries.push({
      cpuType,
      architecture: architectureFromMachOCpuType(cpuType),
      offset,
      size,
      end,
    })
  }

  const orderedEntries = [...entries].sort((left, right) => (left.offset < right.offset ? -1 : 1))
  for (let index = 1; index < orderedEntries.length; index += 1) {
    if (orderedEntries[index].offset < orderedEntries[index - 1].end) {
      throw new Error('Mach-O slices must not overlap')
    }
  }
  return entries
}

function architectureResultFromFatEntries(entries) {
  const architectures = []
  for (const entry of entries) {
    if (architectures.includes(entry.architecture)) {
      throw new Error('Mach-O slices must declare unique architectures')
    }
    architectures.push(entry.architecture)
  }
  return { format: 'mach-o', architectures }
}

function validateFatMachOSlicesInBuffer(buffer, entries) {
  for (const entry of entries) {
    const offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset)) throw new Error('Mach-O slice is out of bounds')
    const slice = parseThinMachOArchitecture(buffer.subarray(offset, offset + 32))
    if (slice.cpuType !== entry.cpuType) {
      throw new Error('Mach-O slice architecture must match its fat entry')
    }
  }
  return architectureResultFromFatEntries(entries)
}

function parseMachOArchitecture(buffer, magic) {
  if (
    magic === MACH_O_MAGIC ||
    magic === MACH_O_CIGAM ||
    magic === MACH_O_MAGIC_64 ||
    magic === MACH_O_CIGAM_64
  ) {
    const slice = parseThinMachOArchitecture(buffer)
    return { format: 'mach-o', architectures: [slice.architecture] }
  }

  const entries = parseFatMachOEntries(buffer, magic, BigInt(buffer.length))
  return validateFatMachOSlicesInBuffer(buffer, entries)
}

function parseElfArchitecture(buffer) {
  requireBytes(buffer, ELF64_HEADER_BYTES)
  if (buffer[4] !== 2) throw new Error('unsupported ELF class')
  if (buffer[5] !== 1 && buffer[5] !== 2) throw new Error('unsupported ELF byte order')
  if (buffer[6] !== 1) throw new Error('invalid ELF version')

  const littleEndian = buffer[5] === 1
  const objectType = readUint16(buffer, 16, littleEndian)
  if (objectType !== 2 && objectType !== 3) throw new Error('invalid ELF object type')
  const machine = readUint16(buffer, 18, littleEndian)
  if (readUint32(buffer, 20, littleEndian) !== 1) throw new Error('invalid ELF version')
  if (readUint16(buffer, 52, littleEndian) !== ELF64_HEADER_BYTES) {
    throw new Error('invalid ELF header size')
  }

  const programHeaderOffset = readUint64(buffer, 32, littleEndian)
  const programHeaderSize = readUint16(buffer, 54, littleEndian)
  const programHeaderCount = readUint16(buffer, 56, littleEndian)
  if (
    programHeaderCount > 0 &&
    (programHeaderOffset < BigInt(ELF64_HEADER_BYTES) ||
      programHeaderSize !== ELF64_PROGRAM_HEADER_BYTES)
  ) {
    throw new Error('invalid ELF program header table')
  }

  const sectionHeaderOffset = readUint64(buffer, 40, littleEndian)
  const sectionHeaderSize = readUint16(buffer, 58, littleEndian)
  const sectionHeaderCount = readUint16(buffer, 60, littleEndian)
  if (
    sectionHeaderCount > 0 &&
    (sectionHeaderOffset < BigInt(ELF64_HEADER_BYTES) ||
      sectionHeaderSize !== ELF64_SECTION_HEADER_BYTES)
  ) {
    throw new Error('invalid ELF section header table')
  }

  return {
    format: 'elf',
    architectures: [architectureFromElfMachine(machine)],
  }
}

function parsePeArchitecture(buffer) {
  requireBytes(buffer, 0x40)
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset < 0x40) throw new Error('invalid PE header offset')
  const coffOffset = peOffset + 4
  requireBytes(buffer, coffOffset + PE_COFF_HEADER_BYTES)
  if (buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('invalid PE signature')
  }

  const sectionCount = buffer.readUInt16LE(coffOffset + 2)
  if (sectionCount < 1 || sectionCount > PE_MAX_SECTIONS) {
    throw new Error('invalid PE section count')
  }
  const optionalHeaderSize = buffer.readUInt16LE(coffOffset + 16)
  if (optionalHeaderSize < PE32_PLUS_STANDARD_BYTES) {
    throw new Error('invalid PE optional header size')
  }
  if ((buffer.readUInt16LE(coffOffset + 18) & 0x0002) === 0) {
    throw new Error('invalid PE characteristics')
  }

  const optionalHeaderOffset = coffOffset + PE_COFF_HEADER_BYTES
  const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderSize
  requireBytes(buffer, optionalHeaderEnd)
  if (buffer.readUInt16LE(optionalHeaderOffset) !== 0x020b) {
    throw new Error('unsupported PE optional header')
  }
  const dataDirectoryCount = buffer.readUInt32LE(optionalHeaderOffset + 108)
  if (
    dataDirectoryCount > PE_MAX_DATA_DIRECTORIES ||
    optionalHeaderSize < PE32_PLUS_STANDARD_BYTES + dataDirectoryCount * 8
  ) {
    throw new Error('invalid PE data directories')
  }
  const sectionTableEnd = optionalHeaderEnd + sectionCount * PE_SECTION_HEADER_BYTES
  const imageSize = buffer.readUInt32LE(optionalHeaderOffset + 56)
  const headersSize = buffer.readUInt32LE(optionalHeaderOffset + 60)
  if (headersSize < sectionTableEnd || headersSize > buffer.length || imageSize < headersSize) {
    throw new Error('invalid PE image layout')
  }
  return {
    format: 'pe',
    architectures: [architectureFromPeMachine(buffer.readUInt16LE(coffOffset))],
  }
}

export function describeBinaryTarget(targetTriple) {
  let architecture
  let goarch
  if (targetTriple.startsWith('aarch64-')) {
    architecture = 'arm64'
    goarch = 'arm64'
  } else if (targetTriple.startsWith('x86_64-')) {
    architecture = 'x86_64'
    goarch = 'amd64'
  } else {
    throw new Error('unsupported target triple')
  }

  if (targetTriple.endsWith('-apple-darwin')) {
    return { targetTriple, goos: 'darwin', goarch, format: 'mach-o', architecture }
  }
  if (targetTriple.endsWith('-unknown-linux-gnu')) {
    return { targetTriple, goos: 'linux', goarch, format: 'elf', architecture }
  }
  if (targetTriple.endsWith('-pc-windows-msvc')) {
    return { targetTriple, goos: 'windows', goarch, format: 'pe', architecture }
  }
  throw new Error('unsupported target triple')
}

export function parseBinaryArchitecture(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  requireBytes(buffer, 4)

  if (buffer[0] === 0x7f && buffer.toString('ascii', 1, 4) === 'ELF') {
    return parseElfArchitecture(buffer)
  }
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return parsePeArchitecture(buffer)
  }

  const magic = buffer.readUInt32BE(0)
  if (
    magic === MACH_O_MAGIC ||
    magic === MACH_O_CIGAM ||
    magic === MACH_O_MAGIC_64 ||
    magic === MACH_O_CIGAM_64 ||
    magic === FAT_MAGIC ||
    magic === FAT_CIGAM ||
    magic === FAT_MAGIC_64 ||
    magic === FAT_CIGAM_64
  ) {
    return parseMachOArchitecture(buffer, magic)
  }
  throw new Error('unsupported binary format')
}

export function assertBinaryArchitectureInfo(binaryArchitecture, targetTriple) {
  const target = describeBinaryTarget(targetTriple)
  if (binaryArchitecture.format !== target.format) {
    throw new Error('binary format must match the target')
  }
  if (
    binaryArchitecture.architectures.length !== 1 ||
    binaryArchitecture.architectures[0] !== target.architecture
  ) {
    throw new Error('binary architecture must match the target exactly')
  }
  return binaryArchitecture
}

export function assertBinaryContainsTargetArchitecture(binaryArchitecture, targetTriple) {
  const target = describeBinaryTarget(targetTriple)
  if (binaryArchitecture.format !== target.format) {
    throw new Error('binary format must match the target')
  }
  if (!binaryArchitecture.architectures.includes(target.architecture)) {
    throw new Error('binary must contain the target architecture')
  }
  return binaryArchitecture
}

export function assertBinaryArchitecture(input, targetTriple) {
  const binaryArchitecture = parseBinaryArchitecture(input)
  return assertBinaryArchitectureInfo(binaryArchitecture, targetTriple)
}

async function readRange(file, size, position) {
  const offset = Number(position)
  if (!Number.isSafeInteger(offset)) throw new Error('binary offset is unsupported')
  const buffer = Buffer.alloc(size)
  let total = 0
  while (total < size) {
    const { bytesRead } = await file.read(buffer, total, size - total, offset + total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return buffer.subarray(0, total)
}

function sameFileIdentity(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function inspectOpenBinary(file, fileSize) {
  const headerSize = Number(
    fileSize < BigInt(MAX_BINARY_HEADER_BYTES) ? fileSize : BigInt(MAX_BINARY_HEADER_BYTES),
  )
  const header = await readRange(file, headerSize, 0n)
  requireBytes(header, 4)

  const magic = header.readUInt32BE(0)
  if (
    magic !== FAT_MAGIC &&
    magic !== FAT_CIGAM &&
    magic !== FAT_MAGIC_64 &&
    magic !== FAT_CIGAM_64
  ) {
    return parseBinaryArchitecture(header)
  }

  const entries = parseFatMachOEntries(header, magic, fileSize)
  for (const entry of entries) {
    const sliceHeader = await readRange(file, 32, entry.offset)
    const slice = parseThinMachOArchitecture(sliceHeader)
    if (slice.cpuType !== entry.cpuType) {
      throw new Error('Mach-O slice architecture must match its fat entry')
    }
  }
  return architectureResultFromFatEntries(entries)
}

class SecureSnapshotError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SecureSnapshotError'
  }
}

function snapshotIdentity(stat) {
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    linkCount: stat.nlink.toString(),
    mode: (stat.mode & 0o7777n).toString(8),
    ownerGroupId: stat.gid.toString(),
    ownerUserId: stat.uid.toString(),
    sizeBytes: stat.size.toString(),
    mtimeNanoseconds: stat.mtimeNs.toString(),
    ctimeNanoseconds: stat.ctimeNs.toString(),
  })
}

function sameFilesystemObject(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid
  )
}

function sameFilesystemBinding(before, after) {
  return sameFilesystemObject(before, after) && before.nlink === after.nlink
}

function sameDirectoryIdentity(before, after) {
  return (
    sameFilesystemBinding(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function assertPathIdentity(path, expected, message) {
  let observed
  try {
    observed = await lstat(path, { bigint: true })
  } catch {
    throw new SecureSnapshotError(message)
  }
  if (observed.isSymbolicLink() || !sameFileIdentity(expected, observed)) {
    throw new SecureSnapshotError(message)
  }
}

async function hashOpenFile(file, size) {
  const totalSize = Number(size)
  if (!Number.isSafeInteger(totalSize)) throw new Error('snapshot is too large')
  const digest = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(SNAPSHOT_CHUNK_BYTES, Math.max(totalSize, 1)))
  let position = 0
  while (position < totalSize) {
    const wanted = Math.min(chunk.length, totalSize - position)
    const { bytesRead } = await file.read(chunk, 0, wanted, position)
    if (bytesRead !== wanted) throw new Error('snapshot is truncated')
    digest.update(chunk.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

async function copyAndHashOpenFile(source, destination, size) {
  const totalSize = Number(size)
  if (!Number.isSafeInteger(totalSize)) throw new Error('snapshot is too large')
  const digest = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(SNAPSHOT_CHUNK_BYTES, Math.max(totalSize, 1)))
  let position = 0
  while (position < totalSize) {
    const wanted = Math.min(chunk.length, totalSize - position)
    const { bytesRead } = await source.read(chunk, 0, wanted, position)
    if (bytesRead !== wanted) throw new Error('snapshot source is truncated')
    digest.update(chunk.subarray(0, bytesRead))
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(
        chunk,
        written,
        bytesRead - written,
        position + written,
      )
      if (result.bytesWritten === 0) throw new Error('snapshot copy is incomplete')
      written += result.bytesWritten
    }
    position += bytesRead
  }
  return digest.digest('hex')
}

function currentProcessIdentity() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new SecureSnapshotError('secure snapshot ownership checks are unavailable')
  }
  return Object.freeze({ gid: BigInt(process.getgid()), uid: BigInt(process.getuid()) })
}

function absolutePathChain(pathname) {
  const parsed = parse(pathname)
  const paths = [parsed.root]
  const remainder = relative(parsed.root, pathname)
  let cursor = parsed.root
  for (const component of remainder.split(sep).filter(Boolean)) {
    cursor = join(cursor, component)
    paths.push(cursor)
  }
  return paths
}

function isSafeAncestorDirectory(identity, currentUid) {
  if (identity.isSymbolicLink() || !identity.isDirectory()) return false
  if (identity.uid !== 0n && identity.uid !== currentUid) return false
  const writableByAnotherPrincipal = (identity.mode & 0o022n) !== 0n
  const stickyDirectory = (identity.mode & 0o1000n) !== 0n
  return !writableByAnotherPrincipal || stickyDirectory
}

function isPrivateSnapshotRoot(identity, currentUid) {
  return (
    !identity.isSymbolicLink() &&
    identity.isDirectory() &&
    identity.uid === currentUid &&
    (identity.mode & 0o077n) === 0n
  )
}

function isContainedPath(rootPath, candidatePath) {
  const difference = relative(rootPath, candidatePath)
  return (
    difference.length > 0 &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  )
}

async function capturePrivateSnapshotAncestry(snapshotRoot) {
  if (typeof snapshotRoot !== 'string' || !isAbsolute(snapshotRoot)) {
    throw new SecureSnapshotError('private generation snapshot root is required')
  }
  const rootPath = resolve(snapshotRoot)
  const currentIdentity = currentProcessIdentity()
  const entries = []
  try {
    for (const pathname of absolutePathChain(rootPath)) {
      const identity = await lstat(pathname, { bigint: true })
      if (!isSafeAncestorDirectory(identity, currentIdentity.uid)) {
        throw new SecureSnapshotError('private generation snapshot ancestry is unsafe')
      }
      entries.push(Object.freeze({ identity, pathname }))
    }
  } catch (error) {
    if (error instanceof SecureSnapshotError) throw error
    throw new SecureSnapshotError('private generation snapshot root is unavailable')
  }
  const rootIdentity = entries.at(-1).identity
  if (!isPrivateSnapshotRoot(rootIdentity, currentIdentity.uid)) {
    throw new SecureSnapshotError('private generation snapshot root is not private')
  }
  return Object.freeze({
    currentIdentity,
    entries: Object.freeze(entries),
    identity: rootIdentity,
    path: rootPath,
  })
}

async function assertSnapshotAncestry(
  expected,
  strictRootIdentity,
  allowRootEntryMutation = false,
) {
  for (const [index, entry] of expected.entries.entries()) {
    let observed
    try {
      observed = await lstat(entry.pathname, { bigint: true })
    } catch {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
    const isRoot = index === expected.entries.length - 1
    const sameIdentity = isRoot
      ? allowRootEntryMutation
        ? sameFilesystemObject(entry.identity, observed)
        : sameFilesystemBinding(entry.identity, observed)
      : sameFilesystemObject(entry.identity, observed)
    if (!isSafeAncestorDirectory(observed, expected.currentIdentity.uid) || !sameIdentity) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
    if (isRoot && strictRootIdentity && !sameDirectoryIdentity(entry.identity, observed)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
  }
}

function assertSecureSourceIdentity(identity, kind, executable) {
  const currentIdentity = currentProcessIdentity()
  const ownerAllowed =
    identity.uid === currentIdentity.uid ||
    (kind === 'package Go toolchain snapshot' && identity.uid === 0n)
  if (
    !identity.isFile() ||
    identity.nlink !== 1n ||
    !ownerAllowed ||
    (identity.mode & 0o7022n) !== 0n ||
    (executable && (identity.mode & 0o100n) === 0n)
  ) {
    throw new SecureSnapshotError(`${kind} source is unsafe`)
  }
}

function assertTrustedCopyIdentity(identity, expectedMode, expectedSize, kind) {
  const currentIdentity = currentProcessIdentity()
  if (
    !identity.isFile() ||
    identity.nlink !== 1n ||
    identity.uid !== currentIdentity.uid ||
    identity.gid !== currentIdentity.gid ||
    (identity.mode & 0o7777n) !== BigInt(expectedMode) ||
    identity.size !== expectedSize
  ) {
    throw new SecureSnapshotError(`${kind} changed`)
  }
}

function validateSnapshotKind(kind) {
  if (kind !== 'binary snapshot' && kind !== 'package Go toolchain snapshot') {
    throw new SecureSnapshotError('secure snapshot kind is invalid')
  }
  return kind
}

async function closeSnapshotFiles(files) {
  let failed = false
  for (const file of files) {
    if (!file) continue
    try {
      await file.close()
    } catch {
      failed = true
    }
  }
  return failed
}

export async function withSecureFileSnapshot(sourcePath, options, operation) {
  const kind = validateSnapshotKind(options?.kind)
  if (typeof operation !== 'function') {
    throw new SecureSnapshotError('secure snapshot operation is required')
  }
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new SecureSnapshotError(`${kind} is unavailable`)
  }

  const initialAncestry = await capturePrivateSnapshotAncestry(options.snapshotRoot)
  const copyMode = options.executable ? 0o500 : 0o400
  let stableAncestry
  let rootFile
  let sourceFile
  let copyWriter
  let copyFile
  let temporaryFile
  let temporaryDirectory
  let copyPath
  let nestedSnapshotRoot
  let temporaryIdentity
  let sourceBefore
  let copyBefore
  let sourceSha256
  let setupError

  try {
    rootFile = await open(initialAncestry.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedRoot = await rootFile.stat({ bigint: true })
    if (!sameFilesystemBinding(initialAncestry.identity, openedRoot)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }

    sourceFile = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    sourceBefore = await sourceFile.stat({ bigint: true })
    assertSecureSourceIdentity(sourceBefore, kind, options.executable === true)
    if (sourceBefore.size < 1n || sourceBefore.size > BigInt(MAX_SNAPSHOT_BYTES)) {
      throw new SecureSnapshotError(`${kind} source is unsafe`)
    }
    await assertPathIdentity(sourcePath, sourceBefore, `${kind} source identity changed`)

    temporaryDirectory = await mkdtemp(join(initialAncestry.path, '.hexclaw-verify-'))
    if (!isContainedPath(initialAncestry.path, temporaryDirectory)) {
      throw new SecureSnapshotError('private generation snapshot containment failed')
    }
    await chmod(temporaryDirectory, 0o700)
    const temporaryBefore = await lstat(temporaryDirectory, { bigint: true })
    if (!isPrivateSnapshotRoot(temporaryBefore, initialAncestry.currentIdentity.uid)) {
      throw new SecureSnapshotError(`${kind} changed`)
    }

    if (options.nestedSnapshotRoot === true) {
      nestedSnapshotRoot = join(temporaryDirectory, 'nested-snapshots')
      if (!isContainedPath(temporaryDirectory, nestedSnapshotRoot)) {
        throw new SecureSnapshotError('private generation snapshot containment failed')
      }
      await mkdir(nestedSnapshotRoot, { mode: 0o700 })
      const nestedIdentity = await lstat(nestedSnapshotRoot, { bigint: true })
      if (!isPrivateSnapshotRoot(nestedIdentity, initialAncestry.currentIdentity.uid)) {
        throw new SecureSnapshotError(`${kind} changed`)
      }
    }

    copyPath = join(temporaryDirectory, options.executable ? 'tool' : 'artifact')
    if (!isContainedPath(temporaryDirectory, copyPath)) {
      throw new SecureSnapshotError('private generation snapshot containment failed')
    }
    copyWriter = await open(
      copyPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      copyMode,
    )
    sourceSha256 = await copyAndHashOpenFile(sourceFile, copyWriter, sourceBefore.size)
    await copyWriter.chmod(copyMode)
    await copyWriter.sync()
    await copyWriter.close()
    copyWriter = undefined

    copyFile = await open(copyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    copyBefore = await copyFile.stat({ bigint: true })
    assertTrustedCopyIdentity(copyBefore, copyMode, sourceBefore.size, kind)
    await assertPathIdentity(copyPath, copyBefore, `${kind} changed`)
    const copySha256 = await hashOpenFile(copyFile, copyBefore.size)
    if (copySha256 !== sourceSha256) throw new Error('snapshot copy digest mismatch')
    if (options.expectedSha256 && sourceSha256 !== options.expectedSha256) {
      throw new SecureSnapshotError(options.digestMismatchMessage)
    }

    const sourceAfterCopy = await sourceFile.stat({ bigint: true })
    if (!sameFileIdentity(sourceBefore, sourceAfterCopy)) {
      throw new SecureSnapshotError(`${kind} source identity changed`)
    }
    await assertPathIdentity(sourcePath, sourceBefore, `${kind} source identity changed`)

    await assertSnapshotAncestry(initialAncestry, false, true)
    const rootAfterSetup = await rootFile.stat({ bigint: true })
    if (!sameFilesystemObject(initialAncestry.identity, rootAfterSetup)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }

    // 完成命名空间写入后固定私有目录为当前用户 0700；helper 文件自身保持单链接 0500。
    await chmod(temporaryDirectory, 0o700)
    temporaryFile = await open(temporaryDirectory, constants.O_RDONLY | constants.O_NOFOLLOW)
    temporaryIdentity = await temporaryFile.stat({ bigint: true })
    if (
      !temporaryIdentity.isDirectory() ||
      temporaryIdentity.uid !== initialAncestry.currentIdentity.uid ||
      temporaryIdentity.gid !== initialAncestry.currentIdentity.gid ||
      (temporaryIdentity.mode & 0o7777n) !== 0o700n
    ) {
      throw new SecureSnapshotError(`${kind} changed`)
    }
    await assertPathIdentity(temporaryDirectory, temporaryIdentity, `${kind} changed`)

    stableAncestry = await capturePrivateSnapshotAncestry(initialAncestry.path)
    const stableRoot = await rootFile.stat({ bigint: true })
    if (!sameDirectoryIdentity(stableAncestry.identity, stableRoot)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
  } catch (error) {
    setupError =
      error instanceof SecureSnapshotError
        ? error
        : new SecureSnapshotError(`${kind} is unavailable`)
  }

  if (setupError) {
    let cleanupFailed = false
    if (temporaryFile) {
      await temporaryFile.chmod(0o700).catch(() => {
        cleanupFailed = true
      })
    } else if (temporaryDirectory) {
      await chmod(temporaryDirectory, 0o700).catch(() => {
        cleanupFailed = true
      })
    }
    cleanupFailed =
      (await closeSnapshotFiles([copyWriter, copyFile, sourceFile, temporaryFile, rootFile])) ||
      cleanupFailed
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { force: true, recursive: true })
      } catch {
        cleanupFailed = true
      }
    }
    if (cleanupFailed) throw new SecureSnapshotError('secure snapshot cleanup failed')
    throw setupError
  }

  const evidence = Object.freeze({
    sha256: sourceSha256,
    sizeBytes: sourceBefore.size.toString(),
    sourceIdentity: snapshotIdentity(sourceBefore),
    copyIdentity: snapshotIdentity(copyBefore),
  })
  const assertSourceUnchanged = async () => {
    const sourceAfter = await sourceFile.stat({ bigint: true })
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new SecureSnapshotError(`${kind} source identity changed`)
    }
    await assertPathIdentity(sourcePath, sourceBefore, `${kind} source identity changed`)
    if ((await hashOpenFile(sourceFile, sourceBefore.size)) !== sourceSha256) {
      throw new SecureSnapshotError(`${kind} source identity changed`)
    }
  }

  const assertUnchanged = async () => {
    await assertSourceUnchanged()

    const copyAfter = await copyFile.stat({ bigint: true })
    if (!sameFileIdentity(copyBefore, copyAfter)) {
      throw new SecureSnapshotError(`${kind} changed`)
    }
    await assertPathIdentity(copyPath, copyBefore, `${kind} changed`)
    if ((await hashOpenFile(copyFile, copyBefore.size)) !== sourceSha256) {
      throw new SecureSnapshotError(`${kind} changed`)
    }

    await assertSnapshotAncestry(stableAncestry, true)
    const rootAfter = await rootFile.stat({ bigint: true })
    if (!sameDirectoryIdentity(stableAncestry.identity, rootAfter)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
    const temporaryAfter = await temporaryFile.stat({ bigint: true })
    if (!sameDirectoryIdentity(temporaryIdentity, temporaryAfter)) {
      throw new SecureSnapshotError(`${kind} changed`)
    }
    await assertPathIdentity(temporaryDirectory, temporaryIdentity, `${kind} changed`)
  }
  const snapshot = Object.freeze({
    assertUnchanged,
    evidence,
    file: copyFile,
    fileDescriptor: copyFile.fd,
    nestedSnapshotRoot,
    path: copyPath,
    sha256: sourceSha256,
    size: copyBefore.size,
  })

  let result
  let operationError
  try {
    result = await operation(snapshot)
  } catch (error) {
    operationError = error
  }

  let verificationError
  try {
    await assertUnchanged()
  } catch (error) {
    verificationError =
      error instanceof SecureSnapshotError ? error : new SecureSnapshotError(`${kind} changed`)
  }

  let cleanupFailed = false
  await temporaryFile.chmod(0o700).catch(() => {
    cleanupFailed = true
  })
  cleanupFailed = (await closeSnapshotFiles([copyFile, temporaryFile])) || cleanupFailed
  try {
    await rm(temporaryDirectory, { force: true, recursive: true })
  } catch {
    cleanupFailed = true
  }

  let returnVerificationError
  try {
    await assertSourceUnchanged()
    await assertSnapshotAncestry(stableAncestry, false, true)
    const rootBeforeReturn = await rootFile.stat({ bigint: true })
    if (!sameFilesystemObject(stableAncestry.identity, rootBeforeReturn)) {
      throw new SecureSnapshotError('private generation snapshot ancestry changed')
    }
  } catch (error) {
    returnVerificationError =
      error instanceof SecureSnapshotError ? error : new SecureSnapshotError(`${kind} changed`)
  }
  cleanupFailed = (await closeSnapshotFiles([sourceFile, rootFile])) || cleanupFailed

  // 嵌套快照已给出的精确安全类别优先，避免外层 ancestry 变化覆盖根因。
  if (operationError instanceof SecureSnapshotError) throw operationError
  if (verificationError) throw verificationError
  if (returnVerificationError) throw returnVerificationError
  if (cleanupFailed) throw new SecureSnapshotError('secure snapshot cleanup failed')
  if (operationError) throw operationError
  return result
}

export async function withSecureBinarySnapshot(binaryPath, options, operation) {
  return withSecureFileSnapshot(
    binaryPath,
    {
      kind: 'binary snapshot',
      snapshotRoot: options?.snapshotRoot,
    },
    async (snapshot) => {
      const architecture = await inspectOpenBinary(snapshot.file, snapshot.size)
      return operation(Object.freeze({ ...snapshot, architecture }))
    },
  )
}

export async function readBinaryArchitecture(binaryPath) {
  let file
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('unsupported platform')
    file = await open(binaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await file.stat({ bigint: true })
    assertSecureSourceIdentity(before, 'binary snapshot', false)
    if (before.size < 4n || before.size > BigInt(MAX_SNAPSHOT_BYTES)) {
      throw new Error('invalid file')
    }
    await assertPathIdentity(binaryPath, before, 'binary identity changed')
    const architecture = await inspectOpenBinary(file, before.size)
    const after = await file.stat({ bigint: true })
    if (!sameFileIdentity(before, after)) throw new Error('binary changed during inspection')
    await assertPathIdentity(binaryPath, before, 'binary identity changed')
    return architecture
  } catch {
    throw new Error('unable to read binary header securely')
  } finally {
    if (file) await file.close().catch(() => undefined)
  }
}
