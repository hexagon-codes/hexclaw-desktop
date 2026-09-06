import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import * as k12Api from '@/api/k12'

const apiPost = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({
  api: vi.fn(),
  apiGet: vi.fn(),
  apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}))

const retiredLowerStem = String.fromCharCode(112, 114, 101, 112)
const retiredUpperStem = String.fromCharCode(80, 114, 101, 112)
const retiredChineseTerm = ['备', '课'].join('')
const forbiddenNames = [
  `${retiredUpperStem}Card`,
  `${retiredLowerStem}-card`,
  `${retiredLowerStem}_card`,
  `${retiredChineseTerm}卡`,
]
const retiredLowerDomainPattern = new RegExp(`\\b${retiredLowerStem}(?:[A-Z_]|\\b)`)
const retiredUpperDomainPattern = new RegExp(`${retiredUpperStem}(?!are|aring|aration)`)

function repositorySources(root: string): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'target', '.git'].includes(entry.name)) continue
      if (entry.name === 'tutoring-tips-canonicalization.test.ts') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!['.ts', '.tsx', '.vue', '.js', '.md'].includes(extname(entry.name))) continue
      out.push({ path: relative(root, path), source: readFileSync(path, 'utf8') })
    }
  }
  for (const directory of ['src', 'tests', 'docs']) visit(join(root, directory))
  for (const file of ['README.md', 'README.en.md', 'CHANGELOG.md']) {
    out.push({ path: file, source: readFileSync(join(root, file), 'utf8') })
  }
  return out
}

function validResponse() {
  return {
    knowledge_points: ['简易方程'],
    sections: [
      { title: '这页在练什么', content: '等式的性质。', source_label: '📖 依据课本' },
      { title: '小明要留意', content: '暂无历史证据。', source_label: '🧠 学情信号' },
      {
        title: '每道题的答案与讲法',
        content: '先问孩子等式两边应该同时做什么。',
        source_label: '🤖 AI 归纳·供参考',
      },
    ],
  }
}

function request() {
  return {
    agent: 'k12-tutor-ming',
    dispatch_id: 'dispatch-confirmed-1',
  }
}

describe('ADR-K12-022 · TutoringTips 单一契约', () => {
  beforeEach(() => apiPost.mockReset())

  it('源码、测试与当前文档拒绝退役领域语义，只允许通用 prepare 词族与明确负向说明', () => {
    const repositoryRoot = process.cwd()
    const violations = repositorySources(repositoryRoot).flatMap(({ path, source }) => {
      const searchable =
        path === 'docs/guide.md'
          ? source.replace(`独立${retiredChineseTerm}卡已退役`, '')
          : source
      const names = forbiddenNames
        .filter((name) => path.includes(name) || searchable.includes(name))
        .map((name) => `${path}: ${name}`)
      if (retiredLowerDomainPattern.test(searchable)) names.push(`${path}: retired lower domain`)
      if (retiredUpperDomainPattern.test(searchable)) names.push(`${path}: retired upper domain`)
      if (searchable.includes(retiredChineseTerm)) names.push(`${path}: retired Chinese domain`)
      return names
    })
    expect(violations).toEqual([])
  })

  it('K12 descriptor 不声明独立动作或侧栏', () => {
    expect(K12_VIEW_DESCRIPTOR.actions).toEqual([])
    expect(K12_VIEW_DESCRIPTOR.sidePanels).toEqual([])
  })

  it('只调用新端点并仅透传可信 agent + dispatch_id', async () => {
    const call = (k12Api as Record<string, unknown>).k12TutoringTips
    expect(call).toBeTypeOf('function')
    apiPost.mockResolvedValue(validResponse())
    const untrustedClientFields = {
      ...request(),
      grade: '客户端年级',
      subject: '客户端学科',
      knowledge_points: ['客户端知识点'],
      problems: ['客户端题目'],
    }
    await (call as (req: ReturnType<typeof request>, signal: AbortSignal) => Promise<unknown>)(
      untrustedClientFields,
      new AbortController().signal,
    )
    expect(apiPost).toHaveBeenCalledWith('/api/k12/tutoring-tips', request(), {
      timeout: 120_000,
      signal: expect.any(AbortSignal),
    })
  })

  it('响应必须恰为三段固定语义，拒绝额外段与热身内容', async () => {
    const call = (k12Api as Record<string, unknown>).k12TutoringTips as
      | ((req: ReturnType<typeof request>) => Promise<unknown>)
      | undefined
    expect(call).toBeTypeOf('function')
    if (!call) return

    apiPost.mockResolvedValueOnce({
      ...validResponse(),
      sections: [
        ...validResponse().sections,
        { title: '额外练习', content: '先做一道热身题。', source_label: 'AI' },
      ],
    })
    await expect(call(request())).rejects.toThrow()

    apiPost.mockResolvedValueOnce({
      ...validResponse(),
      sections: validResponse().sections.map((section, index) =>
        index === 0 ? { ...section, internal_reference_id: 'doc-1' } : section,
      ),
    })
    await expect(call(request())).rejects.toThrow()

    apiPost.mockResolvedValueOnce({
      ...validResponse(),
      sections: validResponse().sections.map((section, index) =>
        index === 1 ? { ...section, source_label: '🗂 本地记录' } : section,
      ),
    })
    await expect(call(request())).rejects.toThrow()

    apiPost.mockResolvedValueOnce(validResponse())
    await expect(call(request())).resolves.toEqual(validResponse())
  })

  it('界面只有 TutoringTips 内联面板与 canonical DOM 标识', () => {
    const views = import.meta.glob('../views/*.vue', {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>
    const source = views['../views/TutoringTipsPanel.vue']
    expect(source).toBeTypeOf('string')
    expect(source).toContain('data-testid="tutoring-tips"')
    expect(source).not.toContain('热身题')
  })
})
