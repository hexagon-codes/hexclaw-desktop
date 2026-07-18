import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { e2eMarker } from './helpers'
import { cleanupSession } from './live-fixture-cleanup'

const USER_ID = 'desktop-user'
const PROVIDER_NAME = process.env.HEX_E2E_PROVIDER || '硅基流动'
const PREFERRED_MODEL = process.env.HEX_E2E_MODEL || 'Qwen/Qwen3.6-35B-A3B'
const DINGTALK_E2E_PREFIX = 'E2E DingTalk'
const createdSessionIds = new Set<string>()

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * 本地目录授权用例的工作目录：不再锚定某台开发机的绝对路径。
 * - HEX_E2E_WORK_DIR 可显式指定授权根目录（真机固定路径场景）；
 * - 缺省时测试自建临时目录（realpath 解开 macOS /var → /private/var 符号链接，
 *   避免 sandbox allowed_paths 与文件工具解析后的真实路径错位）。
 * 断言对象是测试自建的 fixture 子目录（唯一随机名），与机器环境无关。
 */
let WORK_DIR = ''
let WORK_DIR_FIXTURE_ENTRY = ''
let createdWorkDirRoot = false

function ensureWorkDirFixture(): void {
  if (WORK_DIR) return
  const configured = (process.env.HEX_E2E_WORK_DIR || '').trim()
  if (configured) {
    WORK_DIR = configured.replace(/\/+$/, '') || '/'
  } else {
    WORK_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hexclaw-e2e-work-'))
    createdWorkDirRoot = true
  }
  WORK_DIR_FIXTURE_ENTRY = e2eMarker('e2e-live-fixture')
  fs.mkdirSync(path.join(WORK_DIR, WORK_DIR_FIXTURE_ENTRY), { recursive: true })
}

function cleanupWorkDirFixture(): void {
  if (!WORK_DIR) return
  fs.rmSync(path.join(WORK_DIR, WORK_DIR_FIXTURE_ENTRY), { recursive: true, force: true })
  if (createdWorkDirRoot) fs.rmSync(WORK_DIR, { recursive: true, force: true })
  WORK_DIR = ''
  WORK_DIR_FIXTURE_ENTRY = ''
  createdWorkDirRoot = false
}

async function apiJSON<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await request.fetch(`/_hexclaw${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    data: body,
  })
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`${method} ${path} failed: ${response.status()} ${text}`)
  }
  return text ? (JSON.parse(text) as T) : ({} as T)
}

async function resolveLiveModel(request: APIRequestContext): Promise<string> {
  const cfg = await apiJSON<{
    providers?: Record<string, { model?: string; models?: string[]; api_key?: string; enabled?: boolean }>
  }>(request, 'GET', '/api/v1/config/llm')

  const provider = cfg.providers?.[PROVIDER_NAME]
  // 环境前置改显式 skip（20260712 套件卫生）：目标引擎没配 ${PROVIDER_NAME} 时这是
  // 「环境缺前置」不是「产品失败」——skip 带原因，红绿灯报告不再被误染红。
  test.skip(!provider || provider.enabled === false || !(provider.api_key || '').trim(),
    `目标引擎未配置可用的 ${PROVIDER_NAME} provider（需 API Key），跳过依赖它的真模型用例`)

  const models = provider?.models || []
  if (models.includes(PREFERRED_MODEL)) return PREFERRED_MODEL
  return provider?.model || models[0] || PREFERRED_MODEL
}

async function createToolOnlyBlocksSession(request: APIRequestContext, marker: string): Promise<string> {
  const sessionId = e2eMarker('e2e-tool-only')
  await apiJSON(request, 'POST', `/api/v1/sessions?user_id=${encodeURIComponent(USER_ID)}`, {
    id: sessionId,
    title: `E2E tool-only ${marker}`,
    user_id: USER_ID,
  })
  createdSessionIds.add(sessionId)
  await apiJSON(request, 'POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch?user_id=${encodeURIComponent(USER_ID)}`, {
    messages: [
      {
        id: `${sessionId}-u`,
        role: 'user',
        content: '我的知识库有哪些文件？',
      },
      {
        id: `${sessionId}-a`,
        role: 'assistant',
        content: `知识库文件列表 ${marker}: AI 生态链.txt`,
        metadata: {
          blocks: [
            {
              type: 'tool_use',
              id: `toolu-${marker}`,
              name: 'session_search',
              input: { query: '我的知识库有哪些文件？' },
            },
          ],
          tool_calls: [
            {
              id: `toolu-${marker}`,
              name: 'session_search',
              arguments: { query: '我的知识库有哪些文件？' },
              status: 'completed',
              result: 'AI 生态链.txt',
            },
          ],
        },
      },
    ],
  })
  return sessionId
}

