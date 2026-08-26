import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const k12Root = join(testDir, '..')

function readProductionSources(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__tests__')
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return [readProductionSources(path)]
      if (!entry.isFile() || !/\.(ts|vue)$/.test(entry.name)) return []
      return [readFileSync(path, 'utf8')]
    })
    .join('\n')
}

const k12Source = readProductionSources(k12Root)
const recordsSource = readFileSync(join(k12Root, 'views', 'K12RecordsView.vue'), 'utf8')
const creativeSource = readFileSync(join(k12Root, 'views', 'K12CreativeWorksPanel.vue'), 'utf8')
const apiSource = readFileSync(join(k12Root, '..', '..', 'api', 'k12.ts'), 'utf8')

describe('approved learning-profile contracts remain pinned before production implementation', () => {
  it('[BUG-20260725-010] selects original and per-item variants before one atomic practice-set commit', () => {
    expect(k12Source).toContain('选择加入练习集的题目')
    expect(k12Source).toContain('加入练习集（')
    for (const visibleState of ['生成中', '可选择', '生成失败', '已在练习集']) {
      expect(k12Source).toContain(visibleState)
    }
    expect(k12Source).toContain('PracticeCandidateSelectionDTO')
    expect(recordsSource).not.toMatch(/@click=["']runPracticeGeneration\(item\)["']/)
  })

  it('[BUG-20260725-013] defers only the current week without creating mastery evidence', () => {
    expect(k12Source).toContain('本周先不练')
    expect(k12Source).toContain('deferred_this_week')
    expect(recordsSource).not.toContain('家长确定已会')
    expect(apiSource).toContain('defer-this-week')
  })

  it('[BUG-20260725-017] suppresses only from the all-mistakes more menu and restores prior scheduling', () => {
    expect(k12Source).toContain('suppressed')
    expect(k12Source).toContain('恢复复习')
    expect(apiSource).toContain('/suppress')
    expect(apiSource).toContain('/restore-review')
    expect(apiSource).not.toMatch(/mistakes\/.*\/archive/)
    expect(recordsSource).not.toMatch(/@click=["']archiveMistake/)
  })

  it('[BUG-20260725-020] keeps the creative-work collection on two equal tracks', () => {
    expect(creativeSource).toContain('repeat(2, minmax(0, 1fr))')
    expect(creativeSource).not.toContain('repeat(auto-fill')
    expect(creativeSource).not.toContain('repeat(auto-fit')
    expect(creativeSource).toMatch(/min-height:\s*138px/)
    expect(creativeSource).toMatch(/grid-template-columns:\s*104px\s+minmax\(0,\s*1fr\)/)
    expect(creativeSource).toMatch(/height:\s*104px/)
  })
})
