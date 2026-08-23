#!/usr/bin/env node

/**
 * K12 原生第三腿只读前置检查。
 *
 * 该脚本不会启动、重建或修改 Test.app。只有 current-source、等价业务 fixture 与
 * WKWebView 都能被同一可追溯测试包加载时，原生截图才具备与浏览器成对证据相同的语义。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(nativeDir, '../..')
const evidenceRoot = resolve(
  process.env.HEX_K12_VISUAL_EVIDENCE_DIR ||
    join(desktopRoot, '../hexclaw-docs/test/evidence/bug-20260801-001-002-004-005-current-source'),
)
const bundle = join(desktopRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const infoPlist = join(bundle, 'Contents/Info.plist')
const executable = join(bundle, 'Contents/MacOS/hexclaw-desktop')

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

function reserveUnusedPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a dedicated loopback port.'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolvePromise(port)))
    })
  })
}

const dedicatedPort = await reserveUnusedPort()
const testHome = mkdtempSync(join(tmpdir(), 'hexclaw-k12-visual-preflight.'))
chmodSync(testHome, 0o700)
mkdirSync(join(testHome, '.hexclaw'), { mode: 0o700 })

const bundleExists = existsSync(bundle)
const report = {
  status: 'NOT_RUN',
  decision: 'UNSAFE_STATE_EQUIVALENCE',
  app: {
    bundle: relative(desktopRoot, bundle),
    bundleExists,
    executableExists: existsSync(executable),
    identifier: plistValue('CFBundleIdentifier'),
    version: plistValue('CFBundleShortVersionString'),
    bundleModifiedAt: bundleExists ? statSync(bundle).mtime.toISOString() : null,
    launched: false,
    rebuilt: false,
  },
  isolationPreflight: {
    loopbackBinding: '127.0.0.1',
    dedicatedPort,
    portReleasedWithoutListener: true,
    testHomeMode: (statSync(testHome).mode & 0o777).toString(8).padStart(4, '0'),
    userDataRead: false,
    userDataWritten: false,
    externalNetworkRequests: 0,
    realModelCalls: 0,
  },
  fixtureParity: {
    currentSourceTraceableInBundle: false,
    equivalentBusinessFixtureAvailableInWKWebView: false,
    comparableNativeScreenshotState: false,
    reasons: [
      'The existing Test.app is a shared build artifact with no current-source or fixture provenance for this gate.',
      'The paired browser fixture depends on Playwright route interception and init scripts that are not available in the closed WKWebView.',
      'Launching this bundle would create non-equivalent evidence and cannot close the mandatory screenshot gate.',
    ],
  },
  requiredBeforeNativeThirdLeg: [
    'A uniquely named Test.app built from the same current source without overwriting a shared bundle.',
    'An equivalent offline K12 Settings/records/insights fixture reachable inside WKWebView.',
    'Reference/current native captures at 2048x924, DPR 1, zh-CN, light and dark, including restart persistence.',
  ],
}

rmSync(testHome, { recursive: true })
report.isolationPreflight.testHomeRemoved = !existsSync(testHome)
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
writeFileSync(
  join(evidenceRoot, 'test-app-wkwebview-preflight.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
