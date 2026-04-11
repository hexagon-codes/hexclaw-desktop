/**
 * Code Review v10 — Deep Static Analysis Tests
 *
 * Reads source files and verifies bugs we found and fixed,
 * plus documents remaining issues. Each test reads the actual source
 * and asserts the current (correct or documented) behavior.
 *
 * Categories:
 *   1. ToolApprovalCard timer cleanup (FIXED)
 *   2. CanvasView drag-then-click edge prevention (FIXED)
 *   3. Canvas store self-loop prevention (FIXED)
 *   4. Canvas store runWorkflow backend failure (FIXED)
 *   5. BudgetPanel division by zero (FIXED)
 *   6. LogsView i18n (FIXED)
 *   7. DashboardView dashTab dead code (DOCUMENTED)
 *   8. ResearchProgress doneLabelKey same as labelKey (DOCUMENTED)
 *   9. SettingsSecurity ARIA attribute (DOCUMENTED)
 *  10. ChatExportMenu filename sanitization (DOCUMENTED)
 *  11. ErrorBoundary uses Tailwind instead of BEM (DOCUMENTED)
 *  12. TemplatePopup potential issues (DOCUMENTED)
 *  13. MentionPopup hardcoded limit (DOCUMENTED)
 *  14. CommandPalette theme toggle (DOCUMENTED)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = resolve(__dirname, '..')

function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

// ════════════════════════════════════════════════════════════
// 1. ToolApprovalCard timer cleanup (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #1: ToolApprovalCard timer cleanup', () => {
  const src = readSrc('components/chat/ToolApprovalCard.vue')

  it('imports onUnmounted from vue', () => {
    expect(src).toMatch(/import\s*\{[^}]*onUnmounted[^}]*\}\s*from\s*['"]vue['"]/)
  })

  it('calls clearInterval(timer) inside onUnmounted', () => {
    expect(src).toContain('onUnmounted(() => clearInterval(timer))')
  })

  it('uses setInterval to create countdown timer', () => {
    expect(src).toMatch(/const\s+timer\s*=\s*setInterval\(/)
  })

  it('clears timer on approve action', () => {
    // Verify approve function also clears timer to prevent leak
    const approveBlock = src.slice(src.indexOf('function approve()'))
    expect(approveBlock).toContain('clearInterval(timer)')
  })

  it('clears timer on deny action', () => {
    const denyBlock = src.slice(src.indexOf('function deny()'))
    expect(denyBlock).toContain('clearInterval(timer)')
  })
})

// ════════════════════════════════════════════════════════════
// 2. CanvasView drag-then-click edge prevention (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #2: CanvasView drag-then-click edge prevention', () => {
  const src = readSrc('views/CanvasView.vue')

  it('defines stopDrag function', () => {
    expect(src).toContain('function stopDrag()')
  })

  it('stopDrag clears selectedNodeId to prevent accidental edge creation', () => {
    // Extract the stopDrag function body
    const stopDragStart = src.indexOf('function stopDrag()')
    const stopDragSection = src.slice(stopDragStart, stopDragStart + 200)
    expect(stopDragSection).toContain('selectedNodeId.value = null')
  })

  it('stopDrag only clears selectedNodeId when a drag was in progress', () => {
    const stopDragStart = src.indexOf('function stopDrag()')
    const stopDragSection = src.slice(stopDragStart, stopDragStart + 200)
    expect(stopDragSection).toContain('if (draggingNode.value)')
  })

  it('stopDrag resets draggingNode', () => {
    const stopDragStart = src.indexOf('function stopDrag()')
    const stopDragSection = src.slice(stopDragStart, stopDragStart + 200)
    expect(stopDragSection).toContain('draggingNode.value = null')
  })
})

// ════════════════════════════════════════════════════════════
// 3. Canvas store self-loop prevention (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #3: Canvas store self-loop prevention', () => {
  const src = readSrc('stores/canvas.ts')

  it('addEdge guards against self-loops with from === to check', () => {
    expect(src).toContain('edge.from === edge.to')
  })

  it('addEdge returns early for self-loop edges', () => {
    // The self-loop guard should cause an early return
    const addEdgeStart = src.indexOf('function addEdge(')
    const addEdgeSection = src.slice(addEdgeStart, addEdgeStart + 200)
    expect(addEdgeSection).toMatch(/if\s*\(edge\.from\s*===\s*edge\.to\)\s*return/)
  })

  it('addEdge also checks for duplicate edges', () => {
    const addEdgeStart = src.indexOf('function addEdge(')
    const addEdgeSection = src.slice(addEdgeStart, addEdgeStart + 300)
    expect(addEdgeSection).toContain('e.from === edge.from && e.to === edge.to')
  })
})

// ════════════════════════════════════════════════════════════
// 4. Canvas store runWorkflow backend failure (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #4: Canvas store runWorkflow marks nodes as failed on backend error', () => {
  const src = readSrc('stores/canvas.ts')

  it('else branch marks nodes as failed not completed', () => {
    // The else branch (backend unavailable) should mark all nodes as 'failed'
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(runWorkflowBody.indexOf('} else {'))
    expect(elseBranch).toContain("'failed'")
  })

  it('else branch sets runStatus to failed', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(runWorkflowBody.indexOf('} else {'))
    expect(elseBranch).toContain("runStatus.value = 'failed'")
  })

  it('else branch does NOT mark nodes as completed', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    const elseBranch = runWorkflowBody.slice(
      runWorkflowBody.indexOf('} else {'),
      runWorkflowBody.indexOf('} else {') + 400,
    )
    // The else branch should not contain 'completed' for node status
    expect(elseBranch).not.toMatch(/\[nid\]:\s*'completed'/)
  })

  it('success branch marks nodes as completed with animation', () => {
    const runWorkflowStart = src.indexOf('async function runWorkflow()')
    const runWorkflowBody = src.slice(runWorkflowStart)
    // Between if (res) { and } else {
    const successBranch = runWorkflowBody.slice(
      runWorkflowBody.indexOf('if (res)'),
      runWorkflowBody.indexOf('} else {'),
    )
    expect(successBranch).toContain("'completed'")
    expect(successBranch).toContain("'running'")
  })
})

// ════════════════════════════════════════════════════════════
// 5. BudgetPanel division by zero (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #5: BudgetPanel division by zero guard', () => {
  const src = readSrc('components/chat/BudgetPanel.vue')

  it('tokenPct uses maxTokens > 0 guard', () => {
    expect(src).toMatch(/tokenPct.*props\.maxTokens\s*>\s*0/)
  })

  it('tokenPct returns 0 when maxTokens is 0', () => {
    // The ternary should return 0 for the falsy case
    expect(src).toMatch(/tokenPct.*props\.maxTokens\s*>\s*0\s*\?.*:\s*0/)
  })

  it('costPct uses maxCost > 0 guard', () => {
    expect(src).toMatch(/costPct.*props\.maxCost\s*>\s*0/)
  })

  it('costPct returns 0 when maxCost is 0', () => {
    expect(src).toMatch(/costPct.*props\.maxCost\s*>\s*0\s*\?.*:\s*0/)
  })

  it('durationPct also has division guard', () => {
    expect(src).toMatch(/durationPct.*maxDurSeconds\.value\s*>\s*0/)
  })
})

// ════════════════════════════════════════════════════════════
// 6. LogsView i18n (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #6: LogsView i18n — no hardcoded Chinese strings', () => {
  const src = readSrc('views/LogsView.vue')
  const enLocale = readSrc('i18n/locales/en.ts')
  const zhLocale = readSrc('i18n/locales/zh-CN.ts')

  it('does NOT contain hardcoded "刚刚" string', () => {
    expect(src).not.toContain("'刚刚'")
    expect(src).not.toContain('"刚刚"')
  })

  it('imports formatRelative from utils/time', () => {
    expect(src).toContain("formatRelative")
    expect(src).toContain("from '@/utils/time'")
  })

  it('en.ts has logs.justNow key', () => {
    expect(enLocale).toMatch(/justNow:\s*['"]/)
  })

  it('zh-CN.ts has logs.justNow key', () => {
    expect(zhLocale).toMatch(/justNow:\s*['"]/)
  })

  it('formatRelativeTime delegates to formatRelative from utils/time', () => {
    const fnStart = src.indexOf('function formatRelativeTime')
    const fnBody = src.slice(fnStart, fnStart + 400)
    expect(fnBody).toContain('formatRelative(ts, now.value)')
    // Should not contain literal Chinese characters
    expect(fnBody).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

// ════════════════════════════════════════════════════════════
// 7. DashboardView dashTab dead code (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #7 [DOCUMENTED]: DashboardView dashTab ref is bound but has no conditional rendering', () => {
  const src = readSrc('views/DashboardView.vue')

  it('dashTab ref is declared', () => {
    expect(src).toMatch(/const\s+dashTab\s*=\s*ref\s*\(\s*['"]today['"]\s*\)/)
  })

  it('dashTabs segments are defined for today/week/system', () => {
    expect(src).toContain("key: 'today'")
    expect(src).toContain("key: 'week'")
    expect(src).toContain("key: 'system'")
  })

  it('SegmentedControl is bound to dashTab via v-model', () => {
    expect(src).toContain('v-model="dashTab"')
  })

  it('[SMELL] template does NOT use dashTab for conditional content rendering', () => {
    // The <template> section should not contain v-if/v-show based on dashTab
    const templateStart = src.indexOf('<template>')
    const templateSection = src.slice(templateStart)
    expect(templateSection).not.toMatch(/v-if\s*=\s*["']dashTab/)
    expect(templateSection).not.toMatch(/v-show\s*=\s*["']dashTab/)
  })
})

// ════════════════════════════════════════════════════════════
// 8. ResearchProgress doneLabelKey same as labelKey (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #8 [DOCUMENTED]: ResearchProgress doneLabelKey duplicates labelKey', () => {
  const src = readSrc('components/chat/ResearchProgress.vue')

  it('defines a phases array with doneLabelKey property', () => {
    expect(src).toContain('doneLabelKey')
  })

  it('[SMELL] search phase has doneLabelKey identical to labelKey', () => {
    expect(src).toMatch(/key:\s*'search'.*labelKey:\s*'research\.searching'.*doneLabelKey:\s*'research\.searching'/)
  })

  it('[SMELL] analyze phase has doneLabelKey identical to labelKey', () => {
    expect(src).toMatch(/key:\s*'analyze'.*labelKey:\s*'research\.analyzing'.*doneLabelKey:\s*'research\.analyzing'/)
  })

  it('[SMELL] all four phases have matching labelKey and doneLabelKey', () => {
    // Extract phase definitions
    const phasesMatch = src.match(/const\s+phases[^=]*=\s*\[([\s\S]*?)\]/)
    expect(phasesMatch).not.toBeNull()
    const phasesBlock = phasesMatch![1]!
    // Count labelKey and doneLabelKey pairs
    const labelKeys = [...phasesBlock.matchAll(/labelKey:\s*'([^']+)'/g)].map(m => m[1])
    const doneKeys = [...phasesBlock.matchAll(/doneLabelKey:\s*'([^']+)'/g)].map(m => m[1])
    expect(labelKeys.length).toBe(4)
    expect(doneKeys.length).toBe(4)
    // All doneLabelKeys match their corresponding labelKeys
    for (let i = 0; i < labelKeys.length; i++) {
      expect(doneKeys[i]).toBe(labelKeys[i])
    }
  })
})

// ════════════════════════════════════════════════════════════
// 9. SettingsSecurity ARIA attribute (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #9 [DOCUMENTED]: SettingsSecurity aria-checked may receive non-boolean values', () => {
  const src = readSrc('components/settings/SettingsSecurity.vue')

  it('all toggle elements have role="switch"', () => {
    const switchCount = (src.match(/role="switch"/g) || []).length
    expect(switchCount).toBe(5)
  })

  it('all toggle elements have aria-checked attribute', () => {
    const ariaCount = (src.match(/:aria-checked="/g) || []).length
    expect(ariaCount).toBe(5)
  })

  it('[SMELL] pii_filter aria-checked is NOT wrapped with !! (may be undefined)', () => {
    expect(src).toMatch(/:aria-checked="security\.pii_filter"/)
  })

  it('[SMELL] injection_detection aria-checked is NOT wrapped with !! (may be undefined)', () => {
    expect(src).toMatch(/:aria-checked="security\.injection_detection"/)
  })

  it('conversation_encrypt aria-checked IS properly wrapped with !!', () => {
    expect(src).toContain(':aria-checked="!!security.conversation_encrypt"')
  })

  it('key_rotation aria-checked IS properly wrapped with !!', () => {
    expect(src).toContain(':aria-checked="!!security.key_rotation"')
  })
})

// ════════════════════════════════════════════════════════════
// 10. ChatExportMenu filename sanitization (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #10 [DOCUMENTED]: ChatExportMenu filename lacks sanitization', () => {
  const src = readSrc('components/chat/ChatExportMenu.vue')

  it('uses sessionTitle directly in filename for Markdown export', () => {
    expect(src).toMatch(/download\(md,\s*`\$\{title\}\.md`/)
  })

  it('uses sessionTitle directly in filename for JSON export', () => {
    expect(src).toMatch(/download\(JSON\.stringify.*`\$\{title\}\.json`/)
  })

  it('[SMELL] title comes from sessionTitle without sanitization', () => {
    // title is set from props.sessionTitle which can contain special chars
    expect(src).toContain('const title = props.sessionTitle || t(')
  })

  it('[SMELL] no replace/sanitize call exists for filename characters', () => {
    // The download function does not sanitize the filename param
    const downloadFn = src.slice(src.indexOf('function download('))
    expect(downloadFn).not.toMatch(/\.replace\(/)
    expect(downloadFn).not.toMatch(/sanitize/)
  })
})

// ════════════════════════════════════════════════════════════
// 11. ErrorBoundary uses Tailwind instead of BEM (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #11 [DOCUMENTED]: ErrorBoundary uses Tailwind utility classes instead of BEM', () => {
  const src = readSrc('components/common/ErrorBoundary.vue')

  it('uses Tailwind "flex" class', () => {
    expect(src).toContain('class="h-full flex items-center justify-center p-8"')
  })

  it('uses Tailwind "text-center" class', () => {
    expect(src).toContain('class="text-center max-w-sm"')
  })

  it('uses Tailwind "mx-auto" and "mb-4" classes', () => {
    expect(src).toContain('mx-auto mb-4')
  })

  it('uses Tailwind utility classes on the retry button', () => {
    expect(src).toMatch(/class="inline-flex items-center gap-1\.5 px-4 py-2 rounded-lg/)
  })

  it('[SMELL] does NOT use any hc- BEM class names', () => {
    // ErrorBoundary template has no hc-* prefixed class names
    const templateStart = src.indexOf('<template>')
    const templateEnd = src.indexOf('</template>')
    const template = src.slice(templateStart, templateEnd)
    expect(template).not.toMatch(/class="[^"]*hc-/)
  })
})

// ════════════════════════════════════════════════════════════
// 12. TemplatePopup potential issues (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #12 [DOCUMENTED]: TemplatePopup .catch() on synchronous function and search overlap', () => {
  const src = readSrc('components/chat/TemplatePopup.vue')

  it('dbTemplateIncrementUse is declared as returning void (synchronous)', () => {
    expect(src).toMatch(/function\s+dbTemplateIncrementUse\([^)]*\):\s*void/)
  })

  it('[FIXED] handleSelect calls dbTemplateIncrementUse without .catch()', () => {
    // Previously dbTemplateIncrementUse(tpl.id).catch(() => {}) was called on void return.
    // Now fixed: .catch() removed, called directly.
    expect(src).toContain('dbTemplateIncrementUse(tpl.id)')
    expect(src).not.toContain('dbTemplateIncrementUse(tpl.id).catch')
  })

  it('watch on query calls dbSearchTemplates for server-side filtering', () => {
    const queryWatch = src.slice(src.indexOf("watch(() => props.query"))
    expect(queryWatch).toContain('dbSearchTemplates(q)')
  })

  it('computed "filtered" also does client-side filtering on templates', () => {
    expect(src).toMatch(/const\s+filtered\s*=\s*computed/)
    const filteredComputed = src.slice(src.indexOf('const filtered = computed'))
    expect(filteredComputed).toContain('t.title.toLowerCase().includes(q)')
  })

  it('[SMELL] both watch+dbSearch and computed filter run on query change (redundant filtering)', () => {
    // watch reloads templates from storage on query change
    const watchBlock = src.slice(src.indexOf("watch(() => props.query"))
    expect(watchBlock).toContain('dbSearchTemplates')
    // computed also filters templates.value by query
    const computedBlock = src.slice(src.indexOf('const filtered = computed'), src.indexOf('const filtered = computed') + 300)
    expect(computedBlock).toContain('props.query.toLowerCase()')
  })
})

// ════════════════════════════════════════════════════════════
// 13. MentionPopup hardcoded limit (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #13 [DOCUMENTED]: MentionPopup hardcoded .slice(0, 8) with no overflow indicator', () => {
  const src = readSrc('components/chat/MentionPopup.vue')

  it('filteredItems uses .slice(0, 8) to limit results', () => {
    expect(src).toContain('.slice(0, 8)')
  })

  it('[SMELL] template has no overflow indicator when results exceed 8', () => {
    const templateStart = src.indexOf('<template>')
    const templateEnd = src.indexOf('</template>')
    const template = src.slice(templateStart, templateEnd)
    // No "more items" or "..." indicator exists in the template
    expect(template).not.toContain('more')
    expect(template).not.toMatch(/\+\s*\d+/)
    expect(template).not.toContain('overflow')
  })

  it('items array combines agents and skills without deduplication', () => {
    const computedBlock = src.slice(src.indexOf('const filteredItems = computed'), src.indexOf('.slice(0, 8)'))
    expect(computedBlock).toContain("type: 'agent'")
    expect(computedBlock).toContain("type: 'skill'")
  })
})

// ════════════════════════════════════════════════════════════
// 14. CommandPalette theme toggle (DOCUMENTED)
// ════════════════════════════════════════════════════════════

describe('Issue #14 [DOCUMENTED]: CommandPalette theme toggle only handles dark/light', () => {
  const src = readSrc('components/common/CommandPalette.vue')

  it('toggleTheme reads data-theme attribute', () => {
    expect(src).toContain("root.getAttribute('data-theme')")
  })

  it('toggleTheme only checks for dark to toggle to light', () => {
    expect(src).toContain("current === 'dark' ? 'light' : 'dark'")
  })

  it('[SMELL] toggleTheme does not handle system/auto theme preference', () => {
    const toggleFn = src.slice(src.indexOf('function toggleTheme()'), src.indexOf('function toggleTheme()') + 300)
    expect(toggleFn).not.toContain('matchMedia')
    expect(toggleFn).not.toContain('system')
    expect(toggleFn).not.toContain('auto')
  })

  it('[SMELL] any non-dark value (null, "system", etc.) maps to dark', () => {
    // If data-theme is null or "system", the ternary treats it as non-dark -> sets to dark
    const toggleFn = src.slice(src.indexOf('function toggleTheme()'), src.indexOf('function toggleTheme()') + 300)
    // Only two possible outcomes: 'light' or 'dark'
    const outcomes = toggleFn.match(/setAttribute\('data-theme',\s*current === 'dark' \? 'light' : 'dark'\)/)
    expect(outcomes).not.toBeNull()
  })
})
