/**
 * Chain F: Skills -> Hub -> Install
 *
 * Tests the skills lifecycle: list installed skills, search ClawHub,
 * install from hub, install from local, uninstall, enable/disable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────

const { mockApiGet, mockApiPost, mockApiPut, mockApiDelete } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPut: vi.fn(),
  mockApiDelete: vi.fn(),
}))

// ── Module mocks ───────────────────────────────────────────────────

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
  api: {},
  apiSSE: vi.fn(),
  apiWebSocket: vi.fn(),
  fromNativeError: vi.fn(),
  createApiError: vi.fn(),
  isRetryable: vi.fn(),
  getErrorMessage: vi.fn(),
}))

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Chain F: Skills -> Hub -> Install', () => {
  it('F1: getSkills returns skill list via GET /api/v1/skills', async () => {
    mockApiGet.mockResolvedValueOnce({
      skills: [
        { name: 'code-review', description: 'Code review', author: 'dev', version: '1.0.0', triggers: [], tags: ['coding'] },
        { name: 'web-search', description: 'Web search', author: 'dev', version: '2.0.0', triggers: [], tags: ['search'] },
      ],
      total: 2,
      dir: '/home/user/.hexclaw/skills',
    })

    const { getSkills } = await import('@/api/skills')
    const result = await getSkills()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/skills')
    expect(result.skills).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.dir).toBe('/home/user/.hexclaw/skills')
    expect(result.skills[0]!.name).toBe('code-review')
  })

  it('F2: searchClawHub searches the hub via GET /api/v1/clawhub/search', async () => {
    mockApiGet.mockResolvedValueOnce({
      skills: [
        { name: 'git-commit-craft', description: 'Git commit message generator', author: 'devtools', version: '1.4.2', tags: ['git'], downloads: 19200, category: 'coding' },
      ],
    })

    const { searchClawHub } = await import('@/api/skills')
    const results = await searchClawHub('git', 'coding')

    expect(mockApiGet).toHaveBeenCalledWith(
      '/api/v1/clawhub/search',
      { q: 'git', category: 'coding' },
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('git-commit-craft')
    expect(results[0]!.category).toBe('coding')
  })

  it('F2b: searchClawHub without query or category calls base URL', async () => {
    mockApiGet.mockResolvedValueOnce({ skills: [] })

    const { searchClawHub } = await import('@/api/skills')
    await searchClawHub()

    expect(mockApiGet).toHaveBeenCalledWith('/api/v1/clawhub/search', {})
  })

  it('F2c: searchClawHub skips category=all (does not send it)', async () => {
    mockApiGet.mockResolvedValueOnce({ skills: [] })

    const { searchClawHub } = await import('@/api/skills')
    await searchClawHub('', 'all')

    const calledQuery = mockApiGet.mock.calls[0]![1] as Record<string, unknown>
    expect(calledQuery).not.toHaveProperty('category')
  })

  it('F2d: searchClawHub propagates backend error', async () => {
    mockApiGet.mockResolvedValueOnce({ error: 'Hub unreachable' })

    const { searchClawHub } = await import('@/api/skills')
    await expect(searchClawHub('test')).rejects.toThrow('Hub unreachable')
  })

  it('F3: installFromHub sends install request with clawhub:// source', async () => {
    mockApiPost.mockResolvedValueOnce({ name: 'code-review-pro', description: 'Auto review', version: '2.1.0', message: 'installed' })

    const { installFromHub } = await import('@/api/skills')
    await installFromHub('code-review-pro')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/skills/install', {
      source: 'clawhub://code-review-pro',
    })
  })

  it('F4: installSkill installs from local path', async () => {
    mockApiPost.mockResolvedValueOnce({
      name: 'my-skill',
      description: 'Local skill',
      version: '0.1.0',
      message: 'installed',
    })

    const { installSkill } = await import('@/api/skills')
    const result = await installSkill('/path/to/skill')

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/skills/install', {
      source: '/path/to/skill',
    })
    expect(result.name).toBe('my-skill')
  })

  it('F5: uninstallSkill calls DELETE /api/v1/skills/:name', async () => {
    mockApiDelete.mockResolvedValueOnce(undefined)

    const { uninstallSkill } = await import('@/api/skills')
    await uninstallSkill('obsolete-skill')

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/skills/obsolete-skill')
  })

  it('F6: setSkillEnabled calls PUT /api/v1/skills/:name/status', async () => {
    mockApiPut.mockResolvedValueOnce({
      success: true,
      enabled: false,
      effective_enabled: false,
      requires_restart: false,
      message: 'Skill disabled',
    })

    const { setSkillEnabled } = await import('@/api/skills')
    const result = await setSkillEnabled('code-review', false)

    expect(mockApiPut).toHaveBeenCalledWith('/api/v1/skills/code-review/status', { enabled: false })
    expect(result.success).toBe(true)
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('backend')
  })

  it('F6b: setSkillEnabled falls back to local on backend failure', async () => {
    mockApiPut.mockRejectedValueOnce(new Error('Backend unavailable'))

    const { setSkillEnabled } = await import('@/api/skills')
    const result = await setSkillEnabled('offline-skill', true)

    expect(result.success).toBe(true)
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('local-fallback')
    expect(result.warning).toBeDefined()
    expect(result.message).toBe('Backend unavailable')
  })

  it('F7: CLAWHUB_CATEGORIES contains all expected categories', async () => {
    const { CLAWHUB_CATEGORIES } = await import('@/api/skills')

    expect(CLAWHUB_CATEGORIES).toEqual(['all', 'coding', 'research', 'writing', 'data', 'automation', 'productivity'])
  })

  it('F8: full lifecycle: search hub -> install -> list -> disable -> uninstall', async () => {
    const { searchClawHub, installFromHub, getSkills, setSkillEnabled, uninstallSkill } = await import('@/api/skills')

    // Search
    mockApiGet.mockResolvedValueOnce({
      skills: [{ name: 'fact-checker', description: 'Fact check', author: 'verify-ai', version: '1.0.5', tags: [], downloads: 8930, category: 'research' }],
    })
    const searchResults = await searchClawHub('fact')
    expect(searchResults).toHaveLength(1)

    // Install
    mockApiPost.mockResolvedValueOnce({ name: 'fact-checker', message: 'installed' })
    await installFromHub('fact-checker')

    // List (should now include it)
    mockApiGet.mockResolvedValueOnce({
      skills: [{ name: 'fact-checker', description: 'Fact check', author: 'verify-ai', version: '1.0.5', triggers: [], tags: [] }],
      total: 1,
      dir: '/skills',
    })
    const skills = await getSkills()
    expect(skills.skills.find((s) => s.name === 'fact-checker')).toBeDefined()

    // Disable
    mockApiPut.mockResolvedValueOnce({ success: true, enabled: false })
    const disableResult = await setSkillEnabled('fact-checker', false)
    expect(disableResult.enabled).toBe(false)

    // Uninstall
    mockApiDelete.mockResolvedValueOnce(undefined)
    await uninstallSkill('fact-checker')
    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/skills/fact-checker')
  })
})
