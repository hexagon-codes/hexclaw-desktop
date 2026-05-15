import { describe, it, expect, beforeEach } from 'vitest'
import { HookRegistry, getHookRegistry } from '../hookRegistry'
import type { HookDefinition } from '../hookRegistry'

// ── Helpers ───────────────────────────────────────

function makeHook(overrides?: Partial<HookDefinition>): HookDefinition {
  return {
    skillId: 'test-skill',
    hookName: 'test-hook',
    event: 'on-load',
    scriptPath: 'hooks/test.sh',
    ...overrides,
  }
}

// ── HookRegistry ──────────────────────────────────

describe('HookRegistry', () => {
  let registry: HookRegistry

  beforeEach(() => {
    registry = new HookRegistry()
  })

  // ── registerHooks + getHooksForEvent ─────────────

  describe('registerHooks + getHooksForEvent', () => {
    it('registers hooks and retrieves by event', () => {
      const hooks = [
        makeHook({ hookName: 'hook-1', event: 'on-load' }),
        makeHook({ hookName: 'hook-2', event: 'on-execute' }),
      ]

      registry.registerHooks('skill-a', hooks)

      expect(registry.getHooksForEvent('on-load')).toHaveLength(1)
      expect(registry.getHooksForEvent('on-execute')).toHaveLength(1)
      expect(registry.getHooksForEvent('on-error')).toHaveLength(0)
    })

    it('registers multiple hooks for same event', () => {
      const hooks = [
        makeHook({ hookName: 'load-1', event: 'on-load' }),
        makeHook({ hookName: 'load-2', event: 'on-load' }),
      ]

      registry.registerHooks('skill-a', hooks)

      const loadHooks = registry.getHooksForEvent('on-load')
      expect(loadHooks).toHaveLength(2)
      expect(loadHooks[0].hookName).toBe('load-1')
      expect(loadHooks[1].hookName).toBe('load-2')
    })

    it('returns empty array for unregistered event', () => {
      expect(registry.getHooksForEvent('on-message')).toEqual([])
    })
  })

  // ── unregisterSkill ──────────────────────────────

  describe('unregisterSkill', () => {
    it('removes all hooks for a skill', () => {
      const hooks = [
        makeHook({ hookName: 'h1', event: 'on-load' }),
        makeHook({ hookName: 'h2', event: 'on-execute' }),
      ]

      registry.registerHooks('skill-a', hooks)
      expect(registry.getHooksForEvent('on-load')).toHaveLength(1)
      expect(registry.getHooksForEvent('on-execute')).toHaveLength(1)

      registry.unregisterSkill('skill-a')

      expect(registry.getHooksForEvent('on-load')).toHaveLength(0)
      expect(registry.getHooksForEvent('on-execute')).toHaveLength(0)
    })

    it('does not affect other skills', () => {
      registry.registerHooks('skill-a', [makeHook({ event: 'on-load' })])
      registry.registerHooks('skill-b', [makeHook({ event: 'on-load' })])

      registry.unregisterSkill('skill-a')

      expect(registry.getHooksForEvent('on-load')).toHaveLength(1)
      expect(registry.getHooksForEvent('on-load')[0].skillId).toBe('skill-b')
    })

    it('no-ops for unknown skill', () => {
      registry.unregisterSkill('nonexistent')
      expect(registry.size).toBe(0)
    })
  })

  // ── getHooksForSkill ─────────────────────────────

  describe('getHooksForSkill', () => {
    it('returns all hooks for a skill', () => {
      registry.registerHooks('skill-a', [
        makeHook({ hookName: 'h1', event: 'on-load' }),
        makeHook({ hookName: 'h2', event: 'on-execute' }),
        makeHook({ hookName: 'h3', event: 'on-error' }),
      ])

      const hooks = registry.getHooksForSkill('skill-a')
      expect(hooks).toHaveLength(3)
    })

    it('returns empty array for unknown skill', () => {
      expect(registry.getHooksForSkill('nonexistent')).toEqual([])
    })
  })

  // ── Multiple skills same event ───────────────────

  describe('multiple skills registering for same event', () => {
    it('collects hooks from all skills', () => {
      registry.registerHooks('skill-a', [makeHook({ hookName: 'a-hook', event: 'on-load' })])
      registry.registerHooks('skill-b', [makeHook({ hookName: 'b-hook', event: 'on-load' })])
      registry.registerHooks('skill-c', [makeHook({ hookName: 'c-hook', event: 'on-load' })])

      const hooks = registry.getHooksForEvent('on-load')
      expect(hooks).toHaveLength(3)
      const names = hooks.map((h) => h.hookName).sort()
      expect(names).toEqual(['a-hook', 'b-hook', 'c-hook'])
    })
  })

  // ── size ─────────────────────────────────────────

  describe('size', () => {
    it('returns 0 for empty registry', () => {
      expect(registry.size).toBe(0)
    })

    it('returns correct count after registration', () => {
      registry.registerHooks('a', [makeHook()])
      registry.registerHooks('b', [makeHook()])
      expect(registry.size).toBe(2)
    })

    it('decrements after unregister', () => {
      registry.registerHooks('a', [makeHook()])
      registry.registerHooks('b', [makeHook()])
      registry.unregisterSkill('a')
      expect(registry.size).toBe(1)
    })
  })

  // ── getHookRegistry singleton ────────────────────

  describe('getHookRegistry', () => {
    it('returns same instance', () => {
      const a = getHookRegistry()
      const b = getHookRegistry()
      expect(a).toBe(b)
    })
  })
})
