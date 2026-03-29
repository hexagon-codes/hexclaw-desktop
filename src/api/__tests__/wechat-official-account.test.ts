/**
 * 微信公众号接入 — 全场景覆盖测试
 *
 * 验证从配置字段定义、元数据、CRUD、验证到源码清洁度的完整链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CHANNEL_TYPES,
  CHANNEL_CONFIG_FIELDS,
  getChannelMeta,
  getChannelHelpText,
  getRequiredFieldLabels,
  getPlatformHookUrl,
} from '../im-channels'

// ────────────────────────────────────────────────────────
// 1. 微信公众号配置字段完整性
// ────────────────────────────────────────────────────────

describe('wechat config fields', () => {
  const fields = CHANNEL_CONFIG_FIELDS.wechat

  it('has exactly 4 fields: app_id, app_secret, token, aes_key', () => {
    const keys = fields.map((f) => f.key)
    expect(keys).toEqual(['app_id', 'app_secret', 'token', 'aes_key'])
  })

  it('app_id is non-secret, required, with wx... placeholder', () => {
    const f = fields.find((f) => f.key === 'app_id')!
    expect(f.secret).toBeFalsy()
    expect(f.optional).toBeFalsy()
    expect(f.placeholder).toContain('wx')
  })

  it('app_secret is secret and required', () => {
    const f = fields.find((f) => f.key === 'app_secret')!
    expect(f.secret).toBe(true)
    expect(f.optional).toBeFalsy()
  })

  it('token is secret and required', () => {
    const f = fields.find((f) => f.key === 'token')!
    expect(f.secret).toBe(true)
    expect(f.optional).toBeFalsy()
  })

  it('aes_key is secret and optional', () => {
    const f = fields.find((f) => f.key === 'aes_key')!
    expect(f.secret).toBe(true)
    expect(f.optional).toBe(true)
    expect(f.placeholder).toContain('43')
  })

  it('all fields have both zh and en labels', () => {
    for (const f of fields) {
      expect(f.label, `${f.key} missing label`).toBeTruthy()
      expect(f.labelEn, `${f.key} missing labelEn`).toBeTruthy()
    }
  })
})

// ────────────────────────────────────────────────────────
// 2. 微信通道元数据
// ────────────────────────────────────────────────────────

describe('wechat channel meta', () => {
  it('exists in CHANNEL_TYPES', () => {
    const wechat = CHANNEL_TYPES.find((c) => c.type === 'wechat')
    expect(wechat).toBeDefined()
  })

  it('has correct name and nameEn', () => {
    const meta = getChannelMeta('wechat')
    expect(meta.name).toBe('微信公众号')
    expect(meta.nameEn).toBe('WeChat Official')
  })

  it('has WeChat green brand color', () => {
    const meta = getChannelMeta('wechat')
    expect(meta.color).toBe('#07c160')
  })

  it('helpUrl points to WeChat Official Account docs', () => {
    const meta = getChannelMeta('wechat')
    expect(meta.helpUrl).toContain('developers.weixin.qq.com')
    expect(meta.helpUrl).toContain('offiaccount')
  })

  it('does NOT have qrSetup property', () => {
    const meta = getChannelMeta('wechat') as Record<string, unknown>
    expect(meta).not.toHaveProperty('qrSetup')
  })
})

// ────────────────────────────────────────────────────────
// 3. 帮助文本
// ────────────────────────────────────────────────────────

describe('wechat help text', () => {
  it('zh text mentions 公众号 and AppID', () => {
    const text = getChannelHelpText('wechat', 'zh-CN')
    expect(text).toContain('公众号')
    expect(text).toContain('AppID')
  })

  it('en text mentions Official Account', () => {
    const text = getChannelHelpText('wechat', 'en')
    expect(text).toContain('Official Account')
    expect(text).toContain('AppID')
  })

  it('zh and en text do NOT mention QR scan or 扫码', () => {
    const zh = getChannelHelpText('wechat', 'zh-CN')
    const en = getChannelHelpText('wechat', 'en')
    expect(zh).not.toContain('扫码')
    expect(zh).not.toContain('二维码')
    expect(en).not.toContain('QR')
    expect(en).not.toContain('scan')
  })
})

// ────────────────────────────────────────────────────────
// 4. 必填字段验证
// ────────────────────────────────────────────────────────

describe('wechat required field validation', () => {
  it('reports all 3 required fields missing when config is empty', () => {
    const missing = getRequiredFieldLabels({ type: 'wechat', config: {} })
    expect(missing).toHaveLength(3) // app_id, app_secret, token (aes_key is optional)
  })

  it('reports no missing fields when all required fields are filled', () => {
    const missing = getRequiredFieldLabels({
      type: 'wechat',
      config: { app_id: 'wx123', app_secret: 'secret', token: 'mytoken' },
    })
    expect(missing).toHaveLength(0)
  })

  it('does not report aes_key as missing (optional)', () => {
    const missing = getRequiredFieldLabels({
      type: 'wechat',
      config: { app_id: 'wx123', app_secret: 'secret', token: 'mytoken' },
    })
    expect(missing).not.toContain('消息加密密钥（选填）')
    expect(missing).not.toContain('EncodingAESKey (optional)')
  })

  it('reports only the specific missing field', () => {
    const missing = getRequiredFieldLabels({
      type: 'wechat',
      config: { app_id: 'wx123', token: 'mytoken' },
    })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toBe('AppSecret')
  })

  it('treats whitespace-only values as missing', () => {
    const missing = getRequiredFieldLabels({
      type: 'wechat',
      config: { app_id: '  ', app_secret: 'secret', token: 'mytoken' },
    })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('AppID')
  })
})

// ────────────────────────────────────────────────────────
// 5. Webhook URL 生成
// ────────────────────────────────────────────────────────

describe('wechat webhook URL', () => {
  it('generates correct hook URL path', () => {
    const url = getPlatformHookUrl({ name: 'my-wechat', type: 'wechat' })
    expect(url).toContain('/api/v1/platforms/hooks/wechat/my-wechat')
  })

  it('URL-encodes Chinese names', () => {
    const url = getPlatformHookUrl({ name: '我的公众号', type: 'wechat' })
    expect(url).toContain('/api/v1/platforms/hooks/wechat/')
    expect(url).not.toContain('我的公众号')
  })
})

// ────────────────────────────────────────────────────────
// 6. 源码清洁度 — 确保 QR 扫码残留已彻底移除
// ────────────────────────────────────────────────────────

describe('wechat QR scan code removal (source-level verification)', () => {
  const imChannelsSource = fs.readFileSync(
    path.resolve(__dirname, '../im-channels.ts'),
    'utf-8',
  )

  it('no WechatQREvent type definition', () => {
    expect(imChannelsSource).not.toContain('WechatQREvent')
  })

  it('no wechatQRStream function', () => {
    expect(imChannelsSource).not.toContain('wechatQRStream')
  })

  it('no EventSource usage', () => {
    expect(imChannelsSource).not.toContain('EventSource')
  })

  it('no qr-stream endpoint reference', () => {
    expect(imChannelsSource).not.toContain('qr-stream')
    expect(imChannelsSource).not.toContain('qrcode')
  })

  it('no qrSetup property in interface or data', () => {
    expect(imChannelsSource).not.toContain('qrSetup')
  })

  it('no openwechat reference', () => {
    expect(imChannelsSource).not.toContain('openwechat')
  })
})

describe('IMChannelsView QR scan code removal', () => {
  const viewSource = fs.readFileSync(
    path.resolve(__dirname, '../../views/IMChannelsView.vue'),
    'utf-8',
  )

  it('no wxQR reactive state variables', () => {
    expect(viewSource).not.toContain('wxQRRunning')
    expect(viewSource).not.toContain('wxQRDone')
    expect(viewSource).not.toContain('wxQRText')
    expect(viewSource).not.toContain('wxQRStatus')
    expect(viewSource).not.toContain('wxQRError')
  })

  it('no startWxQRSetup or retryWxQR functions', () => {
    expect(viewSource).not.toContain('startWxQRSetup')
    expect(viewSource).not.toContain('retryWxQR')
    expect(viewSource).not.toContain('resetWxQRState')
    expect(viewSource).not.toContain('autoCreateAfterQR')
  })

  it('no qrSetup template conditionals', () => {
    expect(viewSource).not.toContain('qrSetup')
  })

  it('no QR CSS classes', () => {
    expect(viewSource).not.toContain('hc-wx-qr')
  })

  it('no wechatQRStream import', () => {
    expect(viewSource).not.toContain('wechatQRStream')
    expect(viewSource).not.toContain('WechatQREvent')
  })

  it('no unused QR-related icon imports (Loader2, CheckCircle, XCircle)', () => {
    // These were only used by the QR setup UI — verify they are removed from imports
    // (They may still exist if used elsewhere, but let's check they're not dangling)
    const importBlock = viewSource.match(/import\s*\{[^}]*\}\s*from\s*'lucide-vue-next'/s)?.[0] || ''
    expect(importBlock).not.toContain('Loader2')
    expect(importBlock).not.toContain('CheckCircle')
    expect(importBlock).not.toContain('XCircle')
  })
})

// ────────────────────────────────────────────────────────
// 7. CRUD 运行时 — 微信实例创建/更新/删除
// ────────────────────────────────────────────────────────

const invoke = vi.hoisted(() => vi.fn())
const storeGet = vi.hoisted(() => vi.fn())
const storeSet = vi.hoisted(() => vi.fn())
const load = vi.hoisted(() => vi.fn(async () => ({ get: storeGet, set: storeSet })))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ load }))

describe('wechat instance CRUD', () => {
  beforeEach(() => {
    vi.resetModules()
    invoke.mockReset()
    storeGet.mockReset()
    storeSet.mockReset()
    load.mockClear()
  })

  it('creates a wechat instance with all required fields', async () => {
    storeGet.mockResolvedValue(undefined)
    invoke.mockResolvedValue(JSON.stringify({ status: 'ok' }))

    const mod = await import('../im-channels')
    const instance = await mod.createIMInstance('我的公众号', 'wechat', {
      app_id: 'wx1234567890',
      app_secret: 'mysecret',
      token: 'mytoken',
    })

    expect(instance.name).toBe('我的公众号')
    expect(instance.type).toBe('wechat')
    expect(instance.config.app_id).toBe('wx1234567890')
    expect(instance.id).toBeTruthy()

    // Verify backend sync was called with correct provider
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'POST',
      path: '/api/v1/platforms/instances',
    }))
    const body = JSON.parse(invoke.mock.calls[0][1].body)
    expect(body.provider).toBe('wechat')
    expect(body.config.app_id).toBe('wx1234567890')
  })

  it('creates a wechat instance with optional aes_key', async () => {
    storeGet.mockResolvedValue(undefined)
    invoke.mockResolvedValue(JSON.stringify({ status: 'ok' }))

    const mod = await import('../im-channels')
    const instance = await mod.createIMInstance('公众号2', 'wechat', {
      app_id: 'wx0000000000',
      app_secret: 'secret2',
      token: 'token2',
      aes_key: 'a'.repeat(43),
    })

    expect(instance.config.aes_key).toBe('a'.repeat(43))
  })

  it('rejects creation when required field app_id is missing', async () => {
    storeGet.mockResolvedValue(undefined)

    const mod = await import('../im-channels')
    await expect(
      mod.createIMInstance('test', 'wechat', { app_secret: 'secret', token: 'tok' }),
    ).rejects.toThrow('Missing required fields')
  })

  it('rejects creation when required field app_secret is missing', async () => {
    storeGet.mockResolvedValue(undefined)

    const mod = await import('../im-channels')
    await expect(
      mod.createIMInstance('test', 'wechat', { app_id: 'wx123', token: 'tok' }),
    ).rejects.toThrow('Missing required fields')
  })

  it('rejects creation when required field token is missing', async () => {
    storeGet.mockResolvedValue(undefined)

    const mod = await import('../im-channels')
    await expect(
      mod.createIMInstance('test', 'wechat', { app_id: 'wx123', app_secret: 'secret' }),
    ).rejects.toThrow('Missing required fields')
  })

  it('allows creation without optional aes_key', async () => {
    storeGet.mockResolvedValue(undefined)
    invoke.mockResolvedValue(JSON.stringify({ status: 'ok' }))

    const mod = await import('../im-channels')
    const instance = await mod.createIMInstance('test-wechat', 'wechat', {
      app_id: 'wx123',
      app_secret: 'secret',
      token: 'tok',
    })
    expect(instance.type).toBe('wechat')
  })

  it('rejects duplicate wechat instance names (case-insensitive)', async () => {
    storeGet.mockResolvedValue({
      existing: {
        id: 'existing',
        name: '公众号',
        type: 'wechat',
        enabled: true,
        config: { app_id: 'wx1', app_secret: 's', token: 't' },
        createdAt: 1,
      },
    })

    const mod = await import('../im-channels')
    await expect(
      mod.createIMInstance('公众号', 'wechat', { app_id: 'wx2', app_secret: 's2', token: 't2' }),
    ).rejects.toThrow('实例名称重复')
  })

  it('deletes a wechat instance and calls backend delete', async () => {
    storeGet.mockResolvedValue({
      wx1: {
        id: 'wx1',
        name: '公众号-test',
        type: 'wechat',
        enabled: true,
        config: { app_id: 'wx1', app_secret: 's', token: 't' },
        createdAt: 1,
      },
    })
    invoke.mockResolvedValue(JSON.stringify({ ok: true }))

    const mod = await import('../im-channels')
    const result = await mod.deleteIMInstance('wx1')
    expect(result).toBe(true)

    // Verify DELETE was called to backend
    expect(invoke).toHaveBeenCalledWith('proxy_api_request', expect.objectContaining({
      method: 'DELETE',
      path: '/api/v1/platforms/instances/%E5%85%AC%E4%BC%97%E5%8F%B7-test',
    }))
  })

  it('syncs wechat instance to backend on startup', async () => {
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          wx1: {
            id: 'wx1',
            name: 'WechatBot',
            type: 'wechat',
            enabled: true,
            config: { app_id: 'wx999', app_secret: 'sec', token: 'tok' },
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    invoke
      .mockResolvedValueOnce(JSON.stringify({ instances: [] })) // list backend instances
      .mockResolvedValueOnce(JSON.stringify({ status: 'ok' })) // sync

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

    // Verify POST was called with wechat provider
    const syncCall = invoke.mock.calls.find(
      (c) => c[1]?.method === 'POST' && c[1]?.path === '/api/v1/platforms/instances',
    )
    expect(syncCall).toBeDefined()
    const body = JSON.parse(syncCall![1].body)
    expect(body.provider).toBe('wechat')
    expect(body.config.app_id).toBe('wx999')
  })

  it('skips sync when backend already has identical wechat instance', async () => {
    const config = { app_id: 'wx999', app_secret: 'sec', token: 'tok' }
    storeGet.mockImplementation(async (key: string) => {
      if (key === 'im-instances') {
        return {
          wx1: {
            id: 'wx1',
            name: 'WechatBot',
            type: 'wechat',
            enabled: true,
            config,
            createdAt: 1,
          },
        }
      }
      return undefined
    })

    invoke.mockResolvedValueOnce(JSON.stringify({
      instances: [{
        name: 'WechatBot',
        provider: 'wechat',
        enabled: true,
        config,
      }],
    }))

    const mod = await import('../im-channels')
    await mod.ensureIMInstancesSyncedToBackend()

    // Only 1 call: GET list. No POST sync needed.
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────────────────────────────────────────
// 8. i18n 键完整性 — 确保无残留 QR 相关翻译键
// ────────────────────────────────────────────────────────

describe('i18n wechat keys cleanup', () => {
  const enSource = fs.readFileSync(
    path.resolve(__dirname, '../../i18n/locales/en.ts'),
    'utf-8',
  )
  const zhSource = fs.readFileSync(
    path.resolve(__dirname, '../../i18n/locales/zh-CN.ts'),
    'utf-8',
  )

  const removedKeys = [
    'wxStarting', 'wxPreparing', 'wxScanQR', 'wxQRAlt',
    'wxSetupDone', 'wxSetupFailed', 'wxConnectionFailed',
  ]

  for (const key of removedKeys) {
    it(`en locale does not contain removed key: ${key}`, () => {
      expect(enSource).not.toContain(key)
    })
    it(`zh-CN locale does not contain removed key: ${key}`, () => {
      expect(zhSource).not.toContain(key)
    })
  }
})

// ────────────────────────────────────────────────────────
// 9. 微信与企业微信字段区分
// ────────────────────────────────────────────────────────

describe('wechat vs wecom field distinction', () => {
  it('wechat uses app_id (公众号), wecom uses corp_id', () => {
    const wxKeys = CHANNEL_CONFIG_FIELDS.wechat.map((f) => f.key)
    const wecomKeys = CHANNEL_CONFIG_FIELDS.wecom.map((f) => f.key)

    expect(wxKeys).toContain('app_id')
    expect(wxKeys).not.toContain('corp_id')

    expect(wecomKeys).toContain('corp_id')
    expect(wecomKeys).not.toContain('app_id')
  })

  it('wechat aes_key is optional, wecom aes_key is required', () => {
    const wxAes = CHANNEL_CONFIG_FIELDS.wechat.find((f) => f.key === 'aes_key')
    const wecomAes = CHANNEL_CONFIG_FIELDS.wecom.find((f) => f.key === 'aes_key')

    expect(wxAes?.optional).toBe(true)
    expect(wecomAes?.optional).toBeFalsy()
  })

  it('wechat and wecom are separate entries in CHANNEL_TYPES', () => {
    const types = CHANNEL_TYPES.map((c) => c.type)
    expect(types.filter((t) => t === 'wechat')).toHaveLength(1)
    expect(types.filter((t) => t === 'wecom')).toHaveLength(1)
  })
})
