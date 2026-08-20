import { describe, it, expect } from 'vitest'
import {
  isChannelDefaultAgent,
  channelDefaultAgentName,
  resolveEffectiveModel,
  resolveExactChannelModel,
} from '../imChannelBinding'

describe('imChannelBinding — 频道默认模型纯逻辑', () => {
  describe('isChannelDefaultAgent / channelDefaultAgentName', () => {
    it('生成 + 识别匿名频道默认 Agent 命名（一个平台一个）', () => {
      expect(channelDefaultAgentName('telegram')).toBe('@im/telegram')
      expect(channelDefaultAgentName('feishu')).toBe('@im/feishu')
      expect(isChannelDefaultAgent('@im/telegram')).toBe(true)
      expect(isChannelDefaultAgent('@im/feishu')).toBe(true)
    })

    it('普通 Agent / 角色名不被误判为频道默认（不会被过滤出列表）', () => {
      expect(isChannelDefaultAgent('assistant')).toBe(false)
      expect(isChannelDefaultAgent('customer-support')).toBe(false)
      expect(isChannelDefaultAgent('im/telegram')).toBe(false) // 缺 @ 前缀
      expect(isChannelDefaultAgent('')).toBe(false)
    })
  })

  describe('resolveEffectiveModel — 优先级链：命名 Agent / 频道默认 > 全局默认', () => {
    const GLOBAL = 'gpt-4o-mini'

    it('无绑定 Agent → 全局默认', () => {
      expect(resolveEffectiveModel(undefined, GLOBAL)).toEqual({
        modelId: GLOBAL,
        source: 'global',
      })
    })

    it('命名 Agent 有模型偏好 → source=agent + agentLabel', () => {
      const r = resolveEffectiveModel(
        { name: 'support', model: 'claude-sonnet-4', display_name: '客服' },
        GLOBAL,
      )
      expect(r).toEqual({ modelId: 'claude-sonnet-4', source: 'agent', agentLabel: '客服' })
    })

    it('命名 Agent 空模型（声明沿用全局）→ 退回全局默认但仍标注来源 Agent', () => {
      const r = resolveEffectiveModel({ name: 'support', model: '', display_name: '客服' }, GLOBAL)
      expect(r).toEqual({ modelId: GLOBAL, source: 'global', agentLabel: '客服' })
    })

    // 纯接待模型：resolveEffectiveModel 不再特判 @im/*（渠道层不设模型，@im/* 仅作历史遗留）。
    // 传入任何 agent 都按"命名 Agent"解析：有模型 → source=agent；无模型 → 退回全局（保留 agentLabel）。
    // @im/* 的"对用户隐藏"由 userVisibleAgents/UI 负责，不在模型解析里。
    it('不再有 channel 来源：@im/* 也按命名 Agent 解析（有模型→agent）', () => {
      const r = resolveEffectiveModel(
        { name: '@im/feishu', model: 'qwen3-max', display_name: '频道默认模型' },
        GLOBAL,
      )
      expect(r).toEqual({ modelId: 'qwen3-max', source: 'agent', agentLabel: '频道默认模型' })
    })

    it('全局也未配默认 → modelId 空串（UI 据此展示「未配置默认模型」）', () => {
      expect(resolveEffectiveModel(undefined, '')).toEqual({ modelId: '', source: 'global' })
    })

    it('agentLabel 缺 display_name 时回退 name', () => {
      const r = resolveEffectiveModel({ name: 'raw-agent', model: 'm1' }, GLOBAL)
      expect(r).toEqual({ modelId: 'm1', source: 'agent', agentLabel: 'raw-agent' })
    })

    it('保留 Agent 的 provider key，避免同名模型跨 Provider 误配能力', () => {
      expect(
        resolveEffectiveModel(
          { name: 'researcher', provider: 'openai-main', model: 'shared-model' },
          { modelId: 'shared-model', providerId: 'provider-fallback' },
        ),
      ).toEqual({
        modelId: 'shared-model',
        providerKey: 'openai-main',
        source: 'agent',
        agentLabel: 'researcher',
      })
    })
  })

  describe('resolveExactChannelModel — 只消费精确 provider + model 能力', () => {
    const models = [
      {
        providerId: 'provider-supported',
        providerKey: 'openai-main',
        providerName: 'OpenAI Main',
        modelId: 'shared-model',
        modelName: 'Shared supported',
        capabilities: ['text'] as const,
        reasoningSupport: 'supported' as const,
        reasoningControl: {
          dialect: 'reasoning_effort' as const,
          on: 'high',
          off: 'off',
          allowed_efforts: ['high'],
        },
      },
      {
        providerId: 'provider-unsupported',
        providerKey: 'other-provider',
        providerName: 'Other',
        modelId: 'shared-model',
        modelName: 'Shared unsupported',
        capabilities: ['text'] as const,
        reasoningSupport: 'unsupported' as const,
      },
    ]

    it('Agent provider key 精确命中对应模型，不按裸 modelId 取第一项', () => {
      const hit = resolveExactChannelModel(
        {
          modelId: 'shared-model',
          providerKey: 'other-provider',
          source: 'agent',
          agentLabel: '客服',
        },
        models,
      )

      expect(hit?.providerId).toBe('provider-unsupported')
      expect(hit?.reasoningSupport).toBe('unsupported')
    })

    it('缺少精确 Provider 身份时不按裸 modelId 猜测', () => {
      expect(
        resolveExactChannelModel(
          { modelId: 'shared-model', source: 'agent', agentLabel: '旧 Agent' },
          models,
        ),
      ).toBeUndefined()
    })
  })
})