async function createEmptySession(request: APIRequestContext, title: string): Promise<string> {
  const sessionId = e2eMarker('e2e-empty')
  await apiJSON(request, 'POST', `/api/v1/sessions?user_id=${encodeURIComponent(USER_ID)}`, {
    id: sessionId,
    title,
    user_id: USER_ID,
  })
  createdSessionIds.add(sessionId)
  return sessionId
}

async function cleanupCreatedSessions(request: APIRequestContext): Promise<void> {
  for (const sessionId of createdSessionIds) {
    await cleanupSession(request, sessionId)
  }
  createdSessionIds.clear()
}

async function installTauriBridge(
  page: Page,
  options: {
    dingtalkInstance?: Record<string, JsonValue>
    dingtalkTestInstanceId?: string
    dingtalkSuccessAfter?: number
    lastSessionId?: string
  } = {},
): Promise<void> {
  await page.addInitScript(({ dingtalkInstance, dingtalkTestInstanceId, dingtalkSuccessAfter, lastSessionId }) => {
    sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
    localStorage.removeItem('hexclaw:connectorInstances')
    if (lastSessionId) localStorage.setItem('hexclaw_lastSessionId', lastSessionId)
    else localStorage.removeItem('hexclaw_lastSessionId')

    const callbacks: Record<number, (...args: unknown[]) => void> = {}
    let nextCallbackId = 1
    let nextRid = 1
    const ridToPath: Record<number, string> = {}
    const pathToRid: Record<string, number> = {}
    const stores: Record<string, Record<string, unknown>> = {
      'im-channels.json': dingtalkInstance
        ? { 'im-instances': { [String(dingtalkInstance.id)]: dingtalkInstance } }
        : {},
      'secure.dat': {},
    }

    function storeFor(path: string) {
      stores[path] ||= {}
      return stores[path]!
    }

    function runtimeDingTalkTestResult(successAfterValue: unknown) {
      const key = '__HC_E2E_DINGTALK_TEST_CALLS__'
      const current = Number((window as unknown as Record<string, unknown>)[key] || 0) + 1
      ;(window as unknown as Record<string, unknown>)[key] = current
      const successAfter = Number(successAfterValue || 3)
      if (current < successAfter) {
        return JSON.stringify({
          success: false,
          message: 'dingtalk Stream 未连接（连接中，请稍候重试）',
        })
      }
      return JSON.stringify({ success: true, message: '实例健康检查通过' })
    }

    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawURL = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(rawURL, window.location.origin)
      const method = String(init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
      const path = url.pathname.replace(/^\/_hexclaw/, '')
      const dingtalkName = dingtalkInstance?.name ? String(dingtalkInstance.name) : ''
      const encodedName = encodeURIComponent(dingtalkName)
      if (method === 'POST' && path.startsWith('/api/v1/platforms/instances/') && path.endsWith('/test')) {
        return new Response(runtimeDingTalkTestResult(dingtalkSuccessAfter), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'POST' && dingtalkName && path === `/api/v1/platforms/instances/${encodedName}/test`) {
        return new Response(runtimeDingTalkTestResult(dingtalkSuccessAfter), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (
        method === 'POST'
        && dingtalkTestInstanceId
        && path === `/api/v1/platforms/instances/by-id/${encodeURIComponent(String(dingtalkTestInstanceId))}/test`
      ) {
        return new Response(runtimeDingTalkTestResult(dingtalkSuccessAfter), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return realFetch(input, init)
    }

    async function fetchProxy(method: string, path: string, body: string | null | undefined): Promise<string> {
      const dingtalkName = dingtalkInstance?.name ? String(dingtalkInstance.name) : ''
      const encodedName = encodeURIComponent(dingtalkName)

      if (method === 'GET' && path === '/health') {
        return JSON.stringify({ status: 'healthy' })
      }

      if (method === 'GET' && path === '/api/v1/platforms/instances/health' && dingtalkName) {
        return JSON.stringify({
          instances: [{ name: dingtalkName, provider: 'dingtalk', status: 'running', last_error: '' }],
        })
      }

      if (method === 'POST' && path === '/api/v1/platforms/instances' && body) {
        const parsed = JSON.parse(body) as { provider?: string; name?: string }
        if (parsed.provider === 'dingtalk') {
          return JSON.stringify({ ok: true, name: parsed.name })
        }
      }

      if (method === 'POST' && dingtalkName && path === `/api/v1/platforms/instances/${encodedName}/test`) {
        return runtimeDingTalkTestResult(dingtalkSuccessAfter)
      }

      if (
        method === 'POST'
        && dingtalkTestInstanceId
        && path === `/api/v1/platforms/instances/by-id/${encodeURIComponent(String(dingtalkTestInstanceId))}/test`
      ) {
        return runtimeDingTalkTestResult(dingtalkSuccessAfter)
      }

      const response = await fetch(`/_hexclaw${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ?? undefined,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`)
      return text
    }

    ;(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {},
    }

    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: {},
      transformCallback(callback: (...args: unknown[]) => void) {
        const id = nextCallbackId++
        callbacks[id] = callback
        return id
      },
      unregisterCallback(id: number) {
        delete callbacks[id]
      },
      convertFileSrc(path: string) {
        return path
      },
      async invoke(cmd: string, args?: Record<string, unknown>) {
        if (cmd === 'plugin:event|listen') return nextCallbackId++
        if (cmd === 'plugin:event|unlisten') return null
        if (cmd === 'plugin:event|emit') return null
        if (cmd === 'check_engine_health') return true
        if (cmd === 'get_sidecar_status') {
          return { ready: true, base_url: `${window.location.origin}/_hexclaw`, port: 0 }
        }
        if (cmd === 'restart_sidecar') return 'sidecar restarted'

        if (cmd === 'backend_chat') {
          const params = (args?.params || {}) as Record<string, unknown>
          return fetchProxy('POST', '/api/v1/chat', JSON.stringify({
            message: params.message,
            session_id: params.session_id,
            role: params.role,
            provider: params.provider,
            user_id: params.user_id || 'desktop-user',
            model: params.model,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            request_id: params.request_id,
            metadata: params.metadata,
            attachments: params.attachments,
          }))
        }

        if (cmd === 'proxy_api_request') {
          return fetchProxy(
            String(args?.method || 'GET'),
            String(args?.path || '/'),
            args?.body == null ? null : String(args.body),
          )
        }

        if (cmd === 'plugin:store|load') {
          const path = String(args?.path || 'store.json')
          const rid = pathToRid[path] || nextRid++
          pathToRid[path] = rid
          ridToPath[rid] = path
          storeFor(path)
          return rid
        }
        if (cmd === 'plugin:store|get_store') {
          const path = String(args?.path || 'store.json')
          return pathToRid[path] || null
        }

        if (cmd.startsWith('plugin:store|')) {
          const rid = Number(args?.rid)
          const path = ridToPath[rid] || 'store.json'
          const store = storeFor(path)
          const key = args?.key == null ? '' : String(args.key)
          switch (cmd) {
            case 'plugin:store|set':
              store[key] = args?.value
              return null
            case 'plugin:store|get': {
              const exists = Object.prototype.hasOwnProperty.call(store, key)
              return [exists ? store[key] : null, exists]
            }
            case 'plugin:store|has':
              return Object.prototype.hasOwnProperty.call(store, key)
            case 'plugin:store|delete':
              delete store[key]
              return null
            case 'plugin:store|clear':
            case 'plugin:store|reset':
              for (const k of Object.keys(store)) delete store[k]
              return null
            case 'plugin:store|keys':
              return Object.keys(store)
            case 'plugin:store|values':
              return Object.values(store)
            case 'plugin:store|entries':
              return Object.entries(store)
            case 'plugin:store|length':
              return Object.keys(store).length
            case 'plugin:store|reload':
            case 'plugin:store|save':
              return null
          }
        }

        if (cmd === 'plugin:store|close') return null
        return null
      },
    }
  }, options)
}

async function createRuntimeDingTalkInstance(request: APIRequestContext, name: string): Promise<string> {
  try {
    const created = await apiJSON<{ id?: string }>(request, 'POST', '/api/v1/platforms/instances', {
      provider: 'dingtalk',
      name,
      enabled: true,
      config: {
        app_key: 'fake-app-key',
        app_secret: 'fake-app-secret',
        robot_code: 'fake-robot-code',
      },
    })
    expect(created.id, 'sidecar should return a persisted instance id').toBeTruthy()
    return String(created.id)
  } catch (err) {
    if (String(err).includes('provider dingtalk 已被启动策略禁用')) {
      return e2eMarker('synthetic-dingtalk')
    }
    throw err
  }
}

async function cleanupRuntimeDingTalkInstances(request: APIRequestContext): Promise<void> {
  const payload = await apiJSON<{
    instances?: Array<{ id?: string; name?: string; provider?: string }>
  }>(request, 'GET', '/api/v1/platforms/instances')
  for (const inst of payload.instances || []) {
    if (inst.provider === 'dingtalk' && inst.id && (inst.name || '').startsWith(DINGTALK_E2E_PREFIX)) {
      await deleteRuntimeInstance(request, inst.id)
    }
  }
}

async function deleteRuntimeInstance(request: APIRequestContext, id: string): Promise<void> {
  try {
    await apiJSON(request, 'DELETE', `/api/v1/platforms/instances/by-id/${encodeURIComponent(id)}`)
  } catch {
    // best-effort cleanup; the instance name is timestamped so stale rows do not break later tests
  }
}

async function openApp(page: Page, path: string, options?: Parameters<typeof installTauriBridge>[1]) {
  await installTauriBridge(page, options)
  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
}

async function waitForAssistantText(page: Page, expected: RegExp, timeout = 180_000): Promise<string> {
  const assistant = page.getByTestId('chat-message-assistant').last()
  await expect(assistant).toBeVisible({ timeout })
  await expect
    .poll(
      async () => (await assistant.innerText()).replace(/\s+/g, ' ').trim(),
      { timeout, message: `assistant reply should match ${expected}` },
    )
    .toMatch(expected)
  return (await assistant.innerText()).replace(/\s+/g, ' ').trim()
}

function isTransientLLMFailureText(text: string): boolean {
  return /(?:unexpected\s+eof|\beof\b|tls handshake timeout|connection reset|socket hang up|timeout awaiting response headers)/i.test(text)
    && /(?:siliconflow|api\.siliconflow|openai (?:complete|stream) request failed|runtime stream|chat\/completions)/i.test(text)
}

function isRetryableLiveLLMFailure(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error)
  return isTransientLLMFailureText(text)
    || /LIVE_SIDECAR_DISCONNECTED|assistant reply should match/i.test(text)
}

async function waitForAssistantTextOrTransientError(page: Page, expected: RegExp, timeout = 180_000): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const pageText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '')
    if (isTransientLLMFailureText(pageText)) {
      throw new Error(`TRANSIENT_LLM_FAILURE: ${pageText.slice(-800)}`)
    }
    if (/Hexagon 引擎未连接|引擎未连接/.test(pageText)) {
      throw new Error(`LIVE_SIDECAR_DISCONNECTED: ${pageText.slice(-800)}`)
    }
    const assistant = page.getByTestId('chat-message-assistant').last()
    if (await assistant.isVisible().catch(() => false)) {
      const text = (await assistant.innerText()).replace(/\s+/g, ' ').trim()
      if (expected.test(text)) return text
      if (isTransientLLMFailureText(text)) {
        throw new Error(`TRANSIENT_LLM_FAILURE: ${text}`)
      }
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`assistant reply should match ${expected}`)
}

async function retryLiveLLMClosure<T>(action: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isRetryableLiveLLMFailure(error)) throw error
    }
  }
  throw lastError
}

