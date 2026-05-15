import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Tauri invoke ─────────────────────────────

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

import type { SkillMeta } from '@/types'
import { parseSkillScripts, executeScript } from '../skillExecutor'

// ── Helpers ───────────────────────────────────────

function makeSkillMeta(overrides?: Partial<Record<string, unknown>>): SkillMeta {
  return {
    skillId: 'test-skill',
    displayName: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    capabilities: [],
    entry: 'SKILL.md',
    path: 'skills/test-skill',
    source: 'official',
    ...overrides,
  } as SkillMeta
}

// ── parseSkillScripts ─────────────────────────────

describe('parseSkillScripts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when experimental is absent', () => {
    const meta = makeSkillMeta()
    expect(parseSkillScripts(meta)).toEqual([])
  })

  it('returns empty array when scripts is absent', () => {
    const meta = makeSkillMeta({ experimental: { hooks: [] } })
    expect(parseSkillScripts(meta)).toEqual([])
  })

  it('parses valid scripts', () => {
    const meta = makeSkillMeta({
      experimental: {
        scripts: {
          lint: { file: 'scripts/lint.sh', sandbox: 'restricted' },
          build: { file: 'scripts/build.sh', sandbox: 'full' },
        },
      },
    })

    const result = parseSkillScripts(meta)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ name: 'lint', filePath: 'scripts/lint.sh', sandboxMode: 'restricted' })
    expect(result[1]).toEqual({ name: 'build', filePath: 'scripts/build.sh', sandboxMode: 'full' })
  })

  it('skips entries with missing file', () => {
    const meta = makeSkillMeta({
      experimental: {
        scripts: {
          bad: { sandbox: 'restricted' },
        },
      },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseSkillScripts(meta)
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"bad" missing valid "file"'),
    )
    warnSpy.mockRestore()
  })

  it('skips entries with invalid sandbox', () => {
    const meta = makeSkillMeta({
      experimental: {
        scripts: {
          bad: { file: 'x.sh', sandbox: 'unsafe' },
        },
      },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseSkillScripts(meta)
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid sandbox'),
    )
    warnSpy.mockRestore()
  })

  it('skips non-object script entries', () => {
    const meta = makeSkillMeta({
      experimental: {
        scripts: {
          bad: 'not-an-object',
        },
      },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}
    )
    const result = parseSkillScripts(meta)
    expect(result).toEqual([])
    warnSpy.mockRestore()
  })
})

// ── executeScript ─────────────────────────────────

describe('executeScript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls Tauri invoke and returns structured result', async () => {
    mockInvoke.mockResolvedValueOnce({
      exit_code: 0,
      stdout: 'hello',
      stderr: '',
      timed_out: false,
    })

    const result = await executeScript('my-skill', 'run')
    expect(mockInvoke).toHaveBeenCalledWith('skill_execute_script', {
      skillId: 'my-skill',
      scriptName: 'run',
      input: undefined,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('')
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('passes input to invoke', async () => {
    mockInvoke.mockResolvedValueOnce({ exit_code: 0, stdout: '', stderr: '', timed_out: false })

    await executeScript('s1', 'run', 'user input')
    expect(mockInvoke).toHaveBeenCalledWith('skill_execute_script', {
      skillId: 's1',
      scriptName: 'run',
      input: 'user input',
    })
  })

  it('handles invoke error gracefully', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Tauri not available'))

    const result = await executeScript('s1', 'run')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('Tauri not available')
    expect(result.timedOut).toBe(false)
  })

  it('handles non-Error throw', async () => {
    mockInvoke.mockRejectedValueOnce('string error')

    const result = await executeScript('s1', 'run')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('string error')
  })
})
