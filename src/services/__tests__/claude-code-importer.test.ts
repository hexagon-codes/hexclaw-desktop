import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Tauri FS ────────────────────────────────────────

const { mockReadTextFile, mockReadDir, mockWriteTextFile, mockMkdir, mockExists } = vi.hoisted(() => ({
  mockReadTextFile: vi.fn(),
  mockReadDir: vi.fn(),
  mockWriteTextFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockExists: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: mockReadTextFile,
  readDir: mockReadDir,
  writeTextFile: mockWriteTextFile,
  mkdir: mockMkdir,
  exists: mockExists,
}))

import {
  detectClaudeCodeFormat,
  generateSkillJson,
  importClaudeCodeSkill,
  parseManifestJson,
} from '../claudeCodeImporter'

// ── Helpers ─────────────────────────────────────────────

function mockDir(entries: Array<{ name: string; isFile: boolean; isDirectory?: boolean }>) {
  return entries
}

// ── Tests ───────────────────────────────────────────────

describe('claudeCodeImporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockResolvedValue(false)
    mockMkdir.mockResolvedValue(undefined)
    mockWriteTextFile.mockResolvedValue(undefined)
  })

  // ── detectClaudeCodeFormat ───────────────────────────

  describe('detectClaudeCodeFormat', () => {
    it('detects .claude/commands/ → isClaudeCode true', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'deploy.md', isFile: true }])
        }
        return mockDir([])
      })

      const result = await detectClaudeCodeFormat('/src/my-skill')
      expect(result.isClaudeCode).toBe(true)
      expect(result.hasCommands).toBe(true)
      expect(result.hasAgents).toBe(false)
      expect(result.hasHooks).toBe(false)
    })

    it('detects .claude/agents/ → isClaudeCode true', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/agents')) {
          return mockDir([{ name: 'researcher.md', isFile: true }])
        }
        return mockDir([])
      })

      const result = await detectClaudeCodeFormat('/src/my-skill')
      expect(result.isClaudeCode).toBe(true)
      expect(result.hasCommands).toBe(false)
      expect(result.hasAgents).toBe(true)
    })

    it('detects .claude/hooks/ → isClaudeCode true', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/hooks')) {
          return mockDir([{ name: 'pre-build.sh', isFile: true }])
        }
        return mockDir([])
      })

      const result = await detectClaudeCodeFormat('/src/my-skill')
      expect(result.isClaudeCode).toBe(true)
      expect(result.hasHooks).toBe(true)
    })

    it('empty dir → isClaudeCode false', async () => {
      mockReadDir.mockResolvedValue(mockDir([]))

      const result = await detectClaudeCodeFormat('/src/empty-skill')
      expect(result.isClaudeCode).toBe(false)
      expect(result.hasCommands).toBe(false)
      expect(result.hasAgents).toBe(false)
      expect(result.hasHooks).toBe(false)
    })

    it('handles missing .claude directory gracefully', async () => {
      mockReadDir.mockRejectedValue(new Error('ENOENT'))

      const result = await detectClaudeCodeFormat('/src/no-claude')
      expect(result.isClaudeCode).toBe(false)
    })
  })

  // ── generateSkillJson ───────────────────────────────

  describe('generateSkillJson', () => {
    it('generates valid skill.json from commands/*.md', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([
            { name: 'deploy.md', isFile: true },
            { name: 'test.md', isFile: true },
          ])
        }
        return mockDir([])
      })

      const result = await generateSkillJson('/src/my-skill', '/target/my-skill')

      expect(result.skillId).toBe('my-skill')
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1)

      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written.name).toBe('my-skill')
      expect(written.version).toBe('0.1.0')
      expect(written.entry).toBe('SKILL.md')
      expect(written.commands).toHaveLength(2)
      expect(written.commands[0].name).toBe('deploy')
      expect(written.commands[0].file).toBe('.claude/commands/deploy.md')
    })

    it('uses manifest.json name when available', async () => {
      mockExists.mockImplementation(async (path: string) => {
        return path.endsWith('manifest.json')
      })
      mockReadTextFile.mockResolvedValue(JSON.stringify({
        name: 'my-awesome-skill',
        description: 'A cool skill',
      }))
      mockReadDir.mockResolvedValue(mockDir([]))

      const result = await generateSkillJson('/src/my-skill', '/target')

      expect(result.skillId).toBe('my-awesome-skill')
      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written.display_name).toBe('my-awesome-skill')
      expect(written.description).toBe('A cool skill')
    })

    it('maps agents/*.md to experimental.agents', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/agents')) {
          return mockDir([{ name: 'researcher.md', isFile: true }])
        }
        return mockDir([])
      })

      await generateSkillJson('/src/my-skill', '/target')

      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written.experimental.agents).toHaveLength(1)
      expect(written.experimental.agents[0].name).toBe('researcher')
      expect(written.experimental.agents[0].file).toBe('.claude/agents/researcher.md')
    })

    it('maps hooks/*.sh to experimental.hooks', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/hooks')) {
          return mockDir([{ name: 'pre-build.sh', isFile: true }])
        }
        return mockDir([])
      })

      await generateSkillJson('/src/my-skill', '/target')

      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written.experimental.hooks).toHaveLength(1)
      expect(written.experimental.hooks[0].name).toBe('pre-build')
      expect(written.experimental.hooks[0].event).toBe('pre-task')
    })

    it('omits empty experimental and commands', async () => {
      mockReadDir.mockResolvedValue(mockDir([]))

      await generateSkillJson('/src/my-skill', '/target')

      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written.commands).toBeUndefined()
      expect(written.experimental).toBeUndefined()
    })

    it('includes _trust with claude-code source', async () => {
      mockReadDir.mockResolvedValue(mockDir([]))

      await generateSkillJson('/src/my-skill', '/target')

      const written = JSON.parse(mockWriteTextFile.mock.calls[0][1])
      expect(written._trust).toEqual({
        source: 'claude-code',
        verified: false,
        risk: 'medium',
      })
    })
  })

  // ── importClaudeCodeSkill ────────────────────────────

  describe('importClaudeCodeSkill', () => {
    it('full pipeline with SKILL.md', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'run.md', isFile: true }])
        }
        if (path.endsWith('/target/references')) {
          return mockDir([])
        }
        return mockDir([])
      })
      mockExists.mockImplementation(async (path: string) => {
        if (path.endsWith('SKILL.md')) return true
        if (path.endsWith('references')) return false
        return false
      })
      mockReadTextFile.mockResolvedValue('# Skill Content')

      const result = await importClaudeCodeSkill('/src/my-skill', '/target')

      expect(result.success).toBe(true)
      expect(result.skillId).toBe('my-skill')
      expect(result.warnings).toHaveLength(0)

      // SKILL.md copied
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expect.stringContaining('SKILL.md'),
        '# Skill Content',
      )
      // skill.json written
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expect.stringContaining('skill.json'),
        expect.any(String),
      )
    })

    it('falls back to README.md when SKILL.md missing', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'run.md', isFile: true }])
        }
        return mockDir([])
      })
      mockExists.mockImplementation(async (path: string) => {
        if (path.endsWith('SKILL.md')) return false
        if (path.endsWith('README.md')) return true
        return false
      })
      mockReadTextFile.mockResolvedValue('# README content')

      const result = await importClaudeCodeSkill('/src/my-skill', '/target')

      expect(result.success).toBe(true)
      expect(result.warnings).toContain('SKILL.md 不存在，已从 README.md 生成')
    })

    it('warns when neither SKILL.md nor README.md exist', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'run.md', isFile: true }])
        }
        return mockDir([])
      })

      const result = await importClaudeCodeSkill('/src/my-skill', '/target')

      expect(result.success).toBe(true)
      expect(result.warnings).toContain('未找到 SKILL.md 或 README.md')
    })

    it('returns failure for non-Claude-Code directory', async () => {
      mockReadDir.mockResolvedValue(mockDir([]))

      const result = await importClaudeCodeSkill('/src/empty-dir', '/target')

      expect(result.success).toBe(false)
      expect(result.warnings).toContain('目录不是 Claude Code 格式')
    })

    it('creates target directory', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'run.md', isFile: true }])
        }
        return mockDir([])
      })

      await importClaudeCodeSkill('/src/my-skill', '/target')

      expect(mockMkdir).toHaveBeenCalledWith('/target', { recursive: true })
    })

    it('copies references/ when exists', async () => {
      mockReadDir.mockImplementation(async (path: string) => {
        if (path.endsWith('.claude/commands')) {
          return mockDir([{ name: 'run.md', isFile: true }])
        }
        if (path.endsWith('/src/my-skill/references')) {
          return mockDir([{ name: 'data.json', isFile: true }])
        }
        return mockDir([])
      })
      mockExists.mockImplementation(async (path: string) => {
        if (path.endsWith('SKILL.md')) return true
        if (path.endsWith('references')) return true
        return false
      })
      mockReadTextFile.mockResolvedValue('{}')

      const result = await importClaudeCodeSkill('/src/my-skill', '/target')

      expect(result.success).toBe(true)
      // references dir created + file copied
      expect(mockMkdir).toHaveBeenCalledWith('/target/references', { recursive: true })
      expect(mockWriteTextFile).toHaveBeenCalledWith(
        expect.stringContaining('references/data.json'),
        '{}',
      )
    })
  })

  // ── parseManifestJson ────────────────────────────────

  describe('parseManifestJson', () => {
    it('extracts metadata from manifest.json', async () => {
      mockExists.mockImplementation(async (path: string) => {
        return path.endsWith('manifest.json')
      })
      mockReadTextFile.mockResolvedValue(JSON.stringify({
        name: 'test-skill',
        description: 'A test',
        author: 'tester',
      }))

      const result = await parseManifestJson('/src/my-skill')
      expect(result).toEqual({
        name: 'test-skill',
        description: 'A test',
        author: 'tester',
      })
    })

    it('returns empty when no manifest.json', async () => {
      mockExists.mockResolvedValue(false)

      const result = await parseManifestJson('/src/my-skill')
      expect(result).toEqual({})
    })

    it('handles malformed JSON gracefully', async () => {
      mockExists.mockImplementation(async (path: string) => {
        return path.endsWith('manifest.json')
      })
      mockReadTextFile.mockResolvedValue('{ invalid json')

      const result = await parseManifestJson('/src/my-skill')
      expect(result).toEqual({})
    })

    it('ignores non-string fields', async () => {
      mockExists.mockImplementation(async (path: string) => {
        return path.endsWith('manifest.json')
      })
      mockReadTextFile.mockResolvedValue(JSON.stringify({
        name: 123,
        description: true,
      }))

      const result = await parseManifestJson('/src/my-skill')
      expect(result.name).toBeUndefined()
      expect(result.description).toBeUndefined()
    })
  })
})