async function expectPendingOrAssistantVisible(page: Page, timeout = 2_500): Promise<void> {
  await expect
    .poll(
      async () => {
        const pending = await page.getByTestId('chat-assistant-pending').count()
        const assistant = await page.getByTestId('chat-message-assistant').count()
        return pending + assistant
      },
      { timeout, message: 'send should quickly show either a pending bubble or a completed assistant bubble' },
    )
    .toBeGreaterThan(0)
}

async function withCodeExecAutoApproval<T>(page: Page, action: () => Promise<T>): Promise<T> {
  let approved = 0
  let stop = false

  const worker = (async () => {
    while (!stop) {
      const card = page.locator('.hc-approval:not(.hc-approval--responded)').filter({ hasText: 'code_exec' }).first()
      if (await card.isVisible().catch(() => false)) {
        const button = card.locator('.hc-approval__btn--approve')
        if (await button.isVisible().catch(() => false)) {
          await button.click()
          approved += 1
        }
      }
      await page.waitForTimeout(250)
    }
  })()

  let result: T | undefined
  let actionError: unknown
  try {
    result = await action()
  } catch (err) {
    actionError = err
  } finally {
    stop = true
    await worker
  }

  if (actionError) throw actionError
  expect(approved, 'code_exec approval should be requested and approved at least once').toBeGreaterThan(0)
  return result as T
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text)
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('chat-message-user').filter({ hasText: text.slice(0, 80) })).toBeVisible()
  await expectPendingOrAssistantVisible(page, 5_000)
}

