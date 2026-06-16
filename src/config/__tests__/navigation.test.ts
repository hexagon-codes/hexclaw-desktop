/**
 * Tests for navigation registry — data integrity, grouping, lookup, children, active matching.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock all lucide-vue-next icon imports — return a marker component for each named export
vi.mock('lucide-vue-next', () => ({
  LayoutDashboard: 'LayoutDashboard',
  MessageSquare: 'MessageSquare',
  Radio: 'Radio',
  Bot: 'Bot',
  BookOpen: 'BookOpen',
  Zap: 'Zap',
  Blocks: 'Blocks',
  ScrollText: 'ScrollText',
  Settings: 'Settings',
}))

import {
  navigationItems,
  getGroupedNavItems,
  getNavigationItem,
  getNavigationChildren,
  isNavActive,
} from '../navigation'

// ═══════════════════════════════════════════════════════════
// navigationItems data integrity
// ═══════════════════════════════════════════════════════════

describe('navigationItems data integrity', () => {
  it('all items have unique ids', () => {
    const ids = navigationItems.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all items have unique paths', () => {
    const paths = navigationItems.map((n) => n.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('all items have i18nKey', () => {
    for (const item of navigationItems) {
      expect(item.i18nKey).toBeTruthy()
    }
  })

  it('total count is 8', () => {
    expect(navigationItems).toHaveLength(8)
    const ids = navigationItems.map((n) => n.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'chat', 'channels', 'agents',
        'knowledge', 'automation', 'integration', 'logs', 'settings',
      ]),
    )
  })
})

// ═══════════════════════════════════════════════════════════
// getGroupedNavItems
// ═══════════════════════════════════════════════════════════

describe('getGroupedNavItems()', () => {
  const groups = getGroupedNavItems()

  it('returns 4 groups: home, build, connections, system', () => {
    expect(Object.keys(groups).sort()).toEqual(['build', 'connections', 'home', 'system'])
  })

  it('home has 1 item (chat)', () => {
    expect(groups.home).toHaveLength(1)
    expect(groups.home![0]!.id).toBe('chat')
  })

  it('build has 3 items (agents, knowledge, automation)', () => {
    expect(groups.build).toHaveLength(3)
    const ids = groups.build.map((n) => n.id)
    expect(ids).toEqual(['agents', 'knowledge', 'automation'])
  })

  it('connections has 2 items (channels + integration)', () => {
    expect(groups.connections).toHaveLength(2)
    const ids = groups.connections.map((n) => n.id)
    expect(ids).toContain('channels')
    expect(ids).toContain('integration')
  })

  it('system has 2 items (logs + settings)', () => {
    expect(groups.system).toHaveLength(2)
    const ids = groups.system.map((n) => n.id)
    expect(ids).toContain('logs')
    expect(ids).toContain('settings')
  })
})

// ═══════════════════════════════════════════════════════════
// getNavigationItem
// ═══════════════════════════════════════════════════════════

describe('getNavigationItem(id)', () => {
  it('returns item for known id "chat"', () => {
    const item = getNavigationItem('chat')
    expect(item).toBeDefined()
    expect(item!.id).toBe('chat')
    expect(item!.path).toBe('/chat')
  })

  it('returns undefined for unknown id', () => {
    expect(getNavigationItem('nonexistent')).toBeUndefined()
  })

  it('returns item with children for "knowledge"', () => {
    const item = getNavigationItem('knowledge')
    expect(item).toBeDefined()
    expect(item!.children).toBeDefined()
    expect(item!.children!.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════
// getNavigationChildren
// ═══════════════════════════════════════════════════════════

describe('getNavigationChildren(id)', () => {
  it('returns 2 children for "knowledge"', () => {
    const children = getNavigationChildren('knowledge')
    expect(children).toHaveLength(2)
  })

  it('returns 2 children for "automation": tasks + webhooks', () => {
    const children = getNavigationChildren('automation')
    expect(children).toHaveLength(2)
    const ids = children.map((c) => c.id)
    expect(ids).toEqual(['automation-tasks', 'automation-webhooks'])
  })

  it('returns empty array for "chat" (no children)', () => {
    expect(getNavigationChildren('chat')).toEqual([])
  })

  it('returns empty array for unknown id', () => {
    expect(getNavigationChildren('unknown')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
// isNavActive
// ═══════════════════════════════════════════════════════════

describe('isNavActive(itemPath, currentPath)', () => {
  it('normal exact match', () => {
    expect(isNavActive('/chat', '/chat')).toBe(true)
  })

  it('normal sub-route match', () => {
    expect(isNavActive('/knowledge', '/knowledge/memory')).toBe(true)
  })

  it('non-matching paths', () => {
    expect(isNavActive('/chat', '/settings')).toBe(false)
  })

  it('prefix trap — /chat does not match /channels', () => {
    expect(isNavActive('/chat', '/channels')).toBe(false)
  })
})
