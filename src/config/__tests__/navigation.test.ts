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

  it('total count is 9', () => {
    expect(navigationItems).toHaveLength(9)
    const ids = navigationItems.map((n) => n.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'dashboard', 'chat', 'channels', 'agents',
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

  it('returns 3 groups: core, integration, system', () => {
    expect(Object.keys(groups).sort()).toEqual(['core', 'integration', 'system'])
  })

  it('core has 6 items', () => {
    expect(groups.core).toHaveLength(6)
  })

  it('integration has 2 items (integration + logs)', () => {
    expect(groups.integration).toHaveLength(2)
    const ids = groups.integration.map((n) => n.id)
    expect(ids).toContain('integration')
    expect(ids).toContain('logs')
  })

  it('system has 1 item (settings)', () => {
    expect(groups.system).toHaveLength(1)
    expect(groups.system![0]!.id).toBe('settings')
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

  it('returns 2 children for "automation"', () => {
    const children = getNavigationChildren('automation')
    expect(children).toHaveLength(2)
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
  it('dashboard exact match', () => {
    expect(isNavActive('/dashboard', '/dashboard')).toBe(true)
  })

  it('dashboard rejects sub-routes', () => {
    expect(isNavActive('/dashboard', '/dashboard/x')).toBe(false)
  })

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
