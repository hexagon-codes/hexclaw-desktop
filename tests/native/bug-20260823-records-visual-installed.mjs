#!/usr/bin/env node

/**
 * WORKS-DESC-SINGLE-LINE-001 / MISTAKES-ROW-ACTIONS-VISIBLE-001 WKWebView 诊断层。
 *
 * 单个临时 Test.app 依次加载权威原型和当前生产 dist，在同一真实 Tauri WKWebView、
 * 同一窗口尺寸和同一确定性业务夹具下采集。由于该脚本会构建并注入 Test.app，
 * 所有结果只能标记 DIAGNOSTIC_ONLY，不得作为最终安装包精确字节的第三腿：
 *   - 作品 1226px；
 *   - 全部错题 1226px；
 *   - 全部错题 1024px。
 *
 * 只写隔离 Test Home、临时构建目录和专用证据目录；不安装到 /Applications，
 * 不读取或修改用户配置/业务数据，不调用真实模型或 IM。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const prototypeRoot = join(docsRoot, 'prototype')
const prototypePath = join(prototypeRoot, 'app.html')
const srcTauriDir = join(repoRoot, 'src-tauri')
const pixelDiffTool = join(repoRoot, 'tests/e2e/tools/k12_visual_pixel_diff.swift')
const installedCandidateBundle = '/Applications/HexClaw.app'
const evidenceRoot = join(
  docsRoot,
  'docs/evidence/bug-k12-closure-20260824/native-records-final',
)
const phaseKey = '__hexclaw_bug_20260823_records_native_phase__'
const runNonce = `${Date.now()}-${process.pid}`
const productName = `HexClaw Records Visual Test ${runNonce}`
const bundleIdentifier = `com.hexclaw.desktop.k12-records-${runNonce}`
const commandTimeoutMs = 15 * 60 * 1000
const geometryTolerance = 1
const pixelThreshold = 8
const maxChangedPixelRatio = 0.001

const states = [
  {
    id: 'works-1226',
    tab: 4,
    implementationTab: 'subtab-works',
    width: 1226,
    height: 820,
    readySelector: '.k12cw__card',
    readyCount: 3,
    maskSelectors: {
      reference: ['#k12BookTabs .k12-tab-count'],
      current: ['.k12rec__tabs .k12-tab-count'],
    },
    targets: {
      reference: [
        target('records-root', '#k12ViewRecords'),
        target('object-toolbar', '#k12BookToolbar'),
        target('object-tabs', '#k12BookTabs'),
        target('active-panel', '#k12BookPanel4'),
        target('description', '#k12BookPanel4 .practice-overview__copy > p'),
        target('overview', '#k12BookPanel4 .practice-overview'),
        target('kpis', '#k12BookPanel4 .practice-kpis'),
        target('kpi', '#k12BookPanel4 .practice-kpi', true),
        target('add-button', '#k12BookToolbar .rc-4'),
        target('card', '#k12CreativeWorkList .creative-work-card', true),
        target('card-preview', '#k12CreativeWorkList .creative-work-preview', true),
        target('card-top', '#k12CreativeWorkList .creative-work-copy > div:first-child', true),
        target('card-footer', '.creative-work-card__foot', true),
        target('card-time', '.creative-work-card__time', true),
        target('card-action', '.creative-work-card__action', true),
      ],
      current: [
        target('records-root', '.k12rec'),
        target('object-toolbar', '.k12rec__tabs'),
        target('object-tabs', '.k12rec__tabs .k12-book-tabs'),
        target('active-panel', '[data-testid="works-section"]'),
        target('description', '.k12cw__desc'),
        target('overview', '.k12cw__overview'),
        target('kpis', '.k12cw__kpis'),
        target('kpi', '.k12cw__kpi', true),
        target('add-button', '[data-testid="cw-add-open"]'),
        target('card', '.k12cw__card', true),
        target('card-preview', '.k12cw__preview', true),
        target('card-top', '.k12cw__head', true),
        target('card-footer', '.k12cw__foot', true),
        target('card-time', '.k12cw__time', true),
        target('card-action', '.k12cw__detail-toggle', true),
      ],
    },
    comparisonTargets: [
      'object-toolbar',
      'description',
      'overview',
      'kpis',
      'kpi',
      'add-button',
      'card',
      'card-preview',
      'card-top',
      'card-footer',
      'card-time',
      'card-action',
    ],
  },
  {
    id: 'mistakes-1226',
    tab: 1,
    implementationTab: 'subtab-mistakes',
    width: 1226,
    height: 820,
    readySelector: '.k12mistakes .rl-row',
    readyCount: 7,
    maskSelectors: { reference: [], current: [] },
    targets: mistakeTargets(),
    comparisonTargets: [
      'object-toolbar',
      'object-summary',
      'filter-stack',
      'filter-labels',
      'filter-buttons',
      'archive-note',
      'mistake-rows',
      'mistake-question',
      'mistake-description',
      'mistake-actions',
    ],
  },
  {
    id: 'mistakes-1024',
    tab: 1,
    implementationTab: 'subtab-mistakes',
    width: 1024,
    height: 820,
    readySelector: '.k12mistakes .rl-row',
    readyCount: 7,
    maskSelectors: { reference: [], current: [] },
    targets: mistakeTargets(),
    comparisonTargets: [
      'object-toolbar',
      'object-summary',
      'filter-stack',
      'filter-labels',
      'filter-buttons',
      'archive-note',
      'mistake-rows',
      'mistake-question',
      'mistake-description',
      'mistake-actions',
    ],
  },
]

function target(name, selector, all = false) {
  return { name, selector, all, required: true, ignoreText: true }
}

function mistakeTargets() {
  return {
    reference: [
      target('records-root', '#k12ViewRecords'),
      target('object-toolbar', '#k12BookToolbar'),
      target('object-tabs', '#k12BookTabs'),
      target('active-panel', '#k12BookPanel1'),
      target('object-summary', '#k12BookPanel1 .rc-object-summary'),
      target('filter-stack', '#k12BookPanel1 .k12-secondary-tabs'),
      target('filter-labels', '#k12BookPanel1 .k12-secondary-tabs__label', true),
      target('filter-buttons', '#k12BookPanel1 .k12-secondary-tabs__row .source-tag', true),
      target('archive-note', '#k12BookPanel1 .rc-archnote'),
      target('content-container', '#k12ViewRecords > .content'),
      target('mistake-rows', '#k12MistakeList .resource-row', true),
      target('mistake-question', '#k12MistakeList .resource-row > b', true),
      target('mistake-description', '#k12MistakeList .resource-row > .sp', true),
      target('mistake-actions', '#k12MistakeList .resource-row > button', true),
    ],
    current: [
      target('records-root', '.k12rec'),
      target('object-toolbar', '.k12rec__tabs'),
      target('object-tabs', '.k12rec__tabs .k12-book-tabs'),
      target('active-panel', '[data-testid="mistakes-section"]'),
      target('object-summary', '.k12rec__object-summary'),
      target('filter-stack', '.k12rec__filter-stack'),
      target('filter-labels', '.k12rec__filter-label', true),
      target('filter-buttons', '.k12rec__filter', true),
      target('archive-note', '.k12rec__archive-note'),
      target('content-container', '.k12rec__body'),
      target('mistake-rows', '.k12mistakes .rl-row', true),
      target('mistake-question', '.k12mistakes .rl-row > .rl-title', true),
      target('mistake-description', '.k12mistakes .rl-row > .rl-meta', true),
      target('mistake-actions', '.k12mistakes .rl-row > button', true),
    ],
  }
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function installedCandidateReceipt() {
  const executable = join(installedCandidateBundle, 'Contents/MacOS/hexclaw-desktop')
  const sidecar = join(installedCandidateBundle, 'Contents/MacOS/hexclaw')
  if (!existsSync(executable) || !existsSync(sidecar)) return null
  return {
    bundle: installedCandidateBundle,
    executableSHA256: sha256File(executable),
    sidecarSHA256: sha256File(sidecar),
  }
}

function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[records-native] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: 'inherit',
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectCommand(new Error(`Command timed out: ${command} ${args.join(' ')}`))
    }, options.timeoutMs || commandTimeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand()
      else
        rejectCommand(new Error(`Command failed (${code ?? signal}): ${command} ${args.join(' ')}`))
    })
  })
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose) => server.close(resolveClose))
  assert.notEqual(port, 16060)
  assert.notEqual(port, 11434)
  return port
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function readJSONBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 4 * 1024 * 1024) throw new Error('Fixture body exceeds 4 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function createLoopbackFixture(port) {
  const state = {
    reports: [],
    updaterRequests: 0,
    modelInvocations: 0,
    imInvocations: 0,
    unexpectedRequests: [],
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__records_native__/report') {
        state.reports.push(await readJSONBody(request))
        jsonResponse(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        state.modelInvocations += 1
        jsonResponse(response, 503, { error: { message: 'Model calls are forbidden in this gate' } })
        return
      }
      if (/dingtalk|delivery|send[_-]?im/i.test(url.pathname) && request.method !== 'GET') {
        state.imInvocations += 1
        jsonResponse(response, 503, { error: 'IM calls are forbidden in this gate' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'Unexpected fixture request' })
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      jsonResponse(response, 500, { error: 'Fixture failure' })
    }
  })
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      })
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function fixtureData() {
  const mistakes = [
    ['mistake-apple', '苹果和梨的价钱（P52·3）', '小数乘法', '连续错 2 次 · 计算失误', 'new', 'scheduled', '数学', 'photo', 1784160000],
    ['mistake-bulb', '小灯泡没有形成闭合回路', '简单电路', '实验图判断错误', 'new', 'scheduled', '科学', 'photo', 1784073600],
    ['mistake-decimal', '重复执行积木少循环 1 次', '图形化编程', '运行结果已复核 · 到期可再练', 'retried', 'retried', '信息科技', 'verified', 1783900800],
    ['mistake-equation', '解方程 2x + 15 = 43', '简易方程', '复练 1 次 · 仍需巩固', 'retried', 'retried', '数学', 'verified', 1783814400],
    ['mistake-believe', 'believe —— 拼成 belive（少 e）', '错词', '本轮已跳过 · 系统证据不足', 'new', 'scheduled', '英语', 'writing_confirmed', 1783555200],
    ['mistake-poem', '「梅须逊雪三分白」漏「须」字', '默写', '上次生成任务未完成', 'new', 'scheduled', '语文', 'manual', 1783468800],
    ['mistake-position', '用数对表示位置', '位置', '两次独立复练正确', 'mastered', 'mastered', '数学', 'verified', 1782000000],
  ].map(
    ([record_id, question, knowledge_point, error_cause, status, review_state, subject, entry_source, created_at]) => ({
      record_id,
      question,
      knowledge_point,
      error_cause,
      status,
      review_state,
      subject,
      entry_source,
      created_at,
      version: 1,
    }),
  )
  const creativeFeedback = (id, type, evidence) => ({
    feedback_id: id,
    feedback_type: type,
    evidence_refs: evidence.map((_, index) => `evidence-${id}-${index + 1}`),
    visible_evidence: evidence,
    affirmation: '这次作品已经保存了清楚、可见的优点。',
    parent_guidance: '可以请孩子说说自己最满意的部分。',
    next_step: '下一次只尝试改进一个小地方。',
    source_snapshot: {
      source: 'ai',
      method_ref: 'k12-creative-feedback-v1',
      capability: 'creative-work-feedback',
    },
  })
  const creativeWorks = [
    {
      work_id: 'WRITING-20260715-001',
      work_type: 'writing',
      display_name: '《春天的校园》',
      display_kind: '语文·习作',
      preview_variant: 'writing',
      display_evidence: ['切题：校园春景', '结构：三段', '表达：有一处可提升'],
      content_markdown: '柳枝像绿色的丝带，在春风里轻轻摆动。',
      row_version: 1,
      created_at: 1784115343,
      latest_generation_at: 1784115343,
      initial_feedback: {
        generation_id: 'REVIEW-WRITING-20260715-001',
        status: 'succeeded',
        feedback: creativeFeedback('feedback-writing', 'writing', [
          '切题：校园春景',
          '结构：三段',
          '表达：有一处可提升',
        ]),
      },
    },
    {
      work_id: 'ART-20260716-001',
      work_type: 'art',
      display_name: '《雨后的校园》',
      display_kind: '美术·水彩',
      preview_variant: 'default',
      display_evidence: ['构图：主体偏右', '色彩：冷暖有层次', '线条：边缘清楚'],
      row_version: 1,
      created_at: 1784203929,
      latest_generation_at: 1784203929,
      initial_feedback: {
        generation_id: 'REVIEW-ART-20260716-001',
        status: 'succeeded',
        feedback: creativeFeedback('feedback-art', 'art', [
          '构图：主体偏右',
          '色彩：冷暖有层次',
          '线条：边缘清楚',
        ]),
      },
    },
    {
      work_id: 'ART-20260717-002',
      work_type: 'art',
      display_name: '《桌上的水杯》',
      display_kind: '美术·线描',
      preview_variant: 'line',
      display_evidence: ['原图：已保存', '年级：五年级'],
      row_version: 1,
      created_at: 1784248938,
      latest_generation_at: null,
      initial_feedback: {
        generation_id: 'REVIEW-ART-20260717-002',
        status: 'failed',
        failure_message: '点评生成失败',
      },
    },
  ]
  return {
    agent: {
      name: 'k12-fidelity-ming',
      display_name: '小明的辅导助手',
      description: '五年级辅导',
      provider: '',
      model: '',
      metadata: {
        scenario: 'k12-tutor',
        avatar: '🎓',
        'k12.child_name': '小明',
        'k12.grade_term': '五年级下',
        'k12.textbook_edition': '人教版',
      },
    },
    session: {
      id: 'k12-records-native-session',
      title: '小明的辅导助手',
      agent_id: 'k12-fidelity-ming',
      created_at: '2026-07-29T19:32:00+08:00',
      updated_at: '2026-07-29T19:32:00+08:00',
      message_count: 1,
    },
    mistakes,
    creativeWorks,
  }
}

function renderConfig(testHome, sidecarPort, fixtureOrigin) {
  return `server:
  host: 127.0.0.1
  port: ${sidecarPort}
  mode: development
platforms:
  web:
    enabled: true
llm:
  default: fixture
  providers:
    fixture:
      api_key: local-fixture-only
      base_url: ${fixtureOrigin}/v1
      model: fixture-model
      models:
        - fixture-model
      compatible: openai
      locality: cloud
      tools_enabled: false
      enabled: true
  routing:
    enabled: false
  cache:
    enabled: false
  tools:
    enabled: "off"
storage:
  driver: sqlite
  sqlite:
    path: ${JSON.stringify(join(testHome, '.hexclaw/data.db'))}
knowledge:
  enabled: false
memory:
  long_term:
    enabled: false
  vector:
    enabled: false
file_memory:
  enabled: false
heartbeat:
  enabled: false
mcp:
  enabled: false
skills:
  enabled: false
  auto_load: false
router:
  enabled: false
voice:
  enabled: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function redirectReferenceBootstrap(options) {
  const phase = Number(localStorage.getItem(options.phaseKey) || '0')
  if (phase < options.stateCount) {
    globalThis.__HEXCLAW_NATIVE_REFERENCE_REDIRECT__ = true
    void fetch(options.fixtureOrigin + '/__records_native__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        stage: 'reference-redirect',
        phase,
        location: location.pathname + location.search,
      }),
    }).catch(() => {})
    location.replace('./prototype/app.html')
  }
}

async function nativeRecordsVisualDriver(options) {
  'use strict'
  const side = options.side
  const stateCount = options.states.length
  const phase = Number(localStorage.getItem(options.phaseKey) || '0')
  const stateIndex = side === 'reference' ? phase : phase - stateCount
  if (stateIndex < 0 || stateIndex >= stateCount) return
  const state = options.states[stateIndex]
  const fixture = options.fixture
  const telemetry = {
    apiRequests: [],
    fixtureMutations: [],
    modelInvocations: 0,
    imInvocations: 0,
    blockedExternalRequests: [],
  }
  const sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const post = async (payload) => {
    const response = await fetch(options.fixtureOrigin + '/__records_native__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('Fixture report failed: ' + response.status)
  }
  const reportError = (error) => {
    const message =
      error instanceof Error
        ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\n')
        : String(error)
    void post({ stage: 'fixture-error', side, state: state.id, message }).catch(() => {})
  }
  addEventListener('error', (event) => reportError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportError(event.reason))
  await post({
    stage: 'driver-start',
    side,
    state: state.id,
    phase,
    location: location.pathname + location.search,
  })
  const waitFor = async (read, label, timeout = 60000) => {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = read()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(80)
    }
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const response = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  const practiceGeneration = (recordID) => {
    if (recordID === 'mistake-apple') {
      return {
        state: 'joined',
        source_mistake_id: recordID,
        practice_set_id: 'practice-set-visual',
        practice_item_id: 'practice-item-apple',
      }
    }
    if (recordID === 'mistake-poem') {
      return { state: 'failed', source_mistake_id: recordID, failure_reason: '上次生成任务未完成' }
    }
    if (recordID === 'mistake-decimal') return { state: 're_add', source_mistake_id: recordID }
    return { state: 'available', source_mistake_id: recordID }
  }
  const apiResponse = (method, rawPath) => {
    const url = new URL(rawPath, 'http://sidecar.invalid')
    const path = url.pathname
    telemetry.apiRequests.push(method + ' ' + path)
    if (method !== 'GET') telemetry.fixtureMutations.push(method + ' ' + path)
    if (/chat\/completions|\/messages\/stream|\/chat$/.test(path) && method !== 'GET') {
      telemetry.modelInvocations += 1
      return response({ error: 'Model calls are forbidden in this gate' }, 503)
    }
    if (/dingtalk|delivery|send[_-]?im/i.test(path) && method !== 'GET') {
      telemetry.imInvocations += 1
      return response({ error: 'IM calls are forbidden in this gate' }, 503)
    }
    if (path === '/health') return response({ status: 'ok' })
    if (path === '/api/v1/config/llm') {
      return response({ default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } })
    }
    if (path === '/api/v1/config') {
      return response({ server: { host: '127.0.0.1', mode: 'desktop' }, llm: { default: '', providers: {} } })
    }
    if (path === '/api/v1/ollama/status') return response({ running: false, associated: false, models: [] })
    if (path === '/api/v1/agents') return response({ agents: [fixture.agent], total: 1, default: fixture.agent.name })
    if (path === '/api/v1/sessions') return response({ sessions: [fixture.session], total: 1 })
    if (path === '/api/v1/sessions/' + fixture.session.id + '/messages') {
      return response({ messages: [{ id: 'message-1', role: 'user', content: '学习档案视觉夹具', created_at: fixture.session.created_at }], total: 1 })
    }
    if (/^\/api\/v1\/sessions\/[^/]+\/messages$/.test(path)) return response({ messages: [], total: 0 })
    if (path === '/api/v1/streams/active') return response({ streams: [], total: 0 })
    if (path === '/api/k12/view-descriptor') {
      return response({ header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
    }
    if (path === '/api/k12/image-tasks/recoverable') return response({ items: [] })
    if (path === '/api/k12/mistakes') return response({ items: fixture.mistakes, total: 11 })
    if (path === '/api/k12/review-queue') return response({ items: fixture.mistakes.slice(0, 6), total: 6 })
    const generation = path.match(/^\/api\/k12\/mistakes\/([^/]+)\/practice-generation$/)
    if (generation && method === 'GET') return response(practiceGeneration(decodeURIComponent(generation[1])))
    if (path === '/api/k12/creative-works' && method === 'GET') return response({ items: fixture.creativeWorks })
    if (path === '/api/k12/curriculum-progress') return response({ progress: null })
    if (path === '/api/k12/weekly-practice/settings') {
      return response({ agent: fixture.agent.name, revision: 1, timezone: 'Asia/Shanghai', due_review_enabled: true, textbook_consolidation_enabled: false, arithmetic_warmup_enabled: false, arithmetic_minutes: 2 })
    }
    if (path === '/api/k12/weekly-practice/plans/history') return response({ items: [], next_cursor: null })
    if (path === '/api/k12/weekly-practice/plans' && method === 'POST') return response({ plan: null, replayed: false }, 201)
    if (path === '/api/k12/insight-report') {
      return response({ grade_term: '五年级下', trend: { total: 11, mastered: 5, reviewing: 6, retried: 7, archived: 0 }, weak_top3: [], month_new_mistakes: 11, review_completion_rate: 0.72, consecutive_fail_kps: [], week_pending: 6, practice_pending: 2, suggestion: '' })
    }
    if (path === '/api/k12/accumulation' || path === '/api/k12/accumulations') return response({ items: [] })
    if (path === '/api/k12/practice-sets') return response({ items: [] })
    if (path === '/api/v1/webhooks') return response({ webhooks: [], k12_bindings: [], receipts: [], total: 0 })
    if (path.startsWith('/api/k12/')) return response({ items: [] })
    if (path.startsWith('/api/v1/')) return response({ items: [], total: 0 })
    return response({})
  }

  if (side === 'current') {
    const nativeFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.origin === options.fixtureOrigin && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
        const request = input instanceof Request ? input : new Request(url, init)
        return apiResponse(request.method.toUpperCase(), url.pathname + url.search)
      }
      if (url.origin === location.origin || url.origin === options.fixtureOrigin) return nativeFetch(input, init)
      telemetry.blockedExternalRequests.push(url.href)
      return response({ error: 'External request blocked by native visual gate' }, 451)
    }
    class FixtureWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      CONNECTING = 0
      OPEN = 1
      CLOSING = 2
      CLOSED = 3
      binaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = 0
      onclose = null
      onerror = null
      onmessage = null
      onopen = null
      constructor(url) {
        super()
        this.url = String(url)
        queueMicrotask(() => {
          this.readyState = FixtureWebSocket.OPEN
          const event = new Event('open')
          if (this.onopen) this.onopen.call(this, event)
          this.dispatchEvent(event)
        })
      }
      close() {
        this.readyState = FixtureWebSocket.CLOSED
      }
      send() {}
    }
    globalThis.WebSocket = FixtureWebSocket
    if (!localStorage.getItem('__hexclaw_records_native_initialized__')) {
      localStorage.setItem('__hexclaw_records_native_initialized__', '1')
      localStorage.setItem('hc-theme', 'light')
      localStorage.setItem('hc-locale', 'zh-CN')
      localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'k12', introSeen: true }))
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', fixture.session.id)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [fixture.session.id]: fixture.agent.name }))
    }
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    if (location.pathname === '/' || /\/index\.html$/.test(location.pathname)) {
      history.replaceState({}, '', '/chat?role=' + encodeURIComponent(fixture.agent.name) + '&roleTitle=' + encodeURIComponent(fixture.agent.display_name))
    }
  }

  const setWindowSize = async () => {
    const invoke = await waitFor(
      () => typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function' && globalThis.__TAURI_INTERNALS__.invoke.bind(globalThis.__TAURI_INTERNALS__),
      'Tauri invoke bridge',
    )
    await invoke('plugin:window|set_size', {
      label: 'main',
      value: { Logical: { width: state.width, height: state.height } },
    })
    await waitFor(
      () => innerWidth === state.width && innerHeight === state.height,
      'exact logical viewport ' + state.width + 'x' + state.height,
    )
  }
  const openSurface = async () => {
    if (side === 'reference') {
      await waitFor(
        () => typeof globalThis.goRecords === 'function' && typeof globalThis.k12BookTab === 'function',
        'prototype records APIs',
      )
      globalThis.goRecords('ming', state.tab)
      globalThis.k12BookTab(state.tab)
      await waitFor(() => document.querySelector('#k12ViewRecords')?.offsetParent, 'prototype records surface')
      const readySelector = state.tab === 4 ? '#k12CreativeWorkList .creative-work-card' : '#k12MistakeList .resource-row'
      await waitFor(() => document.querySelectorAll(readySelector).length === state.readyCount, 'prototype fixture rows')
      return
    }
    await waitFor(() => document.querySelector('.k12enh-seg'), 'K12 route tabs')
    const recordsTab = await waitFor(
      () => Array.from(document.querySelectorAll('.k12enh-seg [role="tab"]')).find((node) => clean(node.textContent) === '学习档案'),
      'records route tab',
    )
    recordsTab.click()
    await waitFor(() => document.querySelector('.k12rec'), 'current records surface')
    const objectTab = await waitFor(() => document.querySelector('[data-testid="' + state.implementationTab + '"]'), state.implementationTab)
    objectTab.click()
    await waitFor(() => document.querySelectorAll(state.readySelector).length === state.readyCount, 'current fixture rows')
  }
  const freeze = async () => {
    const style = document.createElement('style')
    style.dataset.nativeRecordsFreeze = 'true'
    style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}html{scroll-behavior:auto!important}'
    document.head.append(style)
    await document.fonts.ready
    window.scrollTo(0, 0)
    const content = document.querySelector(side === 'reference' ? '#k12ViewRecords > .content' : '.k12rec__body')
    if (content instanceof HTMLElement) {
      content.scrollLeft = 0
      content.scrollTop = 0
    }
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
  }
  const addPixelMasks = () => {
    document.querySelectorAll('[data-native-records-mask]').forEach((node) => node.remove())
    for (const selector of state.maskSelectors[side]) {
      for (const node of document.querySelectorAll(selector)) {
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const mask = document.createElement('div')
        mask.dataset.nativeRecordsMask = 'true'
        Object.assign(mask.style, {
          position: 'fixed',
          left: rect.x + 'px',
          top: rect.y + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
          background: '#ff00ff',
          borderRadius: getComputedStyle(node).borderRadius,
          zIndex: '2147483647',
          pointerEvents: 'none',
        })
        document.body.append(mask)
      }
    }
  }
  const canonicalColor = (() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    return (value) => {
      if (!context) return value
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const bytes = context.getImageData(0, 0, 1, 1).data
      return 'rgba(' + bytes[0] + ', ' + bytes[1] + ', ' + bytes[2] + ', ' + Number((bytes[3] / 255).toFixed(4)) + ')'
    }
  })()
  const captureTarget = (node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const containmentSelector = ['.resource-row', '.rl-row', '.creative-work-card', '.k12cw__card'].find((selector) => node.closest(selector))
    const container = containmentSelector ? node.closest(containmentSelector) : null
    const containerRect = container?.getBoundingClientRect() || null
    return {
      tag: node.tagName.toLowerCase(),
      text: clean(node.innerText).slice(0, 320),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0,
      attributes: {
        title: node.getAttribute('title'),
        disabled: node.hasAttribute('disabled'),
        ariaSelected: node.getAttribute('aria-selected'),
        ariaPressed: node.getAttribute('aria-pressed'),
        dataReviewState: node.getAttribute('data-review-state'),
      },
      rect: {
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
      metrics: {
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        textClipped: node.scrollWidth > node.clientWidth,
      },
      style: {
        display: style.display,
        position: style.position,
        top: style.top,
        right: style.right,
        bottom: style.bottom,
        left: style.left,
        boxSizing: style.boxSizing,
        backgroundColor: canonicalColor(style.backgroundColor),
        backgroundImage: style.backgroundImage,
        color: canonicalColor(style.color),
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        padding: style.padding,
        margin: style.margin,
        gap: style.gap,
        gridTemplateColumns: style.gridTemplateColumns,
        alignItems: style.alignItems,
        alignSelf: style.alignSelf,
        justifyContent: style.justifyContent,
        flex: style.flex,
        flexBasis: style.flexBasis,
        flexGrow: style.flexGrow,
        flexShrink: style.flexShrink,
        flexWrap: style.flexWrap,
        order: style.order,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        overflow: style.overflow,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
      },
      containment: {
        selector: containmentSelector || null,
        contained: containerRect
          ? rect.left >= containerRect.left - 1 && rect.right <= containerRect.right + 1 && rect.top >= containerRect.top - 1 && rect.bottom <= containerRect.bottom + 1
          : null,
        rect: containerRect
          ? { x: Number(containerRect.x.toFixed(2)), y: Number(containerRect.y.toFixed(2)), width: Number(containerRect.width.toFixed(2)), height: Number(containerRect.height.toFixed(2)) }
          : null,
      },
    }
  }
  const collect = () => {
    const targets = {}
    const requiredMissing = []
    for (const definition of state.targets[side]) {
      const nodes = Array.from(document.querySelectorAll(definition.selector))
      const selected = definition.all ? nodes : nodes.slice(0, 1)
      const matches = selected.map(captureTarget).filter((item) => item.visible)
      targets[definition.name] = {
        selector: definition.selector,
        ignoreText: definition.ignoreText === true,
        matches,
      }
      if (definition.required && matches.length === 0) requiredMissing.push(definition.name)
    }
    const root = document.documentElement
    const violations = requiredMissing.map((name) => 'required target missing: ' + name)
    if (innerWidth !== state.width || innerHeight !== state.height) {
      violations.push('viewport mismatch: ' + innerWidth + 'x' + innerHeight)
    }
    if (root.scrollWidth > root.clientWidth) {
      violations.push('document horizontal overflow: ' + root.scrollWidth + '>' + root.clientWidth)
    }
    if (state.id.startsWith('mistakes-')) {
      for (const name of ['content-container', 'mistake-rows', 'mistake-actions']) {
        for (const [index, match] of (targets[name]?.matches || []).entries()) {
          if (match.metrics.scrollWidth > match.metrics.clientWidth) {
            violations.push(name + '[' + index + '] horizontal overflow')
          }
        }
      }
      for (const [index, action] of (targets['mistake-actions']?.matches || []).entries()) {
        if (action.containment.contained !== true) violations.push('mistake-actions[' + index + '] escapes row')
        if (action.style.whiteSpace !== 'nowrap') violations.push('mistake-actions[' + index + '] text wraps')
      }
    } else {
      const one = (name) => targets[name]?.matches?.[0]
      const toolbar = one('object-toolbar')
      const description = one('description')
      const kpis = one('kpis')
      if (toolbar && (Math.abs(toolbar.rect.height - 42) > 0.01 || toolbar.style.padding !== '0px 14px' || toolbar.style.borderBottomWidth !== '1px')) {
        violations.push('object toolbar contract mismatch')
      }
      if (description && (description.style.whiteSpace !== 'nowrap' || description.style.overflowX !== 'hidden' || description.style.textOverflow !== 'ellipsis' || description.style.flex !== '0 1 auto')) {
        violations.push('works description single-line contract mismatch')
      }
      if (kpis && (kpis.style.flex !== '0 1 auto' || kpis.style.flexWrap !== 'wrap')) {
        violations.push('works KPI flex contract mismatch')
      }
      for (const [index, head] of (targets['card-top']?.matches || []).entries()) {
        if (head.style.whiteSpace !== 'nowrap') violations.push('card-top[' + index + '] wraps')
      }
      for (const [index, action] of (targets['card-action']?.matches || []).entries()) {
        if (action.style.alignSelf !== 'center') violations.push('card-action[' + index + '] is not centered')
      }
    }
    if (telemetry.modelInvocations !== 0) violations.push('model invocation observed')
    if (telemetry.imInvocations !== 0) violations.push('IM invocation observed')
    if (telemetry.blockedExternalRequests.length !== 0) violations.push('external request observed')
    return {
      side,
      state: state.id,
      phase,
      environment: {
        runtime: 'Tauri Test.app WKWebView',
        isTauri: globalThis.isTauri === true,
        hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        locale: navigator.language,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      },
      targets,
      requiredMissing,
      document: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
      telemetry,
      violations,
    }
  }

  try {
    if (document.readyState === 'loading') {
      await new Promise((resolveReady) => addEventListener('DOMContentLoaded', resolveReady, { once: true }))
    }
    await post({ stage: 'driver-dom-ready', side, state: state.id, phase })
    await post({ stage: 'driver-resize-start', side, state: state.id, phase })
    await setWindowSize()
    await post({ stage: 'driver-resize-ready', side, state: state.id, phase })
    await post({ stage: 'driver-surface-start', side, state: state.id, phase })
    await openSurface()
    await post({ stage: 'driver-surface-ready', side, state: state.id, phase })
    await freeze()
    addPixelMasks()
    const snapshot = collect()
    localStorage.setItem(options.phaseKey, String(phase + 1))
    await post({ stage: side + '-ready', snapshot })
  } catch (error) {
    reportError(error)
  }
}

function renderDriver(side, fixtureOrigin) {
  return `;(${nativeRecordsVisualDriver.toString()})(${JSON.stringify({
    side,
    fixtureOrigin,
    phaseKey,
    states,
    fixture: fixtureData(),
  })})`
}

function prepareFrontend(sandbox, fixtureOrigin) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'Current dist/index.html is missing')
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })
  cpSync(prototypeRoot, join(frontend, 'prototype'), { recursive: true })

  const currentDriver = renderDriver('current', fixtureOrigin)
  const referenceDriver = renderDriver('reference', fixtureOrigin)
  const redirectDriver = `;(${redirectReferenceBootstrap.toString()})(${JSON.stringify({
    phaseKey,
    stateCount: states.length,
    fixtureOrigin,
  })})`
  for (const source of [currentDriver, referenceDriver, redirectDriver]) {
    assert.doesNotMatch(source, /<\/script/i)
    assert.doesNotThrow(() => new Function(source), 'Generated WebView fixture must parse')
  }

  const indexPath = join(frontend, 'index.html')
  let index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  const moduleEntry = index.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/)
  assert.ok(moduleEntry, 'Current dist module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const platformMatches = moduleSource.match(platformProbe) || []
  assert.equal(platformMatches.length, 1, 'Current dist must contain one platform probe')
  assert.ok(moduleSource.includes('http://localhost:16060'), 'Current dist API base is missing')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  index = index.replace(
    '<head>',
    `<head>\n<script>${redirectDriver}</script>\n<script>${currentDriver}</script>`,
  )
  writeFileSync(indexPath, index, { mode: 0o600 })

  const referencePath = join(frontend, 'prototype/app.html')
  const reference = readFileSync(referencePath, 'utf8')
  assert.match(reference, /<head>/)
  writeFileSync(
    referencePath,
    reference.replace('<head>', `<head>\n<script>${referenceDriver}</script>`),
    { mode: 0o600 },
  )
  return {
    frontend,
    currentDriverSHA256: createHash('sha256').update(currentDriver).digest('hex'),
    referenceDriverSHA256: createHash('sha256').update(referenceDriver).digest('hex'),
    prototypeSHA256: sha256File(prototypePath),
  }
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.records-native.conf.json')
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `media-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const overlay = {
    productName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(srcTauriDir, frontend), beforeBuildCommand: '' },
    app: {
      windows: [
        {
          label: 'main',
          title: productName,
          width: 1226,
          height: 820,
          minWidth: 900,
          minHeight: 600,
          center: true,
          visible: true,
        },
      ],
      security: { csp },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: {
      updater: {
        endpoints: [`${fixtureOrigin}/updater`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  }
  writeJSON(overlayPath, overlay)
  return overlayPath
}

function listenerPIDs(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

async function waitForHealth(port, processHandle) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('Test.app exited before Sidecar health')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return
    } catch {
      // Sidecar 仍在启动。
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

async function waitForReport(fixtureState, side, stateID, fromIndex, timeout = 75_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const reports = fixtureState.reports.slice(fromIndex)
    const error = reports.find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    const report = reports.find(
      (entry) => entry.stage === `${side}-ready` && entry.snapshot?.state === stateID,
    )
    if (report) return report.snapshot
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${side} ${stateID} report`)
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, appBundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    if (!command.includes(`${appBundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`Dedicated port ${port} has unexpected owner ${pid}: ${command}`)
    }
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [], `Sidecar remains on dedicated port ${port}`)
  return stopped
}

function windowInfoForPID(pid) {
  const swift = `
import Foundation
import CoreGraphics
let target: Int32 = ${Number(pid)}
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
for row in rows {
  let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
  let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
  let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
  if owner == target && layer == 0 && alpha > 0,
     let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue,
     let bounds = row[kCGWindowBounds as String] as? [String: Any],
     let x = (bounds["X"] as? NSNumber)?.doubleValue,
     let y = (bounds["Y"] as? NSNumber)?.doubleValue,
     let width = (bounds["Width"] as? NSNumber)?.doubleValue,
     let height = (bounds["Height"] as? NSNumber)?.doubleValue {
    print("\\(id)|\\(x)|\\(y)|\\(width)|\\(height)")
    break
  }
}
`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output, `No visible native window found for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  assert.ok([id, x, y, width, height].every(Number.isFinite), `Invalid window info: ${output}`)
  return { id, x, y, width, height }
}

function imageDimensions(path) {
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
    encoding: 'utf8',
  })
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
  assert.ok(Number.isFinite(width) && Number.isFinite(height), `Invalid image dimensions: ${output}`)
  return { width, height }
}

function captureWindow(pid, destination, report) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `Native screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `Native screenshot is empty: ${destination}`)
  const pixels = imageDimensions(destination)
  const expected = {
    width: Math.round(report.environment.viewport.width * report.environment.devicePixelRatio),
    height: Math.round(report.environment.viewport.height * report.environment.devicePixelRatio),
  }
  assert.deepEqual(pixels, expected, 'Native screenshot must equal WKWebView pixel viewport')
  return { ...window, pixels, bytes: statSync(destination).size }
}

function targetBounds(snapshot, names) {
  const matches = names.flatMap((name) => snapshot.targets[name]?.matches ?? [])
  assert.ok(matches.length > 0, `No target bounds for ${snapshot.state}`)
  const left = Math.min(...matches.map((match) => match.rect.x))
  const top = Math.min(...matches.map((match) => match.rect.y))
  const right = Math.max(...matches.map((match) => match.rect.x + match.rect.width))
  const bottom = Math.max(...matches.map((match) => match.rect.y + match.rect.height))
  const x = Math.max(0, Math.floor(left) - 4)
  const y = Math.max(0, Math.floor(top) - 4)
  return { x, y, width: Math.ceil(right) - x + 4, height: Math.ceil(bottom) - y + 4 }
}

function cropNativeTarget(source, destination, snapshot, bounds, width, height) {
  const dpr = snapshot.environment.devicePixelRatio
  const cropWidth = Math.round(width * dpr)
  const cropHeight = Math.round(height * dpr)
  const cropX = Math.round(bounds.x * dpr)
  const cropY = Math.round(bounds.y * dpr)
  execFileSync(
    'sips',
    [
      '-c',
      String(cropHeight),
      String(cropWidth),
      '--cropOffset',
      String(cropY),
      String(cropX),
      source,
      '--out',
      destination,
    ],
    { stdio: 'pipe' },
  )
  assert.deepEqual(imageDimensions(destination), { width: cropWidth, height: cropHeight })
  return { x: cropX, y: cropY, width: cropWidth, height: cropHeight, dpr }
}

function pixelDiff(reference, current, output) {
  const stdout = execFileSync(
    'xcrun',
    ['swift', pixelDiffTool, reference, current, output, String(pixelThreshold)],
    { encoding: 'utf8' },
  )
  return JSON.parse(stdout.trim())
}

function compareTargets(reference, current, names) {
  const differences = []
  const add = (targetName, index, field, referenceValue, currentValue, delta) => {
    differences.push({
      target: targetName,
      index,
      field,
      reference: referenceValue,
      current: currentValue,
      ...(delta === undefined ? {} : { delta: Number(delta.toFixed(2)) }),
    })
  }
  for (const name of names) {
    const referenceTarget = reference.targets[name]
    const currentTarget = current.targets[name]
    const referenceMatches = referenceTarget?.matches ?? []
    const currentMatches = currentTarget?.matches ?? []
    if (referenceMatches.length !== currentMatches.length) {
      add(name, null, 'count', referenceMatches.length, currentMatches.length)
    }
    const count = Math.min(referenceMatches.length, currentMatches.length)
    for (let index = 0; index < count; index += 1) {
      const referenceMatch = referenceMatches[index]
      const currentMatch = currentMatches[index]
      for (const attribute of ['title', 'disabled', 'ariaSelected', 'ariaPressed', 'dataReviewState']) {
        if (referenceMatch.attributes[attribute] !== currentMatch.attributes[attribute]) {
          add(name, index, `attributes.${attribute}`, referenceMatch.attributes[attribute], currentMatch.attributes[attribute])
        }
      }
      for (const field of ['x', 'y', 'width', 'height']) {
        const delta = Math.abs(referenceMatch.rect[field] - currentMatch.rect[field])
        if (delta > geometryTolerance) {
          add(name, index, `rect.${field}`, referenceMatch.rect[field], currentMatch.rect[field], delta)
        }
      }
      if (referenceMatch.metrics.textClipped !== currentMatch.metrics.textClipped) {
        add(name, index, 'metrics.textClipped', referenceMatch.metrics.textClipped, currentMatch.metrics.textClipped)
      }
      for (const styleKey of new Set([
        ...Object.keys(referenceMatch.style),
        ...Object.keys(currentMatch.style),
      ])) {
        const inertButtonJustification =
          name === 'mistake-actions' &&
          styleKey === 'justifyContent' &&
          referenceMatch.tag === 'button' &&
          currentMatch.tag === 'button' &&
          [referenceMatch.style[styleKey], currentMatch.style[styleKey]].every((value) =>
            ['normal', 'center'].includes(value),
          )
        if (inertButtonJustification) continue
        if (referenceMatch.style[styleKey] !== currentMatch.style[styleKey]) {
          add(name, index, `style.${styleKey}`, referenceMatch.style[styleKey], currentMatch.style[styleKey])
        }
      }
    }
  }
  return { geometryTolerance, comparedTargets: names, equal: differences.length === 0, differences }
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(docsRoot, '<docs>').replaceAll(sandbox, '<sandbox>')
}

async function main() {
  if (process.env.HEXCLAW_NATIVE_RECORDS_STATIC_CHECK === '1') {
    assert.deepEqual(
      states.map((state) => [state.id, state.width]),
      [
        ['works-1226', 1226],
        ['mistakes-1226', 1226],
        ['mistakes-1024', 1024],
      ],
    )
    assert.equal(new Set(states.map((state) => state.id)).size, states.length)
    assert.match(bundleIdentifier, /^com\.hexclaw\.desktop\.k12-records-/)
    assert.doesNotThrow(() => new Function(renderDriver('reference', 'http://127.0.0.1:1')))
    assert.doesNotThrow(() => new Function(renderDriver('current', 'http://127.0.0.1:1')))
    process.stdout.write('Native records visual diagnostic script static contract PASS.\n')
    return
  }
  if (process.env.HEXCLAW_RUN_NATIVE_RECORDS_VISUAL !== '1') {
    process.stdout.write(
      'Prepared only. Set HEXCLAW_RUN_NATIVE_RECORDS_VISUAL=1 to build and run the isolated Test.app gate.\n',
    )
    return
  }
  assert.equal(process.platform, 'darwin', 'Installed boundary is macOS-only')
  assert.ok(existsSync(prototypePath), 'Authoritative prototype is missing')
  assert.ok(existsSync(pixelDiffTool), 'Swift pixel diff tool is missing')
  mkdirSync(evidenceRoot, { recursive: true })
  const runDir = join(evidenceRoot, `run-${runNonce}`)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-records-native.'))
  chmodSync(sandbox, 0o700)
  const testHome = join(sandbox, 'home')
  const testConfigDir = join(testHome, '.hexclaw')
  const tempDir = join(sandbox, 'tmp')
  const cargoTarget = process.env.HEXCLAW_NATIVE_RECORDS_CARGO_TARGET
    ? resolve(process.env.HEXCLAW_NATIVE_RECORDS_CARGO_TARGET)
    : join(sandbox, 'cargo-target')
  mkdirSync(testHome, { recursive: true, mode: 0o700 })
  mkdirSync(testConfigDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createLoopbackFixture(fixturePort)
  const generations = []
  const captures = new Map()
  const logs = []
  let appProcess = null
  let appLog = null
  let finalStatus = 'NOT_PASS'
  let finalError = null
  let stoppedSidecars = []

  try {
    await fixture.listen()
    const configPath = join(testConfigDir, 'hexclaw.yaml')
    writeFileSync(configPath, renderConfig(testHome, sidecarPort, fixture.origin), { mode: 0o600 })
    chmodSync(configPath, 0o600)
    const offlineEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete offlineEnv.GOROOT
    await runCommand('pnpm', ['build-only'], { env: offlineEnv })
    const frontend = prepareFrontend(sandbox, fixture.origin)
    const overlay = writeOverlay(sandbox, frontend.frontend, sidecarPort, fixture.origin)
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: offlineEnv,
    })
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), `Unique Test.app missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `Unique Test.app executable missing: ${executable}`)
    assert.ok(existsSync(sidecarExecutable), `Unique Test.app Sidecar missing: ${sidecarExecutable}`)
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    const candidate = installedCandidateReceipt()
    assert.ok(candidate, 'Installed candidate receipt is missing')
    assert.equal(
      sha256File(sidecarExecutable),
      candidate.sidecarSHA256,
      'Isolated Test.app must bundle the installed candidate Sidecar',
    )
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(testHome).mode & 0o777, 0o700)
    assert.equal(statSync(testConfigDir).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.deepEqual(listenerPIDs(sidecarPort), [], 'Dedicated Sidecar port is occupied')

    const runtimeEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      HOME: testHome,
      USERPROFILE: testHome,
      CFFIXED_USER_HOME: testHome,
      TMPDIR: tempDir,
      TEMP: tempDir,
      TMP: tempDir,
      HEXCLAW_TEST_MODE: '1',
      HEXCLAW_TEST_HOME: testHome,
      HEXCLAW_SIDECAR_PORT: String(sidecarPort),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }

    const launchAndCapture = async (side, state) => {
      const generation = generations.length + 1
      const stateDir = join(runDir, state.id)
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const logPath = join(sandbox, `app-${generation}.log`)
      appLog = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
      logs.push({ generation, logPath })
      const reportStart = fixture.state.reports.length
      appProcess = spawn(executable, ['-AppleLanguages', '(zh-Hans)', '-AppleLocale', 'zh_CN'], {
        cwd: testHome,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      appProcess.stdout.pipe(appLog, { end: false })
      appProcess.stderr.pipe(appLog, { end: false })
      await waitForHealth(sidecarPort, appProcess)
      const sidecarPIDs = listenerPIDs(sidecarPort)
      assert.equal(sidecarPIDs.length, 1, 'Unique Test.app must own one Sidecar listener')
      let report
      try {
        report = await waitForReport(fixture.state, side, state.id, reportStart)
      } catch (error) {
        try {
          const failedWindow = windowInfoForPID(appProcess.pid)
          const failedPath = join(stateDir, `${side}-failed-native-window.png`)
          execFileSync('/usr/sbin/screencapture', [
            '-x',
            '-o',
            '-l',
            String(failedWindow.id),
            failedPath,
          ])
        } catch {}
        throw error
      }
      assert.equal(report.environment.isTauri, true)
      assert.equal(report.environment.hasTauriInternals, true)
      assert.equal(report.environment.viewport.width, state.width)
      assert.equal(report.environment.viewport.height, state.height)
      const fullPath = join(stateDir, `${side}-native-window.png`)
      const nativeWindow = captureWindow(appProcess.pid, fullPath, report)
      generations.push({
        generation,
        side,
        state: state.id,
        appPID: appProcess.pid,
        sidecarPID: sidecarPIDs[0],
        viewport: report.environment.viewport,
        devicePixelRatio: report.environment.devicePixelRatio,
      })
      captures.set(`${side}:${state.id}`, { report, fullPath, nativeWindow })
      await stopProcess(appProcess)
      await new Promise((resolveEnd) => appLog.end(resolveEnd))
      appLog = null
      stoppedSidecars.push(...(await stopOwnedSidecar(sidecarPort, appBundle)))
    }

    for (const state of states) await launchAndCapture('reference', state)
    for (const state of states) await launchAndCapture('current', state)

    const stateReports = []
    for (const state of states) {
      const reference = captures.get(`reference:${state.id}`)
      const current = captures.get(`current:${state.id}`)
      assert.ok(reference && current, `Missing native capture pair for ${state.id}`)
      assert.equal(reference.report.environment.devicePixelRatio, current.report.environment.devicePixelRatio)
      const referenceBounds = targetBounds(reference.report, state.comparisonTargets)
      const currentBounds = targetBounds(current.report, state.comparisonTargets)
      const visibleWidth = Math.min(
        state.width - referenceBounds.x,
        state.width - currentBounds.x,
      )
      const visibleHeight = Math.min(
        state.height - referenceBounds.y,
        state.height - currentBounds.y,
      )
      const cropWidth = Math.min(
        Math.max(referenceBounds.width, currentBounds.width),
        visibleWidth,
      )
      const cropHeight = Math.min(
        Math.max(referenceBounds.height, currentBounds.height),
        visibleHeight,
      )
      assert.ok(cropWidth > 0 && cropHeight > 0, `Invalid target crop for ${state.id}`)
      const stateDir = join(runDir, state.id)
      const referencePath = join(stateDir, 'reference.png')
      const currentPath = join(stateDir, 'current.png')
      const diffPath = join(stateDir, 'pixel-diff.png')
      const referenceCrop = cropNativeTarget(
        reference.fullPath,
        referencePath,
        reference.report,
        referenceBounds,
        cropWidth,
        cropHeight,
      )
      const currentCrop = cropNativeTarget(
        current.fullPath,
        currentPath,
        current.report,
        currentBounds,
        cropWidth,
        cropHeight,
      )
      const pixels = pixelDiff(referencePath, currentPath, diffPath)
      const targetComparison = compareTargets(reference.report, current.report, state.comparisonTargets)
      const violations = [
        ...reference.report.violations.map((value) => `reference: ${value}`),
        ...current.report.violations.map((value) => `current: ${value}`),
        ...targetComparison.differences.map(
          (value) =>
            `target ${value.target}[${value.index ?? '-'}] ${value.field}: ${JSON.stringify(value.reference)} != ${JSON.stringify(value.current)}`,
        ),
      ]
      if (pixels.changed_pixel_ratio > maxChangedPixelRatio) {
        violations.push(
          `target pixels changed ${pixels.changed_pixels}/${pixels.total_pixels} (${pixels.changed_pixel_ratio})`,
        )
      }
      const status = violations.length === 0 ? 'PASS' : 'RED'
      const report = {
        schemaVersion: 1,
        status,
        evidenceClass: 'DIAGNOSTIC_ONLY',
        acceptance: state.id.startsWith('works-')
          ? 'WORKS-DESC-SINGLE-LINE-001'
          : 'MISTAKES-ROW-ACTIONS-VISIBLE-001',
        state: state.id,
        viewport: { width: state.width, height: state.height },
        nativeBoundary: 'same isolated Test.app / real WKWebView / native CGWindow capture',
        businessContentPolicy: 'same deterministic fixture; target text excluded from semantic diff',
        targetComparison,
        pixelDiff: { ...pixels, threshold: pixelThreshold, maximumChangedPixelRatio: maxChangedPixelRatio },
        crops: { reference: referenceCrop, current: currentCrop },
        violations,
        evidence: {
          reference: 'reference.png',
          current: 'current.png',
          pixelDiff: 'pixel-diff.png',
          referenceNativeWindow: 'reference-native-window.png',
          currentNativeWindow: 'current-native-window.png',
          bboxComputedStyle: 'bbox-computed-style.json',
        },
      }
      writeJSON(join(stateDir, 'bbox-computed-style.json'), {
        reference: reference.report,
        current: current.report,
        comparison: targetComparison,
      })
      writeJSON(join(stateDir, 'diff-report.json'), report)
      stateReports.push(report)
    }

    assert.equal(fixture.state.modelInvocations, 0)
    assert.equal(fixture.state.imInvocations, 0)
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    const currentReports = states.map((state) => captures.get(`current:${state.id}`).report)
    assert.ok(currentReports.every((report) => report.telemetry.modelInvocations === 0))
    assert.ok(currentReports.every((report) => report.telemetry.imInvocations === 0))
    assert.ok(currentReports.every((report) => report.telemetry.blockedExternalRequests.length === 0))
    const rawLogs = logs.map(({ logPath }) => readFileSync(logPath, 'utf8')).join('\n')
    assert.doesNotMatch(rawLogs, /localhost:11434/, 'Isolated Test.app must not probe user Ollama')
    assert.ok(stateReports.every((report) => report.status === 'PASS'))

    const summary = {
      schemaVersion: 1,
      status: 'DIAGNOSTIC_ONLY',
      finalInstalledGateSatisfied: false,
      scope: ['WORKS-DESC-SINGLE-LINE-001', 'MISTAKES-ROW-ACTIONS-VISIBLE-001'],
      app: {
        productName,
        identifier,
        executableSHA256: sha256File(executable),
        sidecarSHA256: sha256File(sidecarExecutable),
        realWKWebView: true,
        nativeWindowCapture: true,
      },
      installedCandidate: {
        ...candidate,
        applicationsDirectoryTouched: false,
        desktopExecutableComparison:
          'The isolated Test.app uses a unique product name and Bundle ID; its Desktop executable hash is recorded separately.',
      },
      source: frontend,
      isolation: {
        testHomeMode: '0700',
        configMode: '0600',
        uniqueBundleIdentifier: true,
        sidecarPort,
        fixturePort,
        applicationsDirectoryTouched: false,
        userHomeRead: false,
        externalNetworkRequests: 0,
        realModelInvocations: 0,
        realIMInvocations: 0,
      },
      states: stateReports.map((report) => ({
        state: report.state,
        status: report.status,
        viewport: report.viewport,
        changedPixelRatio: report.pixelDiff.changed_pixel_ratio,
        differences: report.targetComparison.differences.length,
      })),
      generations,
      fixtureReceipts: fixture.state,
    }
    writeJSON(join(runDir, 'summary.json'), summary)
    finalStatus = 'DIAGNOSTIC_ONLY'
    process.stdout.write(
      `\nRecords Test.app visual diagnostic complete (not installed PASS): ${relative(repoRoot, runDir)}\n`,
    )
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    writeJSON(join(runDir, 'summary.json'), {
      schemaVersion: 1,
      status: 'NOT_PASS',
      error: finalError,
      scope: ['WORKS-DESC-SINGLE-LINE-001', 'MISTAKES-ROW-ACTIONS-VISIBLE-001'],
      generations,
      fixtureReceipts: fixture.state,
    })
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    try {
      stoppedSidecars.push(...(await stopOwnedSidecar(sidecarPort, appBundle)))
    } catch (error) {
      if (!finalError) finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    await fixture.close()
    const logDir = join(runDir, 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    for (const { generation, logPath } of logs) {
      if (existsSync(logPath)) {
        writeFileSync(
          join(logDir, `app-${generation}.log`),
          sanitizeLog(readFileSync(logPath, 'utf8'), sandbox),
          { mode: 0o600 },
        )
      }
    }
    const appBundleExisted = existsSync(appBundle)
    if (process.env.HEXCLAW_NATIVE_RECORDS_CARGO_TARGET) {
      rmSync(appBundle, { recursive: true, force: true })
    }
    rmSync(sandbox, { recursive: true, force: true })
    writeJSON(join(runDir, 'cleanup.json'), {
      status: finalStatus,
      error: finalError,
      appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
      sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
      fixturePortReleased: listenerPIDs(fixturePort).length === 0,
      uniqueAppBundleExisted: appBundleExisted,
      uniqueAppBundleRemoved: !existsSync(appBundle),
      sandboxRemoved: !existsSync(sandbox),
      stoppedSidecars,
    })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
