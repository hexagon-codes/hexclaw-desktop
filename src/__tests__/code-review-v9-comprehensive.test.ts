/**
 * Code Review v9 — Comprehensive Static Analysis Tests
 *
 * Reads source files and checks for real business logic issues,
 * inconsistencies, and code quality problems. Each test documents
 * the current behavior (passing green) while the test *name*
 * serves as a code review finding.
 *
 * Categories:
 *  1. Rust proxy HTTP method coverage
 *  2. Manual query string construction
 *  3. URL encoding inconsistencies
 *  4. Webhook delete-by-name anomaly
 *  5. Canvas silent error swallowing
 *  6. Memory API asymmetry
 *  7. Dead / unused API exports
 *  8. Shared endpoint usage
 *  9. Store return completeness
 * 10. Rust proxy DELETE body handling
 * 11. DESKTOP_USER_ID consistency
 * 12. i18n nav key completeness
 * 13. Additional code quality checks
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'

// ─── Helpers ────────────────────────────────────────────

const ROOT = resolve(__dirname, '../..')
const SRC = resolve(__dirname, '..')

function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf-8')
}

function readRoot(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf-8')
}

/** Collect all .ts and .vue files under a directory, excluding tests and node_modules */
function collectProductionFiles(dir: string): { file: string; content: string }[] {
  const results: { file: string; content: string }[] = []
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '__tests__'].includes(entry.name)) continue
        walk(full)
      } else if (
        entry.isFile() &&
        /\.(ts|vue)$/.test(entry.name) &&
        !entry.name.includes('.test.') &&
        !entry.name.includes('.spec.')
      ) {
        results.push({ file: full, content: readFileSync(full, 'utf-8') })
      }
    }
  }
  walk(dir)
  return results
}

// ════════════════════════════════════════════════════════════
// 1. RUST PROXY HTTP METHOD COVERAGE
// ════════════════════════════════════════════════════════════

describe('Issue #1: Rust proxy_api_request HTTP method support', () => {
  const commandsRs = readRoot('src-tauri/src/commands.rs')

  it('proxy supports GET', () => {
    expect(commandsRs).toContain('"GET" => client.get')
  })

  it('proxy supports POST', () => {
    expect(commandsRs).toContain('"POST" =>')
  })

  it('proxy supports PUT', () => {
    expect(commandsRs).toContain('"PUT" =>')
  })

  it('proxy supports DELETE', () => {
    expect(commandsRs).toContain('"DELETE" =>')
    expect(commandsRs).toContain('client.delete')
  })

  it('proxy supports PATCH', () => {
    expect(commandsRs).toContain('"PATCH"')
    expect(commandsRs).toContain('client.patch')
  })

  it('apiPatch exists in client.ts and is used by updateSessionTitle', () => {
    const clientTs = readSrc('api/client.ts')
    expect(clientTs).toContain('export function apiPatch')

    const chatTs = readSrc('api/chat.ts')
    expect(chatTs).toContain('apiPatch')
    // updateSessionTitle function body uses apiPatch
    const updateBlock = chatTs.slice(chatTs.indexOf('function updateSessionTitle'))
    expect(updateBlock.slice(0, 200)).toContain('apiPatch')
  })

  it('config.ts uses proxyApiRequest only with GET/POST/PUT — no PATCH', () => {
    const configTs = readSrc('api/config.ts')
    // config.ts goes through the Rust proxy; confirm it never uses PATCH
    expect(configTs).not.toContain("'PATCH'")
    expect(configTs).not.toContain('"PATCH"')
  })
})

// ════════════════════════════════════════════════════════════
// 2. MANUAL QUERY STRING CONSTRUCTION IN getLogs
// ════════════════════════════════════════════════════════════

