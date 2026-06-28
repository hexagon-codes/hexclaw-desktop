/**
 * 域 UI 闭环审计 + 修复回归锁（2026-06-22）。
 * 原 6 条 RED 坐实"UI 上存在却不闭环"的 bug；修复后转为 GREEN 回归锁。
 *
 * 修复方式：
 *   UI-1/2 孤儿组件（SettingsSecurity/SettingsNotification，10 toggle 不可达）→ 删除死代码
 *   UI-3   WebhookPanel 创建发后端不收的 url/events → createWebhook 去掉 url/events + 补非空 prompt
 *   UI-4   CanvasView 整页不可达死代码（被 WorkflowPanel 取代）→ 删除
 *   UI-6   SkillsView 卸载失败静默 → catch 写 statusNotice surface
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')
const exists = (rel: string) => existsSync(resolve(SRC, rel))

// UI-1/2 [高][已修：删死代码] 孤儿组件移除——它们从未被任何父组件挂载，10 个 toggle 在 UI 不可达。
describe('UI-1/2 SettingsSecurity / SettingsNotification 孤儿组件已移除', () => {
  it('SettingsSecurity.vue 死代码已删除', () => {
    expect(exists('components/settings/SettingsSecurity.vue')).toBe(false)
  })
  it('SettingsNotification.vue 死代码已删除', () => {
    expect(exists('components/settings/SettingsNotification.vue')).toBe(false)
  })
})

// UI-3 [高][已修] createWebhook 不再发送后端 RegisterWebhookRequest 不存在的 url/events。
const calls = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), del: vi.fn() }))
vi.mock('@/api/client', () => ({
  apiPost: (...a: unknown[]) => calls.post(...a),
  apiGet: (...a: unknown[]) => calls.get(...a),
  apiDelete: (...a: unknown[]) => calls.del(...a),
}))

describe('UI-3 WebhookPanel 创建契约已对齐（不发 url/events，prompt 非空）', () => {
  beforeEach(() => { calls.post.mockReset(); calls.post.mockResolvedValue({ id: 'w1' }) })

  it('createWebhook 只发后端接受的字段，不含 url/events，且 prompt 非空', async () => {
    const { createWebhook } = await import('@/api/webhook')
    await createWebhook({ name: 'hook', type: 'github', prompt: '汇总事件' })
    const body = calls.post.mock.calls[0]![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('url')
    expect(body).not.toHaveProperty('events')
    expect(body.prompt, '后端要求 prompt 非空').not.toBe('')
  })
})

// UI-4 [P1][已修：删死代码] CanvasView 整页不可达（被 WorkflowPanel 取代）已删除。
describe('UI-4 CanvasView 不可达死代码已移除', () => {
  it('CanvasView.vue 已删除', () => {
    expect(exists('views/CanvasView.vue')).toBe(false)
  })
  it('路由仍把 /canvas 与 /automation/canvas 重定向到 /automation（无悬空 import）', () => {
    const router = read('router/index.ts')
    expect(router).toContain("path: '/canvas', redirect: '/automation'")
    expect(router).not.toContain('CanvasView')
  })
})

// UI-8 [中][已修] PromptsView 增删改不再无 try/catch——失败 surface 到 actionError。
// 砍薄版（§5）：saveMemory/removeMemory 随记忆薄版 Tab 移除（记忆管理已迁至 MemoryView）。
describe('UI-8 PromptsView 增删改失败已 surface（不再无 try/catch 静默）', () => {
  const fns = ['savePrompt', 'removePrompt']
  it.each(fns)('%s 有 try/catch 且失败写 actionError', (name) => {
    const src = read('views/PromptsView.vue')
    const fn = src.slice(src.indexOf(`async function ${name}`), src.indexOf(`async function ${name}`) + 700)
    expect(fn, `${name} 应有 catch`).toContain('} catch (err)')
    expect(fn, `${name} catch 应 surface actionError`).toContain('actionError.value =')
  })
})

// UI-7 [高][已修] SettingsView 保存失败不再静默——catch 置 saveFailed，按钮显示「保存失败」。
describe('UI-7 SettingsView 保存失败已 surface（不再仅 logger.error）', () => {
  it('saveConfig 的 catch 置 saveFailed.value（按钮反馈失败）', () => {
    const src = read('views/SettingsView.vue')
    const fn = src.slice(src.indexOf('async function saveConfig'), src.indexOf('async function saveConfig') + 500)
    const catchBlock = fn.slice(fn.indexOf('} catch'))
    expect(catchBlock).toContain('saveFailed.value = true')
    expect(src).toContain("t('settings.toolbar.saveFailed'")
  })
})

// UI-6 [中][已修] SkillsView 卸载失败不再静默——catch 写 statusNotice surface。
describe('UI-6 SkillsView 卸载技能失败已 surface（不再仅 console.error）', () => {
  it('confirmUninstall 的 catch surface 到 statusNotice', () => {
    const src = read('views/SkillsView.vue')
    const fn = src.slice(src.indexOf('async function confirmUninstall'), src.indexOf('async function confirmUninstall') + 700)
    const catchBlock = fn.slice(fn.indexOf('} catch'))
    expect(catchBlock).toContain('statusNotice.value')
  })
})
