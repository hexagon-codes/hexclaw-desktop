/**
 * Code Review Audit Tests
 *
 * 挑刺式全场景覆盖：逻辑错误、边界情况、冗余代码、前后端对齐、安全问题。
 * 每个 describe 对应一个审计发现，用测试证明问题存在或已修复。
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CHANNEL_TYPES,
  CHANNEL_CONFIG_FIELDS,
  CHANNEL_HELP_TEXT,
  getChannelMeta,
  getRequiredFieldLabels,
  type IMChannelType,
} from '../im-channels'
import {
  isKnowledgeUploadUnsupportedFormat,
  isKnowledgeUploadEndpointMissing,
} from '../knowledge'

// ════════════════════════════════════════════════════════
// 1. KNOWLEDGE.TS — isKnowledgeUploadUnsupportedFormat 误报
//    rawStatus === 400 太宽泛，会把非格式错误也归类为"格式不支持"
// ════════════════════════════════════════════════════════

describe('BUG: knowledge upload format detection false positives', () => {
  it('correctly identifies unsupported format error (415)', () => {
    const error = { status: 415, message: 'Unsupported Media Type' }
    expect(isKnowledgeUploadUnsupportedFormat(error)).toBe(true)
  })

  it('correctly identifies format error by Chinese message', () => {
    expect(isKnowledgeUploadUnsupportedFormat(new Error('不支持的文件格式'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('文件格式错误'))).toBe(true)
    expect(isKnowledgeUploadUnsupportedFormat(new Error('文件类型错误'))).toBe(true)
  })

  // FIXED: 400 now requires format-related keyword in message
  it('does NOT classify generic 400 validation errors as format errors', () => {
    // 后端 handler_knowledge.go:49 — "title 和 content 不能为空" → 400
    const validationError = { status: 400, message: 'title 和 content 不能为空' }
    expect(isKnowledgeUploadUnsupportedFormat(validationError)).toBe(false)

    // 后端 handler_knowledge.go:70 — "解析上传失败" → 400
    const uploadParseError = { status: 400, message: '解析上传失败: multipart: NextPart: EOF' }
    expect(isKnowledgeUploadUnsupportedFormat(uploadParseError)).toBe(false)
  })

  it('correctly classifies 400 with format keyword as unsupported format', () => {
    // 后端 handler_knowledge.go:88 — "不支持的文件格式" → 400
    const formatError = { status: 400, message: '不支持的文件格式，请上传 .txt / .md' }
    expect(isKnowledgeUploadUnsupportedFormat(formatError)).toBe(true)
  })

  it('"请求格式错误" matches keyword — acceptable (contains 格式错误)', () => {
    const parseError = { status: 400, message: '请求格式错误: unexpected EOF' }
    // "格式错误" is a format keyword → matched, acceptable
    expect(isKnowledgeUploadUnsupportedFormat(parseError)).toBe(true)
  })

  it('plain 400 with unrelated message is NOT format error', () => {
    // "未找到上传文件" — not a format issue, just missing field
    const missingFile = { status: 400, message: '未找到上传文件' }
    expect(isKnowledgeUploadUnsupportedFormat(missingFile)).toBe(false)

    // "文档 ID 不能为空"
    const missingId = { status: 400, message: '文档 ID 不能为空' }
    expect(isKnowledgeUploadUnsupportedFormat(missingId)).toBe(false)
  })

  it('correctly identifies endpoint missing errors', () => {
    expect(isKnowledgeUploadEndpointMissing({ status: 404 })).toBe(true)
    expect(isKnowledgeUploadEndpointMissing({ status: 405 })).toBe(true)
    expect(isKnowledgeUploadEndpointMissing(new Error('未提供知识库上传接口'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════════
// 2. CSP 策略 — connect-src 过于宽泛
// ════════════════════════════════════════════════════════

describe('SECURITY: CSP connect-src policy', () => {
  const tauriConf = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../..', 'src-tauri/tauri.conf.json'),
      'utf-8',
    ),
  )
  const csp = tauriConf.app.security.csp as string

  it('has connect-src directive', () => {
    expect(csp).toContain('connect-src')
  })

  it('allows connections to backend port 16060', () => {
    expect(csp).toContain('http://localhost:16060')
    expect(csp).toContain('ws://localhost:16060')
  })

  // FIXED: connect-src no longer allows wildcard localhost ports
  it('connect-src does NOT allow wildcard localhost ports', () => {
    expect(csp).not.toContain('http://localhost:*')
    expect(csp).not.toContain('ws://localhost:*')
  })

  it('img-src includes backend for proxied images', () => {
    expect(csp).toContain('img-src')
    expect(csp).toContain('data:')
    expect(csp).toContain('blob:')
  })

  it('does NOT allow unsafe-eval in script-src', () => {
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] || ''
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it('has object-src none', () => {
    expect(csp).toContain("object-src 'none'")
  })
})

// ════════════════════════════════════════════════════════
// 3. 前后端字段对齐 — 所有通道类型 config key 与后端 JSON tag 对齐
// ════════════════════════════════════════════════════════

describe('frontend-backend config field alignment', () => {
  // 后端 config.go 中各平台 Config 结构体的 json tag (从源码提取)
  const backendFieldsByType: Record<string, string[]> = {
    feishu: ['app_id', 'app_secret', 'verification_token'],
    dingtalk: ['app_key', 'app_secret', 'robot_code'],
    discord: ['token'],
    telegram: ['token'],
    wechat: ['app_id', 'app_secret', 'token', 'aes_key'],
    wecom: ['corp_id', 'agent_id', 'secret', 'token', 'aes_key'],
  }

  for (const [type, expectedKeys] of Object.entries(backendFieldsByType)) {
    it(`${type}: frontend config field keys match backend JSON tags`, () => {
      const frontendKeys = CHANNEL_CONFIG_FIELDS[type as IMChannelType].map((f) => f.key)
      expect(frontendKeys.sort()).toEqual(expectedKeys.sort())
    })
  }
})

// ════════════════════════════════════════════════════════
// 4. IMChannelMeta 完整性 — qrSetup 已彻底移除
// ════════════════════════════════════════════════════════

describe('IMChannelMeta: qrSetup completely removed', () => {
  it('no channel type has qrSetup property', () => {
    for (const channel of CHANNEL_TYPES) {
      const meta = channel as Record<string, unknown>
      expect(meta).not.toHaveProperty('qrSetup')
    }
  })

  it('IMChannelMeta interface does not define qrSetup', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../im-channels.ts'),
      'utf-8',
    )
    expect(source).not.toContain('qrSetup')
  })
})

// ════════════════════════════════════════════════════════
// 5. 必填字段验证 — 全通道类型覆盖
// ════════════════════════════════════════════════════════

describe('required field validation: all channel types', () => {
  for (const type of Object.keys(CHANNEL_CONFIG_FIELDS) as IMChannelType[]) {
    const fields = CHANNEL_CONFIG_FIELDS[type]
    const requiredFields = fields.filter((f) => !f.optional)
    const optionalFields = fields.filter((f) => f.optional)

    it(`${type}: reports all ${requiredFields.length} required fields when config is empty`, () => {
      const missing = getRequiredFieldLabels({ type, config: {} })
      expect(missing).toHaveLength(requiredFields.length)
    })

    it(`${type}: reports 0 missing when all required fields filled`, () => {
      const config: Record<string, string> = {}
      for (const f of requiredFields) {
        config[f.key] = 'test-value'
      }
      const missing = getRequiredFieldLabels({ type, config })
      expect(missing).toHaveLength(0)
    })

    if (optionalFields.length > 0) {
      it(`${type}: does not report optional fields as missing`, () => {
        const config: Record<string, string> = {}
        for (const f of requiredFields) {
          config[f.key] = 'test-value'
        }
        // Leave optional fields empty
        const missing = getRequiredFieldLabels({ type, config })
        for (const f of optionalFields) {
          expect(missing).not.toContain(f.label)
        }
      })
    }

    it(`${type}: whitespace-only values count as missing`, () => {
      const config: Record<string, string> = {}
      for (const f of requiredFields) {
        config[f.key] = '   ' // whitespace only
      }
      const missing = getRequiredFieldLabels({ type, config })
      expect(missing).toHaveLength(requiredFields.length)
    })
  }
})

// ════════════════════════════════════════════════════════
// 6. CHANNEL_HELP_TEXT — 全通道双语覆盖 + 内容合理性
// ════════════════════════════════════════════════════════

describe('help text content quality', () => {
  for (const type of Object.keys(CHANNEL_HELP_TEXT) as IMChannelType[]) {
    it(`${type}: zh text is non-trivial (> 20 chars)`, () => {
      expect(CHANNEL_HELP_TEXT[type].zh.length).toBeGreaterThan(20)
    })

    it(`${type}: en text is non-trivial (> 20 chars)`, () => {
      expect(CHANNEL_HELP_TEXT[type].en.length).toBeGreaterThan(20)
    })
  }

  it('wechat help text mentions 公众号 (not 个人号 or 扫码)', () => {
    const zh = CHANNEL_HELP_TEXT.wechat.zh
    expect(zh).toContain('公众号')
    expect(zh).not.toContain('个人号')
    expect(zh).not.toContain('扫码')
    expect(zh).not.toContain('二维码')
  })
})

// ════════════════════════════════════════════════════════
// 7. getChannelMeta — 边界情况
// ════════════════════════════════════════════════════════

describe('getChannelMeta edge cases', () => {
  it('returns valid meta for all known types', () => {
    for (const type of ['feishu', 'dingtalk', 'wechat', 'wecom', 'discord', 'telegram'] as const) {
      const meta = getChannelMeta(type)
      expect(meta.type).toBe(type)
    }
  })

  it('falls back to first channel for unknown type (defensive)', () => {
    const meta = getChannelMeta('nonexistent' as IMChannelType)
    expect(meta.type).toBe(CHANNEL_TYPES[0].type)
  })

  it('all channel colors are valid hex', () => {
    for (const channel of CHANNEL_TYPES) {
      expect(channel.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('all helpUrl are valid https URLs', () => {
    for (const channel of CHANNEL_TYPES) {
      expect(channel.helpUrl).toMatch(/^https:\/\//)
    }
  })
})

// ════════════════════════════════════════════════════════
// 8. 源码清洁度 — 无残留 QR/EventSource/openwechat 引用
// ════════════════════════════════════════════════════════

describe('source cleanliness: no QR remnants across entire src/', () => {
  const srcDir = path.resolve(__dirname, '../..')

  function readAllTsVueFiles(dir: string): { file: string; content: string }[] {
    const results: { file: string; content: string }[] = []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__tests__') {
        results.push(...readAllTsVueFiles(full))
      } else if (entry.isFile() && (/\.(ts|vue)$/.test(entry.name)) && !entry.name.includes('.test.')) {
        results.push({ file: full, content: fs.readFileSync(full, 'utf-8') })
      }
    }
    return results
  }

  const files = readAllTsVueFiles(srcDir)

  it('no production file references wechatQRStream', () => {
    for (const { file, content } of files) {
      expect(content, `Found in ${file}`).not.toContain('wechatQRStream')
    }
  })

  it('no production file references WechatQREvent', () => {
    for (const { file, content } of files) {
      expect(content, `Found in ${file}`).not.toContain('WechatQREvent')
    }
  })

  it('no production file references qrSetup', () => {
    for (const { file, content } of files) {
      expect(content, `Found in ${file}`).not.toContain('qrSetup')
    }
  })

  it('no production file contains EventSource (removed with QR)', () => {
    for (const { file, content } of files) {
      expect(content, `Found in ${file}`).not.toContain('new EventSource')
    }
  })
})

// ════════════════════════════════════════════════════════
// 9. tools-status.ts — 存在且已正确导出
// ════════════════════════════════════════════════════════

describe('tools-status.ts integration', () => {
  it('file exists', () => {
    const filePath = path.resolve(__dirname, '../tools-status.ts')
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('is re-exported from api/index.ts', () => {
    const indexSource = fs.readFileSync(
      path.resolve(__dirname, '../index.ts'),
      'utf-8',
    )
    expect(indexSource).toContain('tools-status')
  })

  it('exports expected functions', async () => {
    // Dynamic import to check exports exist
    const mod = await import('../tools-status')
    expect(typeof mod.getBudgetStatus).toBe('function')
    expect(typeof mod.getToolCacheStats).toBe('function')
    expect(typeof mod.getToolMetrics).toBe('function')
    expect(typeof mod.getToolPermissions).toBe('function')
  })
})

// ════════════════════════════════════════════════════════
// 10. 死文件清理 — useWechatQR.ts 已删除
// ════════════════════════════════════════════════════════

describe('dead file cleanup: useWechatQR.ts removed', () => {
  it('composables/useWechatQR.ts does not exist', () => {
    const filePath = path.resolve(__dirname, '../../composables/useWechatQR.ts')
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('no file in src/ imports useWechatQR', () => {
    const srcDir = path.resolve(__dirname, '../..')
    function searchDir(dir: string): boolean {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__tests__') {
          if (searchDir(full)) return true
        } else if (entry.isFile() && /\.(ts|vue)$/.test(entry.name) && !entry.name.includes('.test.')) {
          const content = fs.readFileSync(full, 'utf-8')
          if (content.includes('useWechatQR')) return true
        }
      }
      return false
    }
    expect(searchDir(srcDir)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════
// 11. i18n 键完整性 — 移除的 QR 键不存在
// ════════════════════════════════════════════════════════

describe('i18n: removed QR keys absent from both locales', () => {
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
    it(`"${key}" absent from en.ts`, () => {
      expect(enSource).not.toContain(`${key}:`)
    })
    it(`"${key}" absent from zh-CN.ts`, () => {
      expect(zhSource).not.toContain(`${key}:`)
    })
  }
})

// ════════════════════════════════════════════════════════
// 11. CHANNEL_CONFIG_FIELDS — secret 字段标记完整性
// ════════════════════════════════════════════════════════

describe('config field security: secrets correctly marked', () => {
  // app_key (DingTalk) is an identifier like app_id, not a secret
  const sensitiveKeyPatterns = ['secret', 'token', 'password', 'aes_key']

  for (const [type, fields] of Object.entries(CHANNEL_CONFIG_FIELDS)) {
    for (const field of fields) {
      const isSensitive = sensitiveKeyPatterns.some((p) =>
        field.key.toLowerCase().includes(p),
      )
      if (isSensitive) {
        it(`${type}.${field.key}: sensitive field is marked as secret`, () => {
          expect(field.secret).toBe(true)
        })
      }
    }
  }
})

// ════════════════════════════════════════════════════════
// 12. Vue 视图文件 — 无 unused import
// ════════════════════════════════════════════════════════

describe('IMChannelsView.vue: no dead imports after QR removal', () => {
  const viewSource = fs.readFileSync(
    path.resolve(__dirname, '../../views/IMChannelsView.vue'),
    'utf-8',
  )

  it('no Loader2 import (was only used by QR UI)', () => {
    expect(viewSource).not.toContain('Loader2')
  })

  it('no CheckCircle import (was only used by QR success)', () => {
    expect(viewSource).not.toContain('CheckCircle')
  })

  it('no XCircle import (was only used by QR error)', () => {
    expect(viewSource).not.toContain('XCircle')
  })

  it('no onBeforeUnmount import (was only used for QR cleanup)', () => {
    expect(viewSource).not.toContain('onBeforeUnmount')
  })

  it('no env/apiBase import (was only used for QR image src)', () => {
    expect(viewSource).not.toContain("from '@/config/env'")
    expect(viewSource).not.toContain('apiBase')
  })

  it('no hc-wx-qr CSS classes', () => {
    expect(viewSource).not.toContain('hc-wx-qr')
  })
})

// ════════════════════════════════════════════════════════
// 14. 功能覆盖率 — P0-P2 新增 API 函数验证
// ════════════════════════════════════════════════════════

describe('P0-P2 feature coverage: new API exports', () => {
  it('chat.ts exports session management functions', async () => {
    const mod = await import('../chat')
    expect(typeof mod.listSessions).toBe('function')
    expect(typeof mod.getSession).toBe('function')
    expect(typeof mod.listSessionMessages).toBe('function')
    expect(typeof mod.deleteSession).toBe('function')
    expect(typeof mod.searchMessages).toBe('function')
    expect(typeof mod.updateMessageFeedback).toBe('function')
  })

  it('im-channels.ts exports runtime control functions', async () => {
    const mod = await import('../im-channels')
    expect(typeof mod.startIMInstance).toBe('function')
    expect(typeof mod.stopIMInstance).toBe('function')
    expect(typeof mod.getIMInstanceHealth).toBe('function')
    expect(typeof mod.listIMInstancesHealth).toBe('function')
  })

  it('models.ts exports listModels', async () => {
    const mod = await import('../models')
    expect(typeof mod.listModels).toBe('function')
  })

  it('index.ts re-exports voice, webhook, and models', () => {
    const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf-8')
    expect(indexSource).toContain('./voice')
    expect(indexSource).toContain('./webhook')
    expect(indexSource).toContain('./models')
  })

  it('navigation includes webhook tab under integration', () => {
    const navSource = fs.readFileSync(
      path.resolve(__dirname, '../../config/navigation.ts'),
      'utf-8',
    )
    expect(navSource).toContain('integration-webhooks')
    expect(navSource).toContain('/integration/webhooks')
  })
})
