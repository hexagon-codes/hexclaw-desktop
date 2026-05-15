import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Tauri FS ────────────────────────────────

const { mockReadTextFile, mockReadDir } = vi.hoisted(() => ({
  mockReadTextFile: vi.fn(),
  mockReadDir: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: mockReadTextFile,
  readDir: mockReadDir,
}))

vi.mock('@tauri-apps/api/path', () => ({
  BaseDirectory: { Resource: 1, AppData: 2 },
  resourceDir: vi.fn().mockResolvedValue('/mock/resource'),
}))

vi.mock('@/config/env', () => ({ env: { isDev: false } }))
vi.mock('@/utils/sizeEstimator', () => ({ estimateSize: () => 0 }))

import { SkillLoader } from '../skillLoader'
import { BaseDirectory } from '@tauri-apps/api/path'

// ── Helpers ───────────────────────────────────────

function makeSkillJson(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    display_name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    capabilities: [],
    entry: 'SKILL.md',
    ...overrides,
  })
}

function makeSkillJsonWithLayers() {
  return JSON.stringify({
    display_name: 'Layered Skill',
    version: '1.0.0',
    layers: [
      { id: 'base', file: 'SKILL.md', trigger: 'always' },
      { id: 'advanced', file: 'advanced.md', trigger: 'user-deep-dive' },
    ],
  })
}

// ── Tests ─────────────────────────────────────────

describe('SkillLoader', () => {
  let loader: SkillLoader

  beforeEach(() => {
    vi.clearAllMocks()
    loader = new SkillLoader(BaseDirectory.AppData)
  })

  // ── loadSkill ────────────────────────────────────

  describe('loadSkill', () => {
    it('loads meta from skill.json', async () => {
      mockReadTextFile.mockResolvedValueOnce(makeSkillJson())

      const pkg = await loader.loadSkill('test-skill')
      expect(pkg.meta.skillId).toBe('test-skill')
      expect(pkg.meta.displayName).toBe('Test Skill')
      expect(pkg.meta.version).toBe('1.0.0')
      expect(pkg.markdown).toBeUndefined()
      expect(pkg.references).toEqual([])
    })

    it('throws SKILL_NOT_FOUND when skill.json missing', async () => {
      mockReadTextFile.mockRejectedValueOnce(new Error('not found'))
      await expect(loader.loadSkill('missing')).rejects.toThrow('skill.json 不存在')
    })

    it('uses fallback defaults for missing fields', async () => {
      mockReadTextFile.mockResolvedValueOnce(JSON.stringify({}))

      const pkg = await loader.loadSkill('minimal')
      expect(pkg.meta.displayName).toBe('minimal')
      expect(pkg.meta.version).toBe('0.0.0')
      expect(pkg.meta.entry).toBe('SKILL.md')
    })

    it('loads SKILL.md when loadMarkdown=true', async () => {
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson())
        .mockResolvedValueOnce('# Hello')

      const pkg = await loader.loadSkill('s1', { loadMarkdown: true })
      expect(pkg.markdown).toBe('# Hello')
    })

    it('loads references when loadReferences=true', async () => {
      mockReadTextFile.mockResolvedValueOnce(makeSkillJson())
      mockReadDir.mockResolvedValueOnce([
        { name: 'ref1.md', isFile: true, isDirectory: false },
        { name: 'ref2.txt', isFile: true, isDirectory: false },
      ])

      const pkg = await loader.loadSkill('s1', { loadReferences: true })
      expect(pkg.references).toHaveLength(2)
      expect(pkg.references[0].relativePath).toBe('ref1.md')
    })
  })

  // ── loadSkillLayer ───────────────────────────────

  describe('loadSkillLayer', () => {
    it('loads correct layer by ID', async () => {
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJsonWithLayers())
        .mockResolvedValueOnce('# Advanced content')

      const pkg = await loader.loadSkillLayer('layered-skill', 'advanced')
      expect(pkg.markdown).toBe('# Advanced content')
    })

    it('throws when layer not found', async () => {
      mockReadTextFile.mockResolvedValueOnce(makeSkillJsonWithLayers())
      await expect(loader.loadSkillLayer('layered-skill', 'nonexistent')).rejects.toThrow('layer "nonexistent" 不存在')
    })

    it('falls back to loadSkill when no layers declared', async () => {
      // loadSkillLayer reads skill.json once (no layers) → falls back to loadSkill() which reads again
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson()) // loadSkillLayer's readSkillJson
        .mockResolvedValueOnce(makeSkillJson()) // loadSkill's readSkillJson

      const pkg = await loader.loadSkillLayer('test-skill', 'base')
      expect(pkg.meta.skillId).toBe('test-skill')
    })
  })

  // ── loadSkillByTrigger ───────────────────────────

  describe('loadSkillByTrigger', () => {
    it('matches exact trigger', async () => {
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJsonWithLayers())
        .mockResolvedValueOnce(makeSkillJsonWithLayers())
        .mockResolvedValueOnce('# Advanced content')

      const pkg = await loader.loadSkillByTrigger('layered-skill', 'user-deep-dive')
      expect(pkg.markdown).toBe('# Advanced content')
    })

    it('falls back to always trigger', async () => {
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJsonWithLayers())
        .mockResolvedValueOnce(makeSkillJsonWithLayers())
        .mockResolvedValueOnce('# Base content')

      const pkg = await loader.loadSkillByTrigger('layered-skill', 'unknown-trigger')
      expect(pkg.markdown).toBe('# Base content')
    })

    it('falls back to loadSkill when no layers', async () => {
      // loadSkillByTrigger reads skill.json once (no layers) → falls back to loadSkill() which reads again
      mockReadTextFile
        .mockResolvedValueOnce(makeSkillJson()) // loadSkillByTrigger's readSkillJson
        .mockResolvedValueOnce(makeSkillJson()) // loadSkill's readSkillJson

      const pkg = await loader.loadSkillByTrigger('test-skill', 'anything')
      expect(pkg.meta.skillId).toBe('test-skill')
    })
  })
})
