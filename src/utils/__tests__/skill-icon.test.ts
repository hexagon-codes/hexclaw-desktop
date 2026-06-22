/**
 * resolveSkillIcon 纯函数单测 —— P0.1 Skill 图标基建。
 */
import { describe, it, expect } from 'vitest'
import { resolveSkillIcon } from '@/utils/skill-icon'

describe('resolveSkillIcon', () => {
  it('emoji icon 透传为 emoji', () => {
    const d = resolveSkillIcon({ icon: '📊', name: 'stocks' })
    expect(d.emoji).toBe('📊')
  })

  it('白名单 lucide 名 icon 直接用', () => {
    const d = resolveSkillIcon({ icon: 'Code', name: 'x' })
    expect(d.emoji).toBeNull()
    expect(d.lucide).toBe('Code')
  })

  it('category 映射到语义图标 + 配色（design→Palette）', () => {
    const d = resolveSkillIcon({ category: 'design', name: 'designer' })
    expect(d.lucide).toBe('Palette')
    expect(d.color).toMatch(/^#/)
  })

  it('category 同义词大小写不敏感（CODE-REVIEW→Code）', () => {
    expect(resolveSkillIcon({ category: 'CODE-REVIEW', name: 'r' }).lucide).toBe('Code')
  })

  it('无 category 时按 tags 映射（finance）', () => {
    expect(resolveSkillIcon({ tags: ['misc', 'Finance'], name: 'f' }).lucide).toBe('TrendingUp')
  })

  it('什么都没有时按 name 哈希给稳定 Puzzle + 区分色', () => {
    const a = resolveSkillIcon({ name: 'alpha' })
    const a2 = resolveSkillIcon({ name: 'alpha' })
    const b = resolveSkillIcon({ name: 'beta-skill' })
    expect(a.lucide).toBe('Puzzle')
    expect(a.color).toBe(a2.color) // 稳定：同名同色
    // 区分度：两个不同名大概率不同色（至少配色盘里有取值）
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('未知 icon 字符串不抛错，回退派生（不渲染原始脏字符串为 lucide）', () => {
    const d = resolveSkillIcon({ icon: '<script>', name: 'xss', category: 'research' })
    expect(d.lucide).toBe('Search') // 落到 category 派生，未把脏串当 lucide
  })

  it('name 缺省也不崩', () => {
    expect(() => resolveSkillIcon({})).not.toThrow()
    expect(resolveSkillIcon({}).color).toMatch(/^#/)
  })
})
