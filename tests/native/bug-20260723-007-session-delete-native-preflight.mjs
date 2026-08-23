#!/usr/bin/env node

/**
 * BUG-20260723-007 会话删除原生边界可比性前置检查。
 *
 * 只读取工作区内 Test.app 候选的元数据并验证隔离条件。浏览器用例依赖
 * Playwright 对 DELETE 依次注入 500/200；关闭的 WKWebView 候选没有等价注入
 * 通道和 current-source 回执，因此禁止启动它制造假等价证据。
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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(nativeDir, '../..')
const evidenceRoot = join(desktopRoot, 'test/evidence/bug-20260723-007-session-delete-lifecycle')
const bundle = join(desktopRoot, 'src-tauri/target/release/bundle/macos/HexClaw Test.app')
const infoPlist = join(bundle, 'Contents/Info.plist')
const executable = join(bundle, 'Contents/MacOS/hexclaw-desktop')
const sidecar = join(bundle, 'Contents/MacOS/hexclaw')

function sha256(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

function modifiedAt(file) {
  return existsSync(file) ? statSync(file).mtime.toISOString() : null
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

function reserveAndReleaseLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to reserve an isolated loopback port'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

const isolatedHome = mkdtempSync(join(tmpdir(), 'hexclaw-bug-007-native-preflight.'))
chmodSync(isolatedHome, 0o700)
const isolatedConfig = join(isolatedHome, '.hexclaw')
mkdirSync(isolatedConfig, { mode: 0o700 })
const dedicatedPort = await reserveAndReleaseLoopbackPort()

const bundlePresent = existsSync(bundle)
const report = {
  bug: 'BUG-20260723-007',
  status: 'NOT COMPARABLE',
  execution: 'NOT_RUN',
  reason:
    'The deterministic browser lifecycle injects DELETE responses 500 then 200 through Playwright routing. The closed WKWebView candidate has no equivalent fixture channel, current-source provenance receipt, or persistent Sidecar receipt for that exact sequence.',
  candidate: {
    relativePath: relative(desktopRoot, bundle),
    bundlePresent,
    bundleIdentifier: plistValue('CFBundleIdentifier'),
    version: plistValue('CFBundleShortVersionString'),
    bundleModifiedAt: modifiedAt(bundle),
    infoPlist: {
      present: existsSync(infoPlist),
      modifiedAt: modifiedAt(infoPlist),
      sha256: sha256(infoPlist),
    },
    executable: {
      present: existsSync(executable),
      modifiedAt: modifiedAt(executable),
      sha256: sha256(executable),
    },
    sidecar: {
      present: existsSync(sidecar),
      modifiedAt: modifiedAt(sidecar),
      sha256: sha256(sidecar),
    },
    launched: false,
    rebuilt: false,
  },
  fixtureParity: {
    currentSourceTraceableInBundle: false,
    sequentialDelete500Then200Injectable: false,
    persistentSidecarReceiptForExactSequence: false,
    sameSessionFixtureInjectableInWKWebView: false,
    comparableInstalledLifecycle: false,
  },
  isolation: {
    isolatedHomeCreated: true,
    isolatedHomeMode: (statSync(isolatedHome).mode & 0o777).toString(8).padStart(4, '0'),
    isolatedConfigMode: (statSync(isolatedConfig).mode & 0o777).toString(8).padStart(4, '0'),
    loopbackBinding: '127.0.0.1',
    dedicatedPort,
    dedicatedPortReservedAndReleased: dedicatedPort > 0,
    appLaunched: false,
    applicationsTouched: false,
    realHomeTouched: false,
    realUserSessionsTouched: false,
    userDataRead: false,
    userDataWritten: false,
    externalNetworkRequests: 0,
  },
}

rmSync(isolatedHome, { recursive: true })
report.isolation.isolatedHomeRemoved = !existsSync(isolatedHome)
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
writeFileSync(join(evidenceRoot, 'native-boundary.json'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
})
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
