import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Tauri FS ────────────────────────────────

const { mockReadTextFile, mockReadDir, mockResourceDir } = vi.hoisted(() => ({
  mockReadTextFile: vi.fn(),
  mockReadDir: vi.fn(),
  mockResourceDir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: mockReadTextFile,
  readDir: mockReadDir,
}))

vi.mock('@tauri-apps/api/path', () => ({
  BaseDirectory: { Resource: 1, AppData: 2 },
  resourceDir: mockResourceDir,
}))

vi.mock('@/config/env', () => ({ env: { isDev: false } }))

import { SkillRegistry } from '../skillRegistry'
import { BaseDirectory } from '@tauri-apps/api/path'

// ── Helpers ───────────────────────────────────────

function makeSkillJson(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    display_name: 'Test Skill',
    version: '1.0.0',
    description: 'A test',
    capabilities: [],
    entry: 'SKILL.md',
    ...overrides,
  })
}

// ── Tests ─────────────────────────────────────────

describe('SkillRegistry', () => {
  let registry: SkillRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    mockResourceDir.mockResolvedValue(undefined)
    registry = new SkillRegistry(BaseDirectory.Resource, BaseDirectory.AppData)
  })

  // ── sanitizeSkillId (indirect) ───────────────────

  describe('sanitizeSkillId (indirect via discover)', () => {
    it('discovers valid skill IDs', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'my-skill', isDirectory: true }]) // official
        .mockResolvedValueOnce([]) // custom
      mockReadTextFile.mockResolvedValueOnce(makeSkillJson())

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].skillId).toBe('my-skill')
    })

    it('sanitizes directory names with invalid chars', async () => {
      // sanitizeSkillId strips non-alphanumeric chars (except -/_)
      // '../etc' → 'etc', './foo' → 'foo'
      mockReadDir
        .mockResolvedValueOnce([
          { name: '../etc', isDirectory: true },
          { name: 'normal-skill', isDirectory: true },
        ])
        .mockResolvedValueOnce([]) // custom
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson())
        .mockResolvedValueOnce(makeSkillJson())

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(2)
      const ids = skills.map((s) => s.skillId).sort()
      expect(ids).toEqual(['etc', 'normal-skill'])
    })

    it('sanitizes dot-prefixed directory names', async () => {
      // '.hidden' → 'hidden' (dot stripped, not skipped)
      mockReadDir
        .mockResolvedValueOnce([{ name: '.hidden', isDirectory: true }])
        .mockResolvedValueOnce([]) // custom
      mockReadTextFile.mockResolvedValueOnce(makeSkillJson())

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].skillId).toBe('hidden')
    })

    it('skips non-directory entries', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'readme.md', isDirectory: false }])
        .mockResolvedValueOnce([]) // custom

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(0)
    })
  })

  // ── buildFallbackMeta (indirect) ─────────────────

  describe('buildFallbackMeta (indirect)', () => {
    it('generates meta from SKILL.md when skill.json missing', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'fallback-skill', isDirectory: true }])
        .mockResolvedValueOnce([]) // custom
      mockReadTextFile
        .mockRejectedValueOnce(new Error('not found')) // skill.json
        .mockResolvedValueOnce('# Fallback Skill') // SKILL.md

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].skillId).toBe('fallback-skill')
      expect(skills[0].version).toBe('0.0.0')
    })

    it('skips when both skill.json and SKILL.md missing', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'broken', isDirectory: true }])
        .mockResolvedValueOnce([]) // custom
      mockReadTextFile
        .mockRejectedValueOnce(new Error('not found')) // skill.json
        .mockRejectedValueOnce(new Error('not found')) // SKILL.md

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(0)
    })
  })

  // ── resolveSkill ─────────────────────────────────

  describe('resolveSkill', () => {
    it('resolves existing skill', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'target', isDirectory: true }])
        .mockResolvedValueOnce([])
      mockReadTextFile.mockResolvedValueOnce(makeSkillJson())

      const found = await registry.resolveSkill('target')
      expect(found).toBeDefined()
      expect(found?.skillId).toBe('target')
    })

    it('returns undefined for missing skill', async () => {
      mockReadDir
        .mockResolvedValueOnce([]) // official
        .mockResolvedValueOnce([]) // custom

      const found = await registry.resolveSkill('nonexistent')
      expect(found).toBeUndefined()
    })
  })

  // ── Official vs Custom conflict ──────────────────

  describe('official vs custom conflict', () => {
    it('official wins over custom when skill IDs collide', async () => {
      mockReadDir
        .mockResolvedValueOnce([{ name: 'shared', isDirectory: true }]) // official
        .mockResolvedValueOnce([{ name: 'shared', isDirectory: true }]) // custom
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson({ display_name: 'Official' }))
        .mockResolvedValueOnce(makeSkillJson({ display_name: 'Custom' }))

      const skills = await registry.getAllSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].displayName).toBe('Official')
    })
  })

  // ── size ─────────────────────────────────────────

  describe('size', () => {
    it('returns 0 before initialization', () => {
      expect(registry.size).toBe(0)
    })

    it('returns correct count after initialization', async () => {
      mockReadDir
        .mockResolvedValueOnce([
          { name: 'a', isDirectory: true },
          { name: 'b', isDirectory: true },
        ])
        .mockResolvedValueOnce([])
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson())
        .mockResolvedValueOnce(makeSkillJson())

      await registry.getAllSkills()
      expect(registry.size).toBe(2)
    })
  })
})
