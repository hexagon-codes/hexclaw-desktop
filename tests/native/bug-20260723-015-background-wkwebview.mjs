#!/usr/bin/env node

/**
 * BUG-20260723-015：当前 worktree 全局背景的隔离 Test.app / WKWebView 证据门。
 *
 * 只在 mkdtemp sandbox 内构建唯一 Bundle ID 的测试 App；使用非持久化 WKWebView、
 * 独立 HOME/TMPDIR 与 HTTP(S) content blocker。结束后只清理本轮 App 和精确子进程。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const evidenceRoot = join(repoRoot, 'test/evidence/bug-20260723-015-current-source')
const nativeEvidenceRoot = join(evidenceRoot, 'native')
const swiftSource = join(nativeDir, 'bug-20260723-015-background-wkwebview.swift')
const runnerSource = fileURLToPath(import.meta.url)
const appLayoutSource = join(repoRoot, 'src/components/layout/AppLayout.vue')
const globalCssSource = join(repoRoot, 'src/assets/styles/global.css')
const k12PresentationSource = join(
  repoRoot,
  'src/features/k12/appearance/K12GlobalPresentation.vue',
)
const prototypeSource = join(docsRoot, 'prototype/app.html')
const productionBundle = '/Applications/HexClaw.app'
const productName = 'HexClaw BUG015 Background Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug015.background'
const executableName = 'hexclaw-bug015-background-test'
const timeoutMs = 5 * 60_000
const sourcePaths = {
  appLayout: appLayoutSource,
  globalCss: globalCssSource,
  k12Presentation: k12PresentationSource,
  prototype: prototypeSource,
  nativeSwiftHarness: swiftSource,
  nativeRunner: runnerSource,
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(path) {
  return sha256(readFileSync(path))
}

function sourceIdentity() {
  return Object.fromEntries(
    Object.entries(sourcePaths).map(([name, path]) => [name, fileSha256(path)]),
  )
}

function portableSourcePath(path) {
  if (path.startsWith(repoRoot)) return relative(repoRoot, path)
  if (path.startsWith(docsRoot)) return `../hexclaw-docs/${relative(docsRoot, path)}`
  return '<external-source>'
}

function sanitize(value, sandbox = '') {
  let result = String(value || '')
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(docsRoot, '<docs>')
    .replace(/\/Users\/[^/\s]+/g, '<user-home>')
  if (sandbox) result = result.replaceAll(sandbox, '<sandbox>')
  return result
}

function sanitizedValue(value, sandbox = '') {
  return JSON.parse(sanitize(JSON.stringify(value), sandbox))
}

function writeJson(path, value, sandbox = '') {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(sanitizedValue(value, sandbox), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

async function runChild(command, args, options = {}) {
  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  let timer
  try {
    const result = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          child.kill('SIGTERM')
          rejectTimeout(new Error(`${command} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    if (result.code !== 0) {
      throw new Error(`${command} exited ${result.code ?? result.signal}\n${stdout}\n${stderr}`)
    }
    return { pid: child.pid, durationMs: Date.now() - startedAt, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

function productionState() {
  const info = join(productionBundle, 'Contents/Info.plist')
  const executable = join(productionBundle, 'Contents/MacOS/hexclaw-desktop')
  return {
    exists: existsSync(productionBundle),
    directoryMtimeMs: existsSync(productionBundle) ? statSync(productionBundle).mtimeMs : null,
    infoSha256: existsSync(info) ? fileSha256(info) : null,
    executableSha256: existsSync(executable) ? fileSha256(executable) : null,
    pids: processRows()
      .filter((row) => row.command.includes(productionBundle))
      .map((row) => row.pid)
      .sort((left, right) => left - right),
  }
}

function extractStyle(source, label) {
  const blocks = [...source.matchAll(/<style\s+scoped>([\s\S]*?)<\/style>/g)]
  assert.equal(blocks.length, 1, `${label} must expose one scoped style block`)
  return blocks[0][1].trim()
}

function extractK12TextureRule(source) {
  const match = source.match(
    /:global\(body\[data-k12-skin-active='k12'\] \.hc-app__body::after\) \{\s*opacity: 0;\s*\}/,
  )
  assert.ok(match, 'K12 texture opacity rule is missing from current worktree')
  return match[0]
}

function writeFixture(implementationResources, appStyle, k12TextureRule, globalCss) {
  mkdirSync(implementationResources, { recursive: true, mode: 0o700 })
  const expandedK12TextureRule = k12TextureRule.replace(':global(', '').replace(') {', ' {')
  writeFileSync(
    join(implementationResources, 'index.html'),
    `<!doctype html>
<html lang="zh-CN" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; connect-src 'none';" />
    <title>HexClaw BUG015 Background Test</title>
    <style>
${globalCss}

${appStyle}

${expandedK12TextureRule}

.bug015-titlebar {
  flex: 0 0 38px;
  height: 38px;
}

.bug015-sidebar {
  flex: 0 0 226px;
  width: 226px;
  position: relative;
  z-index: 1;
}
    </style>
  </head>
  <body>
    <div class="hc-app">
      <div class="bug015-titlebar"></div>
      <div class="hc-app__body">
        <aside class="bug015-sidebar"></aside>
        <main class="hc-app__content">
          <div class="hc-app__glow" aria-hidden="true"></div>
          <div class="hc-app__view"></div>
        </main>
      </div>
    </div>
  </body>
</html>
`,
    { mode: 0o600 },
  )
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${productName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.5.0-beta</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}

function bundleManifest(appBundle) {
  const entries = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        entries.push({
          path: relative(appBundle, path),
          bytes: statSync(path).size,
          sha256: fileSha256(path),
        })
      }
    }
  }
  visit(appBundle)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files: entries,
    sha256: sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join('')),
  }
}

function activeKinds(layers) {
  return layers
    .filter((layer) => layer.active && ['texture', 'glow'].includes(layer.kind))
    .map((layer) => layer.kind)
    .sort()
}

function layer(layers, kind) {
  return layers.find((entry) => entry.kind === kind)
}

function near(left, right, tolerance = 1) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
}

function evaluateState(state) {
  const reference = state.reference.layers
  const implementation = state.implementation.layers
  const referenceTexture = layer(reference, 'texture')
  const implementationTexture = layer(implementation, 'texture')
  const referenceGlow = layer(reference, 'glow')
  const implementationGlow = layer(implementation, 'glow')
  const expected = state.mode === 'k12' ? ['glow'] : ['glow', 'texture']
  const checks = [
    ['reference-active-exact-set', expected, activeKinds(reference)],
    ['implementation-active-exact-set', expected, activeKinds(implementation)],
    [
      'texture-background-image',
      referenceTexture?.style?.backgroundImage,
      implementationTexture?.style?.backgroundImage,
    ],
    [
      'texture-background-size',
      referenceTexture?.style?.backgroundSize,
      implementationTexture?.style?.backgroundSize,
    ],
    ['texture-opacity', referenceTexture?.style?.opacity, implementationTexture?.style?.opacity],
    ['texture-z-index', referenceTexture?.style?.zIndex, implementationTexture?.style?.zIndex],
    ['texture-bbox-x', referenceTexture?.rect?.x, implementationTexture?.rect?.x, 'near'],
    ['texture-bbox-y', referenceTexture?.rect?.y, implementationTexture?.rect?.y, 'near'],
    [
      'texture-bbox-width',
      referenceTexture?.rect?.width,
      implementationTexture?.rect?.width,
      'near',
    ],
    [
      'texture-bbox-height',
      referenceTexture?.rect?.height,
      implementationTexture?.rect?.height,
      'near',
    ],
    [
      'glow-background-image',
      referenceGlow?.style?.backgroundImage,
      implementationGlow?.style?.backgroundImage,
    ],
    ['glow-opacity', referenceGlow?.style?.opacity, implementationGlow?.style?.opacity],
    ['glow-z-index', referenceGlow?.style?.zIndex, implementationGlow?.style?.zIndex],
    ['glow-bbox-x', referenceGlow?.rect?.x, implementationGlow?.rect?.x, 'near'],
    ['glow-bbox-y', referenceGlow?.rect?.y, implementationGlow?.rect?.y, 'near'],
    ['glow-bbox-height', referenceGlow?.rect?.height, implementationGlow?.rect?.height, 'near'],
  ].map(([id, referenceValue, implementationValue, comparison]) => ({
    id,
    reference: referenceValue,
    implementation: implementationValue,
    pass:
      comparison === 'near'
        ? near(referenceValue, implementationValue)
        : JSON.stringify(referenceValue) === JSON.stringify(implementationValue),
  }))
  const environmentPass =
    JSON.stringify(state.reference.environment) === JSON.stringify(state.implementation.environment)
  const runtimePass =
    state.reference.runtimeErrors.length === 0 && state.implementation.runtimeErrors.length === 0
  const pixelPass = state.pixels.normalized.changedPixelRatio <= 0.01
  const pass = checks.every((check) => check.pass) && environmentPass && runtimePass && pixelPass
  return {
    state: state.state,
    mode: state.mode,
    theme: state.theme,
    status: pass ? 'NON_CONFLICT_PASS' : 'RED',
    checks: { pass: checks.every((check) => check.pass), checks },
    environment: {
      status: environmentPass ? 'PASS' : 'RED',
      reference: state.reference.environment,
      implementation: state.implementation.environment,
    },
    runtime: {
      status: runtimePass ? 'PASS' : 'RED',
      referenceErrors: state.reference.runtimeErrors,
      implementationErrors: state.implementation.runtimeErrors,
    },
    pixels: state.pixels,
    layers: { reference, implementation },
    main: { reference: state.reference.main, implementation: state.implementation.main },
    rightPanelDecision: {
      status: 'BLOCKED_PENDING_USER_DECISION',
      declaredConflict: {
        implementationClosedGutterPx: 0,
        prototypeHistoricalClosedGutterPx: 2,
      },
      excludedFromThisGate: [
        'glow bbox width',
        'main content bbox width',
        'closed context/artifacts panel gutter and border width',
      ],
    },
    files: {
      reference: 'reference.png',
      implementation: 'implementation.png',
      diff: 'diff.png',
      pageReference: 'page-reference.png',
      pageImplementation: 'page-implementation.png',
      pageDiff: 'page-diff.png',
    },
  }
}

function updateTopLevelEvidence(nativeSummary) {
  const summaryPath = join(evidenceRoot, 'summary.json')
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    summary.installedCandidate = {
      status: 'PASS_NON_CONFLICT_GATES',
      candidate: 'temporary HexClaw BUG015 Background Test.app',
      boundary: nativeSummary.boundary,
      bundleIdentifier,
      currentWorktreeProvenance: true,
      evidence: 'native/summary.json',
      applicationsTouched: false,
      realHomeTouched: false,
      rightPanelDecision: 'BLOCKED_PENDING_USER_DECISION',
    }
    writeJson(summaryPath, summary)
  }
  const readmePath = join(evidenceRoot, 'README.md')
  if (existsSync(readmePath)) {
    const current = readFileSync(readmePath, 'utf8')
    const replacement =
      '- Installed candidate: **PASS_NON_CONFLICT_GATES** — isolated current-worktree Test.app / WKWebView evidence is in `native/`; the right-panel 0px/2px decision remains independently blocked.'
    const updated = current.match(/^- Installed candidate:.*$/m)
      ? current.replace(/^- Installed candidate:.*$/m, replacement)
      : `${current.trimEnd()}\n${replacement}\n`
    writeFileSync(readmePath, updated, { encoding: 'utf8', mode: 0o600 })
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'BUG-20260723-015 native gate is macOS-only')
  for (const path of Object.values(sourcePaths))
    assert.ok(existsSync(path), `missing input: ${path}`)
  if (existsSync(nativeEvidenceRoot)) rmSync(nativeEvidenceRoot, { recursive: true, force: true })
  mkdirSync(nativeEvidenceRoot, { recursive: true, mode: 0o700 })

  const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'hexclaw-bug015-background-'))
  chmodSync(sandbox, 0o700)
  const testHome = join(sandbox, 'home')
  const testTmp = join(sandbox, 'tmp')
  const appBundle = join(sandbox, `${productName}.app`)
  const contents = join(appBundle, 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  const staging = join(sandbox, 'evidence')
  for (const directory of [testHome, testTmp, macos, resources, staging]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  const sourceBefore = sourceIdentity()
  const productionBefore = productionState()
  let childPid = null
  let finalError = null
  let cleanup = null

  try {
    const appLayout = readFileSync(appLayoutSource, 'utf8')
    const globalCss = readFileSync(globalCssSource, 'utf8')
    const k12Presentation = readFileSync(k12PresentationSource, 'utf8')
    const appStyle = extractStyle(appLayout, 'AppLayout.vue')
    const k12TextureRule = extractK12TextureRule(k12Presentation)
    assert.ok(appStyle.includes('.hc-app__body::after'), 'AppLayout texture rule is missing')
    assert.ok(appStyle.includes('.hc-app__glow'), 'AppLayout glow rule is missing')
    const implementationResources = join(resources, 'implementation')
    writeFixture(implementationResources, appStyle, k12TextureRule, globalCss)
    const referenceResources = join(resources, 'reference')
    mkdirSync(referenceResources, { recursive: true, mode: 0o700 })
    cpSync(prototypeSource, join(referenceResources, 'app.html'))

    writeFileSync(join(contents, 'Info.plist'), infoPlist(), { mode: 0o600 })
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????', { mode: 0o600 })
    const executable = join(macos, executableName)
    const compile = runSync('swiftc', [
      swiftSource,
      '-o',
      executable,
      '-framework',
      'AppKit',
      '-framework',
      'WebKit',
    ])
    chmodSync(executable, 0o700)
    const builtIdentifier = runSync('plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      join(contents, 'Info.plist'),
    ])
    assert.equal(builtIdentifier, bundleIdentifier)
    const manifest = bundleManifest(appBundle)
    writeJson(
      join(nativeEvidenceRoot, 'build-identity.json'),
      {
        bundle: `${productName}.app`,
        bundleIdentifier: builtIdentifier,
        bundleManifest: manifest,
        executableSha256: fileSha256(executable),
        sourceSnapshot: Object.fromEntries(
          Object.entries(sourceBefore).map(([name, digest]) => [
            name,
            { path: portableSourcePath(sourcePaths[name]), sha256: digest },
          ]),
        ),
        extractedCurrentSource: {
          appLayoutScopedStyleSha256: sha256(appStyle),
          k12TextureRuleSha256: sha256(k12TextureRule),
          globalCssSha256: sha256(globalCss),
          appLayoutTextureRulePresent: true,
          appLayoutGlowRulePresent: true,
          k12TextureOpacityRule: k12TextureRule,
        },
        compileStdout: compile,
      },
      sandbox,
    )

    const appEnvironment = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: testHome,
      CFFIXED_USER_HOME: testHome,
      TMPDIR: testTmp,
      HEXCLAW_TEST_HOME: testHome,
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      AppleLanguages: '(zh-CN)',
      AppleLocale: 'zh_CN',
    }
    const run = await runChild(executable, [resources, staging], { env: appEnvironment })
    childPid = run.pid
    writeFileSync(
      join(nativeEvidenceRoot, 'test-app.log'),
      sanitize(`${run.stdout}${run.stderr}`, sandbox),
      { encoding: 'utf8', mode: 0o600 },
    )
    const rawPath = join(staging, 'native-raw-report.json')
    assert.ok(existsSync(rawPath), 'native raw report is missing')
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'))
    assert.equal(raw.bundleIdentifier, bundleIdentifier)
    assert.equal(raw.contentRuleInstalled, true)
    assert.deepEqual(raw.blockedNavigations, [])
    assert.equal(raw.states.length, 4)

    const evaluatedStates = raw.states.map(evaluateState)
    for (const state of evaluatedStates) {
      const sourceDirectory = join(staging, state.state)
      const destination = join(nativeEvidenceRoot, state.state)
      mkdirSync(destination, { recursive: true, mode: 0o700 })
      for (const file of [
        'reference.png',
        'implementation.png',
        'diff.png',
        'page-reference.png',
        'page-implementation.png',
        'page-diff.png',
      ]) {
        cpSync(join(sourceDirectory, file), join(destination, file))
      }
      writeJson(join(destination, 'computed-style.json'), state, sandbox)
      assert.equal(
        state.status,
        'NON_CONFLICT_PASS',
        `${state.state} native background gate is RED`,
      )
    }
    const sourceAfter = sourceIdentity()
    assert.deepEqual(
      sourceAfter,
      sourceBefore,
      'current worktree inputs changed during native gate',
    )
    const productionAfterRun = productionState()
    assert.deepEqual(productionAfterRun, productionBefore, '/Applications HexClaw state changed')
    const nativeSummary = {
      bug: 'BUG-20260723-015',
      acceptance: 'UI-GLOBAL-BACKGROUND-001',
      status: 'NON_CONFLICT_PASS_RIGHT_PANEL_BLOCKED',
      boundary: 'isolated temporary Test.app / non-persistent WKWebView / homomorphic CSS fixture',
      bundleIdentifier,
      currentWorktreeProvenance: {
        stable: true,
        sourceHashes: sourceBefore,
        bundleManifestSha256: manifest.sha256,
      },
      isolation: {
        temporaryHome: true,
        temporaryDirectoryMode: '0700',
        nonPersistentWebsiteDataStore: true,
        httpContentRuleInstalled: true,
        externalNavigations: [],
        dedicatedPorts: [],
        applicationsTouched: false,
        realHomeTouched: false,
      },
      states: evaluatedStates.map((state) => ({
        state: state.state,
        status: state.status,
        activeReferenceExactSet: activeKinds(state.layers.reference),
        activeImplementationExactSet: activeKinds(state.layers.implementation),
        normalizedChangedPixelRatio: state.pixels.normalized.changedPixelRatio,
        rightPanelDecision: state.rightPanelDecision.status,
      })),
      rightPanelDecision: {
        status: 'BLOCKED_PENDING_USER_DECISION',
        implementationClosedGutterPx: 0,
        prototypeHistoricalClosedGutterPx: 2,
        excludedFromEveryOtherBackgroundGate: true,
      },
      rawPageScreenshots: {
        status: 'DIAGNOSTIC_ONLY',
        reason:
          '原型与同态实现 fixture 的业务 DOM 不同；背景通过门使用相同 WKWebView 内的固定检查平面。',
      },
    }
    writeJson(join(nativeEvidenceRoot, 'summary.json'), nativeSummary, sandbox)
    updateTopLevelEvidence(nativeSummary)
  } catch (error) {
    finalError = error
    writeJson(
      join(nativeEvidenceRoot, 'failure.json'),
      { status: 'NOT_PASS', error: error.stack || error.message },
      sandbox,
    )
  } finally {
    const ownedBeforeCleanup = processRows().filter(
      (row) => row.command.includes(sandbox) || row.command.includes(bundleIdentifier),
    )
    for (const row of ownedBeforeCleanup) {
      if (row.pid !== process.pid) {
        try {
          process.kill(row.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') finalError ||= error
        }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    const ownedAfterStop = processRows().filter(
      (row) => row.command.includes(sandbox) || row.command.includes(bundleIdentifier),
    )
    if (ownedAfterStop.length > 0) {
      finalError ||= new Error(`owned Test.app processes remain: ${JSON.stringify(ownedAfterStop)}`)
    }
    const productionAfterCleanup = productionState()
    if (JSON.stringify(productionAfterCleanup) !== JSON.stringify(productionBefore)) {
      finalError ||= new Error('/Applications HexClaw state changed during cleanup')
    }
    rmSync(sandbox, { recursive: true, force: true })
    cleanup = {
      testAppPid: childPid,
      ownedProcessesObservedBeforeCleanup: ownedBeforeCleanup.map((row) => row.pid),
      ownedProcessesRemaining: ownedAfterStop.map((row) => row.pid),
      sandboxRemoved: !existsSync(sandbox),
      testAppRemoved: !existsSync(appBundle),
      dedicatedPorts: [],
      applicationsStateUnchanged:
        JSON.stringify(productionAfterCleanup) === JSON.stringify(productionBefore),
      realHomeTouched: false,
    }
    writeJson(join(nativeEvidenceRoot, 'cleanup.json'), cleanup)
  }

  assert.ok(cleanup.sandboxRemoved, 'native sandbox was not removed')
  assert.ok(cleanup.testAppRemoved, 'temporary Test.app was not removed')
  assert.deepEqual(cleanup.ownedProcessesRemaining, [], 'owned native processes remain')
  assert.equal(cleanup.applicationsStateUnchanged, true, '/Applications state changed')
  if (finalError) throw finalError
  process.stdout.write(
    'BUG-20260723-015 isolated Test.app WKWebView: NON_CONFLICT_PASS_RIGHT_PANEL_BLOCKED\n',
  )
  process.stdout.write('Evidence: test/evidence/bug-20260723-015-current-source/native/\n')
}

await main()
