#!/usr/bin/env node

/**
 * BUG-20260728-006 当前源码隔离 Test.app 验收。
 * 生产 dist 只复制进临时目录并注入测试传输；使用唯一 Bundle ID、隔离 HOME 与真实 WKWebView。
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
const srcTauriDir = join(repoRoot, 'src-tauri')
const nativeScenario = process.env.HEXCLAW_NATIVE_SCENARIO || 'profile-authority'
const chatInstalledScenario = nativeScenario === 'bug-20260726-009-019'
assert.ok(
  chatInstalledScenario || nativeScenario === 'profile-authority',
  `unsupported native scenario: ${nativeScenario}`,
)
const evidenceRoot = resolve(
  process.env.HEX_K12_INSTALLED_EVIDENCE ||
    process.env.HEX_K12_PROFILE_AUTHORITY_EVIDENCE ||
    join(
      docsRoot,
      chatInstalledScenario
        ? 'test/evidence/bug-20260726-009-019-installed-20260823'
        : 'test/evidence/bug-20260728-006-profile-authority-20260822',
    ),
)
const productName = chatInstalledScenario
  ? 'HexClaw K12 Chat 009 019 Test'
  : 'HexClaw K12 Profile 006 Test'
const bundleIdentifier = chatInstalledScenario
  ? 'com.hexclaw.desktop.bug-20260726-009-019'
  : 'com.hexclaw.desktop.bug-20260728-006'
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sha256File = (path) => sha256(readFileSync(path))

function runCommand(command, args, env) {
  return new Promise((resolveCommand, rejectCommand) => {
    process.stdout.write(`\n[k12-profile-installed] ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
    const timer = setTimeout(
      () => {
        child.kill('SIGTERM')
        rejectCommand(new Error(`Command timed out: ${command}`))
      },
      15 * 60 * 1000,
    )
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveCommand()
      else rejectCommand(new Error(`Command failed (${code ?? signal}): ${command}`))
    })
  })
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose) => server.close(resolveClose))
  assert.ok(![16060, 11434].includes(port))
  return port
}

function createFixtureServer(port) {
  const state = { reports: [], released: new Set(), unexpectedRequests: [] }
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
      if (request.method === 'POST' && url.pathname === '/report') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        state.reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        })
        response.end('{"ok":true}')
        return
      }
      if (request.method === 'GET' && url.pathname === '/gate') {
        response.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        })
        response.end(
          JSON.stringify({ released: state.released.has(url.searchParams.get('stage') || '') }),
        )
        return
      }
      if (request.method === 'GET' && url.pathname === '/updater') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      response.end('{}')
    } catch (error) {
      state.unexpectedRequests.push(
        `fixture-error:${error instanceof Error ? error.message : String(error)}`,
      )
      response.writeHead(500, { 'Access-Control-Allow-Origin': '*' })
      response.end('{}')
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
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function fixtureData() {
  const now = '2026-07-28T12:00:00+08:00'
  const agent = {
    name: 'agent-k12-ming',
    display_name: '小明的辅导助手 · 五年级',
    description: '五年级上 · 数学教材与当前进度 · 按年级边界讲解',
    provider: 'HexClaw-GPT',
    model: 'gpt-5.6-sol',
    skills: [
      'builtin.k12.photo',
      'builtin.k12.progressive',
      'builtin.k12.mistakes',
      'builtin.k12.works',
      'builtin.k12.subjects',
    ],
    system_prompt: '你是小明的辅导助手。讲解只使用孩子学过的知识。',
    metadata: {
      scenario: 'k12-tutor',
      avatar: '🎓',
      'k12.learner_id': 'learner-ming',
      'k12.child_name': '小明',
      'k12.grade_term': '五年级上',
      'k12.profile_revision': '3',
      'k12.textbook_edition': '人教版',
      'k12.textbook_edition.math': '人教版',
    },
  }
  const progress = {
    progress_id: 'progress-math-ming',
    agent: agent.name,
    subject: 'math',
    revision: 4,
    textbook_binding_id: 'binding-math-ming',
    textbook_manifest_id: 'manifest-math-pep-5b-g1',
    textbook_edition: '人教版',
    textbook_version: '2022',
    title: '数学',
    volume: '五年级下册',
    unit_id: 'unit-4',
    unit_title: '第4单元「分数的意义和性质」',
    requested_page_from: 45,
    requested_page_to: 62,
    page_verification_status: 'not_requested',
    segment_refs: [],
    evidence_source: 'parent_confirmed',
    confirmed_at: now,
    created_at: now,
    updated_at: now,
  }
  const binding = {
    manifest_id: 'manifest-math-pep-5b-g1',
    document_id: 'document-math-pep-5b',
    document_generation: 1,
    document_title: '义务教育教科书·数学五年级下册.pdf',
    state: 'ready_for_confirmation',
    retryable: false,
    failure_message: '',
    text_index_state: 'ready',
    vector_index_state: 'ready',
    catalog: {
      subject: 'math',
      textbook_edition: '人教版',
      textbook_version: '2022',
      title: '数学',
      volume: '五年级下册',
      page_min: 1,
      page_max: 120,
      units: [
        {
          unit_id: 'unit-4',
          title: '第4单元「分数的意义和性质」',
          page_from: 45,
          page_to: 62,
          lessons: [],
        },
      ],
      page_refs: [],
    },
    updated_at: now,
  }
  const settings = {
    agent: agent.name,
    revision: 7,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: true,
    textbook_consolidation_tier: 'standard',
    arithmetic_warmup_enabled: true,
    arithmetic_minutes: 2,
    created_at: now,
    updated_at: now,
  }
  const track = (planSection) => ({ plan_section: planSection, status: 'ready', items: [] })
  const weeklyPlan = {
    plan_id: 'weekly-ming-2026-31',
    agent: agent.name,
    revision: 2,
    iso_week_year: 2026,
    iso_week_number: 31,
    timezone: 'Asia/Shanghai',
    week_start: '2026-07-27T00:00:00+08:00',
    week_end: '2026-08-02T23:59:59+08:00',
    local_start_date: '2026-07-27',
    local_end_date: '2026-08-02',
    status: 'draft',
    settings_revision: 7,
    curriculum_progress_revision: 4,
    tracks: [track('due_review'), track('textbook_consolidation'), track('arithmetic_warmup')],
    created_at: now,
    updated_at: now,
  }
  const chat = chatInstalledScenario
    ? {
        sessionID: 'session-k12-ming',
        sourceMessageID: 'installed-k12-source-message',
        assistantMessageID: 'installed-k12-assistant-message',
        dispatchID: 'installed-k12-dispatch',
        messages: [
          {
            id: 'installed-k12-source-message',
            role: 'user',
            content: Array.from({ length: 18 }, (_, index) => `作业图片说明 ${index + 1}`).join('\n'),
            timestamp: now,
            created_at: now,
          },
          {
            id: 'installed-k12-assistant-message',
            role: 'assistant',
            content: '后续助手消息：TaskShell 必须稳定排在本消息之前。',
            timestamp: now,
            created_at: now,
            agent_name: agent.name,
          },
        ],
        dispatch: {
          dispatch_id: 'installed-k12-dispatch',
          task_intent: 'artwork',
          status: 'routed',
          provider_display_name: 'HexClaw-GPT',
          model_id: 'gpt-5.6-sol',
          retryable: false,
          intent_evidence: ['parent_selected_artwork'],
          intent_confidence: 1,
          confirmation_candidates: [],
          target: { type: 'creative_work_intake', id: 'installed-k12-intake' },
          target_projection: {
            kind: 'creative',
            intake_id: 'installed-k12-intake',
            work_type: 'art',
        status: 'preparing',
            entry_kind: 'new_work',
            routing_provenance: 'parent_selected',
            commit_required: true,
            commit_state: 'pending',
          },
      progress: { operation: 'classification', state: 'routed' },
          version: 1,
          created_at: Date.parse(now) / 1000,
          updated_at: Date.parse(now) / 1000,
        },
      }
    : null
  return { agent, progress, binding, settings, weeklyPlan, now, chat }
}

function renderFixture(origin) {
  const fixture = fixtureData()
  return `;(function runProfileInstalledGate() {
  'use strict'
  const origin = ${JSON.stringify(origin)}
  const fixture = ${JSON.stringify(fixture)}
  const runtime = { hadTauriFlag: globalThis.isTauri === true, hasTauriInternals: typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function' }
  const originalFetch = globalThis.fetch.bind(globalThis)
  const unexpectedApi = [], blockedExternal = [], runtimeErrors = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const api = (method, path) => {
    if (path === '/health') return json({ status: 'ok' })
    if (path === '/api/v1/config') return json({ general: { welcomeCompleted: true }, knowledge: { enabled: true }, llm: { default: 'HexClaw-GPT', providers: { 'HexClaw-GPT': { api_key: 'test', base_url: 'http://127.0.0.1:18080/v1', model: 'gpt-5.6-sol', models: ['gpt-5.6-sol'] } }, routing: { enabled: false }, cache: { enabled: false } } })
    if (path === '/api/v1/config/llm') return json({ default: 'HexClaw-GPT', providers: { 'HexClaw-GPT': { api_key: 'test', base_url: 'http://127.0.0.1:18080/v1', model: 'gpt-5.6-sol', models: ['gpt-5.6-sol'] } }, routing: { enabled: false }, cache: { enabled: false } })
    if (path === '/api/v1/config/llm/models' && method === 'POST') return json({ models: ['gpt-5.6-sol'] })
    if (path === '/api/v1/ollama/status') return json({ running: false, associated: false, models: [] })
    if (['/api/v1/images/status', '/api/v1/videos/status', '/api/v1/voicechat/status'].includes(path)) return json({ available: false, configured: false })
    if (path === '/api/v1/roles') return json({ roles: [], total: 0 })
    if (path === '/api/v1/agents/rules') return json({ rules: [], total: 0 })
    if (path === '/api/v1/agents') return json({ agents: [fixture.agent], total: 1, default: fixture.agent.name })
    if (path === '/api/v1/sessions') return json({ sessions: [{ id: 'session-k12-ming', title: fixture.agent.display_name, agent_id: fixture.agent.name, created_at: fixture.now, updated_at: fixture.now, message_count: fixture.chat ? fixture.chat.messages.length : 0 }], total: 1 })
    if (fixture.chat && path === '/api/v1/sessions/' + fixture.chat.sessionID + '/messages') return json({ messages: fixture.chat.messages, total: fixture.chat.messages.length })
    if (/^\\/api\\/v1\\/sessions\\/[^/]+\\/(messages|artifacts|branches)$/.test(path)) return json({ messages: [], artifacts: [], branches: [], total: 0 })
    if (path === '/api/v1/streams/active') return json({ streams: [], total: 0 })
    if (path === '/api/v1/prompts' || path === '/api/v1/prompts/all') return json({ prompts: [], total: 0 })
    if (path === '/api/v1/skills') return json({ dir: '/fixture/skills', skills: [], total: 0 })
    if (path === '/api/v1/webhooks') return json({ webhooks: [], k12_bindings: [], total: 0 })
    if (path === '/api/v1/memory') return json({ entries: [], summary: '', capacity: { used: 0, max: 200, archived: 0 }, total: 0, has_more: false, legacy_mode: false })
    if (path === '/api/v1/config/memory') return json({ enabled: true, auto_memory: 'inline', recall_min_score: 0.35, active_recall: true, profile: false, profile_interval_mins: 1440 })
    if (path === '/api/v1/knowledge/documents') return json({ documents: [], total: 0, limit: 50, offset: 0, sources: [] })
    if (path === '/api/k12/view-descriptor') return json({ header_tabs: ['辅导', '学习档案', '学情'], message_badges: [], composer_placeholder: '', composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1 })
    if (path === '/api/k12/curriculum-progress') return json({ progress: fixture.progress, revision: 4 })
    if (path === '/api/k12/textbook-binding-options') return json({ items: [fixture.binding] })
    if (path === '/api/k12/weekly-practice/settings') return json(fixture.settings)
    if (path === '/api/k12/weekly-practice/plans' && method === 'POST') return json({ plan: fixture.weeklyPlan, replayed: false })
    if (path === '/api/k12/weekly-practice/plans/history') return json({ items: [], next_cursor: null })
    if (['/api/k12/mistakes', '/api/k12/review-queue', '/api/k12/accumulation', '/api/k12/practice-sets'].includes(path)) return json({ items: [] })
    if (path === '/api/k12/creative-works') return json({ items: [] })
    if (path === '/api/k12/insight-report') return json({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], consecutive_fail_kps: [], month_new_mistakes: 0, review_completion_rate: -1 })
    if (path === '/api/k12/study-time') return json({ days: [], total_minutes: 0 })
    if (fixture.chat && path === '/api/k12/image-tasks/recoverable') return json({ items: [{ dispatch_id: fixture.chat.dispatchID, source_session_id: fixture.chat.sessionID, source_message_id: fixture.chat.sourceMessageID, attempt_generation: 1, version: 1, stage: 'routed', status: 'routed', projection_ready: true, terminal: false }] })
    if (fixture.chat && path === '/api/k12/image-tasks/' + fixture.chat.dispatchID) return json({ dispatch: fixture.chat.dispatch })
    if (path === '/api/k12/image-tasks/recoverable') return json({ items: [] })
    unexpectedApi.push(method + ' ' + path); return json({})
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin === origin) return originalFetch(input, init)
    if (url.origin === 'http://localhost:11434') {
      const method = (input instanceof Request ? input.method : init?.method || 'GET').toUpperCase()
      if (method === 'GET' && url.pathname === '/api/tags') return json({ models: [] })
      if (method === 'GET' && url.pathname === '/api/version') return json({ version: 'test' })
      unexpectedApi.push(method + ' ' + url.origin + url.pathname)
      return json({}, 404)
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') { const request = input instanceof Request ? input : new Request(url, init); return api(request.method.toUpperCase(), url.pathname) }
    if (url.origin === location.origin) return originalFetch(input, init)
    blockedExternal.push((init?.method || 'GET') + ' ' + url.origin + url.pathname); throw new TypeError('external network blocked')
  }
  if (fixture.chat) {
    const fixtureCallbacks = new Map()
    let fixtureCallbackID = 1
    const fixtureTauri = globalThis.__TAURI_INTERNALS__ || {}
    const nativeInvoke = typeof fixtureTauri.invoke === 'function' ? fixtureTauri.invoke.bind(fixtureTauri) : null
    const fixtureInvoke = async (command, args = {}) => {
      if (command === 'sidecar_socket_open') {
        const callbackID = args?.onEvent?.id
        if (typeof callbackID !== 'number') throw new Error('fixture sidecar socket requires an event channel')
        queueMicrotask(() => fixtureCallbacks.get(callbackID)?.({ index: 0, message: { type: 'open' } }))
        return 'k12-fixture-socket-' + callbackID
      }
      if (command === 'sidecar_socket_close') return null
      if (command === 'check_engine_health') return true
      if (command === 'plugin:event|listen') return fixtureCallbackID++
      if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit' || command === 'plugin:clipboard-manager|write_text') return null
      return nativeInvoke ? nativeInvoke(command, args) : null
    }
    const bridge = {
      invoke: fixtureInvoke,
      transformCallback: (callback) => { const callbackID = fixtureCallbackID++; fixtureCallbacks.set(callbackID, callback); return callbackID },
      unregisterCallback: (callbackID) => fixtureCallbacks.delete(callbackID),
    }
    for (const [key, value] of Object.entries(bridge)) {
      try { Object.defineProperty(fixtureTauri, key, { configurable: true, enumerable: true, writable: true, value }) }
      catch { try { fixtureTauri[key] = value } catch {} }
    }
    if (!globalThis.__TAURI_INTERNALS__) {
      try { Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, enumerable: false, writable: true, value: fixtureTauri }) }
      catch {}
    }
  }
  class FixtureWebSocket extends EventTarget { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; constructor(url) { super(); this.url = String(url); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event) }) } close() { this.readyState = 3 } send() {} }
  globalThis.WebSocket = FixtureWebSocket
  const visibleAnchor = (container) => { if (!(container instanceof HTMLElement)) return null; const box = container.getBoundingClientRect(); const node = Array.from(container.querySelectorAll('[data-scroll-anchor-id]')).find((candidate) => candidate.getBoundingClientRect().bottom > box.top + 1); return node ? { id: node.getAttribute('data-scroll-anchor-id'), offset: Math.round(node.getBoundingClientRect().top - box.top) } : null }
  const scrollSnapshot = () => { const container = document.querySelector('.hc-chat__messages'); if (!(container instanceof HTMLElement)) return null; return { scrollTop: container.scrollTop, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight, atBottom: container.scrollHeight - container.scrollTop - container.clientHeight <= 2, anchor: visibleAnchor(container) } }
  const contentTelemetry = { count: 0, before: [], after: [] }
  globalThis.__hexclawInstalledContentUpdated = () => { contentTelemetry.count += 1; contentTelemetry.before.push(scrollSnapshot()); requestAnimationFrame(() => requestAnimationFrame(() => contentTelemetry.after.push(scrollSnapshot()))) }
  void originalFetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'bootstrap', observation: { runtime, route: location.pathname } }) })
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hexclaw:welcomeRedirectDone', '1'); sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'); localStorage.setItem('hc-theme', 'light'); localStorage.setItem('hexclaw_lastSessionId', 'session-k12-ming'); localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ 'session-k12-ming': fixture.agent.name })); if (fixture.chat) localStorage.setItem('hc-k12-appearance-v1', JSON.stringify({ version: 1, preference: 'k12', introSeen: true })); history.replaceState({}, '', fixture.chat ? '/chat' : '/agents')
  addEventListener('error', (event) => runtimeErrors.push(clean(event.message)))
  addEventListener('unhandledrejection', (event) => runtimeErrors.push(clean(event.reason?.message || event.reason)))
  const waitFor = async (read, label, timeout = 45000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = read(); if (value) return value; await sleep(80) } throw new Error('timed out waiting for ' + label) }
  const findButton = (root, label) => Array.from(root.querySelectorAll('button')).find((node) => clean(node.textContent) === label)
  const measure = (node) => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, maxWidth: style.maxWidth, maxHeight: style.maxHeight } }
  const snapshot = (entry) => { const root = document.querySelector('.k12pf'), body = root?.querySelector('.k12pf__body'), math = root?.querySelector('[data-testid="k12-math-progress"]'); if (!(root instanceof HTMLElement) || !(body instanceof HTMLElement) || !(math instanceof HTMLElement)) throw new Error('profile surface missing'); return { entry, route: location.pathname, runtime, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, errors: Array.from(root.querySelectorAll('.k12pf__err')).map((node) => clean(node.textContent)).filter(Boolean), active: { tag: document.activeElement?.tagName || '', className: document.activeElement?.className || '', testid: document.activeElement?.getAttribute?.('data-testid') || '' }, scrollTop: body.scrollTop, mathSubjectExactSet: Array.from(root.querySelectorAll('[data-testid="k12-textbook-row"]')).map((node) => node.getAttribute('data-subject')), root: measure(root), body: measure(body), math: measure(math), runtimeErrors: [...runtimeErrors], unexpectedApi: [...unexpectedApi], blockedExternal: [...blockedExternal] } }
  const post = async (stage, observation) => { const result = await originalFetch(origin + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, observation }) }); if (!result.ok) throw new Error('report failed') }
  const waitGate = async (stage) => { while (true) { const result = await originalFetch(origin + '/gate?stage=' + encodeURIComponent(stage)); if ((await result.json()).released) return; await sleep(80) } }
  const chatSnapshot = () => { const thread = document.querySelector('.hc-chat__thread'); const task = document.querySelector('[data-testid="recognize-guard"]'); if (!(thread instanceof HTMLElement) || !(task instanceof HTMLElement)) throw new Error('chat task surface missing'); const order = Array.from(thread.querySelectorAll('[data-scroll-anchor-id],[data-testid="recognize-guard"]')).map((node) => node.hasAttribute('data-scroll-anchor-id') ? { kind: 'message', id: node.getAttribute('data-scroll-anchor-id') } : { kind: 'task', id: node.getAttribute('data-dispatch-id'), sourceMessageID: node.getAttribute('data-source-message-id') }); return { runtime, route: location.pathname, order, sourceMessageID: fixture.chat.sourceMessageID, assistantMessageID: fixture.chat.assistantMessageID, taskID: task.getAttribute('data-dispatch-id'), taskSourceMessageID: task.getAttribute('data-source-message-id'), contentUpdatedCount: contentTelemetry.count, scrollBefore: contentTelemetry.before[0], scrollAfter: contentTelemetry.after[contentTelemetry.after.length - 1], runtimeErrors: [...runtimeErrors], unexpectedApi: [...unexpectedApi], blockedExternal: [...blockedExternal] } }
  const execute = async () => {
    if (document.readyState === 'loading') await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
    if (fixture.chat) { await post('k12-chat-route', { route: location.pathname, readyState: document.readyState, messageAnchors: document.querySelectorAll('[data-scroll-anchor-id]').length, taskShells: document.querySelectorAll('[data-testid="recognize-guard"]').length, testids: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 20).map((node) => node.getAttribute('data-testid')) }); await waitFor(() => document.querySelector('[data-testid="recognize-guard"][data-dispatch-id="' + fixture.chat.dispatchID + '"]'), 'restored task shell'); await waitFor(() => document.querySelector('[data-scroll-anchor-id="' + fixture.chat.assistantMessageID + '"]'), 'assistant message'); await waitFor(() => contentTelemetry.count > 0 && contentTelemetry.after.length > 0, 'content-updated telemetry'); await sleep(300); await post('k12-chat-order-scroll', chatSnapshot()); return }
    const card = await waitFor(() => Array.from(document.querySelectorAll('.hc-cxcard')).find((node) => clean(node.textContent).includes('小明的辅导助手')), 'agent card')
    const edit = await waitFor(() => findButton(card, '编辑档案'), 'edit button'); edit.focus(); edit.click(); await waitFor(() => document.querySelector('.k12pf'), 'agent profile'); await sleep(300); await post('agents-entry', snapshot('agents-entry')); await waitGate('agents-entry')
    document.querySelector('.k12pf__x')?.click(); await waitFor(() => !document.querySelector('.k12pf'), 'profile close')
    const records = await waitFor(() => findButton(card, '学习档案'), 'records button'); records.click(); const recordsSurface = await waitFor(() => document.querySelector('.k12rec'), 'records surface'); const progressCard = await waitFor(() => Array.from(recordsSurface.querySelectorAll('.rc-week-progress')).find((node) => clean(node.textContent).includes('当前教材进度')), 'progress card'); const adjust = await waitFor(() => findButton(progressCard, '调整进度'), 'adjust button'); adjust.click(); await waitFor(() => document.activeElement?.getAttribute?.('data-testid') === 'k12-math-progress', 'math focus'); await sleep(300); await post('weekly-entry', snapshot('weekly-entry')); await waitGate('weekly-entry')
  }
  void execute().catch(async (error) => { runtimeErrors.push(error instanceof Error ? error.stack || error.message : String(error)); await post('fixture-error', { runtime, route: location.pathname, readyState: document.readyState, messageAnchors: document.querySelectorAll('[data-scroll-anchor-id]').length, taskShells: document.querySelectorAll('[data-testid="recognize-guard"]').length, testids: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 30).map((node) => node.getAttribute('data-testid')), runtimeErrors, unexpectedApi, blockedExternal }).catch(() => {}) })
})()`
}

function prepareFrontend(sandbox, origin) {
  const dist = join(repoRoot, 'dist')
  assert.ok(existsSync(join(dist, 'index.html')))
  const frontend = join(sandbox, 'frontend')
  cpSync(dist, frontend, { recursive: true })
  const fixture = renderFixture(origin)
  assert.ok(!fixture.includes('</script>'))
  assert.doesNotThrow(() => new Function(fixture))
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const moduleEntry = index.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/)
  assert.ok(moduleEntry, 'current dist module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const platformMatches = moduleSource.match(platformProbe) || []
  assert.equal(platformMatches.length, 1, 'current dist must contain one platform probe')
  moduleSource = moduleSource.replace(platformProbe, (match) =>
    match.replace('return!!globalThis.isTauri', 'return!1'),
  )
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  if (chatInstalledScenario) {
    const marker = 'reason:"scenario-content-updated"'
    const assetsDir = join(frontend, 'assets')
    const chunks = readdirSync(assetsDir)
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => ({ entry, path: join(assetsDir, entry) }))
      .filter(({ path }) => readFileSync(path, 'utf8').includes(marker))
    assert.equal(chunks.length, 1, 'current dist must contain one content-updated chunk')
    const source = readFileSync(chunks[0].path, 'utf8')
    assert.equal(source.split(marker).length - 1, 1)
    writeFileSync(
      chunks[0].path,
      source.replace(
        marker,
        'reason:(globalThis.__hexclawInstalledContentUpdated?.(),"scenario-content-updated")',
      ),
      { mode: 0o600 },
    )
  }
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script>${fixture}</script>`), {
    mode: 0o600,
  })
  return frontend
}

function writeOverlay(sandbox, frontend, origin) {
  const overlayPath = join(sandbox, 'tauri.k12-profile.conf.json')
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
      security: {
        csp: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: http://localhost:* http://127.0.0.1:*; media-src 'self' data: blob: http://localhost:* http://127.0.0.1:*; connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* ${origin}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`,
      },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: {
      updater: { endpoints: [`${origin}/updater`], dangerousInsecureTransportProtocol: true },
    },
  }
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

function config(sandbox, port) {
  return `server:\n  host: 127.0.0.1\n  port: ${port}\n  mode: development\nplatforms:\n  web:\n    enabled: true\nllm:\n  providers: {}\n  routing:\n    enabled: false\n  cache:\n    enabled: false\nstorage:\n  driver: sqlite\n  sqlite:\n    path: ${JSON.stringify(join(sandbox, '.hexclaw/data.db'))}\nknowledge:\n  enabled: false\nmemory:\n  long_term:\n    enabled: false\nheartbeat:\n  enabled: false\nmcp:\n  enabled: false\nskills:\n  enabled: false\n  auto_load: false\nrouter:\n  enabled: false\nvoice:\n  enabled: false\nobserve:\n  log_level: info\n`
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

async function waitHealth(port, app) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error('Test.app exited before health')
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok
      )
        return
    } catch {}
    await sleep(250)
  }
  throw new Error('Sidecar health timed out')
}

async function waitReport(state, stage) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const found = state.reports.find((entry) => entry.stage === stage)
    if (found) return found
    const failed = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (failed) throw new Error(`WKWebView fixture failed: ${failed.observation.runtimeErrors}`)
    await sleep(100)
  }
  throw new Error(`WKWebView report timed out: ${stage}`)
}

async function stopProcess(app) {
  if (!app || app.exitCode !== null) return
  app.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise((resolveStop) => app.once('exit', () => resolveStop(true))),
    sleep(5000).then(() => false),
  ])
  if (!stopped && app.exitCode === null) {
    app.kill('SIGKILL')
    await new Promise((resolveStop) => app.once('exit', resolveStop))
  }
}

async function stopSidecar(port, bundle) {
  const stopped = []
  for (const pid of listenerPIDs(port)) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
    assert.ok(command.includes(`${bundle}/Contents/MacOS/hexclaw serve --desktop`))
    process.kill(pid, 'SIGTERM')
    stopped.push(pid)
  }
  const deadline = Date.now() + 10_000
  while (listenerPIDs(port).length && Date.now() < deadline) await sleep(100)
  assert.deepEqual(listenerPIDs(port), [])
  return stopped
}

function capture(pid, destination) {
  const swift = `import Foundation\nimport CoreGraphics\nlet target: Int32 = ${Number(pid)}\nlet rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []\nfor row in rows { let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1; let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1; if owner == target && layer == 0, let id = (row[kCGWindowNumber as String] as? NSNumber)?.intValue, let bounds = row[kCGWindowBounds as String] as? [String: Any], let width = (bounds["Width"] as? NSNumber)?.doubleValue, let height = (bounds["Height"] as? NSNumber)?.doubleValue { print("\\(id)|\\(width)|\\(height)"); break } }`
  const output = execFileSync('/usr/bin/swift', ['-e', swift], { encoding: 'utf8' }).trim()
  assert.ok(output)
  const [id, width, height] = output.split('|').map(Number)
  execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(id), destination])
  assert.ok(existsSync(destination) && statSync(destination).size > 1024)
  return { width, height, bytes: statSync(destination).size }
}

async function main() {
  assert.equal(process.platform, 'darwin')
  mkdirSync(evidenceRoot, { recursive: true })
  for (const entry of readdirSync(evidenceRoot))
    if (/^test-app-(?:installed-|failure)/.test(entry))
      rmSync(join(evidenceRoot, entry), { force: true })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-k12-profile-installed.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const cargoTarget = join(sandbox, 'cargo-target')
  const bundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reservePort(),
    sidecarPort = await reservePort()
  const fixture = createFixtureServer(fixturePort)
  const profilePath = join(repoRoot, 'src/features/k12/views/K12ProfileForm.vue')
  const testPath = join(repoRoot, 'src/features/k12/__tests__/K12ProfileForm.test.ts')
  const provenance = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    profileSourceSHA256: sha256File(profilePath),
    directTestSHA256: sha256File(testPath),
    scopedDiffSHA256: sha256(
      execFileSync('git', ['diff', '--', profilePath, testPath], { cwd: repoRoot }),
    ),
  }
  let app = null,
    log = null,
    status = 'NOT_PASS',
    failure = null,
    bundleRemoved = false,
    stoppedSidecars = []
  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, config(sandbox, sidecarPort), { mode: 0o600 })
    const buildEnv = {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: cargoTarget,
      GOENV: 'off',
      GOPROXY: 'off',
      GOSUMDB: 'off',
      PNPM_CONFIG_OFFLINE: 'true',
      npm_config_offline: 'true',
    }
    delete buildEnv.GOROOT
    await runCommand('pnpm', ['build-only'], buildEnv)
    const frontend = prepareFrontend(sandbox, fixture.origin)
    provenance.builtDistIndexSHA256 = sha256File(join(repoRoot, 'dist/index.html'))
    provenance.injectedTestIndexSHA256 = sha256File(join(frontend, 'index.html'))
    const overlay = writeOverlay(sandbox, frontend, fixture.origin)
    await runCommand(
      'pnpm',
      ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'],
      buildEnv,
    )
    const plist = join(bundle, 'Contents/Info.plist'),
      executable = join(bundle, 'Contents/MacOS/hexclaw-desktop'),
      sidecar = join(bundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(plist) && existsSync(executable) && existsSync(sidecar))
    const identifier = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(identifier, bundleIdentifier)
    assert.equal(statSync(sandbox).mode & 0o777, 0o700)
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.deepEqual(listenerPIDs(sidecarPort), [])
    const logPath = join(sandbox, 'test-app.log')
    log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
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
      DINGTALK_LIVE_SEND: '0',
      NO_PROXY: '*',
      no_proxy: '*',
    }
    app = spawn(executable, [], {
      cwd: sandbox,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    app.stdout.pipe(log, { end: false })
    app.stderr.pipe(log, { end: false })
    await waitHealth(sidecarPort, app)
    const sidecarPIDs = listenerPIDs(sidecarPort)
    assert.equal(sidecarPIDs.length, 1)
    if (chatInstalledScenario) {
      const chat = (await waitReport(fixture.state, 'k12-chat-order-scroll')).observation
      const chatShot = capture(
        app.pid,
        join(evidenceRoot, 'test-app-installed-k12-chat-order-scroll.png'),
      )
      assert.equal(chat.runtime.hadTauriFlag, true)
      assert.equal(chat.runtime.hasTauriInternals, true)
      assert.deepEqual(chat.order, [
        { kind: 'message', id: chat.sourceMessageID },
        {
          kind: 'task',
          id: chat.taskID,
          sourceMessageID: chat.sourceMessageID,
        },
        { kind: 'message', id: chat.assistantMessageID },
      ])
      assert.equal(chat.taskID, fixtureData().chat.dispatchID)
      assert.equal(chat.taskSourceMessageID, chat.sourceMessageID)
      assert.ok(chat.contentUpdatedCount >= 1)
      assert.ok(chat.scrollBefore && chat.scrollAfter)
      for (const snapshot of [chat.scrollBefore, chat.scrollAfter]) {
        assert.ok(snapshot.scrollTop >= 0)
        assert.ok(snapshot.clientHeight > 0)
        assert.ok(snapshot.scrollHeight >= snapshot.clientHeight)
        assert.ok(snapshot.anchor?.id)
      }
      if (chat.scrollBefore.atBottom) assert.equal(chat.scrollAfter.atBottom, true)
      else assert.equal(chat.scrollAfter.anchor.id, chat.scrollBefore.anchor.id)
      assert.deepEqual(chat.runtimeErrors, [])
      assert.deepEqual(chat.unexpectedApi, [])
      assert.deepEqual(chat.blockedExternal, [])
      assert.deepEqual(fixture.state.unexpectedRequests, [])
      provenance.executableSHA256 = sha256File(executable)
      provenance.sidecarSHA256 = sha256File(sidecar)
      writeFileSync(
        join(evidenceRoot, 'test-app-installed-summary.json'),
        `${JSON.stringify({ issue: ['BUG-20260726-009', 'BUG-20260726-019'], conclusion: 'PASS', boundary: 'isolated-current-source-Test.app-real-WKWebView', app: { productName, identifier, nativeWindow: true, realWKWebView: true, appPID: app.pid, sidecarPID: sidecarPIDs[0] }, provenance, isolation: { runtimeHomeMode: '0700', configMode: '0600', uniqueBundleIdentifier: true, sidecarPort, fixturePort, applicationsDirectoryTouched: false, runtimeRealHomeUsed: false, userDataTouched: false, externalNetworkRequests: 0, realModelInvocations: 0, realIMInvocations: 0 }, entry: chat, screenshots: { chat: chatShot } }, null, 2)}\n`,
      )
    } else {
    const agents = await waitReport(fixture.state, 'agents-entry')
    const agentsShot = capture(app.pid, join(evidenceRoot, 'test-app-installed-agents-entry.png'))
    fixture.state.released.add('agents-entry')
    const weekly = await waitReport(fixture.state, 'weekly-entry')
    const weeklyShot = capture(app.pid, join(evidenceRoot, 'test-app-installed-weekly-entry.png'))
    fixture.state.released.add('weekly-entry')
    const agentsValue = agents.observation,
      weeklyValue = weekly.observation
    assert.equal(agentsValue.runtime.hadTauriFlag, true)
    assert.equal(agentsValue.runtime.hasTauriInternals, true)
    assert.equal(agentsValue.root.rect.width, 560)
    assert.ok(
      Math.abs(
        Number.parseFloat(agentsValue.body.maxHeight) - agentsValue.viewport.height * 0.7,
      ) < 0.02,
    )
    assert.deepEqual(agentsValue.mathSubjectExactSet, ['math'])
    assert.deepEqual(agentsValue.errors, [])
    // 智能体入口按验收合同默认聚焦“孩子称呼”输入框，而不是操作按钮。
    assert.equal(agentsValue.active.tag, 'INPUT')
    assert.equal(agentsValue.active.className, 'k12pf__input')
    assert.equal(agentsValue.scrollTop, 0)
    assert.deepEqual(weeklyValue.errors, [])
    assert.equal(weeklyValue.active.testid, 'k12-math-progress')
    assert.ok(weeklyValue.scrollTop > 0)
    assert.deepEqual(weeklyValue.mathSubjectExactSet, ['math'])
    assert.deepEqual(weeklyValue.runtimeErrors, [])
    assert.deepEqual(weeklyValue.unexpectedApi, [])
    assert.deepEqual(weeklyValue.blockedExternal, [])
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    provenance.executableSHA256 = sha256File(executable)
    provenance.sidecarSHA256 = sha256File(sidecar)
    writeFileSync(
      join(evidenceRoot, 'test-app-installed-summary.json'),
      `${JSON.stringify({ issue: 'BUG-20260728-006', conclusion: 'PASS', boundary: 'isolated-current-source-Test.app-real-WKWebView', app: { productName, identifier, nativeWindow: true, realWKWebView: true, appPID: app.pid, sidecarPID: sidecarPIDs[0] }, provenance, isolation: { runtimeHomeMode: '0700', configMode: '0600', uniqueBundleIdentifier: true, sidecarPort, fixturePort, applicationsDirectoryTouched: false, runtimeRealHomeUsed: false, userDataTouched: false, externalNetworkRequests: 0, realModelInvocations: 0, realIMInvocations: 0 }, entries: { agents: agentsValue, weekly: weeklyValue }, screenshots: { agents: agentsShot, weekly: weeklyShot } }, null, 2)}\n`,
    )
    }
    status = 'PASS'
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (app?.exitCode === null)
      try {
        capture(app.pid, join(evidenceRoot, 'test-app-failure.png'))
      } catch {}
    throw error
  } finally {
    await stopProcess(app)
    if (log) await new Promise((resolveEnd) => log.end(resolveEnd))
    try {
      stoppedSidecars = await stopSidecar(sidecarPort, bundle)
    } catch (error) {
      failure ||= error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    await fixture.close()
    const logPath = join(sandbox, 'test-app.log')
    if (existsSync(logPath))
      writeFileSync(
        join(evidenceRoot, 'test-app-installed.log'),
        readFileSync(logPath, 'utf8')
          .replaceAll(repoRoot, '<repo>')
          .replaceAll(sandbox, '<sandbox>'),
      )
    if (!existsSync(join(evidenceRoot, 'test-app-installed-summary.json')))
      writeFileSync(
        join(evidenceRoot, 'test-app-installed-summary.json'),
        `${JSON.stringify({ issue: chatInstalledScenario ? ['BUG-20260726-009', 'BUG-20260726-019'] : 'BUG-20260728-006', conclusion: status, error: failure, reports: fixture.state.reports }, null, 2)}\n`,
      )
    rmSync(bundle, { recursive: true, force: true })
    bundleRemoved = !existsSync(bundle)
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(
      join(evidenceRoot, 'test-app-installed-cleanup.json'),
      `${JSON.stringify({ status, appProcessStopped: !app || app.exitCode !== null || app.signalCode !== null, sidecarPortReleased: listenerPIDs(sidecarPort).length === 0, fixtureClosed: true, uniqueAppBundleRemoved: bundleRemoved, sandboxRemoved: !existsSync(sandbox), stoppedSidecars }, null, 2)}\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
