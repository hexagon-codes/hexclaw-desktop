/**
 * 默认模型显示 Bug 修复验证
 *
 * 复现场景：用户在设置页把默认模型从 qwen3.5:9b 改为 gemma4:e4b，
 * 回到对话页后仍显示旧模型。
 *
 * 根因：当存在默认 Agent 且 Agent 配置了模型偏好时，
 * selectedModelDisplay 和 syncChatParams 优先使用 Agent 模型，
 * 忽略用户在设置页设置的默认模型。
 *
 * 修复：普通聊天始终用用户默认模型，仅显式 Agent 模式才让 Agent 决策。
 */
import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@/types'

// ━━━ 提取被测逻辑为纯函数（与 ChatView 内部逻辑一一对应） ━━━

/** 修复后的 selectedModelDisplay 逻辑 */
function selectedModelDisplay(params: {
  userOverrodeModel: boolean
  chatMode: string
  agentRole: string
  findAgent: (name: string) => AgentConfig | undefined
  selectedModel: string
  selectedProviderId: string
  availableModels: { modelId: string; modelName: string; providerId: string }[]
}): string {
  const { userOverrodeModel, chatMode, agentRole, findAgent, selectedModel, selectedProviderId, availableModels } = params

  // 仅在显式 Agent 模式下，且用户未手动选模型时，显示 Agent 偏好模型
  if (!userOverrodeModel && chatMode === 'agent' && agentRole) {
    const cfg = findAgent(agentRole)
    if (cfg?.model) {
      const agentLabel = cfg.display_name || cfg.name || agentRole
      return `${cfg.model} · ${agentLabel}`
    }
  }
  if (selectedModel === 'auto') return 'Auto'
  if (!selectedModel) return 'Select Model'
  const found = availableModels.find(
    (m) => m.modelId === selectedModel && (!selectedProviderId || m.providerId === selectedProviderId),
  )
  return found ? found.modelName : selectedModel
}

/** 修复前的 selectedModelDisplay 逻辑（用于对比） */
function selectedModelDisplayBefore(params: {
  userOverrodeModel: boolean
  chatMode: string
  agentRole: string
  defaultAgentName: string
  findAgent: (name: string) => AgentConfig | undefined
  selectedModel: string
  selectedProviderId: string
  availableModels: { modelId: string; modelName: string; providerId: string }[]
}): string {
  const { userOverrodeModel, chatMode, agentRole, defaultAgentName, findAgent, selectedModel, selectedProviderId, availableModels } = params

  if (!userOverrodeModel) {
    const agentName = (chatMode === 'agent' && agentRole)
      ? agentRole
      : defaultAgentName
    if (agentName) {
      const cfg = findAgent(agentName)
      if (cfg?.model) return `${cfg.model} ⟵ Agent`
    }
  }
  if (selectedModel === 'auto') return 'Auto'
  if (!selectedModel) return 'Select Model'
  const found = availableModels.find(
    (m) => m.modelId === selectedModel && (!selectedProviderId || m.providerId === selectedProviderId),
  )
  return found ? found.modelName : selectedModel
}

/** 修复后的 syncChatParams 逻辑 */
function computeLetBackendDecide(params: {
  chatMode: string
  agentRole: string
  userOverrodeModel: boolean
}): boolean {
  return params.chatMode === 'agent' && !!params.agentRole && !params.userOverrodeModel
}

/** 修复前的 syncChatParams 逻辑 */
function computeLetBackendDecideBefore(params: {
  chatMode: string
  agentRole: string
  userOverrodeModel: boolean
  defaultAgentName: string
  defaultAgentHasModel: boolean
}): boolean {
  const hasExplicitAgent = params.chatMode === 'agent' && !!params.agentRole
  const defaultAgentHasModel = !hasExplicitAgent && !!params.defaultAgentName && params.defaultAgentHasModel
  return (hasExplicitAgent || defaultAgentHasModel) && !params.userOverrodeModel
}

// ━━━ 测试数据 ━━━

const agents: AgentConfig[] = [
  { name: 'assistant', display_name: '小蟹', model: 'qwen3.5:9b', provider: 'ollama', description: '默认助手' },
]

const findAgent = (name: string) => agents.find(a => a.name === name)

const availableModels = [
  { modelId: 'gemma4:e4b', modelName: 'gemma4:e4b', providerId: 'ollama-1' },
  { modelId: 'qwen3.5:9b', modelName: 'qwen3.5:9b', providerId: 'ollama-1' },
]

// ━━━ 测试 ━━━

