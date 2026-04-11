/**
 * Chain B: IM Channels -> Backend Sync
 *
 * Tests the IM instance lifecycle: create/update/delete with backend sync,
 * test endpoints, required field validation, and deduplication of sync calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────

const { mockInvoke, mockLoad } = vi.hoisted(() => {
  const storeData = new Map<string, unknown>()
  return {
    mockInvoke: vi.fn().mockResolvedValue('{}'),
    mockLoad: vi.fn().mockResolvedValue({
      get: vi.fn((key: string) => Promise.resolve(storeData.get(key))),
      set: vi.fn((key: string, val: unknown) => { storeData.set(key, val); return Promise.resolve() }),
      save: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: mockLoad,
}))

vi.mock('@/utils/errors', () => ({
  messageFromUnknownError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
  fromNativeError: vi.fn((e: unknown) => ({
    code: 'UNKNOWN',
    message: e instanceof Error ? e.message : String(e),
  })),
  fromHttpStatus: vi.fn((status: number) => ({
    code: 'SERVER_ERROR',
    message: `HTTP ${status}`,
  })),
}))

vi.mock('@/config/env', () => ({
  OLLAMA_BASE: 'http://localhost:11434', env: { apiBase: 'http://localhost:9870' },
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // Default: invoke returns valid JSON
  mockInvoke.mockResolvedValue('{}')
})

afterEach(() => {
  vi.restoreAllMocks()
  // Reset module cache to clear _store singleton
  vi.resetModules()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain B: IM Channels -> Backend Sync', () => {
  it('B1: createIMInstance saves to local store AND syncs to backend (proxyApiRequest POST)', async () => {
    // proxyApiRequest for sync: POST to /api/v1/platforms/instances
    mockInvoke.mockResolvedValue('{"message":"ok"}')

    const { createIMInstance } = await import('@/api/im-channels')

    const instance = await createIMInstance(
      'My Feishu Bot',
      'feishu',
      { app_id: 'cli_xxx', app_secret: 'secret123' },
      true,
    )

    expect(instance.name).toBe('My Feishu Bot')
    expect(instance.type).toBe('feishu')
    expect(instance.enabled).toBe(true)
    expect(instance.id).toBeDefined()

    // Verify backend sync was called via invoke('proxy_api_request')
    expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'POST',
      path: '/api/v1/platforms/instances',
    }))

    // Verify the body contains correct payload
    const syncCall = mockInvoke.mock.calls.find(
      (c) => c[0] === 'proxy_api_request' && JSON.parse(c[1]?.body || '{}').provider === 'feishu',
    )
    expect(syncCall).toBeDefined()
  })

  it('B2: updateIMInstance syncs changes to backend', async () => {
    mockInvoke.mockResolvedValue('{"message":"ok"}')

    const { createIMInstance, updateIMInstance } = await import('@/api/im-channels')

    const instance = await createIMInstance(
      'DingTalk Bot',
      'dingtalk',
      { app_key: 'key1', app_secret: 'sec1', robot_code: 'robot1' },
      false,
    )

    vi.clearAllMocks()
    mockInvoke.mockResolvedValue('{"message":"ok"}')

    const result = await updateIMInstance(instance.id, { enabled: true })

    expect(result).toBe(true)
    // Should have called proxy_api_request for sync
    expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'POST',
      path: '/api/v1/platforms/instances',
    }))
  })

  it('B3: deleteIMInstance calls backend DELETE then removes from local store', async () => {
    mockInvoke.mockResolvedValue('{"message":"ok"}')

    const { createIMInstance, deleteIMInstance, getIMInstances } = await import('@/api/im-channels')

    const instance = await createIMInstance(
      'Discord Bot',
      'discord',
      { token: 'bot-token-123' },
      true,
    )

    vi.clearAllMocks()
    mockInvoke.mockResolvedValue('{"message":"ok"}')

    const result = await deleteIMInstance(instance.id)

    expect(result).toBe(true)

    // Verify backend DELETE was called with the instance name
    expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'DELETE',
      path: `/api/v1/platforms/instances/${encodeURIComponent('Discord Bot')}`,
    }))

    // After delete, instance should not be in local store
    const instances = await getIMInstances()
    expect(instances.find((i) => i.id === instance.id)).toBeUndefined()
  })

  it('B4: testIMInstance calls correct test endpoint per platform', async () => {
    // First call: health check (GET /health) succeeds
    // Second call: test endpoint (POST /api/v1/im/channels/feishu/test) returns success
    mockInvoke
      .mockResolvedValueOnce('{}')   // health check
      .mockResolvedValueOnce('{"success":true,"message":"Connected"}')  // test

    const { testIMInstance } = await import('@/api/im-channels')

    const result = await testIMInstance({
      id: 'inst1',
      name: 'Feishu Bot',
      type: 'feishu',
      enabled: true,
      config: { app_id: 'cli_xxx', app_secret: 'secret' },
      createdAt: Date.now(),
    })

    expect(result.success).toBe(true)
    expect(result.message).toBe('Connected')

    // Verify it called the feishu-specific test endpoint
    expect(mockInvoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'POST',
      path: '/api/v1/im/channels/feishu/test',
    }))
  })

  it('B5: testSavedIMInstanceRuntime skips connectivity test for disabled instances', async () => {
    mockInvoke.mockResolvedValue('{}')

    const { testSavedIMInstanceRuntime } = await import('@/api/im-channels')

    const result = await testSavedIMInstanceRuntime({
      id: 'inst1',
      name: 'Telegram Bot',
      type: 'telegram',
      enabled: false,
      config: { token: 'bot-token' },
      createdAt: Date.now(),
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('disabled')
  })

  it('B6: getRequiredFieldLabels correctly identifies missing required fields', async () => {
    const { getRequiredFieldLabels } = await import('@/api/im-channels')

    // Feishu with no config - should report app_id and app_secret as missing
    const missingFeishu = getRequiredFieldLabels({ type: 'feishu', config: {} })
    expect(missingFeishu).toContain('App ID')
    expect(missingFeishu).toContain('App Secret')
    // verification_token is optional, should NOT be in missing
    expect(missingFeishu).not.toContain('验证 Token（选填）')

    // DingTalk with partial config
    const missingDing = getRequiredFieldLabels({
      type: 'dingtalk',
      config: { app_key: 'key1' },
    })
    expect(missingDing).toContain('App Secret')
    expect(missingDing).toContain('Robot Code')
    expect(missingDing).not.toContain('App Key') // already filled

    // Discord fully filled
    const missingDiscord = getRequiredFieldLabels({
      type: 'discord',
      config: { token: 'abc' },
    })
    expect(missingDiscord).toHaveLength(0)
  })

  it('B7: getRequiredFieldLabels excludes optional fields (like wechat aes_key)', async () => {
    const { getRequiredFieldLabels } = await import('@/api/im-channels')

    // WeChat with required fields filled but optional aes_key empty
    const missing = getRequiredFieldLabels({
      type: 'wechat',
      config: { app_id: 'wx123', app_secret: 'secret', token: 'tok' },
    })
    // aes_key is optional so it should NOT appear
    expect(missing).toHaveLength(0)

    // WeChat with NO required fields filled
    const missingAll = getRequiredFieldLabels({ type: 'wechat', config: {} })
    // Should have app_id, app_secret, token but NOT aes_key
    expect(missingAll.length).toBe(3)
    expect(missingAll).not.toContain('消息加密密钥（选填）')
  })

  it('B8: ensureIMInstancesSyncedToBackend deduplicates concurrent calls', async () => {
    mockInvoke.mockResolvedValue('{"instances":[]}')

    const { ensureIMInstancesSyncedToBackend } = await import('@/api/im-channels')

    // Call twice concurrently - should only trigger one sync
    const p1 = ensureIMInstancesSyncedToBackend()
    const p2 = ensureIMInstancesSyncedToBackend()

    await Promise.all([p1, p2])

    // The GET /api/v1/platforms/instances (list backend instances) should have been called
    // only once due to dedup
    const listCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === 'proxy_api_request' && c[1]?.method === 'GET' && c[1]?.path === '/api/v1/platforms/instances',
    )
    expect(listCalls.length).toBe(1)
  })
})
