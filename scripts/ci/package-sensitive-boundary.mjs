#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const XATTR = '/usr/bin/xattr'
const CHMOD = '/bin/chmod'
const LS = '/bin/ls'
const SCAN_CHUNK_BYTES = 1024 * 1024
// 4096 字节覆盖当前全部有限规则的理论最大跨度，并为后续规则保留审计余量。
const SCAN_OVERLAP_BYTES = 4096
const MAX_SCAN_ENTRIES = 100_000
const MAX_SCAN_FILES = 50_000
const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024 * 1024
const MAX_SCAN_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const METADATA_TIMEOUT_MS = 120_000
const METADATA_OUTPUT_BYTES = 4 * 1024 * 1024
const MACOS_PROVENANCE_XATTR = 'com.apple.provenance'
const MACOS_PROVENANCE_BYTES = 11
const OLLAMA_PUBLIC_BUILD_PROVENANCE = '/Users/runner/work/ollama/ollama/'
const OLLAMA_PUBLIC_BUILD_PROVENANCE_MASK = '_'.repeat(OLLAMA_PUBLIC_BUILD_PROVENANCE.length)
const OLLAMA_RESOURCE_PREFIXES = Object.freeze([
  'HexClaw.app/Contents/Resources/ollama/',
  'ollama/',
])
// 仅固定 Ollama v0.30.10 中携带上述公开 CI 路径的文件可以使用例外；
// 任何字节变化都会改变 SHA-256，并恢复普通用户目录拒绝规则。
const OLLAMA_PUBLIC_PROVENANCE_SHA256 = Object.freeze(
  new Set([
    '00a375a2c23ad478d4f403b3160d7e79214074605f52947ba063836a47fd447a',
    '0b5d45e319355b04115d3eba2c226a6857fae885744b775be52d8463d2de0a9f',
    '1bcf60454d2f95124e9bc32967e93e6bebcc46900e905368bc4e747527ab4e08',
    '1cecd5f0c4d0b73f33ea4f23490d3132526754262274611394e8eb8b9a135fcf',
    '203ae2eac7e3fd1397f94cf82aca77115056c702681684342dac545e6bee1cf0',
    '21fb418f21ff06ae09d63ec5250ee49671c67fcccfaeb8ff7e84bc1e949fb909',
    '34eb4ee88e2ecdf4e48c561990e704ec9150f4eca7ae6ff741eb47a27e2bae78',
    '42b552cdf255b201c2996cc9b2010fd04f695e7ac46724fe3062b0e19de9b11f',
    '5926ba03fca5722bf4d03308f08ea409912f16ec7a28e88875e2cda3e475a811',
    '5982d61eb30df5caca8375854ef5e16c7c1459f22ed7eb1aa3befebfab5c2142',
    '633c2eb96912f18ccc44e457bcd6de377805b3a8efa95b8eaeea9d2da43abff4',
    '68d2170f93781afdce87398ffb1be33d770dba7c3bfb709a59d3f55fce7a06a6',
    '73a3a71eeb295a5dcdd5dc0689e074ecca4099db1ec6541a406cd0fa1fb0bc71',
    '79894ca114a137ac82872ace85e75fee20be5be883c590d0f73aa279d3081ccd',
    '7b76e25484a2fa3b86e95d0e24423581339eb418237426ed61f2a3e25e3bf605',
    '8c0d3e40f250a25b4480a66da165cad3d0269ee91b11e3513c92d4573f692e35',
    '9c196b9e9afa7a47ab105f9c4565d5f9e7da62dbc7f6007b024e74fb16863c7e',
    '9ee43dd2cb3c93b713a41e751455ff80f1abe4854abe548bed5975ba41b1d0e4',
    'c1110cc91be7c17f26d640e78047f86109f9c7f86b433179a64e8084dc18355d',
    'ca9c1058b90d2b13c80b8387b4037d26e4d6e7cb286f91f9df80acf5f05b889f',
    'cd19e1a35b3d5d37c78d0b1ad33a62099a08ea255d63592eee9ca34937a9bd11',
    'd02803fc1968943f9e7ae6f9e8b19a45198b37640ea65a6fea281d3c4397cdde',
    'dddb5f902b7cd4c671ecd15c5ae87d940653ace7f2392a7bdf2ed05799120c40',
    'ed8e8158fee6c131a1d9eb5fe804501e04d0ed2b5e5716fc69d33d46e2a6450b',
    'ef4a73ef68f0125d085d931d1fd3c68b7d77a5d990995933eb19687dcdc74dd1',
    'f080d6d463aa4281a4d293cae58017f916c77273c4b779ba707a04ad7c40a54c',
    'f16d38256a089e81a5016dd42a2c088a79baef031d5122ff5799d28089063437',
  ]),
)

