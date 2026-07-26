import { beforeEach, describe, expect, it } from 'vitest'
import { scenarioRegistry } from '@/shell/scenario/registry'
import {
  resolveK12AssistantIdentityProjection,
  type K12AssistantIdentityProjection,
} from '../assistant-identity'

function registerIdentityProjection() {
  scenarioRegistry.registerIdentityProjectionResolver((ctx) =>
    resolveK12AssistantIdentityProjection(ctx.metadata),
  )
}

describe('BUG-20260726-029 K12 助手身份历史投影', () => {
  beforeEach(() => {
    scenarioRegistry.reset()
    registerIdentityProjection()
  })

  it('从当前孩子档案生成唯一助手身份，并兼容旧自动生成的辅导老师标题', () => {
    const ctx = {
      agentId: 'k12-tutor-xiaoming',
      metadata: {
        scenario: 'k12-tutor',
        'k12.child_name': '小明',
        'k12.grade_term': '五年级下',
      },
    }
    const projection = scenarioRegistry.resolveIdentityProjection(ctx) as K12AssistantIdentityProjection

    expect(projection.displayName).toBe('小明的辅导助手 · 五年级')
    expect(projection.generatedAliases).toContain('小明的辅导老师 · 五年级')
    expect(
      scenarioRegistry.projectInstanceDisplayName(ctx, '小明的辅导老师 · 五年级'),
    ).toBe('小明的辅导助手 · 五年级')
    expect(
      scenarioRegistry.projectInstanceDisplayName(ctx, 'k12-tutor-xiaoming'),
    ).toBe('小明的辅导助手 · 五年级')
  })

  it('只投影 K12 自动身份，不替换自定义会话标题或现实老师语义', () => {
    const ctx = {
      agentId: 'k12-tutor-xiaoming',
      metadata: {
        scenario: 'k12-tutor',
        'k12.child_name': '小明',
        'k12.grade_term': '五年级下',
      },
    }

    expect(
      scenarioRegistry.projectInstanceDisplayName(ctx, '老师布置作业怎么回复？'),
    ).toBe('老师布置作业怎么回复？')
    expect(
      scenarioRegistry.projectInstanceDisplayName(ctx, '我给这个会话起的名字'),
    ).toBe('我给这个会话起的名字')
  })

  it('孩子姓名缺失时 fail closed，不从历史标题猜测儿童身份', () => {
    const ctx = {
      agentId: 'k12-tutor-unknown',
      metadata: { scenario: 'k12-tutor' },
    }

    expect(scenarioRegistry.resolveIdentityProjection(ctx)).toBeNull()
    expect(
      scenarioRegistry.projectInstanceDisplayName(ctx, '小红的辅导老师 · 六年级'),
    ).toBe('小红的辅导老师 · 六年级')
  })
})
