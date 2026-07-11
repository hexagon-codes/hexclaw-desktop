import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('AUDIT-20260711 cross-layer contracts', () => {
  it('grade request exposes the backend subject routing field', () => {
    const api = src('src/api/k12.ts')
    const gradeReq = api.match(/export interface GradeReq\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(gradeReq).toMatch(/\bsubject\??:\s*string\b/)
  })

  it('orphan binding cleanup also runs when the registered-agent list is empty', () => {
    const view = src('src/views/ChatView.vue')
    const skipsEmptyAgentList =
      /role\s*&&\s*agentsStore\.registeredAgents\.length\s*>\s*0\s*&&\s*!isChannelDefaultAgent/.test(view)

    expect(skipsEmptyAgentList, 'orphan guard is disabled for the empty-list state').toBe(false)
  })

  it('K12 recognition callouts use RTL-safe logical border and radius properties', () => {
    const view = src('src/features/k12/views/RecognizeGuardPanel.vue')
    const callouts = ['rec-row__details', 'rec-cold', 'rec-row'].map(
      (name) => view.match(new RegExp(`\\.${name}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '',
    )

    for (const block of callouts) {
      expect(block).toContain('border-inline-start:')
      expect(block).toContain('border-start-end-radius:')
      expect(block).toContain('border-end-end-radius:')
      expect(block).not.toContain('border-left:')
    }
    expect(view).not.toMatch(/border-left(?:-color)?:/)
  })
})
