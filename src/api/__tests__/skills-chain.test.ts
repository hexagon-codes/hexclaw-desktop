/**
 * Skills Chain — 全场景覆盖
 *
 * 覆盖 getSkills / installSkill / uninstallSkill / setSkillEnabled (含 fallback)
 *        searchClawHub / installFromHub / filterMockSkills / normalizeHubCategory
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

import {
  getSkills,
  installSkill,
  uninstallSkill,
  setSkillEnabled,
  searchClawHub,
  installFromHub,
  CLAWHUB_CATEGORIES,
} from '../skills'

describe('Skills Chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  // ─── getSkills ───────────────────────────────────

  describe('getSkills', () => {
    it('calls GET /api/v1/skills', async () => {
      mockFetch.mockResolvedValue({ skills: [], total: 0, dir: '/skills' })
      const result = await getSkills()
      expect(mockFetch).toHaveBeenCalledWith('/api/v1/skills', expect.objectContaining({ method: 'GET' }))
      expect(result.skills).toEqual([])
      expect(result.dir).toBe('/skills')
    })
  })

  // ─── installSkill ────────────────────────────────

  describe('installSkill', () => {
    it('calls POST /api/v1/skills/install with source', async () => {
      mockFetch.mockResolvedValue({ name: 'test', description: 'desc', version: '1.0', message: 'ok' })
      await installSkill('/path/to/skill')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/skills/install',
        expect.objectContaining({ method: 'POST', body: { source: '/path/to/skill' } }),
      )
    })
  })

  // ─── uninstallSkill ──────────────────────────────

  describe('uninstallSkill', () => {
    it('calls DELETE /api/v1/skills/:name with URL encoding', async () => {
      mockFetch.mockResolvedValue({})
      await uninstallSkill('my skill/v2')
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/v1/skills/${encodeURIComponent('my skill/v2')}`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  // ─── setSkillEnabled ─────────────────────────────

  describe('setSkillEnabled', () => {
    it('returns backend source on success', async () => {
      mockFetch.mockResolvedValue({ enabled: true, effective_enabled: true, requires_restart: false, message: 'ok' })
      const result = await setSkillEnabled('test-skill', true)
      expect(result.source).toBe('backend')
      expect(result.success).toBe(true)
      expect(result.enabled).toBe(true)
    })

    it('falls back to local when backend unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'))
      const result = await setSkillEnabled('test-skill', false)
      expect(result.source).toBe('local-fallback')
      expect(result.success).toBe(true)
      expect(result.enabled).toBe(false)
      expect(result.warning).toContain('Backend unreachable')
    })

    it('handles partial backend response (missing effective_enabled)', async () => {
      mockFetch.mockResolvedValue({ enabled: true })
      const result = await setSkillEnabled('test-skill', true)
      expect(result.effective_enabled).toBeUndefined()
      expect(result.requires_restart).toBeUndefined()
    })

    it('uses requested enabled value when backend omits it', async () => {
      mockFetch.mockResolvedValue({})
      const result = await setSkillEnabled('test-skill', true)
      expect(result.enabled).toBe(true)
    })
  })

  // ─── searchClawHub ───────────────────────────────

  describe('searchClawHub', () => {
    it('calls GET /api/v1/clawhub/search with query params', async () => {
      mockFetch.mockResolvedValue({ skills: [] })
      await searchClawHub('code-review', 'coding')
      const call = mockFetch.mock.calls[0]!
      expect(call[0]).toBe('/api/v1/clawhub/search')
      expect(call[1]).toMatchObject({ method: 'GET', query: { q: 'code-review', category: 'coding' } })
    })

    it('omits category "all" from query params', async () => {
      mockFetch.mockResolvedValue({ skills: [] })
      await searchClawHub('test', 'all')
      const call = mockFetch.mock.calls[0]!
      const query = (call[1] as Record<string, unknown>)?.query as Record<string, unknown> | undefined
      expect(query).not.toHaveProperty('category')
    })

    it('omits empty query from query params', async () => {
      mockFetch.mockResolvedValue({ skills: [] })
      await searchClawHub()
      const call = mockFetch.mock.calls[0]!
      expect(call[0]).toBe('/api/v1/clawhub/search')
      const query = (call[1] as Record<string, unknown>)?.query as Record<string, unknown> | undefined
      expect(query).toEqual({})
    })

    it('throws when backend returns error string', async () => {
      mockFetch.mockResolvedValue({ error: 'Hub unavailable' })
      await expect(searchClawHub('test')).rejects.toThrow('Hub unavailable')
    })

    it('handles raw array response (no skills wrapper)', async () => {
      const skills = [
        { name: 'skill1', description: 'desc', author: 'me', version: '1.0', tags: [], downloads: 0, category: 'coding' },
      ]
      mockFetch.mockResolvedValue(skills)
      const result = await searchClawHub()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('skill1')
    })

    it('normalizes unknown categories to coding', async () => {
      mockFetch.mockResolvedValue({
        skills: [{ name: 'test', description: '', author: '', version: '', tags: [], downloads: 0, category: 'unknown-cat' }],
      })
      const result = await searchClawHub()
      expect(result[0]!.category).toBe('coding')
    })

    it('handles empty error string as non-error', async () => {
      mockFetch.mockResolvedValue({ error: '  ', skills: [] })
      const result = await searchClawHub()
      expect(result).toEqual([])
    })
  })

  // ─── installFromHub ──────────────────────────────

  describe('installFromHub', () => {
    it('calls POST /api/v1/skills/install with clawhub:// source', async () => {
      mockFetch.mockResolvedValue({})
      await installFromHub('code-review-pro')
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/skills/install',
        expect.objectContaining({ method: 'POST', body: { source: 'clawhub://code-review-pro' } }),
      )
    })
  })

  // ─── Constants ───────────────────────────────────

  describe('CLAWHUB_CATEGORIES', () => {
    it('includes all expected categories', () => {
      expect(CLAWHUB_CATEGORIES).toContain('all')
      expect(CLAWHUB_CATEGORIES).toContain('coding')
      expect(CLAWHUB_CATEGORIES).toContain('research')
      expect(CLAWHUB_CATEGORIES).toContain('writing')
      expect(CLAWHUB_CATEGORIES).toContain('data')
      expect(CLAWHUB_CATEGORIES).toContain('automation')
      expect(CLAWHUB_CATEGORIES).toContain('productivity')
    })
  })
})
