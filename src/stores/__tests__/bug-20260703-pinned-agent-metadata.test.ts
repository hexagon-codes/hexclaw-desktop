/**
 * BUG-20260703（实机#1「Agent 抢答」前端侧）：
 * 桌面端「发送给 X」是显式契约，但选默认助理时 agentRole='' 不发任何锁定信号，
 * 后端 RouteWithFallback 按内容改派给专属 Agent（人设/模型全被接管）。
 * 契约：聊天请求 metadata 恒带 pinned_agent——命名 Agent 用其名，默认助理用 'default'；
 * 未传（IM/旧链路调用方）则不透传，后端内容路由保持现状。
 */
import { describe, it, expect } from 'vitest'
import { buildChatRequestMetadata } from '../chat-request-metadata'

const base = { thinkingEnabled: false, memoryEnabled: true }

describe('BUG-20260703 pinned_agent 锁定信号', () => {
  it('UT-PINFE-001: 选默认助理（agentRole 为空串）→ pinned_agent=default', () => {
    const meta = buildChatRequestMetadata({ ...base, pinnedAgent: '' })
    expect(meta?.pinned_agent).toBe('default')
  })

  it('UT-PINFE-002: 选命名 Agent → pinned_agent 用其名', () => {
    const meta = buildChatRequestMetadata({ ...base, pinnedAgent: '专业翻译' })
    expect(meta?.pinned_agent).toBe('专业翻译')
  })

  it('UT-PINFE-003: 名字两端空白要归一（后端按名精确查 Agent）', () => {
    const meta = buildChatRequestMetadata({ ...base, pinnedAgent: '  translator  ' })
    expect(meta?.pinned_agent).toBe('translator')
  })

  it('UT-PINFE-004: 未传 pinnedAgent（非聊天调用方）→ 不透传该键', () => {
    const meta = buildChatRequestMetadata({ ...base, thinkingEnabled: true })
    expect(meta && 'pinned_agent' in meta).toBe(false)
  })
})