// 用户目录只接受可证明的登录名语法；255 字节上限覆盖 POSIX LOGIN_NAME_MAX，
// 同时阻止压缩代码或二进制中的长标点片段被误判为真实 home 路径。
const POSIX_LOGIN_NAME = String.raw`[A-Za-z_](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_$-])?`
// Windows profile 名允许内部空格，但末尾空格和点不构成稳定的目录边界。
const WINDOWS_PROFILE_NAME = String.raw`[A-Za-z0-9_](?:[A-Za-z0-9._ $-]{0,253}[A-Za-z0-9_$-])?`
const USER_HOME_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9._~%/\\-])(?:file:\/\/)?(?:\/Users\/${POSIX_LOGIN_NAME}(?=$|[^A-Za-z0-9._$-])|\/home\/${POSIX_LOGIN_NAME}(?=$|[^A-Za-z0-9._$-])|\/(?:var\/)?root(?=$|[^A-Za-z0-9._$-])|[A-Za-z]:[\\/]Users[\\/]${WINDOWS_PROFILE_NAME}(?=$|[^A-Za-z0-9._ $-]))`,
  'u',
)
// Windows 路径大小写不敏感；POSIX 路径保持大小写敏感，避免把小写 API 路由误判为用户目录。
const WINDOWS_USER_HOME_PATTERN =
  /(?<![A-Za-z0-9._~%/\\-])[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_](?:[A-Za-z0-9._ $-]{0,253}[A-Za-z0-9_$-])?(?=$|[^A-Za-z0-9._ $-])/iu
let darwinCurrentUserHomePattern

function currentDarwinUserHomePattern() {
  if (process.platform !== 'darwin') return undefined
  if (darwinCurrentUserHomePattern) return darwinCurrentUserHomePattern

  let home
  try {
    home = userInfo().homedir
  } catch {
    fail('input:current-user-home')
  }
  if (
    typeof home !== 'string' ||
    !isAbsolute(home) ||
    home === '/' ||
    Buffer.byteLength(home, 'utf8') >= SCAN_OVERLAP_BYTES
  ) {
    fail('input:current-user-home')
  }
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // macOS 默认文件系统大小写不敏感；仅匹配当前系统账户的完整 home，避免误判普通 /users API 路由。
  darwinCurrentUserHomePattern = new RegExp(
    String.raw`(?<![A-Za-z0-9._~%/\\-])(?:file:\/\/)?${escaped}(?=$|[^A-Za-z0-9._$-])`,
    'iu',
  )
  return darwinCurrentUserHomePattern
}

const CREDENTIAL_CONFIG_BASENAMES = Object.freeze(
  new Set([
    '.curlrc',
    '.dockercfg',
    '.gemrc',
    '.git-credentials',
    '.gitconfig',
    '.netrc',
    '.npmrc',
    '.pnpmrc',
    '.pypirc',
    '.wgetrc',
    '.yarnrc',
    '.yarnrc.yml',
    '_netrc',
  ]),
)

const CONTENT_RULES = Object.freeze([
  Object.freeze({ category: 'path:misremapped-cargo', pattern: /\/build\/home\/\.cargo\// }),
  Object.freeze({
    category: 'path:user-home',
    pattern: USER_HOME_PATTERN,
  }),
  Object.freeze({
    category: 'path:user-home',
    pattern: WINDOWS_USER_HOME_PATTERN,
  }),
  Object.freeze({
    category: 'path:test-home',
    pattern:
      // oxlint-disable-next-line no-control-regex -- 二进制路径边界必须显式识别 NUL。
      /(?:\/(?:[^/\0\r\n]{1,128}\/){0,16}|[A-Za-z]:\\(?:[^\\\0\r\n]{1,128}\\){0,16})(?:hexclaw|codex)[-_](?:test|e2e|fixture|missing-llm)[-_]home(?:[-_][^/\\\0\r\n]{1,128})?(?:[/\\\0]|$)/i,
  }),
  Object.freeze({
    category: 'secret:private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  }),
  Object.freeze({
    category: 'secret:anthropic',
    pattern:
      /(?<![A-Za-z0-9])sk-ant-(?=[A-Za-z0-9_-]{0,128}[A-Z])(?=[A-Za-z0-9_-]{0,128}[0-9])[A-Za-z0-9_-]{20,}/,
  }),
  Object.freeze({
    category: 'secret:openai',
    pattern:
      /(?<![A-Za-z0-9])sk-(?!ant-)(?:proj-)?(?=[A-Za-z0-9_-]{0,128}[A-Z])(?=[A-Za-z0-9_-]{0,128}[0-9])[A-Za-z0-9_-]{20,}/,
  }),
  Object.freeze({ category: 'secret:aws-access-key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ }),
  Object.freeze({ category: 'secret:google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/ }),
  Object.freeze({ category: 'secret:github-token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/ }),
  Object.freeze({ category: 'secret:slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ }),
  Object.freeze({
    category: 'secret:dingtalk-token',
    pattern: /oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9_-]{16,}/i,
  }),
])

class BoundaryError extends Error {
  constructor(category, { exitCode, signal } = {}) {
    super(`Package sensitive boundary: [${category}]`)
    this.name = 'BoundaryError'
    this.category = category
    this.exitCode = Number.isInteger(exitCode) ? exitCode : undefined
    this.signal = typeof signal === 'string' ? signal : undefined
  }
}

function fail(category) {
  throw new BoundaryError(category)
}

function requireAbsoluteDirectory(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail(`input:${label}`)
  return resolve(pathname)
}

function relativePath(root, pathname) {
  const value = relative(root, pathname)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    fail('file:escaped-root')
  }
  return value.split(sep).join('/')
}

function filenameCategory(pathname) {
  const components = String(pathname).replaceAll('\\', '/').split('/')
  for (const component of components) {
    const lower = component.toLowerCase()
    if (lower.startsWith('.env')) return 'file:environment'
    if (CREDENTIAL_CONFIG_BASENAMES.has(lower)) return 'file:credential-config'
    if (lower === '.hexclaw') return 'file:private-profile'
    if (lower.startsWith('.codex')) return 'file:codex-workspace'
    if (lower.startsWith('._')) return 'file:apple-double'
    if (['test', 'tests', 'fixtures', 'test-results', 'playwright-report'].includes(lower)) {
      return 'file:test-artifact'
    }
    if (/\.(?:test|spec)\.[^.]+$/i.test(component)) return 'file:test-artifact'
    if (/\.(?:tmp|temp|bak|backup|orig|swp)$/i.test(component) || lower === '.ds_store') {
      return 'file:temporary'
    }
    if (/\.(?:pem|key|p12|pfx|mobileprovision)$/i.test(component)) return 'file:key-material'
    if (
      /\.(?:log|receipt)$/i.test(component) ||
      /release-ui-(?:attestation|dist-manifest)/i.test(component)
    ) {
      return 'file:release-evidence'
    }
    if (/\.(?:yaml|yml)$/i.test(component)) return 'file:configuration'
    if (
      /(?:credential|secret|api[-_]?key|access[-_]?token|(?:^|[-_.])token(?:[-_.]|$))/i.test(
        component,
      )
    ) {
      return 'file:credential'
    }
  }
  return null
}

function stablePatternMatch(pattern, text, stableLength) {
  pattern.lastIndex = 0
  const match = pattern.exec(text)
  return match && match.index + match[0].length <= stableLength
}

function contentCategory(text, displayPath, stableLength = text.length) {
  // 固定摘要的 Ollama 官方制品带有公开 CI 源码路径；仅在其专属资源目录内忽略该精确前缀，
  // 其它用户目录、其它位置及任何相似前缀仍按普通敏感路径拒绝。
  const homeInspectionText = OLLAMA_RESOURCE_PREFIXES.some((prefix) =>
    displayPath?.startsWith(prefix),
  )
    ? text.replaceAll(OLLAMA_PUBLIC_BUILD_PROVENANCE, OLLAMA_PUBLIC_BUILD_PROVENANCE_MASK)
    : text
  const currentUserHome = currentDarwinUserHomePattern()
  if (currentUserHome && stablePatternMatch(currentUserHome, homeInspectionText, stableLength)) {
    return 'path:user-home'
  }
  for (const rule of CONTENT_RULES) {
    const inspectedText = rule.category === 'path:user-home' ? homeInspectionText : text
    if (stablePatternMatch(rule.pattern, inspectedText, stableLength)) return rule.category
  }
  return null
}

function ollamaProvenanceDigests(adapters) {
  const configured = adapters?.ollamaProvenanceSHA256
  if (configured === undefined) return OLLAMA_PUBLIC_PROVENANCE_SHA256
  if (
    !(configured instanceof Set) ||
    [...configured].some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
  ) {
    fail('input:ollama-provenance')
  }
  return configured
}

function scanLimits(overrides = {}) {
  const limits = {
    maxEntries: overrides.maxEntries ?? MAX_SCAN_ENTRIES,
    maxFiles: overrides.maxFiles ?? MAX_SCAN_FILES,
    maxFileBytes: overrides.maxFileBytes ?? MAX_SCAN_FILE_BYTES,
    maxTotalBytes: overrides.maxTotalBytes ?? MAX_SCAN_TOTAL_BYTES,
  }
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles <= 0 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes <= 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes <= 0
  ) {
    fail('input:scan-limits')
  }
  return Object.freeze(limits)
}

function consumeEntryBudget(budget, limits) {
  budget.entries += 1
  if (budget.entries > limits.maxEntries) fail('limit:entry-count')
}

function sameFileIdentity(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

function runBoundedCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? METADATA_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? METADATA_OUTPUT_BYTES
  if (
    !isAbsolute(command) ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== 'string')
  ) {
    return Promise.reject(new BoundaryError('metadata:invalid-command'))
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timedOut = false
    let exceeded = false
    let outputBytes = 0
    const stdout = []
    const stderr = []
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const collect = (chunks) => (chunk) => {
      if (exceeded) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = maxOutputBytes - outputBytes
      if (bytes.length > remaining) {
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining))
        exceeded = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(bytes)
      outputBytes += bytes.length
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()
    child.once('error', () => finish(rejectPromise, new BoundaryError('metadata:command-start')))
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(rejectPromise, new BoundaryError('metadata:command-timeout', { signal }))
        return
      }
      if (exceeded) {
        finish(rejectPromise, new BoundaryError('metadata:command-output-limit', { signal }))
        return
      }
      finish(resolvePromise, {
        code: Number.isInteger(code) ? code : -1,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function requireCommand(runCommand, command, args, category) {
  let result
  try {
    result = await runCommand(command, args, {
      timeoutMs: METADATA_TIMEOUT_MS,
      maxOutputBytes: METADATA_OUTPUT_BYTES,
    })
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError(category)
  }
  if (!result || !Number.isInteger(result.code)) throw new BoundaryError(category)
  if (result.code !== 0 || result.signal !== null) {
    throw new BoundaryError(category, { exitCode: result.code, signal: result.signal })
  }
  return result
}

function xattrName(line) {
  const separator = line.lastIndexOf(': ')
  return (separator >= 0 ? line.slice(separator + 2) : line).trim()
}

function verifyProvenanceValues(output, expectedCount) {
  const lines = output.split(/\r?\n/u).filter(Boolean)
  let waitingForValue = false
  let observed = 0
  for (const line of lines) {
    const normalized = line.trimEnd()
    if (normalized.endsWith(':')) {
      if (waitingForValue) fail('metadata:provenance-format')
      waitingForValue = true
      continue
    }
    if (!waitingForValue || !/^(?:[0-9A-F]{2})(?: [0-9A-F]{2})*$/u.test(normalized)) {
      fail('metadata:provenance-format')
    }
    const bytes = Buffer.from(normalized.replaceAll(' ', ''), 'hex')
    // macOS 15 会保留不可移除的系统 provenance；仅接受其固定 11 字节结构，
    // 从而无法承载路径、令牌或其它可变长度秘密。
    if (
      bytes.length !== MACOS_PROVENANCE_BYTES ||
      bytes[0] !== 0x01 ||
      bytes[1] !== 0x02 ||
      bytes[2] !== 0x00 ||
      contentCategory(bytes.toString('latin1'))
    ) {
      fail('metadata:provenance-value')
    }
    observed += 1
    waitingForValue = false
  }
  if (waitingForValue || observed !== expectedCount) fail('metadata:provenance-format')
}

async function preflightTreeStructure(pathname, label, budget, limits) {
  try {
    const root = requireAbsoluteDirectory(pathname, label)
    const rootMetadata = await lstat(root)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail(`input:${label}`)
    consumeEntryBudget(budget, limits)
    const visit = async (directory) => {
      const entries = await opendir(directory)
      for await (const entry of entries) {
        consumeEntryBudget(budget, limits)
        const childPath = resolve(directory, entry.name)
        const child = relativePath(root, childPath)
        const displayPath = `${label}/${child}`
        const forbidden = filenameCategory(child)
        if (forbidden) fail(forbidden, displayPath)
        const metadata = await lstat(childPath)
        if (metadata.isSymbolicLink()) fail('file:symbolic-link', displayPath)
        if (metadata.isDirectory()) {
          await visit(childPath)
          continue
        }
        if (!metadata.isFile()) fail('file:non-regular', displayPath)
        if (metadata.nlink !== 1) fail('file:hard-link', displayPath)
      }
    }
    await visit(root)
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('file:preflight-failed')
  }
}

async function verifyMacTreeMetadataAfterPreflight(root, runCommand) {
  const attributes = await requireCommand(
    runCommand,
    XATTR,
    ['-r', '-s', root],
    'metadata:xattr-command',
  )
  const names = attributes.stdout.split(/\r?\n/u).filter(Boolean).map(xattrName)
  if (names.some((name) => name !== MACOS_PROVENANCE_XATTR)) fail('metadata:xattr')
  if (names.length > 0) {
    const values = await requireCommand(
      runCommand,
      XATTR,
      ['-p', '-r', '-s', '-x', MACOS_PROVENANCE_XATTR, root],
      'metadata:provenance-command',
    )
    verifyProvenanceValues(values.stdout, names.length)
  }

  const acl = await requireCommand(runCommand, LS, ['-leR', root], 'metadata:acl-command')
  if (/^\s+\d+:/mu.test(acl.stdout)) fail('metadata:acl')
  return Object.freeze({ metadataVerified: true, retainedSystemProvenance: names.length })
}

export async function verifyMacTreeMetadata(pathname, adapters = {}) {
  const root = requireAbsoluteDirectory(pathname, 'metadata-root')
  if (process.platform !== 'darwin') fail('metadata:unsupported-platform')
  const limits = scanLimits(adapters.limits)
  await preflightTreeStructure(root, 'metadata-root', { entries: 0 }, limits)
  const runCommand = adapters.runCommand ?? runBoundedCommand
  return verifyMacTreeMetadataAfterPreflight(root, runCommand)
}

async function sanitizeMacTreeMetadataAfterPreflight(root, runCommand) {
  await requireCommand(runCommand, XATTR, ['-c', '-r', '-s', root], 'metadata:xattr-clear')
  await requireCommand(runCommand, CHMOD, ['-R', '-N', root], 'metadata:acl-clear')
  return verifyMacTreeMetadataAfterPreflight(root, runCommand)
}

export async function sanitizeMacPackageMetadata(options, adapters = {}) {
  try {
    const runCommand = adapters.runCommand ?? runBoundedCommand
    const distRoot = requireAbsoluteDirectory(options?.distRoot, 'dist-root')
    const appBundle = requireAbsoluteDirectory(options?.appBundle, 'app-bundle')
    if (process.platform !== 'darwin') fail('metadata:unsupported-platform')
    const limits = scanLimits(adapters.limits)
    const preflightBudget = { entries: 0 }
    await preflightTreeStructure(distRoot, 'dist-root', preflightBudget, limits)
    await preflightTreeStructure(appBundle, 'app-bundle', preflightBudget, limits)
    const dist = await sanitizeMacTreeMetadataAfterPreflight(distRoot, runCommand)
    const app = await sanitizeMacTreeMetadataAfterPreflight(appBundle, runCommand)
    return Object.freeze({
      metadataVerified: true,
      retainedSystemProvenance: dist.retainedSystemProvenance + app.retainedSystemProvenance,
      verifiedRoots: 2,
    })
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('metadata:unexpected')
  }
}

async function scanFile(
  pathname,
  displayPath,
  budget,
  limits,
  observations,
  allowedOllamaProvenance,
) {
  let handle
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) fail('file:non-regular', displayPath)
    if (before.nlink !== 1n) fail('file:hard-link', displayPath)
    if (before.size > BigInt(limits.maxFileBytes)) fail('limit:file-bytes', displayPath)
    budget.files += 1
    budget.bytes += Number(before.size)
    if (budget.files > limits.maxFiles) fail('limit:file-count')
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > limits.maxTotalBytes) {
      fail('limit:total-bytes')
    }

    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES)
    const isOllamaResource = OLLAMA_RESOURCE_PREFIXES.some((prefix) =>
      displayPath.startsWith(prefix),
    )
    const digest = isOllamaResource ? createHash('sha256') : undefined
    const expectedBytes = Number(before.size)
    let carry = ''
    let observedOllamaProvenance = false
    let position = 0
    while (position < expectedBytes) {
      const length = Math.min(chunk.length, expectedBytes - position)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead <= 0) fail('file:identity-changed', displayPath)
      const bytes = chunk.subarray(0, bytesRead)
      digest?.update(bytes)
      const text = `${carry}${bytes.toString('latin1')}`
      const finalChunk = position + bytesRead === expectedBytes
      const stableLength = finalChunk ? text.length : Math.max(0, text.length - SCAN_OVERLAP_BYTES)
      if (isOllamaResource && text.includes(OLLAMA_PUBLIC_BUILD_PROVENANCE)) {
        observedOllamaProvenance = true
      }
      const category = contentCategory(text, displayPath, stableLength)
      if (category) fail(category, displayPath)
      if (text.includes('/build/cargo/')) observations.rustCargoRemap = true
      carry = text.slice(-SCAN_OVERLAP_BYTES)
      position += bytesRead
    }
    const sha256 = digest?.digest('hex')
    if (observedOllamaProvenance && !allowedOllamaProvenance.has(sha256 ?? '')) {
      fail('path:user-home', displayPath)
    }
    const after = await handle.stat({ bigint: true })
    if (!sameFileIdentity(before, after)) fail('file:identity-changed', displayPath)
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('file:read-failed', { displayPath })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function scanRoot(
  root,
  label,
  budget,
  limits,
  observations = {},
  allowedOllamaProvenance = OLLAMA_PUBLIC_PROVENANCE_SHA256,
) {
  const rootMetadata = await lstat(root).catch(() => undefined)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail(`input:${label}`)
  }

  const beforeEntries = budget.entries
  const beforeFiles = budget.files
  const beforeBytes = budget.bytes
  consumeEntryBudget(budget, limits)
  const visit = async (directory) => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      consumeEntryBudget(budget, limits)
      const pathname = resolve(directory, entry.name)
      const child = relativePath(root, pathname)
      const displayPath = `${label}/${child}`
      const forbidden = filenameCategory(child)
      if (forbidden) fail(forbidden, displayPath)

      const metadata = await lstat(pathname)
      if (metadata.isDirectory()) {
        await visit(pathname)
        continue
      }
      if (metadata.isSymbolicLink()) {
        fail('file:symbolic-link', displayPath)
      }
      if (!metadata.isFile()) fail('file:non-regular', displayPath)
      await scanFile(pathname, displayPath, budget, limits, observations, allowedOllamaProvenance)
    }
  }
  await visit(root)
  return Object.freeze({
    scannedBytes: budget.bytes - beforeBytes,
    scannedEntries: budget.entries - beforeEntries,
    scannedFiles: budget.files - beforeFiles,
  })
}

async function scanPackageRoots(options, limits, allowedOllamaProvenance) {
  const distRoot = requireAbsoluteDirectory(options?.distRoot, 'dist-root')
  const appBundle = requireAbsoluteDirectory(options?.appBundle, 'app-bundle')
  const budget = { bytes: 0, entries: 0, files: 0 }
  const dist = await scanRoot(distRoot, 'dist', budget, limits, {}, allowedOllamaProvenance)
  const app = await scanRoot(appBundle, 'HexClaw.app', budget, limits, {}, allowedOllamaProvenance)
  if (
    budget.entries > limits.maxEntries ||
    budget.files > limits.maxFiles ||
    budget.bytes > limits.maxTotalBytes
  ) {
    fail('limit:global')
  }
  return Object.freeze({
    findingCount: 0,
    scannedBytes: dist.scannedBytes + app.scannedBytes,
    scannedEntries: dist.scannedEntries + app.scannedEntries,
    scannedFiles: dist.scannedFiles + app.scannedFiles,
    scannedRoots: 2,
  })
}

export async function verifyPackageSensitiveBoundary(options, adapters = {}) {
  try {
    const distRoot = requireAbsoluteDirectory(options?.distRoot, 'dist-root')
    const appBundle = requireAbsoluteDirectory(options?.appBundle, 'app-bundle')
    const limits = scanLimits(adapters.limits)
    if (process.platform === 'darwin') {
      const runCommand = adapters.runCommand ?? runBoundedCommand
      const preflightBudget = { entries: 0 }
      await preflightTreeStructure(distRoot, 'dist-root', preflightBudget, limits)
      await preflightTreeStructure(appBundle, 'app-bundle', preflightBudget, limits)
      await verifyMacTreeMetadataAfterPreflight(distRoot, runCommand)
      await verifyMacTreeMetadataAfterPreflight(appBundle, runCommand)
    }
    const result = await scanPackageRoots(
      { distRoot, appBundle },
      limits,
      ollamaProvenanceDigests(adapters),
    )
    return Object.freeze({ ...result, metadataVerified: process.platform === 'darwin' })
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('io:unexpected')
  }
}

export async function verifyPackageRootBoundary(options, adapters = {}) {
  try {
    const root = requireAbsoluteDirectory(options?.root, 'root')
    const label = options?.label
    if (typeof label !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(label)) {
      fail('input:root-label')
    }
    const limits = scanLimits(adapters.limits)
    const budget = { bytes: 0, entries: 0, files: 0 }
    const result = await scanRoot(
      root,
      label,
      budget,
      limits,
      {},
      ollamaProvenanceDigests(adapters),
    )
    return Object.freeze({ findingCount: 0, ...result, scannedRoots: 1 })
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('io:unexpected')
  }
}

export async function verifyRustSourceRootBoundary(options, adapters = {}) {
  try {
    const root = requireAbsoluteDirectory(options?.root, 'root')
    const limits = scanLimits(adapters.limits)
    const budget = { bytes: 0, entries: 0, files: 0 }
    const observations = { rustCargoRemap: false }
    const result = await scanRoot(root, 'rust-source-output', budget, limits, observations)
    if (!observations.rustCargoRemap) fail('path:missing-cargo-remap')
    return Object.freeze({ findingCount: 0, ...result, scannedRoots: 1, rustCargoRemap: true })
  } catch (error) {
    if (error instanceof BoundaryError) throw error
    throw new BoundaryError('io:unexpected')
  }
}

function parseCLI(argv) {
  const action = argv[0]
  if (!['sanitize', 'verify', 'verify-root', 'verify-rust-source-root'].includes(action)) {
    fail('cli:invalid-arguments')
  }
  const expected =
    action === 'verify-root'
      ? ['--label', '--root']
      : action === 'verify-rust-source-root'
        ? ['--root']
        : ['--app-bundle', '--dist']
  if (argv.length !== 1 + expected.length * 2) fail('cli:invalid-arguments')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!expected.includes(name) || !value || values[name] !== undefined) {
      fail('cli:invalid-arguments')
    }
    values[name] = value
  }
  return {
    action,
    options:
      action === 'verify-root'
        ? { label: values['--label'], root: values['--root'] }
        : action === 'verify-rust-source-root'
          ? { root: values['--root'] }
          : { appBundle: values['--app-bundle'], distRoot: values['--dist'] },
  }
}

function safeCLIError(error) {
  const category = error instanceof BoundaryError ? error.category : 'internal'
  const fields = [`ERROR: package-sensitive-boundary category=${category}`]
  if (error instanceof BoundaryError && error.exitCode !== undefined) {
    fields.push(`exit=${error.exitCode}`)
  }
  if (error instanceof BoundaryError && /^[A-Z0-9]+$/u.test(error.signal ?? '')) {
    fields.push(`signal=${error.signal}`)
  }
  return fields.join(' ')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(async () => {
      const command = parseCLI(process.argv.slice(2))
      if (command.action === 'sanitize') {
        await sanitizeMacPackageMetadata(command.options)
      }
      if (command.action === 'verify-root') {
        return verifyPackageRootBoundary(command.options)
      }
      if (command.action === 'verify-rust-source-root') {
        return verifyRustSourceRootBoundary(command.options)
      }
      return verifyPackageSensitiveBoundary(command.options)
    })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.stdout.write('PASS: package sensitive boundary verified.\n')
    })
    .catch((error) => {
      process.stderr.write(`${safeCLIError(error)}\n`)
      process.exitCode = 1
    })
}