test.describe.serial('bugfix real browser click closure', () => {
  test.setTimeout(600_000)

  test.beforeAll(async ({ request }) => {
    ensureWorkDirFixture()
    await cleanupRuntimeDingTalkInstances(request)
  })

  test.afterAll(async ({ request }) => {
    cleanupWorkDirFixture()
    await cleanupRuntimeDingTalkInstances(request)
    await cleanupCreatedSessions(request)
  })

  test('local folder grant, real model reply, pending bubble, and regenerate replacement', async ({ page, request }) => {
    const model = await resolveLiveModel(request)
    await openApp(page, '/channels')

    await page.getByTestId('segmented-connectors').click()
    await page.getByTestId('connections-add').click()
    await page.getByTestId('connector-type-localFolder').click()
    await page.getByTestId('connector-name-input').fill(`E2E Work ${e2eMarker('work')}`)
    await page.getByTestId('connector-config-path').fill(`${WORK_DIR}/`)
    const enabled = page.getByTestId('connector-enabled')
    if (!(await enabled.isChecked())) await page.getByTestId('connector-enabled-toggle').click()
    await page.getByTestId('connector-save').click()

    await expect(page.getByTestId('connector-card-localFolder')).toBeVisible()
    await expect
      .poll(
        async () => {
          const cfg = await apiJSON<{ sandbox?: { allowed_paths?: string[] } }>(request, 'GET', '/api/v1/config')
          return cfg.sandbox?.allowed_paths || []
        },
        { timeout: 20_000, message: 'local folder connector should sync into sandbox.allowed_paths' },
      )
      .toContain(WORK_DIR)

    const marker = e2eMarker('local-list')
    await page.goto(`/chat?model=${encodeURIComponent(model)}`)
    await page.getByTestId('chat-input').fill(
      `请求标记 ${marker}。请必须调用本地文件列表工具读取 ${WORK_DIR} 的一级目录。最终只输出你真实看到的目录名，每行一个；不要编造。`,
    )
    await page.getByTestId('chat-send').click()

    await expect(page.getByTestId('chat-message-user').filter({ hasText: WORK_DIR })).toBeVisible()
    await expectPendingOrAssistantVisible(page)

    const firstReply = await waitForAssistantText(page, new RegExp(WORK_DIR_FIXTURE_ENTRY), 300_000)
    expect(firstReply).not.toMatch(/Access denied|outside allowed directories|not in \/private\/tmp/i)

    await page.getByTestId('chat-message-assistant').last().hover()
    await page.getByTestId('message-regenerate').last().click({ force: true })
    await expect
      .poll(
        async () => await page.getByTestId('chat-message-assistant').count(),
        { timeout: 5_000, message: 'regenerate should remove the old assistant bubble before replaying' },
      )
      .toBeLessThanOrEqual(1)

    const secondReply = await waitForAssistantText(page, new RegExp(WORK_DIR_FIXTURE_ENTRY), 300_000)
    expect(secondReply).not.toMatch(/Access denied|outside allowed directories|not in \/private\/tmp/i)
    await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1)
  })

  test('local folder disable clears the synced sandbox grant and keeps paths normalized', async ({ page, request }) => {
    await openApp(page, '/channels')

    await page.getByTestId('segmented-connectors').click()
    await page.getByTestId('connections-add').click()
    await page.getByTestId('connector-type-localFolder').click()
    await page.getByTestId('connector-name-input').fill(`E2E Work Disable ${e2eMarker('work-disable')}`)
    await page.getByTestId('connector-config-path').fill(`${WORK_DIR}////`)
    const enabled = page.getByTestId('connector-enabled')
    if (!(await enabled.isChecked())) await page.getByTestId('connector-enabled-toggle').click()
    await page.getByTestId('connector-save').click()

    await expect(page.getByTestId('connector-card-localFolder')).toBeVisible()
    await expect
      .poll(
        async () => {
          const cfg = await apiJSON<{ sandbox?: { allowed_paths?: string[] } }>(request, 'GET', '/api/v1/config')
          return (cfg.sandbox?.allowed_paths || []).filter((path) => path === WORK_DIR).length
        },
        { timeout: 20_000, message: 'local folder connector should sync a single normalized sandbox path' },
      )
      .toBe(1)

    await page.getByTestId('connector-toggle-localFolder').first().click()
    await expect
      .poll(
        async () => {
          const cfg = await apiJSON<{ sandbox?: { allowed_paths?: string[] } }>(request, 'GET', '/api/v1/config')
          return cfg.sandbox?.allowed_paths || []
        },
        { timeout: 20_000, message: 'disabled local folder connector should be removed from sandbox.allowed_paths' },
      )
      .not.toContain(WORK_DIR)
  })

  test('tool-only assistant blocks keep the textual answer visible after reload', async ({ page, request }) => {
    const marker = e2eMarker('fallback')
    const sessionId = await createToolOnlyBlocksSession(request, marker)
    await openApp(page, '/chat', { lastSessionId: sessionId })

    const assistant = page.getByTestId('chat-message-assistant').last()
    await expect(assistant).toBeVisible({ timeout: 30_000 })
    await expect(assistant).toContainText(marker)
    await expect(assistant).toContainText('AI 生态链.txt')
    await expect(assistant).toContainText('session_search')
  })

  test('DingTalk runtime test retries transient stream-connecting status from real click path', async ({ page, request }) => {
    const name = `${DINGTALK_E2E_PREFIX} ${e2eMarker('ok')}`
    const id = await createRuntimeDingTalkInstance(request, name)
    try {
      await openApp(page, '/channels', {
        dingtalkTestInstanceId: id,
        dingtalkInstance: { id, name, provider: 'dingtalk', enabled: true },
      })
      const card = page.getByTestId('channel-card-dingtalk').filter({ hasText: name })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByTestId('channel-test-dingtalk').click()

      await expect(card.getByTestId('channel-test-result-dingtalk')).toContainText('实例健康检查通过', {
        timeout: 10_000,
      })
      await expect
        .poll(async () => page.evaluate(() => Number((window as unknown as Record<string, unknown>).__HC_E2E_DINGTALK_TEST_CALLS__ || 0)), {
          timeout: 5_000,
          message: 'DingTalk transient health test should retry twice before success',
        })
        .toBe(3)
    } finally {
      await deleteRuntimeInstance(request, id)
    }
  })

  test('DingTalk runtime test reports transient failure after bounded retries', async ({ page, request }) => {
    const name = `${DINGTALK_E2E_PREFIX} Fail ${e2eMarker('fail')}`
    const id = await createRuntimeDingTalkInstance(request, name)
    try {
      await openApp(page, '/channels', {
        dingtalkTestInstanceId: id,
        dingtalkSuccessAfter: 99,
        dingtalkInstance: { id, name, provider: 'dingtalk', enabled: true },
      })
      const card = page.getByTestId('channel-card-dingtalk').filter({ hasText: name })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByTestId('channel-test-dingtalk').click()

      await expect(card.getByTestId('channel-test-result-dingtalk')).toContainText('dingtalk Stream 未连接', {
        timeout: 10_000,
      })
      await expect
        .poll(async () => page.evaluate(() => Number((window as unknown as Record<string, unknown>).__HC_E2E_DINGTALK_TEST_CALLS__ || 0)), {
          timeout: 5_000,
          message: 'DingTalk transient health test should stop after the retry budget',
        })
        .toBe(3)
    } finally {
      await deleteRuntimeInstance(request, id)
    }
  })
})

