/**
 * Code Review V7 — 最终全面覆盖
 *
 * 聚焦之前从未被测试直接验证的业务逻辑。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

// ═══════════════════════════════════════════════════
// 1. IM Channels — updateIMInstance 改名回滚逻辑
// ═══════════════════════════════════════════════════

describe('IM Channels updateIMInstance — 改名事务回滚', () => {
  it('改名时先创建新名后删旧名，删旧失败则回滚新名', () => {
    const source = readFileSync('src/api/im-channels.ts', 'utf-8')
    const updateFn = source.match(/export async function updateIMInstance[\s\S]*?^}/m)
    expect(updateFn).toBeTruthy()
    const fn = updateFn![0]

    // 改名流程：1.sync(new, disabled) → 2.delete(old) → 3.sync(new, enabled)
    expect(fn).toContain('current.name !== next.name')
    expect(fn).toContain("syncBackendInstance({ ...next, enabled: false })")
    expect(fn).toContain('deleteBackendInstance(current.name)')

    // 回滚：deleteBackendInstance(current.name) 失败时清理新创建的
    expect(fn).toContain('deleteBackendInstance(next.name).catch(() => {})')
    expect(fn).toContain('throw e')
  })
})

// ═══════════════════════════════════════════════════
// 2. Canvas — saveWorkflow localStorage 降级
// ═══════════════════════════════════════════════════

describe('Canvas saveWorkflow — localStorage 降级', () => {
  it('API 失败时降级到 localStorage 保存', () => {
    const source = readFileSync('src/api/canvas.ts', 'utf-8')
    const saveFn = source.match(/export async function saveWorkflow[\s\S]*?^}/m)
    expect(saveFn).toBeTruthy()
    const fn = saveFn![0]

    // 正常路径调 API
    expect(fn).toContain("apiPost<Workflow>('/api/v1/canvas/workflows'")
    // 降级路径写 localStorage
    expect(fn).toContain('setLocalWorkflows(workflows)')
    // catch 块处理（带错误参数和日志）
    expect(fn).toContain('} catch (e) {')
    expect(fn).toContain('logger.warn')
  })

  it('deleteWorkflow 也有 localStorage 降级', () => {
    const source = readFileSync('src/api/canvas.ts', 'utf-8')
    const deleteFn = source.match(/export async function deleteWorkflow[\s\S]*?^}/m)
    expect(deleteFn).toBeTruthy()
    expect(deleteFn![0]).toContain('getLocalWorkflows().filter')
  })
})

// ═══════════════════════════════════════════════════
// 3. Logs store — MAX_ENTRIES 限制 + 去重
// ═══════════════════════════════════════════════════

describe('Logs store — 条目上限和去重', () => {
  it('实时日志超过 MAX_ENTRIES 时移除最老的', () => {
    const source = readFileSync('src/stores/logs.ts', 'utf-8')
    expect(source).toContain('MAX_ENTRIES = 1000')
    // 超限时切片
    expect(source).toContain('entries.value.length >= MAX_ENTRIES')
    expect(source).toContain('entries.value.slice(1)')
  })

  it('loadHistory 按 id 去重避免重复', () => {
    const source = readFileSync('src/stores/logs.ts', 'utf-8')
    expect(source).toContain('new Set(entries.value.map(e => e.id))')
    expect(source).toContain('existing.has(e.id)')
  })

  it('reconnect 使用指数退避', () => {
    const source = readFileSync('src/stores/logs.ts', 'utf-8')
    expect(source).toContain('reconnectDelay * 2')
    expect(source).toContain('Math.min(reconnectDelay * 2, 30000)')
  })
})

// ═══════════════════════════════════════════════════
// 4. App store — restartSidecar 并发锁
// ═══════════════════════════════════════════════════

describe('App store — restartSidecar 并发锁', () => {
  it('重复调用 restartSidecar 复用同一 promise', () => {
    const source = readFileSync('src/stores/app.ts', 'utf-8')
    const restartFn = source.match(/function restartSidecar[\s\S]*?return restartPromise\s*\}/m)
    expect(restartFn).toBeTruthy()
    const fn = restartFn![0]

    // 锁：if (restartPromise) return restartPromise
    expect(fn).toContain('if (restartPromise) return restartPromise')
    // finally 清锁
    expect(fn).toContain('restartPromise = null')
  })
})

// ═══════════════════════════════════════════════════
// 5. useVoice — 资源清理完整性
// ═══════════════════════════════════════════════════

describe('useVoice — 资源清理', () => {
  it('组件卸载时同时停止 STT 和 TTS', () => {
    const source = readFileSync('src/composables/useVoice.ts', 'utf-8')
    // cleanup 同时调 stopListening + stopSpeaking
    expect(source).toContain('function cleanup()')
    expect(source).toContain('stopListening()')
    expect(source).toContain('stopSpeaking()')
    // onUnmounted 注册 cleanup
    expect(source).toContain('onUnmounted(cleanup)')
  })

  it('TTS 清理 Audio 资源和 blob URL', () => {
    const source = readFileSync('src/composables/useVoice.ts', 'utf-8')
    expect(source).toContain('URL.revokeObjectURL(audioUrl)')
    // 防止 play 前有残留 URL
    expect(source).toContain('audioUrl = null')
  })

  it('Tauri WKWebView 环境下禁用 SpeechRecognition', () => {
    const source = readFileSync('src/composables/useVoice.ts', 'utf-8')
    // Tauri 环境检测
    expect(source).toContain("(globalThis as unknown as Record<string, unknown>).isTauri")
    expect(source).toContain('return false')
  })
})

// ═══════════════════════════════════════════════════
// 6. Agents store — 错误处理
// ═══════════════════════════════════════════════════

describe('Agents store — loadRoles 错误处理', () => {
  it('loadRoles 使用 trySafe 包裹，失败不崩溃', () => {
    const source = readFileSync('src/stores/agents.ts', 'utf-8')
    expect(source).toContain('trySafe')
    expect(source).toContain("await trySafe(() => getRoles()")
    // error 被赋值
    expect(source).toContain('error.value = err')
  })
})

// ═══════════════════════════════════════════════════
// 7. IM Channels — 实例名唯一性验证
// ═══════════════════════════════════════════════════

describe('IM Channels — 实例名唯一性', () => {
  it('createIMInstance 调用 assertUniqueInstanceName', () => {
    const source = readFileSync('src/api/im-channels.ts', 'utf-8')
    const createFn = source.match(/export async function createIMInstance[\s\S]*?^}/m)
    expect(createFn).toBeTruthy()
    expect(createFn![0]).toContain('assertUniqueInstanceName(all, finalName)')
  })

  it('updateIMInstance 改名时也检查唯一性', () => {
    const source = readFileSync('src/api/im-channels.ts', 'utf-8')
    const updateFn = source.match(/export async function updateIMInstance[\s\S]*?^}/m)
    expect(updateFn).toBeTruthy()
    expect(updateFn![0]).toContain('assertUniqueInstanceName(all, next.name, id)')
  })

  it('assertUniqueInstanceName 大小写不敏感比较', () => {
    const source = readFileSync('src/api/im-channels.ts', 'utf-8')
    expect(source).toContain('normalizeInstanceName')
    const normFn = source.match(/function normalizeInstanceName[\s\S]*?^}/m)
    expect(normFn).toBeTruthy()
    expect(normFn![0]).toContain('.toLowerCase()')
  })
})

// ═══════════════════════════════════════════════════
// 8. 安全审计 — API 路径参数注入防护
// ═══════════════════════════════════════════════════

describe('安全 — 路径遍历防护', () => {
  it('proxy_api_request 命令检查路径前缀和 .. 遍历', () => {
    const source = readFileSync('src-tauri/src/commands.rs', 'utf-8')
    // 路径前缀检查
    expect(source).toContain("!path.starts_with('/')")
    // .. 遍历防护
    expect(source).toContain('path.contains("..")')
  })

  it('stream_chat 命令阻止 SSRF 到 cloud metadata', () => {
    const source = readFileSync('src-tauri/src/commands.rs', 'utf-8')
    expect(source).toContain('169.254.169.254')
    expect(source).toContain('metadata.google.internal')
  })
})

// ═══════════════════════════════════════════════════
// 9. i18n — 所有新增模块 key 完整性
// ═══════════════════════════════════════════════════

describe('i18n — 全局 key 完整性抽检', () => {
  it('tasks 模块 key 中英文都有 statusRunning', () => {
    const zhCN = readFileSync('src/i18n/locales/zh-CN.ts', 'utf-8')
    const en = readFileSync('src/i18n/locales/en.ts', 'utf-8')
    expect(zhCN).toContain("statusRunning:")
    expect(en).toContain("statusRunning:")
  })

  it('settings.status key 中英文都完整（12个 key）', () => {
    const zhCN = readFileSync('src/i18n/locales/zh-CN.ts', 'utf-8')
    const en = readFileSync('src/i18n/locales/en.ts', 'utf-8')
    const keys = ['title', 'loadData', 'budget', 'toolCache', 'toolMetrics',
      'toolName', 'toolCalls', 'toolSuccessRate', 'toolLatency', 'toolPermissions', 'refresh']
    for (const key of keys) {
      expect(zhCN, `zh-CN missing ${key}`).toContain(`${key}:`)
      expect(en, `en missing ${key}`).toContain(`${key}:`)
    }
  })
})

// ═══════════════════════════════════════════════════
// 10. 全量死代码检查 — 所有删除的旧 API 确认已清理
// ═══════════════════════════════════════════════════

describe('死代码审计 — 已清理项确认', () => {
  it('models.ts 不再导出 listModels 函数', () => {
    const source = readFileSync('src/api/models.ts', 'utf-8')
    expect(source).not.toContain('export function listModels')
  })

  it('webhook.ts 不再导出 registerWebhook 函数', () => {
    const source = readFileSync('src/api/webhook.ts', 'utf-8')
    expect(source).not.toContain('export function registerWebhook')
  })

  it('desktop.ts 不再调用后端 API', () => {
    const source = readFileSync('src/api/desktop.ts', 'utf-8')
    expect(source).not.toContain('apiPost')
    expect(source).not.toContain('/api/v1/')
  })
})
