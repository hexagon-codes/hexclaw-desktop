#!/usr/bin/env node

/**
 * 能力页视觉门的安装态只读前置检查。
 *
 * 只检查工作区内 Test.app 候选与隔离条件，不启动应用、不读取用户数据，也不接触
 * /Applications。缺少 current-source 构建证明或同态 fixture 注入通道时必须保持
 * NOT COMPARABLE，禁止用共享安装包截图冒充当前源码验收。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = path.join(desktopRoot, 'test/evidence/bug-20260723-009-010-current-source')
const fixture = 'bug-20260723-009-010-homomorphic-v2'
const bundle = path.join(desktopRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const infoPlist = path.join(bundle, 'Contents/Info.plist')
const executable = path.join(bundle, 'Contents/MacOS/hexclaw-desktop')

function sha256(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

function plistValue(key) {
  if (!existsSync(infoPlist)) return null
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to reserve loopback port')
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

const sandbox = mkdtempSync(path.join(tmpdir(), 'hexclaw-capability-visual.'))
chmodSync(sandbox, 0o700)
mkdirSync(path.join(sandbox, '.hexclaw'), { mode: 0o700 })
const dedicatedPort = await reservePort()
const bundleExists = existsSync(bundle)

const report = {
  bugs: ['BUG-20260723-009', 'BUG-20260723-010'],
  fixture,
  status: 'NOT_RUN',
  decision: 'NOT COMPARABLE',
  app: {
    candidate: 'src-tauri/target/release/bundle/macos/HexClaw Test.app',
    bundleExists,
    identifier: plistValue('CFBundleIdentifier'),
    version: plistValue('CFBundleShortVersionString'),
    bundleModifiedAt: bundleExists ? statSync(bundle).mtime.toISOString() : null,
    executableSha256: sha256(executable),
    infoPlistSha256: sha256(infoPlist),
    launched: false,
    rebuilt: false,
  },
  isolation: {
    testHomeMode: (statSync(sandbox).mode & 0o777).toString(8).padStart(4, '0'),
    dedicatedLoopbackPort: dedicatedPort,
    applicationsTouched: false,
    userDataRead: false,
    userDataWritten: false,
    externalNetworkRequests: 0,
    realModelCalls: 0,
  },
  fixtureParity: {
    currentSourceTraceableInBundle: false,
    sameCapabilityFixtureInjectableInWKWebView: false,
    domAndComputedStyleChannelAvailable: false,
    reasons: [
      'The shared Test.app has no exact build manifest tying its bundled frontend to this worktree.',
      'The deterministic browser state uses route interception that is unavailable in the closed WKWebView bundle.',
      'Without the same Skills/MCP fixture and a WKWebView DOM/computed-style capture channel, an installed screenshot would not be homomorphic.',
    ],
  },
}

rmSync(sandbox, { recursive: true })
report.isolation.testHomeRemoved = !existsSync(sandbox)
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
writeFileSync(
  path.join(evidenceRoot, 'installed-boundary.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