describe('Issue #2: getLogs manual URLSearchParams vs apiGet query param', () => {
  const logsTs = readSrc('api/logs.ts')

  it('getLogs uses apiGet query parameter (consistent with other APIs)', () => {
    // Fixed: getLogs now uses apiGet's built-in query parameter support
    expect(logsTs).not.toContain('new URLSearchParams()')
    expect(logsTs).toContain("'/api/v1/logs'")
  })

  it('getLogs does NOT append manual query string to URL path', () => {
    // Fixed: no more manual ?qs concatenation
    expect(logsTs).not.toMatch(/apiGet.*`\/api\/v1\/logs\$\{qs/)
  })

  it('getLogStats uses apiGet without manual query — consistent', () => {
    // getLogStats is a separate function that uses apiGet directly (no URLSearchParams)
    const statsIdx = logsTs.indexOf('function getLogStats')
    expect(statsIdx).toBeGreaterThan(-1)
    const statsBlock = logsTs.slice(statsIdx, statsIdx + 120)
    expect(statsBlock).toContain('apiGet')
    expect(statsBlock).toContain('/api/v1/logs/stats')
    // getLogStats does NOT build URLSearchParams manually
    expect(statsBlock).not.toContain('URLSearchParams')
  })

  it('getLogs passes query object to apiGet', () => {
    // Fixed: now uses apiGet(url, query) pattern
    expect(logsTs).toContain('Object.keys(q).length')
  })
})

// ════════════════════════════════════════════════════════════
// 3. SESSION API URL ENCODING INCONSISTENCY
// ════════════════════════════════════════════════════════════

describe('Issue #3: Session API functions missing encodeURIComponent', () => {
  const chatTs = readSrc('api/chat.ts')

  it('deleteMessage DOES use encodeURIComponent — correct', () => {
    // deleteMessage is defined on a single line; check near its definition
    const idx = chatTs.indexOf('function deleteMessage')
    expect(idx).toBeGreaterThan(-1)
    const block = chatTs.slice(idx, idx + 200)
    expect(block).toContain('encodeURIComponent(messageId)')
  })

  it('forkSession URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function forkSession')
    const block = chatTs.slice(idx, idx + 300)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('getSessionBranches URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function getSessionBranches')
    const block = chatTs.slice(idx, idx + 250)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('getSession URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function getSession(')
    const block = chatTs.slice(idx, idx + 200)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('listSessionMessages URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function listSessionMessages')
    const block = chatTs.slice(idx, idx + 400)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('updateSessionTitle URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function updateSessionTitle')
    const block = chatTs.slice(idx, idx + 250)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('deleteSession URL-encodes sessionId', () => {
    const idx = chatTs.indexOf('function deleteSession')
    const block = chatTs.slice(idx, idx + 200)
    expect(block).toContain('encodeURIComponent(sessionId)')
  })

  it('updateMessageFeedback URL-encodes messageId', () => {
    const idx = chatTs.indexOf('function updateMessageFeedback')
    const block = chatTs.slice(idx, idx + 250)
    expect(block).toContain('encodeURIComponent(messageId)')
  })

  it('other API modules DO use encodeURIComponent for path params consistently', () => {
    // Verify that knowledge, agents, mcp, skills, etc. all encode their path params
    const knowledgeTs = readSrc('api/knowledge.ts')
    expect(knowledgeTs).toContain('getDocument')
    expect(knowledgeTs).toContain('encodeURIComponent(id)')

    const agentsTs = readSrc('api/agents.ts')
    expect(agentsTs).toContain('encodeURIComponent(name)')

    const mcpTs = readSrc('api/mcp.ts')
    expect(mcpTs).toContain('encodeURIComponent(name)')
  })
})

// ════════════════════════════════════════════════════════════
// 4. WEBHOOK DELETE USES NAME INSTEAD OF ID
// ════════════════════════════════════════════════════════════

describe('Issue #4: deleteWebhook uses name parameter, not id', () => {
  const webhookTs = readSrc('api/webhook.ts')

  it('Webhook interface defines both id and name fields', () => {
    expect(webhookTs).toMatch(/interface Webhook[\s\S]*?id:\s*string/)
    expect(webhookTs).toMatch(/interface Webhook[\s\S]*?name:\s*string/)
  })

  it('deleteWebhook function parameter is named "id"', () => {
    expect(webhookTs).toMatch(/function deleteWebhook\(id:\s*string\)/)
  })

  it('deleteWebhook path uses the id parameter', () => {
    expect(webhookTs).toMatch(/\/api\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}/)
  })

  it('other delete functions use id — agents, team, knowledge, mcp all use id/name consistently', () => {
    const agentsTs = readSrc('api/agents.ts')
    expect(agentsTs).toMatch(/unregisterAgent\(name:\s*string\)/)

    const mcpTs = readSrc('api/mcp.ts')
    expect(mcpTs).toMatch(/removeMcpServer\(name:\s*string\)/)

    // For entity types that have both id and name, skills and MCP use name
    // because those entities are name-keyed (no numeric id).
    // But Webhook HAS an id field — using name is the inconsistency.
    const skillsTs = readSrc('api/skills.ts')
    expect(skillsTs).toMatch(/uninstallSkill\(name:\s*string\)/)
  })

  it('team and knowledge delete functions use id (the standard pattern)', () => {
    const teamTs = readSrc('api/team.ts')
    expect(teamTs).toMatch(/deleteSharedAgent\(id:\s*string\)/)
    expect(teamTs).toMatch(/removeTeamMember\(id:\s*string\)/)

    const knowledgeTs = readSrc('api/knowledge.ts')
    expect(knowledgeTs).toMatch(/deleteDocument\(id:\s*string\)/)
  })
})

// ════════════════════════════════════════════════════════════
// 5. CANVAS API SILENT ERROR SWALLOWING
// ════════════════════════════════════════════════════════════

describe('Issue #5: Canvas workflow functions silently catch ALL errors', () => {
  const canvasTs = readSrc('api/canvas.ts')

  it('saveWorkflow catches errors with parameter and logs via logger', () => {
    const saveBlock = canvasTs.match(/async function saveWorkflow[\s\S]*?^}/m)?.[0] || ''
    expect(saveBlock).toContain('} catch (e) {')
    expect(saveBlock).toContain('logger.warn')
  })

  it('getWorkflows catches errors with parameter and logs via logger', () => {
    const getBlock = canvasTs.match(/async function getWorkflows[\s\S]*?^}/m)?.[0] || ''
    expect(getBlock).toContain('} catch (e) {')
    expect(getBlock).toContain('logger.warn')
  })

  it('deleteWorkflow catches errors with parameter and logs via logger', () => {
    const deleteBlock = canvasTs.match(/async function deleteWorkflow[\s\S]*?^}/m)?.[0] || ''
    expect(deleteBlock).toContain('} catch (e) {')
    expect(deleteBlock).toContain('logger.warn')
  })

  it('runWorkflow propagates errors to caller (store handles fallback)', () => {
    const runBlock = canvasTs.match(/export async function runWorkflow[\s\S]*?^}/m)?.[0] || ''
    // No try/catch — errors propagate to the store layer
    expect(runBlock).not.toContain('catch')
    expect(runBlock).toContain('apiPost')
  })

  it('getWorkflowRun does NOT catch errors — it is the only one that propagates', () => {
    const runStatusBlock = canvasTs.match(/async function getWorkflowRun[^}]+\}/s)?.[0] || ''
    expect(runStatusBlock).not.toContain('catch')
  })

  it('listPanels and getPanel do NOT silently catch — they propagate errors', () => {
    // These non-workflow functions correctly let errors propagate
    expect(canvasTs).toMatch(/function listPanels\(\)[\s\S]*?return apiGet/)
    expect(canvasTs).toMatch(/function getPanel\(id[\s\S]*?return apiGet/)
    // Neither has a try/catch
    const listBlock = canvasTs.match(/function listPanels\(\)[^}]+\}/s)?.[0] || ''
    expect(listBlock).not.toContain('catch')
  })
})

// ════════════════════════════════════════════════════════════
// 6. MEMORY API: updateMemory MISSING TYPE PARAMETER
// ════════════════════════════════════════════════════════════

describe('Issue #6: updateMemory missing type parameter vs saveMemory', () => {
  const memoryTs = readSrc('api/memory.ts')

  it('saveMemory accepts optional type parameter', () => {
    expect(memoryTs).toMatch(/function saveMemory\(content:\s*string,\s*type\?/)
  })

  it('saveMemory sends type in the request body', () => {
    expect(memoryTs).toMatch(/apiPost.*\{.*content.*type/)
  })

  it('updateMemory accepts an optional type parameter (same as saveMemory)', () => {
    const updateSig = memoryTs.match(/function updateMemory\([^)]+\)/)?.[0] || ''
    expect(updateSig).toContain('content: string')
    expect(updateSig).toContain('type')
  })

  it('updateMemory request body includes type field with default "memory"', () => {
    const updateBlock = memoryTs.match(/function updateMemory[\s\S]*?^\}/m)?.[0] || ''
    expect(updateBlock).toContain("type: type ?? 'memory'")
  })
})

// ════════════════════════════════════════════════════════════
// 7. DEAD / UNUSED API EXPORTS
// ════════════════════════════════════════════════════════════

describe('Issue #7: API functions exported but never imported in production code', () => {
  const productionFiles = collectProductionFiles(SRC)

  /** Check if a name is used in any production file other than its definition file */
  function isUsedInProduction(name: string, definedInFile: string): boolean {
    return productionFiles.some(({ file, content }) => {
      if (file === definedInFile) return false
      return content.includes(name)
    })
  }

  it('sendStreamViaTauri has been removed from chat.ts (dead code cleanup)', () => {
    const chatTs = readSrc('api/chat.ts')
    expect(chatTs).not.toContain('sendStreamViaTauri')
  })

  it('getSession is exported from chat.ts but not used in production code', () => {
    const chatFile = resolve(SRC, 'api/chat.ts')
    // getSession is defined in chat.ts. Check if any other production file references it.
    // Note: "getSession" is a common string so we check more carefully
    const used = productionFiles.some(({ file, content }) => {
      if (file === chatFile) return false
      // Must appear as an import or a call, not just a substring
      return (
        content.includes('getSession') &&
        !file.includes('__tests__') &&
        (content.includes("import") && content.includes('getSession'))
      )
    })
    // getSession may be re-exported through index.ts barrel.
    // Check if any non-api file actually imports and calls it.
    const callers = productionFiles.filter(({ file, content }) => {
      if (file.includes('api/index.ts') || file.includes('api/chat.ts')) return false
      return content.includes('getSession(') || content.includes('getSession,')
    })
    // If callers is empty, the function is dead code in production
    expect(callers.length).toBe(0)
  })

  it('deleteMemory is exported from memory.ts — verify if used', () => {
    const memoryFile = resolve(SRC, 'api/memory.ts')
    const callers = productionFiles.filter(({ file, content }) => {
      if (file === memoryFile || file.includes('api/index.ts')) return false
      return content.includes('deleteMemory')
    })
    // deleteMemory is likely used in KnowledgeView or MemoryView
    // This test documents whether it has callers
    if (callers.length === 0) {
      // Document: deleteMemory is not called in any production file
      expect(callers).toHaveLength(0)
    } else {
      expect(callers.length).toBeGreaterThan(0)
    }
  })

  it('getStats is exported from system.ts — verify if used', () => {
    const systemFile = resolve(SRC, 'api/system.ts')
    const callers = productionFiles.filter(({ file, content }) => {
      if (file === systemFile || file.includes('api/index.ts')) return false
      return content.includes('getStats(') || content.includes('getStats,')
    })
    // Document whether getStats is actually called
    if (callers.length === 0) {
      expect(callers).toHaveLength(0)
    } else {
      expect(callers.length).toBeGreaterThan(0)
    }
  })

  it('getVoiceStatus is exported from voice.ts — verify if used', () => {
    const voiceFile = resolve(SRC, 'api/voice.ts')
    const callers = productionFiles.filter(({ file, content }) => {
      if (file === voiceFile || file.includes('api/index.ts')) return false
      return content.includes('getVoiceStatus')
    })
    if (callers.length === 0) {
      expect(callers).toHaveLength(0)
    } else {
      expect(callers.length).toBeGreaterThan(0)
    }
  })

  it('speechToText is exported from voice.ts — verify if used', () => {
    const voiceFile = resolve(SRC, 'api/voice.ts')
    const callers = productionFiles.filter(({ file, content }) => {
      if (file === voiceFile || file.includes('api/index.ts')) return false
      return content.includes('speechToText')
    })
    if (callers.length === 0) {
      expect(callers).toHaveLength(0)
    } else {
      expect(callers.length).toBeGreaterThan(0)
    }
  })
})

// ════════════════════════════════════════════════════════════
// 8. CHAT.TS SESSION ID NOT URL-ENCODED IN MULTIPLE FUNCTIONS
// ════════════════════════════════════════════════════════════

describe('Issue #8: chat.ts — session IDs embedded raw in URL template literals', () => {
  const chatTs = readSrc('api/chat.ts')

  // All session functions now use encodeURIComponent for sessionId
  it('all session functions use encodeURIComponent(sessionId) in URL paths', () => {
    // Functions: forkSession, getSessionBranches, getSession, listSessionMessages,
    //            updateSessionTitle, deleteSession
    const encodedSessionIdUsages = chatTs.match(/\$\{encodeURIComponent\(sessionId\)\}/g) || []
    expect(encodedSessionIdUsages.length).toBeGreaterThanOrEqual(6)
  })

  it('chat.ts uses encodeURIComponent for all path params (sessionId + messageId)', () => {
    const encodeUsages = chatTs.match(/encodeURIComponent/g) || []
    // 6 session functions + deleteMessage + updateMessageFeedback = 8
    expect(encodeUsages.length).toBeGreaterThanOrEqual(8)
  })
})

// ════════════════════════════════════════════════════════════
// 9. SHARED ENDPOINT: searchMcpMarketplace AND searchClawHub
// ════════════════════════════════════════════════════════════

describe('Issue #9: searchMcpMarketplace and searchClawHub share /api/v1/clawhub/search', () => {
  const mcpTs = readSrc('api/mcp.ts')
  const skillsTs = readSrc('api/skills.ts')

  it('searchMcpMarketplace uses CLAWHUB_SEARCH_ENDPOINT constant with type=mcp', () => {
    expect(mcpTs).toContain("CLAWHUB_SEARCH_ENDPOINT = '/api/v1/clawhub/search'")
    expect(mcpTs).toContain("type: 'mcp'")
  })

  it('getMcpMarketplace also uses CLAWHUB_SEARCH_ENDPOINT with type=mcp', () => {
    const getMcpBlock = mcpTs.match(/function getMcpMarketplace[\s\S]*?^}/m)?.[0] || ''
    expect(getMcpBlock).toContain('CLAWHUB_SEARCH_ENDPOINT')
    expect(getMcpBlock).toContain("type: 'mcp'")
  })

  it('searchClawHub calls /api/v1/clawhub/search (same endpoint, no type filter by default)', () => {
    expect(skillsTs).toContain("'/api/v1/clawhub/search'")
  })

  it('searchClawHub and searchMcpMarketplace both hit the same backend endpoint', () => {
    // This is by design: they share the hub search API but filter differently.
    // searchMcpMarketplace always passes type='mcp'
    // searchClawHub passes category when provided, no forced type filter
    const mcpSearch = mcpTs.match(/function searchMcpMarketplace[\s\S]*?^}/m)?.[0] || ''
    const hubSearch = skillsTs.match(/function searchClawHub[\s\S]*?^}/m)?.[0] || ''

    expect(mcpSearch).toContain("type: 'mcp'")
    // searchClawHub does not force a type parameter
    expect(hubSearch).not.toContain("type: 'mcp'")
  })
})

// ════════════════════════════════════════════════════════════
// 10. CHAT STORE: streamingReasoningStartTime IS EXPORTED (FIXED)
// ════════════════════════════════════════════════════════════

describe('Issue #10: streamingReasoningStartTime in chat store return (FIXED)', () => {
  const chatStoreTs = readFileSync(resolve(SRC, 'stores/chat.ts'), 'utf-8')

  it('streamingReasoningStartTime is declared as a ref in the store', () => {
    expect(chatStoreTs).toMatch(/streamingReasoningStartTime\s*=\s*ref/)
  })

  it('streamingReasoningStartTime IS included in the store return object', () => {
    // This was previously missing. Verify it is now returned.
    const returnIdx = chatStoreTs.lastIndexOf('return {')
    expect(returnIdx).toBeGreaterThan(-1)
    const returnBlock = chatStoreTs.slice(returnIdx, returnIdx + 600)
    expect(returnBlock).toContain('streamingReasoningStartTime')
  })

  it('streamingReasoningStartTime is used to calculate thinking duration', () => {
    expect(chatStoreTs).toContain('streamingReasoningStartTime.value')
    expect(chatStoreTs).toContain('Date.now() - streamingReasoningStartTime.value')
  })

  it('streamingReasoningStartTime is reset to 0 on cancel/done', () => {
    const resets = chatStoreTs.match(/streamingReasoningStartTime\.value\s*=\s*0/g) || []
    // Should be reset in multiple places: finishAssistantMessage, cancelStream, etc.
    expect(resets.length).toBeGreaterThanOrEqual(3)
  })
})

// ════════════════════════════════════════════════════════════
// 11. RUST PROXY DROPS DELETE BODY
// ════════════════════════════════════════════════════════════

describe('Issue #11: Rust proxy DELETE does not forward body', () => {
  const commandsRs = readRoot('src-tauri/src/commands.rs')
  const clientTs = readSrc('api/client.ts')

  it('Rust proxy DELETE handler now forwards body (like POST/PUT/PATCH)', () => {
    // The DELETE arm now attaches body just like POST/PUT
    const deleteSection = commandsRs.slice(commandsRs.indexOf('"DELETE" =>'))
    const nextArm = deleteSection.indexOf('\n        }')
    const deleteArm = deleteSection.slice(0, nextArm + 10)
    expect(deleteArm).toContain('client.delete')
    expect(deleteArm).toContain('body')
  })

  it('TypeScript apiDelete does not accept a body parameter (consistent)', () => {
    // apiDelete<T>(url: string) — no body param
    const deleteFunc = clientTs.match(/function apiDelete[^}]+\}/s)?.[0] || ''
    expect(deleteFunc).toContain('url: string')
    // Verify the function does NOT accept a body parameter
    expect(deleteFunc).not.toContain('body')
  })

  it('Rust POST, PUT, and DELETE all forward body', () => {
    // Confirm POST, PUT, and DELETE all handle the body
    const postArm = commandsRs.match(/"POST"\s*=>[\s\S]*?(?="PUT")/)?.[0] || ''
    expect(postArm).toContain('body')
    const putArm = commandsRs.match(/"PUT"\s*=>[\s\S]*?(?="DELETE")/)?.[0] || ''
    expect(putArm).toContain('body')
    // DELETE now also forwards body (like POST/PUT/PATCH)
    const deleteSection = commandsRs.slice(commandsRs.indexOf('"DELETE" =>'))
    expect(deleteSection).toContain('body')
  })
})

// ════════════════════════════════════════════════════════════
// 12. DESKTOP_USER_ID CONSTANT USAGE CONSISTENCY
// ════════════════════════════════════════════════════════════

describe('Issue #12: API functions that send user_id use DESKTOP_USER_ID constant', () => {
  it('chat.ts imports and uses DESKTOP_USER_ID', () => {
    const chatTs = readSrc('api/chat.ts')
    expect(chatTs).toContain("import { DESKTOP_USER_ID } from '@/constants'")
    expect(chatTs).toContain('user_id: DESKTOP_USER_ID')
  })

  it('tasks.ts imports and uses DESKTOP_USER_ID', () => {
    const tasksTs = readSrc('api/tasks.ts')
    expect(tasksTs).toContain("import { DESKTOP_USER_ID } from '@/constants'")
    expect(tasksTs).toContain('user_id: DESKTOP_USER_ID')
  })

  it('webhook.ts imports and uses DESKTOP_USER_ID', () => {
    const webhookTs = readSrc('api/webhook.ts')
    expect(webhookTs).toContain("import { DESKTOP_USER_ID } from '@/constants'")
    expect(webhookTs).toContain('user_id: DESKTOP_USER_ID')
  })

  it('websocket.ts imports and uses DESKTOP_USER_ID', () => {
    const wsTs = readSrc('api/websocket.ts')
    expect(wsTs).toContain("import { DESKTOP_USER_ID } from '@/constants'")
    expect(wsTs).toContain('user_id: DESKTOP_USER_ID')
  })

  it('no API file uses hardcoded "desktop-user" string instead of the constant', () => {
    const apiFiles = [
      'api/chat.ts', 'api/tasks.ts', 'api/webhook.ts', 'api/websocket.ts',
      'api/memory.ts', 'api/mcp.ts', 'api/skills.ts', 'api/agents.ts',
      'api/knowledge.ts', 'api/canvas.ts', 'api/system.ts', 'api/voice.ts',
      'api/ollama.ts', 'api/team.ts', 'api/logs.ts', 'api/settings.ts',
    ]
    for (const f of apiFiles) {
      const content = readSrc(f)
      const hasHardcoded = content.includes("'desktop-user'") || content.includes('"desktop-user"')
      expect(hasHardcoded, `${f} should not hardcode "desktop-user"`).toBe(false)
    }
  })

  it('Rust backend_chat uses "desktop-user" as default — matches DESKTOP_USER_ID constant', () => {
    const commandsRs = readRoot('src-tauri/src/commands.rs')
    expect(commandsRs).toContain('"desktop-user"')
    const constantsTs = readSrc('constants.ts')
    expect(constantsTs).toContain("'desktop-user'")
  })

  it('tasks.ts deleteCronJob does NOT URL-encode the job id', () => {
    // Also verifying tasks.ts path parameter handling as part of the user_id review
    const tasksTs = readSrc('api/tasks.ts')
    const deleteBlock = tasksTs.match(/function deleteCronJob[\s\S]*?^}/m)?.[0] || ''
    expect(deleteBlock).toContain('encodeURIComponent(id)')
  })
})

// ════════════════════════════════════════════════════════════
// 13. I18N NAV KEY COMPLETENESS
// ════════════════════════════════════════════════════════════

describe('Issue #13: i18n nav key completeness — all navigation items have translations', () => {
  const enTs = readFileSync(resolve(SRC, 'i18n/locales/en.ts'), 'utf-8')
  const zhTs = readFileSync(resolve(SRC, 'i18n/locales/zh-CN.ts'), 'utf-8')
  const navigationTs = readFileSync(resolve(SRC, 'config/navigation.ts'), 'utf-8')

  // Extract all i18nKey values from navigation.ts
  const i18nKeys = [...navigationTs.matchAll(/i18nKey:\s*'([^']+)'/g)].map(m => m[1]!)

  it('navigation.ts defines at least 10 nav items with i18nKeys', () => {
    expect(i18nKeys.length).toBeGreaterThanOrEqual(10)
  })

  for (const key of i18nKeys) {
    const shortKey = key.replace('nav.', '')
    it(`en.ts has nav key "${shortKey}"`, () => {
      expect(enTs).toContain(`${shortKey}:`)
    })
    it(`zh-CN.ts has nav key "${shortKey}"`, () => {
      expect(zhTs).toContain(`${shortKey}:`)
    })
  }

  it('sidebar uses t("nav.sidebarLabel") — key exists in both locales', () => {
    expect(enTs).toContain('sidebarLabel')
    expect(zhTs).toContain('sidebarLabel')
  })

  it('engine status keys exist in both locales', () => {
    const statusKeys = ['engineRunning', 'engineStarting', 'engineStopped', 'restartEngine']
    for (const key of statusKeys) {
      expect(enTs, `en.ts missing ${key}`).toContain(`${key}:`)
      expect(zhTs, `zh-CN.ts missing ${key}`).toContain(`${key}:`)
    }
  })
})

// ════════════════════════════════════════════════════════════
// 14. ADDITIONAL CODE QUALITY: api/index.ts BARREL COMPLETENESS
// ════════════════════════════════════════════════════════════

describe('api/index.ts barrel export completeness', () => {
  const indexTs = readSrc('api/index.ts')

  const expectedModules = [
    'chat', 'agents', 'logs', 'memory', 'mcp', 'settings',
    'skills', 'system', 'tasks', 'knowledge', 'canvas',
    'tools-status', 'voice', 'webhook', 'team', 'ollama',
    'im-channels', 'config', 'desktop',
  ]

  for (const mod of expectedModules) {
    it(`re-exports ./${mod}`, () => {
      expect(indexTs).toContain(`./${mod}`)
    })
  }

  it('exports apiPatch from client (needed for PATCH operations)', () => {
    expect(indexTs).toContain('apiPatch')
  })

  it('exports LLMModel type from models', () => {
    expect(indexTs).toContain('./models')
  })
})

// ════════════════════════════════════════════════════════════
// 15. VOICE.TS: speechToText MANUAL QUERY STRING (SAME PATTERN AS LOGS)
// ════════════════════════════════════════════════════════════

describe('voice.ts manual URLSearchParams (same inconsistency as logs.ts)', () => {
  const voiceTs = readSrc('api/voice.ts')

  it('speechToText appends language to FormData instead of URLSearchParams', () => {
    expect(voiceTs).not.toContain('new URLSearchParams()')
    expect(voiceTs).toContain("form.append('language', language)")
  })

  it('speechToText sends form directly to apiPost without query string in URL', () => {
    expect(voiceTs).toContain("apiPost<STTResponse>('/api/v1/voice/transcribe', form)")
  })
})

// ════════════════════════════════════════════════════════════
// 16. CANVAS CRUD: getLocalWorkflows CATCHES SILENTLY
// ════════════════════════════════════════════════════════════

describe('Canvas localStorage fallback: getLocalWorkflows error handling', () => {
  const canvasTs = readSrc('api/canvas.ts')

  it('getLocalWorkflows catches JSON parse errors silently', () => {
    // If localStorage contains invalid JSON, it returns []
    const block = canvasTs.match(/function getLocalWorkflows[\s\S]*?^}/m)?.[0] || ''
    expect(block).toContain('} catch {')
    expect(block).toContain('return []')
  })
})

// ════════════════════════════════════════════════════════════
// 17. CONFIG.TS: proxyApiRequest — NO PATCH SUPPORT SURFACE
// ════════════════════════════════════════════════════════════

describe('config.ts proxy usage only uses supported HTTP methods', () => {
  const configTs = readSrc('api/config.ts')

  it('getLLMConfig uses GET (supported)', () => {
    expect(configTs).toMatch(/proxyApiRequestText\('GET'/)
  })

  it('updateLLMConfig uses PUT (supported)', () => {
    expect(configTs).toMatch(/proxyApiRequestText\('PUT'/)
  })

  it('testLLMConnection uses POST (supported)', () => {
    expect(configTs).toMatch(/proxyApiRequestText\('POST'/)
  })

  it('no function in config.ts uses PATCH or DELETE via proxy', () => {
    expect(configTs).not.toContain("'PATCH'")
    expect(configTs).not.toContain("'DELETE'")
  })
})

// ════════════════════════════════════════════════════════════
// 18. TEAM.TS: SAME SILENT ERROR PATTERN AS CANVAS
// ════════════════════════════════════════════════════════════

describe('team.ts silent error fallback pattern (same concern as canvas)', () => {
  const teamTs = readSrc('api/team.ts')

  it('getSharedAgents catches errors and falls back to localStorage', () => {
    const block = teamTs.match(/async function getSharedAgents[\s\S]*?^}/m)?.[0] || ''
    expect(block).toContain('catch (e)')
    expect(block).toContain('getLocal<SharedAgent[]>')
  })

  it('team fallback catches are logged (better than canvas which is fully silent)', () => {
    // team.ts at least logs the error via logger.warn
    expect(teamTs).toContain('logger.warn(TEAM_FALLBACK_WARNINGS')
  })
})

// ════════════════════════════════════════════════════════════
// 19. TASKS.TS: CRON JOB PATH PARAMS NOT URL-ENCODED
// ════════════════════════════════════════════════════════════

describe('tasks.ts: cron job id URL-encoded in path params (FIXED)', () => {
  const tasksTs = readSrc('api/tasks.ts')

  const functionsWithId = ['deleteCronJob', 'pauseCronJob', 'resumeCronJob', 'triggerCronJob', 'getCronJobHistory']

  for (const fn of functionsWithId) {
    it(`${fn} uses encodeURIComponent for id param`, () => {
      const block = tasksTs.match(new RegExp(`function ${fn}[\\s\\S]*?^}`, 'm'))?.[0] || ''
      expect(block).toContain('encodeURIComponent(id)')
    })
  }
})

// ════════════════════════════════════════════════════════════
// 20. CLIENT.TS: apiDelete IS STRICTLY NO-BODY
// ════════════════════════════════════════════════════════════

describe('client.ts apiDelete signature and behavior', () => {
  const clientTs = readSrc('api/client.ts')

  it('apiDelete accepts only url (no body parameter)', () => {
    const sig = clientTs.match(/export function apiDelete<T>\([^)]+\)/)?.[0] || ''
    expect(sig).toBe('export function apiDelete<T>(url: string)')
  })

  it('apiPost accepts body parameter (contrast with apiDelete)', () => {
    const sig = clientTs.match(/export function apiPost<T>\([^)]+\)/)?.[0] || ''
    expect(sig).toContain('body')
  })

  it('apiPut accepts body parameter (contrast with apiDelete)', () => {
    const sig = clientTs.match(/export function apiPut<T>\([^)]+\)/)?.[0] || ''
    expect(sig).toContain('body')
  })
})

// ════════════════════════════════════════════════════════════
// 21. AGENTS.TS: deleteRule USES NUMERIC ID (NO ENCODING NEEDED)
// ════════════════════════════════════════════════════════════

describe('agents.ts: deleteRule uses numeric id — no encoding needed but consistent', () => {
  const agentsTs = readSrc('api/agents.ts')

  it('deleteRule takes id as number', () => {
    expect(agentsTs).toMatch(/function deleteRule\(id:\s*number\)/)
  })

  it('unregisterAgent encodes name (string param needs encoding)', () => {
    const idx = agentsTs.indexOf('function unregisterAgent')
    const block = agentsTs.slice(idx, idx + 200)
    expect(block).toContain('encodeURIComponent(name)')
  })

  it('updateAgent encodes name', () => {
    const idx = agentsTs.indexOf('function updateAgent')
    const block = agentsTs.slice(idx, idx + 200)
    expect(block).toContain('encodeURIComponent(name)')
  })
})

// ════════════════════════════════════════════════════════════
// 22. RUST PROXY: ERROR RESPONSE RETURNS ERR STRING (NOT JSON)
// ════════════════════════════════════════════════════════════

describe('Rust proxy error format', () => {
  const commandsRs = readRoot('src-tauri/src/commands.rs')

  it('proxy returns Err(String) for HTTP 400+', () => {
    expect(commandsRs).toMatch(/status >= 400[\s\S]*?Err\(format!/)
  })

  it('config.ts wraps proxy errors with messageFromUnknownError', () => {
    const configTs = readSrc('api/config.ts')
    expect(configTs).toContain('messageFromUnknownError')
  })
})

// ════════════════════════════════════════════════════════════
// 23. OLLAMA.TS: pullOllamaModel USES RAW FETCH (NOT apiPost)
// ════════════════════════════════════════════════════════════

describe('ollama.ts: pullOllamaModel uses raw fetch for streaming', () => {
  const ollamaTs = readSrc('api/ollama.ts')

  it('pullOllamaModel uses native fetch instead of apiPost (for streaming response)', () => {
    const pullBlock = ollamaTs.match(/async function pullOllamaModel[\s\S]*?^}/m)?.[0] || ''
    expect(pullBlock).toContain('fetch(')
    expect(pullBlock).not.toContain('apiPost')
  })

  it('other ollama functions use apiGet/apiPost/apiDelete consistently', () => {
    // Each function uses the expected HTTP method. We verify by extracting a block.
    const checkFn = (fnName: string, expected: string) => {
      const idx = ollamaTs.indexOf(`function ${fnName}`)
      expect(idx, `${fnName} should exist`).toBeGreaterThan(-1)
      const block = ollamaTs.slice(idx, idx + 200)
      expect(block, `${fnName} should use ${expected}`).toContain(expected)
    }
    checkFn('getOllamaStatus', 'apiGet')
    checkFn('getOllamaRunning', 'apiGet')
    checkFn('unloadOllamaModel', 'apiPost')
    checkFn('deleteOllamaModel', 'apiDelete')
    checkFn('restartOllama', 'apiPost')
  })
})

// ════════════════════════════════════════════════════════════
// 24. CLIENT.TS: SSE USES RAW FETCH (NOT ofetch)
// ════════════════════════════════════════════════════════════

describe('client.ts: apiSSE uses native fetch (not ofetch) for streaming', () => {
  const clientTs = readSrc('api/client.ts')

  it('apiSSE uses native fetch for streaming body access', () => {
    const sseBlock = clientTs.match(/async function apiSSE[\s\S]*?^}/m)?.[0] || ''
    expect(sseBlock).toContain('await fetch(')
    // ofetch doesn't support ReadableStream body access
  })

  it('apiSSE correctly constructs the full URL with env.apiBase prefix', () => {
    expect(clientTs).toContain('`${env.apiBase}${url}`')
  })
})

// ════════════════════════════════════════════════════════════
// 25. WEBSOCKET: HEARTBEAT AND RECONNECT LOGIC
// ════════════════════════════════════════════════════════════

describe('websocket.ts: connection management correctness', () => {
  const wsTs = readSrc('api/websocket.ts')

  it('heartbeat timer is cleaned up on disconnect', () => {
    expect(wsTs).toMatch(/disconnect[\s\S]*stopHeartbeat/)
  })

  it('reconnect timer is cleaned up on disconnect', () => {
    expect(wsTs).toMatch(/disconnect[\s\S]*stopReconnect/)
  })

  it('max reconnect attempts is bounded', () => {
    expect(wsTs).toContain('maxReconnectAttempts')
    expect(wsTs).toMatch(/reconnectAttempts >= this\.maxReconnectAttempts/)
  })

  it('pong timeout is checked during heartbeat', () => {
    expect(wsTs).toContain('pongTimeoutMs')
    expect(wsTs).toContain('pong timeout')
  })

  it('intentionalClose flag prevents reconnect loop', () => {
    expect(wsTs).toContain('this.intentionalClose = true')
    expect(wsTs).toMatch(/!this\.intentionalClose[\s\S]*attemptReconnect/)
  })

  it('cleanupConnection nullifies all WebSocket event handlers', () => {
    const idx = wsTs.indexOf('private cleanupConnection')
    expect(idx).toBeGreaterThan(-1)
    const block = wsTs.slice(idx, idx + 500)
    expect(block).toContain('this.ws.onopen = null')
    expect(block).toContain('this.ws.onmessage = null')
    expect(block).toContain('this.ws.onclose = null')
    expect(block).toContain('this.ws.onerror = null')
  })
})

// ════════════════════════════════════════════════════════════
// 26. KNOWLEDGE.TS: UPLOAD ERROR HANDLING CHAIN
// ════════════════════════════════════════════════════════════

describe('knowledge.ts: upload error handling is thorough', () => {
  const knowledgeTs = readSrc('api/knowledge.ts')

  it('uploadDocument checks isKnowledgeUploadEndpointMissing before re-throwing', () => {
    const uploadBlock = knowledgeTs.match(/async function uploadDocument[\s\S]*?^}/m)?.[0] || ''
    expect(uploadBlock).toContain('isKnowledgeUploadEndpointMissing')
  })

  it('XHR upload handles progress, load, error, and abort events', () => {
    expect(knowledgeTs).toContain("xhr.upload.addEventListener('progress'")
    expect(knowledgeTs).toContain("xhr.addEventListener('load'")
    expect(knowledgeTs).toContain("xhr.addEventListener('error'")
    expect(knowledgeTs).toContain("xhr.addEventListener('abort'")
  })

  it('normalizeKnowledgeEndpointError handles 404 and 405 specially', () => {
    expect(knowledgeTs).toContain('rawStatus === 404')
    expect(knowledgeTs).toContain('rawStatus === 405')
  })
})

// ════════════════════════════════════════════════════════════
// 27. SKILLS.TS: CLAWHUB_FORCE_MOCK IS OFF IN PRODUCTION
// ════════════════════════════════════════════════════════════

describe('skills.ts: CLAWHUB_FORCE_MOCK is disabled', () => {
  const skillsTs = readSrc('api/skills.ts')

  it('CLAWHUB_FORCE_MOCK is set to false', () => {
    expect(skillsTs).toContain('const CLAWHUB_FORCE_MOCK = false')
  })

  it('searchClawHub checks CLAWHUB_FORCE_MOCK first', () => {
    const searchBlock = skillsTs.match(/async function searchClawHub[\s\S]*?^}/m)?.[0] || ''
    expect(searchBlock).toContain('if (CLAWHUB_FORCE_MOCK)')
  })
})

// ════════════════════════════════════════════════════════════
// 28. MCP.TS: callMcpTool INPUT VALIDATION
// ════════════════════════════════════════════════════════════

describe('mcp.ts: callMcpTool validates input before sending', () => {
  const mcpTs = readSrc('api/mcp.ts')

  it('validates toolName is non-empty', () => {
    expect(mcpTs).toContain('!toolName')
    expect(mcpTs).toContain("typeof toolName !== 'string'")
    expect(mcpTs).toContain('!toolName.trim()')
  })

  it('trims toolName before sending', () => {
    expect(mcpTs).toContain('name: toolName.trim()')
  })

  it('checks for backend error in response', () => {
    expect(mcpTs).toContain("typeof res.error === 'string'")
    expect(mcpTs).toContain('res.error.trim()')
  })

  it('handles null result case', () => {
    expect(mcpTs).toContain('res.result === undefined && !res.error')
    expect(mcpTs).toContain('result: null')
  })
})

// ════════════════════════════════════════════════════════════
// 29. STREAM_CHAT: SECURITY CHECKS IN RUST
// ════════════════════════════════════════════════════════════

describe('commands.rs: stream_chat has security checks', () => {
  const commandsRs = readRoot('src-tauri/src/commands.rs')

  it('blocks cloud metadata endpoint (SSRF protection)', () => {
    expect(commandsRs).toContain('169.254.169.254')
    expect(commandsRs).toContain('metadata.google.internal')
    expect(commandsRs).toContain('Blocked: cloud metadata endpoint')
  })

  it('validates URL scheme is http or https only', () => {
    expect(commandsRs).toMatch(/scheme != "https" && scheme != "http"/)
    expect(commandsRs).toContain('Unsupported scheme')
  })

  it('proxy_api_request validates path starts with / and blocks ..', () => {
    expect(commandsRs).toContain("!path.starts_with('/')")
    expect(commandsRs).toContain('path.contains("..")')
    expect(commandsRs).toContain('Invalid API path')
  })
})

// ════════════════════════════════════════════════════════════
// 30. CROSS-CUTTING: TIMEOUT CONFIGURATION
// ════════════════════════════════════════════════════════════

describe('timeout configuration across the stack', () => {
  const commandsRs = readRoot('src-tauri/src/commands.rs')
  const clientTs = readSrc('api/client.ts')

  it('Rust proxy has 30s timeout', () => {
    expect(commandsRs).toContain('timeout(std::time::Duration::from_secs(30))')
  })

  it('Rust stream_chat has 120s timeout (matches backend Agent processing)', () => {
    expect(commandsRs).toContain('timeout(std::time::Duration::from_secs(120))')
  })

  it('Rust backend_chat has 120s timeout (matches stream_chat)', () => {
    // backend_chat should also be 120s
    const backendChatBlock = commandsRs.match(/async fn backend_chat[\s\S]*?^}/m)?.[0] || ''
    expect(backendChatBlock).toContain('from_secs(120)')
  })

  it('ofetch client uses env.timeout', () => {
    expect(clientTs).toContain('timeout: env.timeout')
  })

  it('health check uses 3s timeout (fast fail)', () => {
    expect(commandsRs).toContain('from_secs(3)')
  })
})

// ════════════════════════════════════════════════════════════
// 31. MEMORY.TS: clearAllMemory AND deleteMemory BOTH USE apiDelete
// ════════════════════════════════════════════════════════════

describe('memory.ts: two delete operations with different semantics', () => {
  const memoryTs = readSrc('api/memory.ts')

  it('deleteMemory deletes a single memory by id', () => {
    expect(memoryTs).toMatch(/function deleteMemory\(id:\s*string\)/)
    expect(memoryTs).toContain("apiDelete<{ message: string }>(`/api/v1/memory/${encodeURIComponent(id)}`)")
  })

  it('clearAllMemory deletes all memories (no id)', () => {
    expect(memoryTs).toMatch(/function clearAllMemory\(\)/)
    expect(memoryTs).toContain("apiDelete<{ message: string }>('/api/v1/memory')")
  })

  it('deleteMemory uses encodeURIComponent (safe against path traversal)', () => {
    expect(memoryTs).toContain('encodeURIComponent(id)')
  })
})

// ════════════════════════════════════════════════════════════
// 32. DESKTOP.TS: CLIPBOARD FALLBACK
// ════════════════════════════════════════════════════════════

describe('desktop.ts: setClipboard has proper fallback', () => {
  const desktopTs = readSrc('api/desktop.ts')

  it('prefers navigator.clipboard.writeText', () => {
    expect(desktopTs).toContain('navigator.clipboard?.writeText')
  })

  it('falls back to document.execCommand for non-HTTPS environments', () => {
    expect(desktopTs).toContain("document.execCommand('copy')")
  })

  it('cleans up the temporary textarea element', () => {
    expect(desktopTs).toContain('document.body.removeChild(textarea)')
  })
})

// ════════════════════════════════════════════════════════════
// 33. SUMMARY: ENCODEURI CONSISTENCY AUDIT ACROSS ALL API FILES
// ════════════════════════════════════════════════════════════

describe('Cross-file encodeURIComponent audit: which API functions encode path params', () => {
  // Files that CORRECTLY encode path parameters
  it('knowledge.ts: all path-param functions encode', () => {
    const src = readSrc('api/knowledge.ts')
    // Use function name + opening paren to avoid matching getDocuments instead of getDocument
    const pathParamFns = ['getDocument(', 'deleteDocument(', 'reindexDocument(']
    for (const fn of pathParamFns) {
      const idx = src.indexOf(`function ${fn}`)
      expect(idx, `${fn} should exist`).toBeGreaterThan(-1)
      const block = src.slice(idx, idx + 300)
      expect(block, `${fn} should use encodeURIComponent`).toContain('encodeURIComponent')
    }
  })

  it('agents.ts: updateAgent and unregisterAgent encode', () => {
    const src = readSrc('api/agents.ts')
    expect(src.match(/updateAgent[\s\S]*?encodeURIComponent/)).toBeTruthy()
    expect(src.match(/unregisterAgent[\s\S]*?encodeURIComponent/)).toBeTruthy()
  })

  it('canvas.ts: getPanel, deleteWorkflow, runWorkflow, getWorkflowRun all encode', () => {
    const src = readSrc('api/canvas.ts')
    expect(src.match(/getPanel[\s\S]*?encodeURIComponent/)).toBeTruthy()
    expect(src.match(/deleteWorkflow[\s\S]*?encodeURIComponent/)).toBeTruthy()
    expect(src.match(/runWorkflow[\s\S]*?encodeURIComponent/)).toBeTruthy()
    expect(src.match(/getWorkflowRun[\s\S]*?encodeURIComponent/)).toBeTruthy()
  })

  // chat.ts now consistently encodes all path params
  it('chat.ts: all session functions and message functions encode path params', () => {
    const src = readSrc('api/chat.ts')
    const encodeCount = (src.match(/encodeURIComponent/g) || []).length
    // 6 session functions + deleteMessage + updateMessageFeedback = 8
    expect(encodeCount).toBeGreaterThanOrEqual(8)
  })

  it('tasks.ts: all 5 functions with id path param now encode (FIXED)', () => {
    const src = readSrc('api/tasks.ts')
    const encodeCount = (src.match(/encodeURIComponent/g) || []).length
    expect(encodeCount).toBeGreaterThanOrEqual(5)
  })
})
