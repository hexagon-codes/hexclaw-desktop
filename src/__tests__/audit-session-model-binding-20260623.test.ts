import { describe, it, expect, beforeEach } from 'vitest'
import {
  getSessionModel,
  setSessionModel,
  clearSessionModel,
  pruneSessionModels,
  resolveSessionModel,
  SESSION_MODEL_STORAGE_KEY,
  type AvailableModelLite,
} from '@/stores/session-model-binding'

// AUDIT 2026-06-23 会话级模型绑定（普通会话切走再切回模型被重置 → 钉死不变量）
//
// 业界共识（ChatGPT / Cursor / Poe）：模型是会话上下文的一部分。
// 本应用模型是「每请求发送、后端无状态」→ 绑定属客户端偏好 → localStorage 持久化。
// 解析优先级：会话绑定 > Agent 模型 > 全局默认。

const MODELS: AvailableModelLite[] = [
  { modelId: 'glm-4-flash', providerId: 'p-zhipu', providerKey: 'zhipu', providerName: '智谱' },
  { modelId: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai', providerName: 'OpenAI' },
  { modelId: 'qwen3.5:9b', providerId: 'p-ollama', providerKey: 'ollama', providerName: 'Ollama' },
]

beforeEach(() => {
  localStorage.clear()
})

describe('AUDIT session-model-binding — 持久化基元', () => {
  it('未绑定会话返回 null（新会话跟随默认，不凭空带模型）', () => {
    expect(getSessionModel('S-new')).toBeNull()
  })

  it('set 后 get 拿回同一绑定', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai', providerName: 'OpenAI' })
    expect(getSessionModel('S-A')).toEqual({
      model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai', providerName: 'OpenAI',
    })
  })

  it('★核心不变量：会话间隔离 —— 在 A 选模型、再去 B 选另一个，切回 A 仍是 A 的模型', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    setSessionModel('S-B', { model: 'glm-4-flash', providerId: 'p-zhipu', providerKey: 'zhipu' })
    expect(getSessionModel('S-A')?.model).toBe('gpt-strong')
    expect(getSessionModel('S-B')?.model).toBe('glm-4-flash')
  })

  it('★核心不变量：绑定跨「重启」存活（重新从 localStorage 读，模拟切走再切回 / 重开 App）', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    // 模拟重启：直接从底层存储重新解析，不依赖任何内存态
    expect(getSessionModel('S-A')?.model).toBe('gpt-strong')
    const raw = localStorage.getItem(SESSION_MODEL_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)['S-A'].model).toBe('gpt-strong')
  })

  it('clearSessionModel 删除单个绑定（删会话时清理，防孤儿）', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    clearSessionModel('S-A')
    expect(getSessionModel('S-A')).toBeNull()
  })

  it('★防累积：pruneSessionModels 丢弃不在有效集合内的绑定（map 有界，规避 373MB 类事故）', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    setSessionModel('S-B', { model: 'glm-4-flash', providerId: 'p-zhipu', providerKey: 'zhipu' })
    setSessionModel('S-ghost', { model: 'qwen3.5:9b', providerId: 'p-ollama', providerKey: 'ollama' })
    pruneSessionModels(['S-A', 'S-B']) // S-ghost 已不在会话列表
    expect(getSessionModel('S-A')).not.toBeNull()
    expect(getSessionModel('S-B')).not.toBeNull()
    expect(getSessionModel('S-ghost')).toBeNull()
  })

  it('损坏的 localStorage 不抛错，降级为无绑定', () => {
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, '{not valid json')
    expect(() => getSessionModel('S-A')).not.toThrow()
    expect(getSessionModel('S-A')).toBeNull()
    // 覆写一次后恢复正常
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    expect(getSessionModel('S-A')?.model).toBe('gpt-strong')
  })
})

describe('AUDIT session-model-binding — resolveSessionModel 解析决策', () => {
  it('无绑定 → kind=none（沿用默认/Agent 决策）', () => {
    expect(resolveSessionModel('S-x', MODELS)).toEqual({ kind: 'none' })
  })

  it('绑定且模型仍可用 → kind=restore，带回最新 provider 元信息', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    const res = resolveSessionModel('S-A', MODELS)
    expect(res.kind).toBe('restore')
    const restored = res as Extract<typeof res, { kind: 'restore' }>
    expect(restored.model.modelId).toBe('gpt-strong')
    expect(restored.model.providerKey).toBe('openai')
    expect(restored.model.providerName).toBe('OpenAI')
  })

  it('绑定 auto → kind=auto', () => {
    setSessionModel('S-A', { model: 'auto', providerId: '', providerKey: '' })
    expect(resolveSessionModel('S-A', MODELS)).toEqual({ kind: 'auto' })
  })

  it('★绑定的模型已不可用（Ollama 删了 / provider 禁用）→ kind=unavailable（优雅回退，不静默用错模型/不崩）', () => {
    setSessionModel('S-A', { model: 'deleted-local-model', providerId: 'p-ollama', providerKey: 'ollama' })
    expect(resolveSessionModel('S-A', MODELS)).toEqual({ kind: 'unavailable' })
  })

  it('同 modelId 多 provider：providerId 不匹配视为不可用，匹配才 restore', () => {
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-not-exist', providerKey: 'x' })
    expect(resolveSessionModel('S-A', MODELS).kind).toBe('unavailable')
    setSessionModel('S-A', { model: 'gpt-strong', providerId: 'p-openai', providerKey: 'openai' })
    expect(resolveSessionModel('S-A', MODELS).kind).toBe('restore')
  })
})