test.describe.serial('code_exec real browser user closure', () => {
  test.setTimeout(600_000)

  test.afterAll(async ({ request }) => {
    await cleanupCreatedSessions(request)
  })

  test('user approves model-written Python shell calculation and receives executed result', async ({ page, request }) => {
    const model = await resolveLiveModel(request)
    const prompt = `请调用 code_exec 且只调用一次，自己写并运行 Python 脚本完成任务，不要心算，不要直接给结论。
订单数据：A 3*19，B 2*41，A 5*19，C 7*11。
脚本必须计算每个 SKU revenue、总 revenue、最大 SKU，并计算 sha256("A:152|B:82|C:77") 前 12 位。
脚本 stdout 必须只 print 这一行：PY_UI_CODE_EXEC_OK total_revenue=311 best_sku=A checksum=a965ccb2218b
拿到工具结果后不要再次调用 code_exec，最终回答必须逐字包含这行 stdout。`

    const reply = await retryLiveLLMClosure(async () => {
      const sessionId = await createEmptySession(request, `E2E code_exec shell ${e2eMarker('shell')}`)
      await openApp(page, `/chat?model=${encodeURIComponent(model)}`, { lastSessionId: sessionId })
      return withCodeExecAutoApproval(page, async () => {
        await sendChatMessage(page, prompt)
        return waitForAssistantTextOrTransientError(
          page,
          /PY_UI_CODE_EXEC_OK[\s\S]*total_revenue=311[\s\S]*best_sku=A[\s\S]*checksum=a965ccb2218b/,
          180_000,
        )
      })
    })
    expect(reply).toContain('PY_UI_CODE_EXEC_OK')
    expect(reply).not.toMatch(/requires approval|user denied|runtime_missing|ModuleNotFoundError|被拒绝|拒绝|无法执行|未执行|blocked by hook/i)
  })

  test('user approves model-written Python crawler and receives parsed page result', async ({ page, request }) => {
    const model = await resolveLiveModel(request)
    const prompt = `请调用 code_exec 一次，自己写并运行 Python 网络爬虫脚本，不要直接给结论。
要求只使用 Python 标准库 urllib.request 和 re，抓取 http://example.com/，解析 <title> 文本，统计 href 链接数量和 HTML 字节数。
最终回答必须包含脚本 stdout 里的这一行：PY_UI_CRAWL_OK title=Example Domain hrefs=2 bytes=559`

    const reply = await retryLiveLLMClosure(async () => {
      const sessionId = await createEmptySession(request, `E2E code_exec crawler ${e2eMarker('crawler')}`)
      await openApp(page, `/chat?model=${encodeURIComponent(model)}`, { lastSessionId: sessionId })
      return withCodeExecAutoApproval(page, async () => {
        await sendChatMessage(page, prompt)
        return waitForAssistantTextOrTransientError(
          page,
          /PY_UI_CRAWL_OK[\s\S]*title=Example Domain[\s\S]*hrefs=2[\s\S]*bytes=559/,
          180_000,
        )
      })
    })
    expect(reply).toContain('PY_UI_CRAWL_OK')
    expect(reply).not.toMatch(/Operation not permitted|CRAWL_ERROR|runtime_missing|被拒绝|拒绝|无法执行|未执行|blocked by hook/i)
  })
})