describe('Bug 复现：默认模型被 Agent 偏好覆盖', () => {
  const bugScenario = {
    userOverrodeModel: false,
    chatMode: 'chat' as string,      // 普通聊天模式
    agentRole: '',                     // 无显式 Agent
    defaultAgentName: 'assistant',     // 有默认 Agent
    selectedModel: 'gemma4:e4b',       // 用户设置的默认模型
    selectedProviderId: 'ollama-1',
    availableModels,
  }

  it('修复前：普通聊天显示 Agent 模型而非用户默认模型', () => {
    const display = selectedModelDisplayBefore({
      ...bugScenario,
      findAgent,
    })
    // BUG: 用户设了 gemma4 但显示 qwen3.5 ⟵ Agent
    expect(display).toBe('qwen3.5:9b ⟵ Agent')
    expect(display).not.toContain('gemma4')
  })

  it('修复后：普通聊天正确显示用户默认模型', () => {
    const display = selectedModelDisplay({
      ...bugScenario,
      findAgent,
    })
    expect(display).toBe('gemma4:e4b')
  })

  it('修复前：syncChatParams 让后端决策（忽略用户默认模型）', () => {
    const letBackendDecide = computeLetBackendDecideBefore({
      chatMode: 'chat',
      agentRole: '',
      userOverrodeModel: false,
      defaultAgentName: 'assistant',
      defaultAgentHasModel: true,
    })
    // BUG: 普通聊天却 letBackendDecide=true，用户设的默认模型被忽略
    expect(letBackendDecide).toBe(true)
  })

  it('修复后：普通聊天使用用户默认模型', () => {
    const letBackendDecide = computeLetBackendDecide({
      chatMode: 'chat',
      agentRole: '',
      userOverrodeModel: false,
    })
    expect(letBackendDecide).toBe(false)
  })
})

describe('Agent 模式行为不变', () => {
  it('显式 Agent 模式：显示 Agent 模型 + Agent 名字', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: false,
      chatMode: 'agent',
      agentRole: 'assistant',
      findAgent,
      selectedModel: 'gemma4:e4b',
      selectedProviderId: 'ollama-1',
      availableModels,
    })
    expect(display).toBe('qwen3.5:9b · 小蟹')
  })

  it('显式 Agent 模式：letBackendDecide = true', () => {
    const letBackendDecide = computeLetBackendDecide({
      chatMode: 'agent',
      agentRole: 'assistant',
      userOverrodeModel: false,
    })
    expect(letBackendDecide).toBe(true)
  })

  it('Agent 模式但用户手动选了模型：显示用户选择', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: true,
      chatMode: 'agent',
      agentRole: 'assistant',
      findAgent,
      selectedModel: 'gemma4:e4b',
      selectedProviderId: 'ollama-1',
      availableModels,
    })
    expect(display).toBe('gemma4:e4b')
  })

  it('Agent 模式用户手动选模型：letBackendDecide = false', () => {
    const letBackendDecide = computeLetBackendDecide({
      chatMode: 'agent',
      agentRole: 'assistant',
      userOverrodeModel: true,
    })
    expect(letBackendDecide).toBe(false)
  })
})

describe('Agent 无模型偏好时回退到用户默认', () => {
  const agentsNoModel: AgentConfig[] = [
    { name: 'helper', display_name: '助手', model: '', provider: '', description: '无模型偏好' },
  ]

  it('Agent 无 model 配置：显示用户默认模型', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: false,
      chatMode: 'agent',
      agentRole: 'helper',
      findAgent: (n) => agentsNoModel.find(a => a.name === n),
      selectedModel: 'gemma4:e4b',
      selectedProviderId: 'ollama-1',
      availableModels,
    })
    expect(display).toBe('gemma4:e4b')
  })
})

describe('边界情况', () => {
  it('无模型选中：显示 Select Model', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: false,
      chatMode: 'chat',
      agentRole: '',
      findAgent,
      selectedModel: '',
      selectedProviderId: '',
      availableModels,
    })
    expect(display).toBe('Select Model')
  })

  it('auto 模式：显示 Auto', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: false,
      chatMode: 'chat',
      agentRole: '',
      findAgent,
      selectedModel: 'auto',
      selectedProviderId: '',
      availableModels,
    })
    expect(display).toBe('Auto')
  })

  it('模型不在 availableModels 中：显示原始 ID', () => {
    const display = selectedModelDisplay({
      userOverrodeModel: false,
      chatMode: 'chat',
      agentRole: '',
      findAgent,
      selectedModel: 'unknown-model',
      selectedProviderId: '',
      availableModels,
    })
    expect(display).toBe('unknown-model')
  })
})
