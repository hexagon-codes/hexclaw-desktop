import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(new URL('../../release/scripts/render-bundle.sh', import.meta.url))
const bashPath = '/bin/bash'

function tarOctal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function tarArchive(entries) {
  const chunks = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512)
    Buffer.from(entry.name).copy(header, 0, 0, 100)
    header.write(tarOctal(entry.mode ?? 0o755, 8), 100, 'ascii')
    header.write(tarOctal(0, 8), 108, 'ascii')
    header.write(tarOctal(0, 8), 116, 'ascii')
    header.write(tarOctal(entry.type === '0' || !entry.type ? body.length : 0, 12), 124, 'ascii')
    header.write(tarOctal(0, 12), 136, 'ascii')
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 'ascii')
    if (entry.linkname) Buffer.from(entry.linkname).copy(header, 157, 0, 100)
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    chunks.push(header)
    if (entry.type === '0' || !entry.type) {
      chunks.push(body)
      const padding = (512 - (body.length % 512)) % 512
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks), { mtime: 0 })
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipArchive(entries) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const body = Buffer.from(entry.body ?? '')
    const checksum = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    localChunks.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100755) * 0x10000) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)
    offset += local.length + name.length + body.length
  }

  const centralDirectory = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localChunks, centralDirectory, end])
}

async function runArchiveAudit(archivePath, format, member, candidate, env = {}) {
  return execFileAsync(
    bashPath,
    [
      scriptPath,
      'audit-archive',
      format,
      archivePath,
      member,
      candidate,
      '1048576',
      '1048576',
      '32',
      '4194304',
    ],
    { env: { ...process.env, ...env } },
  )
}

async function expectArchiveRejected(archivePath, format, member, candidate) {
  await assert.rejects(runArchiveAudit(archivePath, format, member, candidate), (error) => {
    assert.match(error.stderr, /^ERROR: render archive policy rejected input\.\n$/u)
    assert.doesNotMatch(error.stderr, new RegExp(archivePath.replaceAll('\\', '\\\\'), 'u'))
    return true
  })
}

test('archive audit accepts one exact regular executable from tar and zip', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-archive-safe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tarPath = join(root, 'safe.tar.gz')
  const zipPath = join(root, 'safe.zip')
  await Promise.all([
    writeFile(
      tarPath,
      tarArchive([
        { name: 'bundle/tool', body: 'safe' },
        { name: 'bundle/tool-alias', type: '2', linkname: 'tool' },
      ]),
    ),
    writeFile(
      zipPath,
      zipArchive([
        { name: 'bundle/tool.exe', body: 'safe' },
        { name: 'bundle/tool-alias.exe', body: 'tool.exe', mode: 0o120777 },
      ]),
    ),
  ])

  const [tarResult, zipResult] = await Promise.all([
    runArchiveAudit(tarPath, 'tar.gz', 'bundle/tool', 'tool'),
    runArchiveAudit(zipPath, 'zip', 'bundle/tool.exe', 'tool.exe'),
  ])
  assert.equal(tarResult.stdout, 'PASS: render archive policy verified.\n')
  assert.equal(zipResult.stdout, 'PASS: render archive policy verified.\n')
})

test('archive audit rejects malicious tar entries before extraction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-tar-malicious-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    { name: 'absolute', entries: [{ name: '/bundle/tool', body: 'bad' }] },
    { name: 'traversal', entries: [{ name: '../bundle/tool', body: 'bad' }] },
    { name: 'nul', entries: [{ name: 'bundle/tool\0../bad', body: 'bad' }] },
    { name: 'symlink', entries: [{ name: 'bundle/tool', type: '2', linkname: '/tmp/bad' }] },
    {
      name: 'escaping-symlink',
      entries: [
        { name: 'bundle/tool', body: 'safe' },
        { name: 'bundle/alias', type: '2', linkname: '../../bad' },
      ],
    },
    { name: 'hardlink', entries: [{ name: 'bundle/tool', type: '1', linkname: 'other' }] },
    {
      name: 'alias-hardlink',
      entries: [
        { name: 'bundle/tool', body: 'safe' },
        { name: 'bundle/tool-alias', type: '1', linkname: 'bundle/tool' },
      ],
    },
    { name: 'fifo', entries: [{ name: 'bundle/tool', type: '6' }] },
    { name: 'device', entries: [{ name: 'bundle/tool', type: '3' }] },
    {
      name: 'duplicate-candidate',
      entries: [
        { name: 'bundle/tool', body: 'one' },
        { name: 'other/tool', body: 'two' },
      ],
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const archivePath = join(root, `${fixture.name}.tar.gz`)
      await writeFile(archivePath, tarArchive(fixture.entries))
      await expectArchiveRejected(archivePath, 'tar.gz', 'bundle/tool', 'tool')
    })
  }
})

test('archive audit rejects malicious zip entries before extraction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-zip-malicious-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    { name: 'absolute', entries: [{ name: '/bundle/tool.exe', body: 'bad' }] },
    { name: 'traversal', entries: [{ name: '../bundle/tool.exe', body: 'bad' }] },
    { name: 'nul', entries: [{ name: 'bundle/tool.exe\0../bad', body: 'bad' }] },
    { name: 'symlink', entries: [{ name: 'bundle/tool.exe', mode: 0o120777 }] },
    {
      name: 'escaping-symlink',
      entries: [
        { name: 'bundle/tool.exe', body: 'safe' },
        { name: 'bundle/alias.exe', body: '/tmp/bad', mode: 0o120777 },
      ],
    },
    { name: 'fifo', entries: [{ name: 'bundle/tool.exe', mode: 0o010777 }] },
    {
      name: 'duplicate-candidate',
      entries: [
        { name: 'bundle/tool.exe', body: 'one' },
        { name: 'other/tool.exe', body: 'two' },
      ],
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const archivePath = join(root, `${fixture.name}.zip`)
      await writeFile(archivePath, zipArchive(fixture.entries))
      await expectArchiveRejected(archivePath, 'zip', 'bundle/tool.exe', 'tool.exe')
    })
  }
})

test('archive audit ignores PATH wrappers and accepts only absolute trusted tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hexclaw-render-path-wrapper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const wrappers = join(root, 'wrappers')
  const marker = join(root, 'wrapper-used')
  const archivePath = join(root, 'safe.tar.gz')
  await mkdir(wrappers)
  await writeFile(archivePath, tarArchive([{ name: 'bundle/tool', body: 'safe' }]))
  for (const name of [
    'python3',
    'curl',
    'tar',
    'shasum',
    'sha256sum',
    'cp',
    'mv',
    'find',
    'head',
  ]) {
    const wrapper = join(wrappers, name)
    await writeFile(wrapper, `#!/bin/sh\nprintf used >> '${marker}'\nexit 99\n`)
    await chmod(wrapper, 0o755)
  }

  const result = await runArchiveAudit(archivePath, 'tar.gz', 'bundle/tool', 'tool', {
    PATH: `${wrappers}:${process.env.PATH ?? ''}`,
  })
  assert.equal(result.stdout, 'PASS: render archive policy verified.\n')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})
