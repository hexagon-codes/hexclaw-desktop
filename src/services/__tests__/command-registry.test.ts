import { describe, it, expect, beforeEach } from 'vitest'
import { getCommandRegistry } from '../commandRegistry'
import type { CommandDefinition } from '../commandRegistry'
import type { SkillCommand } from '@/types/skill'

// ── Helpers ───────────────────────────────────────

function makeSkillCommand(overrides?: Partial<SkillCommand>): SkillCommand {
  const name = overrides?.name ?? 'test-cmd'
  return {
    name,
    file: `commands/${name}.md`,
    description: 'A test command',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────

describe('CommandRegistry', () => {
  let registry: ReturnType<typeof getCommandRegistry>

  beforeEach(() => {
    // 获取单例并清理状态
    registry = getCommandRegistry()
    // 清理所有已注册的命令
    for (const cmd of registry.getAllCommands()) {
      registry.unregisterSkill(cmd.skillId)
    }
  })

  // ── registerCommands ─────────────────────────────

  describe('registerCommands', () => {
    it('registers commands from SkillCommand array', () => {
      const commands: SkillCommand[] = [
        makeSkillCommand({ name: 'summarize' }),
        makeSkillCommand({ name: 'bulletize' }),
      ]

      registry.registerCommands('test-skill', commands)

      const all = registry.getAllCommands()
      expect(all).toHaveLength(2)
      expect(all.map((c) => c.trigger).sort()).toEqual(['/bulletize', '/summarize'])
    })

    it('sets correct metadata on registered commands', () => {
      const commands = [makeSkillCommand({ name: 'my-cmd', description: 'My command' })]

      registry.registerCommands('my-skill', commands, 'claude-code-import')

      const cmd = registry.findCommand('/my-cmd')
      expect(cmd).toBeDefined()
      expect(cmd!.skillId).toBe('my-skill')
      expect(cmd!.commandName).toBe('my-cmd')
      expect(cmd!.description).toBe('My command')
      expect(cmd!.trigger).toBe('/my-cmd')
      expect(cmd!.mdPath).toBe('commands/my-cmd.md')
      expect(cmd!.source).toBe('claude-code-import')
    })

    it('handles empty commands array', () => {
      registry.registerCommands('empty-skill', [])

      expect(registry.getAllCommands()).toHaveLength(0)
    })

    it('defaults source to skill-package', () => {
      const commands = [makeSkillCommand()]

      registry.registerCommands('default-source', commands)

      const cmd = registry.findCommand('/test-cmd')
      expect(cmd!.source).toBe('skill-package')
    })
  })

  // ── findCommand ──────────────────────────────────

  describe('findCommand', () => {
    it('finds command by exact trigger', () => {
      registry.registerCommands('skill-1', [
        makeSkillCommand({ name: 'summarize' }),
      ])

      const found = registry.findCommand('/summarize')
      expect(found).toBeDefined()
      expect(found!.skillId).toBe('skill-1')
    })

    it('finds command case-insensitively', () => {
      registry.registerCommands('skill-1', [
        makeSkillCommand({ name: 'MyCmd' }),
      ])

      // 应该匹配 /mycmd
      const found = registry.findCommand('/mycmd')
      expect(found).toBeDefined()
      expect(found!.commandName).toBe('MyCmd')
    })

    it('normalizes trigger without leading slash', () => {
      registry.registerCommands('skill-1', [
        makeSkillCommand({ name: 'summarize' }),
      ])

      // 不带 / 前缀也应该匹配
      const found = registry.findCommand('summarize')
      expect(found).toBeDefined()
    })

    it('returns undefined for unknown trigger', () => {
      const found = registry.findCommand('/nonexistent')
      expect(found).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      const found = registry.findCommand('')
      expect(found).toBeUndefined()
    })
  })

  // ── unregisterSkill ──────────────────────────────

  describe('unregisterSkill', () => {
    it('removes all commands for a skill', () => {
      registry.registerCommands('skill-a', [
        makeSkillCommand({ name: 'cmd-a1' }),
        makeSkillCommand({ name: 'cmd-a2' }),
      ])
      registry.registerCommands('skill-b', [
        makeSkillCommand({ name: 'cmd-b1' }),
      ])

      registry.unregisterSkill('skill-a')

      expect(registry.findCommand('/cmd-a1')).toBeUndefined()
      expect(registry.findCommand('/cmd-a2')).toBeUndefined()
      expect(registry.findCommand('/cmd-b1')).toBeDefined()
    })

    it('handles unregistering non-existent skill', () => {
      // 不应抛出错误
      registry.unregisterSkill('nonexistent')

      expect(registry.getAllCommands()).toHaveLength(0)
    })

    it('allows re-registering commands after unregister', () => {
      registry.registerCommands('skill-x', [
        makeSkillCommand({ name: 'cmd-x1' }),
      ])
      registry.unregisterSkill('skill-x')

      registry.registerCommands('skill-x', [
        makeSkillCommand({ name: 'cmd-x2' }),
      ])

      expect(registry.findCommand('/cmd-x1')).toBeUndefined()
      expect(registry.findCommand('/cmd-x2')).toBeDefined()
    })
  })

  // ── getAllCommands ────────────────────────────────

  describe('getAllCommands', () => {
    it('returns empty array when no commands registered', () => {
      expect(registry.getAllCommands()).toEqual([])
    })

    it('returns all registered commands', () => {
      registry.registerCommands('s1', [
        makeSkillCommand({ name: 'a' }),
        makeSkillCommand({ name: 'b' }),
      ])
      registry.registerCommands('s2', [
        makeSkillCommand({ name: 'c' }),
      ])

      const all = registry.getAllCommands()
      expect(all).toHaveLength(3)
      expect(all.map((c) => c.commandName).sort()).toEqual(['a', 'b', 'c'])
    })
  })
})
