import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock modules ─────────────────────────────────

vi.mock('@/types', () => ({}))
vi.mock('@/types/capability', () => ({
  DEFAULT_ALLOWED_CAPABILITIES: ['llm', 'filesystem.read'],
}))

vi.mock('./skillExecutor', () => ({
  parseSkillScripts: vi.fn().mockReturnValue([]),
  executeScript: vi.fn(),
}))

vi.mock('./skillLoader', () => ({
  SkillLoader: vi.fn().mockImplementation(() => ({
    loadSkillByTrigger: vi.fn(),
    loadSkill: vi.fn(),
  })),
}))

vi.mock('./runtimeBridge', () => ({
  executeChatTask: vi.fn(),
  registerChatTask: vi.fn(),
}))

vi.mock('@/utils/buildAssistantMessage', () => ({
  buildAssistantMessage: vi.fn(),
}))

vi.mock('./runtime/runtimeServices', () => ({
  getRuntimeServices: vi.fn().mockReturnValue({
    capabilityRegistry: {},
    capabilityValidator: { validate: vi.fn().mockReturnValue({ valid: true }) },
  }),
}))

vi.mock('@/stores/runtime', () => ({
  useRuntimeStore: vi.fn().mockReturnValue({
    loadSkillLayerForTask: vi.fn(),
  }),
}))

vi.mock('@/stores/tasks', () => ({
  useTaskStore: vi.fn().mockReturnValue({
    enqueue: vi.fn(),
  }),
}))

vi.mock('@tauri-apps/api/path', () => ({
  BaseDirectory: { Resource: 1, AppData: 2 },
  resourceDir: vi.fn().mockResolvedValue('/mock'),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
}))

// Shared mock instance for resolveSkillByName tests
const mockGetAllSkills = vi.fn()

vi.mock('./skillRegistry', () => ({
  SkillRegistry: vi.fn().mockImplementation(() => ({
    getAllSkills: mockGetAllSkills,
  })),
}))

import { parseSkillInvocation, resolveSkillByName } from '../skillBridge'
import type { SkillMeta } from '@/types'

// ── Helpers ───────────────────────────────────────

function makeSkill(overrides?: Partial<SkillMeta>): SkillMeta {
  return {
    skillId: 'test-skill',
    displayName: 'Test Skill',
    version: '1.0.0',
    description: '',
    capabilities: [],
    entry: 'SKILL.md',
    path: 'skills/test-skill',
    source: 'official',
    ...overrides,
  }
}

/** Minimal mock registry that only exposes getAllSkills */
function makeMockRegistry(skills: SkillMeta[]) {
  return { getAllSkills: vi.fn().mockResolvedValue(skills) } as any
}

// ── parseSkillInvocation ──────────────────────────

describe('parseSkillInvocation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses @mention with input', () => {
    const result = parseSkillInvocation('@summarize hello world')
    expect(result).toEqual({ skillName: 'summarize', skillInput: 'hello world' })
  })

  it('parses @mention without input', () => {
    const result = parseSkillInvocation('@summarize')
    expect(result).toEqual({ skillName: 'summarize', skillInput: '' })
  })

  it('parses @mention with only whitespace after', () => {
    const result = parseSkillInvocation('@summarize   ')
    expect(result).toEqual({ skillName: 'summarize', skillInput: '' })
  })

  it('returns null for non-skill message', () => {
    expect(parseSkillInvocation('hello world')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseSkillInvocation('')).toBeNull()
  })

  it('returns null for text without @', () => {
    expect(parseSkillInvocation('summarize this text')).toBeNull()
  })

  it('handles @mention with special characters in input', () => {
    const result = parseSkillInvocation('@code-fix print("hello")')
    expect(result).toEqual({ skillName: 'code-fix', skillInput: 'print("hello")' })
  })
})

// ── resolveSkillByName ────────────────────────────

describe('resolveSkillByName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches by skillId (case-insensitive)', async () => {
    const skill = makeSkill({ skillId: 'my-skill', displayName: 'My Skill' })
    const registry = makeMockRegistry([skill])

    const found = await resolveSkillByName('my-skill', registry)
    expect(found).toBeDefined()
    expect(found?.skillId).toBe('my-skill')
  })

  it('matches by displayName (case-insensitive)', async () => {
    const skill = makeSkill({ skillId: 'abc', displayName: 'My Skill' })
    const registry = makeMockRegistry([skill])

    const found = await resolveSkillByName('my skill', registry)
    expect(found).toBeDefined()
    expect(found?.skillId).toBe('abc')
  })

  it('returns undefined when no match', async () => {
    const registry = makeMockRegistry([makeSkill({ skillId: 'other' })])

    const found = await resolveSkillByName('nonexistent', registry)
    expect(found).toBeUndefined()
  })

  it('returns undefined for empty skill list', async () => {
    const registry = makeMockRegistry([])

    const found = await resolveSkillByName('anything', registry)
    expect(found).toBeUndefined()
  })
})
