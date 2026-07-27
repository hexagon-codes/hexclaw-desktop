import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../..')
const apiSource = fs.readFileSync(path.join(root, 'api/k12.ts'), 'utf8')
const storeSource = fs.readFileSync(path.join(root, 'features/k12/store.ts'), 'utf8')
const recordsSource = fs.readFileSync(
  path.join(root, 'features/k12/views/K12RecordsView.vue'),
  'utf8',
)

describe('approved learning-profile API boundary', () => {
  it('uses only the v57 suppress/restore review commands', () => {
    expect(storeSource).toContain('k12SuppressMistake')
    expect(storeSource).toContain('k12RestoreMistakeReview')
    expect(storeSource).not.toContain('k12ArchiveMistake')
    expect(storeSource).not.toContain('k12RestoreMistake,')
  })

  it('sends defer with the authoritative plan week and mistake CAS version', () => {
    for (const field of ['version: number', 'iso_year: number', 'iso_week: number']) {
      expect(apiSource).toContain(field)
    }
    expect(recordsSource).toContain('version: source.version')
    expect(recordsSource).toContain('iso_year: plan.iso_week_year')
    expect(recordsSource).toContain('iso_week: plan.iso_week_number')
    expect(recordsSource).toContain('错题版本尚未同步，请刷新后重试')
  })
})
