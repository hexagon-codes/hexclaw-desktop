#!/usr/bin/env node

/**
 * BUG-20260801-007/008/009/010 的隔离原生第三腿。
 *
 * 仅把当前生产 dist 复制到临时目录并注入测试传输；生产源码、权威原型和用户数据不变。
 * Test.app 使用唯一 Bundle ID、0700 Test Home、专用 loopback 端口和真实 Tauri WKWebView。
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
  readdirSync,
  readFileSync,
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
const srcTauriDir = join(repoRoot, 'src-tauri')
const evidenceRoot = join(docsRoot, 'test/evidence/bug-20260801-007-008-009-010-current-source')
const productName = 'HexClaw K12 007-010 Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260801-007-008-009-010'
const commandTimeoutMs = 15 * 60 * 1000

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[k12-installed] ${command} ${args.join(' ')}\n`)
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
    if (length > 2 * 1024 * 1024) throw new Error('fixture body exceeds 2 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function createLoopbackFixture(port) {
  const state = {
    reports: [],
    modelListRequests: 0,
    chatRequests: 0,
    updaterRequests: 0,
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
      if (request.method === 'POST' && url.pathname === '/__k12_bug_boundary__/report') {
        const report = await readJSONBody(request)
        state.reports.push(report)
        jsonResponse(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        state.modelListRequests += 1
        jsonResponse(response, 200, {
          object: 'list',
          data: [{ id: 'fixture-model', object: 'model', created: 0, owned_by: 'loopback' }],
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        state.chatRequests += 1
        jsonResponse(response, 503, {
          error: { message: 'model calls are forbidden in this gate' },
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      jsonResponse(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      jsonResponse(response, 500, { error: 'fixture failure' })
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

function renderConfig(sandbox, sidecarPort, fixtureOrigin) {
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
      model_specs_mode: explicit
      model_specs:
        - id: fixture-model
          display_name: Isolated Fixture Model
          capabilities:
            - text
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
    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}
knowledge:
  enabled: false
  embedding:
    disable_auto_install: true
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
skill:
  sandbox:
    enabled: false
  builtin:
    search: false
    weather: false
    browser: false
    code_exec: false
    file_ops: false
observe:
  log_level: info
  metrics:
    enabled: false
`
}

function fixtureData() {
  const now = new Date()
  const todayAt = (hour, minute) => {
    const value = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0)
    return value.toISOString()
  }
  const localDate = (month, day, hour = 12) =>
    new Date(now.getFullYear(), month - 1, day, hour, 0, 0).toISOString()
  const sessions = [
    ['session-k12', 'mingming', 'mingming', localDate(7, 29), 6],
    ['session-hong', 'xiaohong', 'xiaohong', localDate(6, 15), 2],
    ['decimal', '小数乘法讲解', '', todayAt(14, 32), 2],
    ['orphan', '已删除的智能体', '', todayAt(9, 18), 28],
    ['research', '高级研究分析师', '', localDate(6, 16), 4],
    ['baidu', '百度热搜采集问题', '', localDate(6, 16), 2],
    ['summary-1', '总结以下三条科技要点，并把…', '', localDate(6, 13), 2],
    ['browser-1', '用 browser 工具访问 http://to…', '', localDate(6, 12, 15), 2],
    ['browser-2', '用 browser 工具访问 http://to…', '', localDate(6, 12, 14), 2],
    ['browser-3', '用 browser 工具访问 http://to…', '', localDate(6, 12, 13), 1],
    ['baidu-page', '访问百度热搜榜页面 https://to…', '', localDate(6, 12, 12), 2],
    ['summary-2', '总结以下三条科技要点，并把…', '', localDate(6, 12, 11), 2],
  ].map(([id, title, agent_id, updated_at, message_count]) => ({
    id,
    title,
    ...(agent_id ? { agent_id } : {}),
    created_at: updated_at,
    updated_at,
    message_count,
  }))
  const mistakes = [
    [
      'm-apple',
      '苹果和梨的价钱（P52·3）',
      '小数乘法',
      '连续错 2 次 · 计算失误',
      'scheduled',
      '数学',
    ],
    ['m-circuit', '小灯泡没有形成闭合回路', '简单电路', '实验图判断错误', 'scheduled', '科学'],
    [
      'm-loop',
      '重复执行积木少循环 1 次',
      '图形化编程',
      '运行结果已复核 · 到期可再练',
      'retried',
      '信息科技',
    ],
    ['m-eq', '解方程 2x + 15 = 43', '简易方程', '复练 1 次 · 仍需巩固', 'retried', '数学'],
    [
      'm-believe',
      'believe —— 拼成 belive（少 e）',
      '错词',
      '本轮已跳过 · 系统证据不足',
      'scheduled',
      '英语',
    ],
    ['m-poem', '「梅须逊雪三分白」漏「须」字', '默写', '上次生成任务未完成', 'scheduled', '语文'],
    ['m-position', '用数对表示位置', '位置', '两次独立复练正确', 'mastered', '数学'],
  ].map(([record_id, question, knowledge_point, error_cause, status, subject], index) => ({
    record_id,
    question,
    knowledge_point,
    error_cause,
    status,
    review_state: status,
    version: 1,
    subject,
    review_kind: ['英语', '语文'].includes(subject) ? 'verbatim' : 'verify',
    entry_source: [
      'photo',
      'photo',
      'verified',
      'verified',
      'writing_confirmed',
      'manual',
      'verified',
    ][index],
    created_at: Math.floor(
      new Date(
        now.getFullYear(),
        [6, 6, 6, 6, 6, 6, 5][index],
        [16, 15, 13, 12, 9, 8, 21][index],
        12,
      ).getTime() / 1000,
    ),
  }))
  const tutorSourceMessageID = 'k12-tutor-p52-message'
  const tutorDispatchID = 'op-k12-ming-homework-001'
  const tutorDispatch = {
    dispatch_id: tutorDispatchID,
    task_intent: 'completed_homework',
    status: 'awaiting_confirmation',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'fixture-model',
    retryable: false,
    automatic_budget_seconds: 300,
    automatic_started_at: 1785295800,
    automatic_deadline_at: 1785296100,
    automatic_remaining_seconds: 258,
    operation_deadline_at: 1785296400,
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-k12-tutor-p52' },
    target_projection: {
      kind: 'homework',
      stage: 'assessing',
      confirmation_state: 'pending',
      anchor_state: 'located',
      recognition: {
        subject: '数学',
        questions: [
          {
            problem_id: 'problem-1',
            problem_kind: 'standalone',
            source_number_path: ['一', '1'],
            display_label: '一、1',
            page_asset_id: 'asset://k12-tutor/p52.png',
            question: '4 ÷ 0.5 = 8',
            raw_transcription: '4 ÷ 0.5 = 8',
            canonical_markdown: '4 \\div 0.5 = 8',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['小数除法'],
            answer_state: 'present',
            student_answer: '8',
            answer_canonical_valid: true,
            confirmation_required: false,
            confirmed_version: 1,
          },
          {
            problem_id: 'problem-2',
            problem_kind: 'standalone',
            source_number_path: ['一', '2'],
            display_label: '一、2',
            page_asset_id: 'asset://k12-tutor/p52.png',
            question: '10 × 0.01 = 0.1',
            raw_transcription: '10 × 0.01 = 0.1',
            canonical_markdown: '10 \\times 0.01 = 0.1',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['小数乘法'],
            answer_state: 'present',
            student_answer: '0.1',
            answer_canonical_valid: true,
            confirmation_required: true,
            confirmation_reasons: ['decimal_point'],
            confirmed_version: 0,
          },
          {
            problem_id: 'problem-3-1',
            problem_kind: 'subproblem',
            parent_problem_id: 'problem-3',
            subproblem_no: '1',
            source_number_path: ['三', '1'],
            display_label: '三、1',
            page_asset_id: 'asset://k12-tutor/p52.png',
            question: '列出求梨总价的算式',
            raw_transcription: '列出求梨总价的算式',
            canonical_markdown: '列出求梨总价的算式',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['小数乘法'],
            answer_state: 'present',
            student_answer: '',
            answer_canonical_valid: true,
            confirmation_required: true,
            confirmation_reasons: ['evidence_conflict'],
            confirmed_version: 0,
          },
          {
            problem_id: 'problem-3-2',
            problem_kind: 'subproblem',
            parent_problem_id: 'problem-3',
            subproblem_no: '2',
            source_number_path: ['三', '2'],
            display_label: '三、2',
            page_asset_id: 'asset://k12-tutor/p52.png',
            question: '求梨每千克多少元',
            raw_transcription: '求梨每千克多少元',
            canonical_markdown: '求梨每千克多少元',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['简易方程'],
            answer_state: 'present',
            student_answer: '',
            answer_canonical_valid: true,
            confirmation_required: false,
            confirmed_version: 1,
          },
        ],
      },
      progressive: {
        structure_version: 1,
        snapshot_revision: 8,
        problem_progress: [
          {
            problem_id: 'problem-1',
            status: 'correct',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
          {
            problem_id: 'problem-2',
            status: 'processing',
            input_revision: 1,
            published_revision: 0,
            current_disposition: 'current',
          },
          {
            problem_id: 'problem-3-1',
            status: 'awaiting_source',
            input_revision: 1,
            published_revision: 0,
            current_disposition: 'current',
          },
          {
            problem_id: 'problem-3-2',
            status: 'awaiting_source',
            input_revision: 1,
            published_revision: 0,
            current_disposition: 'current',
          },
        ],
        coverage: {
          total: 4,
          published: 1,
          skipped: 0,
          awaiting: 3,
          failed: 0,
          status: 'in_progress',
          projection_revision: 8,
        },
      },
    },
    progress: { operation: 'homework', state: 'assessing' },
    version: 8,
    created_at: 1785295800,
    updated_at: 1785295842,
  }
  const practiceStates = {
    'm-apple': 'joined',
    'm-circuit': 'available',
    'm-loop': 're_add',
    'm-eq': 'available',
    'm-believe': 'available',
    'm-poem': 'failed',
    'm-position': 'hidden',
  }
  return {
    sessions,
    mistakes,
    tutorSourceMessageID,
    tutorDispatch,
    practiceStates,
    agents: [
      {
        name: 'mingming',
        display_name: '小明的辅导助手',
        description: '五年级辅导',
        provider: '',
        model: '',
        metadata: {
          scenario: 'k12-tutor',
          avatar: '🎓',
          'k12.child_name': '小明',
          'k12.grade_term': '五年级',
          'k12.textbook_edition': '人教版',
        },
      },
      {
        name: 'xiaohong',
        display_name: '小红的辅导助手',
        description: '三年级辅导',
        provider: '',
        model: '',
        metadata: {
          scenario: 'k12-tutor',
          avatar: '🎓',
          'k12.child_name': '小红',
          'k12.grade_term': '三年级',
          'k12.textbook_edition': '人教版',
        },
      },
    ],
    report: {
      grade_term: '五年级',
      trend: { mastered: 6, reviewing: 5, retried: 6, archived: 0, total: 11 },
      weak_top3: [
        { knowledge_point: '简易方程', count: 5, share: 5 / 9, subject: '数学' },
        { knowledge_point: '小数乘法', count: 3, share: 3 / 9, subject: '数学' },
        { knowledge_point: '多边形面积', count: 1, share: 1 / 9, subject: '数学' },
      ],
      month_new_mistakes: 9,
      review_completion_rate: 0.72,
      consecutive_fail_kps: ['简易方程'],
      week_pending: 6,
      practice_pending: 6,
      suggestion:
        '“等式两边同时变化”连续 3 次未通过。建议先做 2 道等式性质热身，再进入本周复习卷中的方程题。',
    },
  }
}

function renderWebViewFixture(fixtureOrigin) {
  const data = fixtureData()
  return `;(function runK12BugInstalledBoundary() {
  'use strict'
  const fixtureOrigin = ${JSON.stringify(fixtureOrigin)}
  const fixture = ${JSON.stringify(data)}
  const phaseKey = '__hexclaw_bug_20260801_007_010_phase__'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
  const post = async (payload) => {
    const response = await fetch(fixtureOrigin + '/__k12_bug_boundary__/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('fixture report failed: ' + response.status)
  }
  const reportFixtureError = (error) => {
    const message =
      error instanceof Error
        ? [error.name + ': ' + error.message, error.stack].filter(Boolean).join('\\n')
        : String(error)
    void post({ stage: 'fixture-error', message }).catch(() => {})
  }
  addEventListener('error', (event) => reportFixtureError(event.error || event.message))
  addEventListener('unhandledrejection', (event) => reportFixtureError(event.reason))
  void post({
    stage: 'bootstrap',
    isTauri: globalThis.isTauri === true,
    hasInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function',
  }).catch(() => {})
  const waitFor = async (read, label, timeout = 30000) => {
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
    throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError : ''))
  }
  const response = (value, status = 200) => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Array.from(new TextEncoder().encode(JSON.stringify(value))),
  })
  const apiResponse = (method, rawPath) => {
    const url = new URL(rawPath, 'http://sidecar.invalid')
    const path = url.pathname
    if (path === '/health') return response({ status: 'ok' })
    if (path === '/api/v1/config/llm') return response({ default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } })
    if (path === '/api/v1/config') return response({ server: { host: '127.0.0.1', mode: 'desktop' }, llm: { default: '', providers: {} } })
    if (path === '/api/v1/ollama/status') return response({ running: false, associated: false, models: [] })
    if (path === '/api/v1/agents') return response({ agents: fixture.agents, total: fixture.agents.length, default: 'mingming' })
    if (path === '/api/v1/sessions') return response({ sessions: fixture.sessions, total: fixture.sessions.length })
    if (path === '/api/v1/sessions/session-k12/messages') return response({ messages: [{ id: fixture.tutorSourceMessageID, role: 'user', content: '📷 数学练习册 P52\\n粘贴 / 手机拍照', timestamp: '2026-07-29T19:32:00+08:00', created_at: '2026-07-29T19:32:00+08:00' }], total: 1 })
    if (/^\\/api\\/v1\\/sessions\\/[^/]+\\/messages$/.test(path)) return response({ messages: [], total: 0 })
    if (path === '/api/v1/streams/active') return response({ streams: [], total: 0 })
    if (path === '/api/k12/view-descriptor') return response({ header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
    if (path === '/api/k12/image-tasks/recoverable') return response({ items: [{ dispatch_id: fixture.tutorDispatch.dispatch_id, source_session_id: 'session-k12', source_message_id: fixture.tutorSourceMessageID, attempt_generation: 1, version: fixture.tutorDispatch.version, stage: fixture.tutorDispatch.target_projection.stage, status: fixture.tutorDispatch.status, projection_ready: true, terminal: false }] })
    if (path === '/api/k12/image-tasks/' + fixture.tutorDispatch.dispatch_id && method === 'GET') return response({ dispatch: fixture.tutorDispatch })
    if (path === '/api/k12/insight-report') return response(fixture.report)
    if (path === '/api/k12/mistakes' || path === '/api/k12/review-queue') return response({ items: fixture.mistakes, total: fixture.mistakes.length })
    const practice = path.match(/^\\/api\\/k12\\/mistakes\\/([^/]+)\\/practice-generation$/)
    if (practice && method === 'GET') {
      const id = decodeURIComponent(practice[1])
      return response({ source_mistake_id: id, state: fixture.practiceStates[id] || 'available', failure_reason: id === 'm-poem' ? 'fixture failure' : undefined, practice_set_id: id === 'm-apple' ? 'set-1' : undefined, practice_item_id: id === 'm-apple' ? 'item-1' : undefined })
    }
    if (path === '/api/k12/curriculum-progress') return response({ progress: null })
    if (path === '/api/k12/weekly-practice/settings') return response({ agent: 'mingming', revision: 1, timezone: 'Asia/Shanghai', due_review_enabled: true, textbook_consolidation_enabled: false, arithmetic_warmup_enabled: false, arithmetic_minutes: 2 })
    if (path === '/api/k12/weekly-practice/plans/history') return response({ items: [], next_cursor: null })
    if (path === '/api/k12/weekly-practice/plans' && method === 'POST') return response({ plan: null, replayed: false }, 201)
    if (path.startsWith('/api/k12/')) return response({ items: [] })
    if (path.startsWith('/api/v1/')) return response({ items: [], total: 0 })
    return response({})
  }

  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin === fixtureOrigin && (url.pathname === '/health' || url.pathname.startsWith('/api/'))) {
      const request = input instanceof Request ? input : new Request(url, init)
      const result = apiResponse(request.method.toUpperCase(), url.pathname + url.search)
      return new Response(new Uint8Array(result.body), {
        status: result.status,
        headers: result.headers,
      })
    }
    return nativeFetch(input, init)
  }

  if (!localStorage.getItem('__hexclaw_bug_20260801_007_010_initialized__')) {
    localStorage.setItem('__hexclaw_bug_20260801_007_010_initialized__', '1')
    localStorage.setItem(phaseKey, '0')
    localStorage.setItem('hc-theme', 'light')
    localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'k12', introSeen: true }))
    localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.setItem('hexclaw_lastSessionId', 'session-k12')
    localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12': 'mingming', 'session-hong': 'xiaohong' }))
  }
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')

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

  const findTab = (name) => Array.from(document.querySelectorAll('.k12enh-seg [role="tab"]')).find((node) => clean(node.textContent) === name)
  const measure = (selector) => {
    const node = document.querySelector(selector)
    if (!(node instanceof HTMLElement)) return null
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor, backdropFilter: style.getPropertyValue('backdrop-filter'), webkitBackdropFilter: style.getPropertyValue('-webkit-backdrop-filter') }
  }
  const snapshot = (surface) => {
    const session = document.querySelector('.hc-chat__sidebar')?.getBoundingClientRect()
    const ambient = Array.from(document.querySelectorAll('.k12-ambient-butterfly')).map((node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, intersectsSession: Boolean(session && rect.right > session.left && rect.left < session.right && rect.bottom > session.top && rect.top < session.bottom) }
    })
    return {
      surface,
      route: location.pathname + location.search,
      theme: document.documentElement.dataset.theme,
      skin: document.body.dataset.k12SkinActive,
      isTauri: globalThis.isTauri === true,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, locale: navigator.language },
      sessionSidebar: measure('.hc-chat__sidebar'),
      mainScene: measure('.k12-global-presentation__main-scene'),
      sidebarScene: measure('.k12-global-presentation__sidebar-scene'),
      tiles: measure('.k12ins__tiles'),
      priority: measure('[data-testid="insight-priority-card"]'),
      ambient,
      sessionCount: document.querySelectorAll('.hc-sessions__item').length,
      firstSessionMeta: clean(
        document.querySelector('.hc-sessions__item .hc-sessions__time')?.textContent,
      ),
      tutorTaskVisible: Boolean(
        document.querySelector('[data-testid="k12-photo-assistant-message"]'),
      ),
      tutorP52Visible: clean(document.body?.innerText).includes('数学练习册 P52'),
      records: Array.from(document.querySelectorAll('.k12mistakes .rl-row')).map((row) => ({
        id: row.dataset.recordId,
        text: clean(row.textContent),
      })),
      insightActions: Array.from(document.querySelectorAll('[data-testid="insight-setback-action"], [data-testid="insight-week-action"]')).map((node) => clean(node.textContent)),
    }
  }
  const openSurface = async (surface) => {
    await waitFor(() => document.querySelector('.k12enh-seg'), 'K12 route tabs')
    const label = surface === 'tutor' ? '辅导' : surface === 'records' ? '学习档案' : '学情'
    const tab = await waitFor(() => findTab(label), label + ' tab')
    tab.click()
    if (surface === 'tutor') {
      await waitFor(
        () =>
          findTab(label)?.getAttribute('aria-selected') === 'true' &&
          document.querySelector('.k12-global-presentation__main-scene') &&
          document.querySelector('[data-testid="k12-photo-assistant-message"]'),
        'selected tutor surface',
      )
    }
    if (surface === 'records') {
      await waitFor(() => document.querySelector('.k12rec'), 'records surface')
      const mistakes = await waitFor(() => document.querySelector('[data-testid="subtab-mistakes"]'), 'mistakes tab')
      mistakes.click()
      await waitFor(() => document.querySelectorAll('.k12mistakes .rl-row').length === 7, 'seven record rows')
    }
    if (surface === 'insights') await waitFor(() => document.querySelector('[data-testid="insight-priority-card"]'), 'insight priority')
    await sleep(100)
    return snapshot(surface)
  }
  const runRoutes = async () => {
    const observations = []
    observations.push(await openSurface('tutor'))
    observations.push(await openSurface('records'))
    observations.push(await openSurface('insights'))
    return observations
  }
  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    await post({
      stage: 'dom-ready',
      route: location.pathname + location.search,
      body: clean(document.body && document.body.innerText).slice(0, 500),
    })
    const phase = Number(localStorage.getItem(phaseKey) || '0')
    if (phase === 0) {
      const observations = await runRoutes()
      await post({ stage: 'light-routes', observations })
      localStorage.setItem(phaseKey, '1')
      localStorage.setItem('hc-theme', 'dark')
      location.reload()
      return
    }
    if (phase === 1) {
      const observations = await runRoutes()
      localStorage.setItem(phaseKey, '2')
      await post({ stage: 'ready-for-restart', observations, persisted: { theme: localStorage.getItem('hc-theme'), appearance: localStorage.getItem('hc-k12-appearance-v1') } })
      return
    }
    if (phase === 2) {
      const observations = await runRoutes()
      localStorage.setItem(phaseKey, '3')
      await post({ stage: 'restarted-routes', observations, persisted: { theme: localStorage.getItem('hc-theme'), appearance: localStorage.getItem('hc-k12-appearance-v1') } })
    }
  }
  void execute().catch(reportFixtureError)
})()
`
}

function prepareFrontend(sandbox, fixtureOrigin) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')), 'current dist/index.html is missing')
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })
  const fixtureSource = renderWebViewFixture(fixtureOrigin)
  assert.ok(!fixtureSource.includes('</script>'), 'fixture source must be safe to inline')
  assert.doesNotThrow(() => new Function(fixtureSource), 'generated fixture must parse')
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  assert.match(index, /<head>/)
  const moduleEntry = index.match(
    /<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/,
  )
  assert.ok(moduleEntry, 'current dist module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const platformMatches = moduleSource.match(platformProbe) || []
  assert.equal(platformMatches.length, 1, 'current dist must contain one platform probe')
  assert.ok(moduleSource.includes('http://localhost:16060'), 'current dist API base is missing')
  moduleSource = moduleSource
    .replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1'))
    .replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script>${fixtureSource}</script>`))
  return frontend
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin) {
  const overlayPath = join(sandbox, 'tauri.k12-bug-installed.conf.json')
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
          width: 1280,
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
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
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
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // Sidecar is still starting.
    }
    await sleep(250)
  }
  throw new Error(`Sidecar health timed out on loopback port ${port}`)
}

async function waitForReport(state, stage, fromIndex = 0, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = state.reports.slice(fromIndex).find((entry) => entry.stage === stage)
    if (report) return report
    const error = state.reports.slice(fromIndex).find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report: ${stage}`)
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', () => resolveExit(true))),
    sleep(5_000).then(() => false),
  ])
  if (!exited && processHandle.exitCode === null) {
    processHandle.kill('SIGKILL')
    await new Promise((resolveExit) => processHandle.once('exit', resolveExit))
  }
}

async function stopOwnedSidecar(port, bundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    if (!command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`)) {
      throw new Error(`dedicated port ${port} has unexpected owner ${pid}: ${command}`)
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
  assert.ok(output, `no visible native window found for PID ${pid}`)
  const [id, x, y, width, height] = output.split('|').map(Number)
  assert.ok([id, x, y, width, height].every(Number.isFinite), `invalid window info: ${output}`)
  return { id, x, y, width, height }
}

function captureWindow(pid, destination) {
  const window = windowInfoForPID(pid)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.id), destination])
  assert.ok(existsSync(destination), `native screenshot missing: ${destination}`)
  assert.ok(statSync(destination).size > 1024, `native screenshot is empty: ${destination}`)
  return { ...window, bytes: statSync(destination).size }
}

function sanitizeLog(raw, sandbox) {
  return raw.replaceAll(repoRoot, '<repo>').replaceAll(sandbox, '<sandbox>')
}

async function main() {
  assert.equal(process.platform, 'darwin', 'installed boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true })
  for (const entry of readdirSync(evidenceRoot)) {
    if (
      /^installed-(?:summary|cleanup)\.json$/.test(entry) ||
      /^installed-app-\d+\.log$/.test(entry) ||
      entry === 'installed-failure.png' ||
      entry === 'installed-debug-after-health.png' ||
      /^installed-current-source-(?:before|after)-restart-dark-insights\.png$/.test(entry)
    ) {
      rmSync(join(evidenceRoot, entry), { force: true })
    }
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-k12-bug-installed.'))
  chmodSync(sandbox, 0o700)
  const cargoTarget = join(sandbox, 'cargo-target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createLoopbackFixture(fixturePort)
  let appProcess = null
  let appLog = null
  let appLogPath = ''
  let appLogGeneration = 0
  let appBundleRemoved = false
  const generations = []
  let finalStatus = 'NOT_PASS'
  let finalError = null

  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
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
    const overlay = writeOverlay(sandbox, frontend, sidecarPort, fixture.origin)
    rmSync(appBundle, { recursive: true, force: true })
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], {
      env: offlineEnv,
    })
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist), `unique Test.app missing: ${infoPlist}`)
    assert.ok(existsSync(executable), `unique Test.app executable missing: ${executable}`)
    assert.ok(
      existsSync(sidecarExecutable),
      `unique Test.app Sidecar missing: ${sidecarExecutable}`,
    )
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(join(sandbox, '.hexclaw')).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.deepEqual(
      listenerPIDs(sidecarPort),
      [],
      `dedicated Sidecar port ${sidecarPort} is occupied`,
    )

    const runtimeEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      HOME: sandbox,
      USERPROFILE: sandbox,
      CFFIXED_USER_HOME: sandbox,
      TMPDIR: join(sandbox, 'tmp'),
      TEMP: join(sandbox, 'tmp'),
      TMP: join(sandbox, 'tmp'),
      HEXCLAW_TEST_MODE: '1',
      HEXCLAW_TEST_HOME: sandbox,
      HEXCLAW_SIDECAR_PORT: String(sidecarPort),
      HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml',
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    const launch = async () => {
      appLogGeneration += 1
      appLogPath = join(sandbox, `app-${appLogGeneration}.log`)
      appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
      appProcess = spawn(executable, [], {
        cwd: sandbox,
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      appProcess.stdout.pipe(appLog, { end: false })
      appProcess.stderr.pipe(appLog, { end: false })
      await waitForHealth(sidecarPort, appProcess)
      const pids = listenerPIDs(sidecarPort)
      assert.equal(pids.length, 1, 'unique Test.app must own exactly one Sidecar listener')
      generations.push({ appPID: appProcess.pid, sidecarPID: pids[0] })
      return appProcess
    }

    await launch()
    captureWindow(appProcess.pid, join(evidenceRoot, 'installed-debug-after-health.png'))
    const light = await waitForReport(fixture.state, 'light-routes')
    const beforeRestart = await waitForReport(fixture.state, 'ready-for-restart')
    const beforeScreenshot = captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'installed-current-source-before-restart-dark-insights.png'),
    )
    const reportsBeforeRestart = fixture.state.reports.length
    await stopProcess(appProcess)
    await new Promise((resolveEnd) => appLog.end(resolveEnd))
    appLog = null
    await stopOwnedSidecar(sidecarPort, appBundle)
    await launch()
    const restarted = await waitForReport(fixture.state, 'restarted-routes', reportsBeforeRestart)
    const afterScreenshot = captureWindow(
      appProcess.pid,
      join(evidenceRoot, 'installed-current-source-after-restart-dark-insights.png'),
    )

    const allObservations = [
      ...light.observations,
      ...beforeRestart.observations,
      ...restarted.observations,
    ]
    assert.equal(light.observations.length, 3)
    assert.equal(beforeRestart.observations.length, 3)
    assert.equal(restarted.observations.length, 3)
    assert.equal(generations.length, 2)
    assert.notEqual(generations[0].appPID, generations[1].appPID)
    assert.notEqual(generations[0].sidecarPID, generations[1].sidecarPID)
    assert.equal(beforeRestart.persisted.theme, 'dark')
    assert.equal(restarted.persisted.theme, 'dark')
    assert.match(restarted.persisted.appearance, /"preference":"k12"/)
    assert.ok(allObservations.every((entry) => entry.isTauri === true))
    assert.ok(allObservations.every((entry) => entry.skin === 'k12'))
    assert.ok(allObservations.every((entry) => entry.sessionSidebar?.rect.width === 256))
    assert.ok(
      allObservations.every(
        (entry) =>
          entry.sessionSidebar?.backdropFilter === 'none' &&
          ['', 'none'].includes(entry.sessionSidebar?.webkitBackdropFilter || ''),
      ),
    )
    assert.ok(
      allObservations.every((entry) => entry.ambient.every((item) => !item.intersectsSession)),
    )
    assert.ok(
      allObservations.every(
        (entry) =>
          /k12-content-(?:light|dark)(?:-[A-Za-z0-9_-]+)?\.png/.test(
            entry.mainScene?.backgroundImage || '',
          ) &&
          !/k12-scene-(?:light|dark)(?:-[A-Za-z0-9_-]+)?\.png/.test(
            entry.mainScene?.backgroundImage || '',
          ),
      ),
    )
    assert.ok(allObservations.every((entry) => entry.sessionCount === 12))
    assert.ok(allObservations.every((entry) => entry.firstSessionMeta === '7月29日'))
    const tutors = allObservations.filter((entry) => entry.surface === 'tutor')
    assert.equal(tutors.length, 3)
    assert.ok(tutors.every((entry) => entry.tutorTaskVisible && entry.tutorP52Visible))
    const records = allObservations.filter((entry) => entry.surface === 'records')
    assert.equal(records.length, 3)
    assert.ok(records.every((entry) => entry.records.length === 7))
    assert.ok(
      records.every(
        (entry) =>
          entry.records.map((record) => record.id).join(',') ===
          'm-apple,m-circuit,m-loop,m-eq,m-believe,m-poem,m-position',
      ),
    )
    const insights = allObservations.filter((entry) => entry.surface === 'insights')
    assert.equal(insights.length, 3)
    assert.ok(
      insights.every(
        (entry) =>
          Math.abs(entry.priority.rect.x - entry.tiles.rect.x) <= 0.01 &&
          Math.abs(entry.priority.rect.width - entry.tiles.rect.width) <= 0.01,
      ),
    )
    assert.ok(
      insights.every((entry) =>
        entry.insightActions.some((text) => text.includes('6 道题已加入练习集')),
      ),
    )
    assert.equal(fixture.state.chatRequests, 0)
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    const rawLogs = [1, 2]
      .map((generation) => readFileSync(join(sandbox, `app-${generation}.log`), 'utf8'))
      .join('\n')
    assert.doesNotMatch(rawLogs, /localhost:11434/, 'isolated Test.app must not probe user Ollama')

    const summary = {
      schemaVersion: 1,
      status: 'PASS',
      scope: ['BUG-20260801-007', 'BUG-20260801-008', 'BUG-20260801-009', 'BUG-20260801-010'],
      app: {
        productName,
        identifier,
        bundle: relative(repoRoot, appBundle),
        executableSHA256: sha256File(executable),
        sidecarSHA256: sha256File(sidecarExecutable),
        nativeWindow: true,
        realWKWebView: true,
      },
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
      generations,
      reports: { light, beforeRestart, restarted },
      screenshots: { beforeRestart: beforeScreenshot, afterRestart: afterScreenshot },
      fixtureReceipts: fixture.state,
    }
    writeFileSync(
      join(evidenceRoot, 'installed-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    finalStatus = 'PASS'
    process.stdout.write(
      `\nK12 installed Test.app boundary PASS: ${relative(repoRoot, evidenceRoot)}\n`,
    )
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (appProcess && appProcess.exitCode === null) {
      try {
        captureWindow(appProcess.pid, join(evidenceRoot, 'installed-failure.png'))
      } catch (captureError) {
        fixture.state.unexpectedRequests.push(
          `failure-screenshot:${captureError instanceof Error ? captureError.message : String(captureError)}`,
        )
      }
    }
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    let stoppedSidecars = []
    try {
      stoppedSidecars = await stopOwnedSidecar(sidecarPort, appBundle)
    } catch (error) {
      if (!finalError)
        finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    await fixture.close()
    for (let generation = 1; generation <= appLogGeneration; generation += 1) {
      const source = join(sandbox, `app-${generation}.log`)
      if (existsSync(source)) {
        writeFileSync(
          join(evidenceRoot, `installed-app-${generation}.log`),
          sanitizeLog(readFileSync(source, 'utf8'), sandbox),
        )
      }
    }
    if (!existsSync(join(evidenceRoot, 'installed-summary.json'))) {
      writeFileSync(
        join(evidenceRoot, 'installed-summary.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: finalStatus,
            error: finalError,
            scope: ['BUG-20260801-007', 'BUG-20260801-008', 'BUG-20260801-009', 'BUG-20260801-010'],
            isolation: {
              sidecarPort,
              fixturePort,
              applicationsDirectoryTouched: false,
              userHomeRead: false,
              externalNetworkRequests: 0,
              realModelInvocations: 0,
              realIMInvocations: 0,
            },
            generations,
            reports: fixture.state.reports,
            fixtureReceipts: fixture.state,
          },
          null,
          2,
        )}\n`,
      )
    }
    rmSync(appBundle, { recursive: true, force: true })
    appBundleRemoved = !existsSync(appBundle)
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'installed-cleanup.json'),
      `${JSON.stringify(
        {
          status: finalStatus,
          appProcessStopped:
            !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null,
          sidecarPortReleased: listenerPIDs(sidecarPort).length === 0,
          fixtureClosed: true,
          uniqueAppBundleRemoved: appBundleRemoved,
          sandboxRemoved: !existsSync(sandbox),
          stoppedSidecars,
        },
        null,
        2,
      )}\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
