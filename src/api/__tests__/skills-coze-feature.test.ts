/**
 * Skill 扣子式增强 — api 契约测试（P1.3 generate / install content + P2.6 hub icon 透传）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiPost = vi.fn()
const apiGet = vi.fn()
vi.mock('@/api/client', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

describe('generateSkill', () => {
  beforeEach(() => {
    apiPost.mockReset()
  })
  it('POST /skills/generate {description} → 返回 content 字符串', async () => {
    apiPost.mockResolvedValue({ content: '---\nname: x\n---\n# x' })
    const { generateSkill } = await import('@/api/skills')
    const md = await generateSkill('一个整理会议纪要的技能')
    expect(apiPost).toHaveBeenCalledWith('/api/v1/skills/generate', {
      description: '一个整理会议纪要的技能',
    })
    expect(md).toContain('name: x')
  })
  it('content 缺失时返回空串（不崩）', async () => {
    apiPost.mockResolvedValue({})
    const { generateSkill } = await import('@/api/skills')
    expect(await generateSkill('x')).toBe('')
  })
})

describe('installSkillContent', () => {
  beforeEach(() => apiPost.mockReset())
  it('POST /skills/install {type:content, content}', async () => {
    apiPost.mockResolvedValue({ name: 'x', message: 'ok' })
    const { installSkillContent } = await import('@/api/skills')
    await installSkillContent('---\nname: x\n---\n# body')
    expect(apiPost).toHaveBeenCalledWith('/api/v1/skills/install', {
      type: 'content',
      content: '---\nname: x\n---\n# body',
    })
  })
})

describe('hub skill icon 透传 (P2.6)', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })
  it('searchClawHub 把后端 icon 字段映射到 ClawHubSkill.icon', async () => {
    apiGet.mockResolvedValue({
      skills: [
        { name: 'a', description: 'd', author: 'x', version: '1', tags: [], downloads: 3, type: 'skill', icon: '📊', rating: 4.5 },
      ],
    })
    const { searchClawHub } = await import('@/api/skills')
    const list = await searchClawHub()
    expect(list[0]!.icon).toBe('📊')
    expect(list[0]!.rating).toBe(4.5)
  })
})
