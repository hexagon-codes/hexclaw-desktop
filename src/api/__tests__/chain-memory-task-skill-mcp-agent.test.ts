/**
 * Chain Tests: Memory / Task / Skill / MCP / Agent lifecycle
 *
 * Chains 4–8 test end-to-end business flows by mocking ofetch at the
 * transport layer. Each chain verifies the correct API path, HTTP method,
 * and parameter forwarding for every step in the lifecycle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, AgentRule } from '@/types'

// ─── ofetch mock (transport level) ─────────────────────
const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({
  ofetch: {
    create: () => mockFetch,
  },
}))

// ─── helpers ───────────────────────────────────────────

/** Extracts the call args for the Nth invocation (0-based). */
function callArgs(n: number): [string, Record<string, unknown>] {
  return mockFetch.mock.calls[n] as [string, Record<string, unknown>]
}

// ─── setup ─────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules()
  mockFetch.mockReset()
})

// =========================================================
// Chain 4 — Memory Lifecycle
// =========================================================
describe('Chain 4: Memory Lifecycle', () => {
  it('saveMemory → getMemory → searchMemory → updateMemory → deleteMemory → clearAllMemory', async () => {
    // Arrange: six sequential responses
    mockFetch
      .mockResolvedValueOnce({ message: 'saved' })            // saveMemory
      .mockResolvedValueOnce({ content: 'hello world' })       // getMemory
      .mockResolvedValueOnce({ results: ['hello'], vector_results: null, total: 1 }) // searchMemory
      .mockResolvedValueOnce({ message: 'updated' })           // updateMemory
      .mockResolvedValueOnce({ message: 'deleted' })           // deleteMemory
      .mockResolvedValueOnce({ message: 'cleared' })           // clearAllMemory

    const { saveMemory, getMemory, searchMemory, updateMemory, deleteMemory, clearAllMemory } =
      await import('../memory')

    // Act
    const saveRes = await saveMemory('hello world', 'memory')
    const getRes = await getMemory()
    const searchRes = await searchMemory('hello')
    const updateRes = await updateMemory('hello world v2')
    const deleteRes = await deleteMemory('mem-1')
    const clearRes = await clearAllMemory()

    // Assert — 6 calls total
    expect(mockFetch).toHaveBeenCalledTimes(6)

    // 1) saveMemory → POST /api/v1/memory
    const [savePath, saveOpts] = callArgs(0)
    expect(savePath).toBe('/api/v1/memory')
    expect(saveOpts.method).toBe('POST')
    expect(saveOpts.body).toEqual({ content: 'hello world', type: 'memory' })
    expect(saveRes).toEqual({ message: 'saved' })

    // 2) getMemory → GET /api/v1/memory
    const [getPath, getOpts] = callArgs(1)
    expect(getPath).toBe('/api/v1/memory')
    expect(getOpts.method).toBe('GET')
    expect(getRes).toEqual({ content: 'hello world' })

    // 3) searchMemory → GET /api/v1/memory/search?q=hello
    const [searchPath, searchOpts] = callArgs(2)
    expect(searchPath).toBe('/api/v1/memory/search')
    expect(searchOpts.method).toBe('GET')
    expect(searchOpts.query).toEqual({ q: 'hello' })
    expect(searchRes.total).toBe(1)

    // 4) updateMemory → PUT /api/v1/memory
    const [updatePath, updateOpts] = callArgs(3)
    expect(updatePath).toBe('/api/v1/memory')
    expect(updateOpts.method).toBe('PUT')
    expect(updateOpts.body).toEqual({ content: 'hello world v2' })
    expect(updateRes).toEqual({ message: 'updated' })

    // 5) deleteMemory → DELETE /api/v1/memory/:id
    const [deletePath, deleteOpts] = callArgs(4)
    expect(deletePath).toBe('/api/v1/memory/mem-1')
    expect(deleteOpts.method).toBe('DELETE')
    expect(deleteRes).toEqual({ message: 'deleted' })

    // 6) clearAllMemory → DELETE /api/v1/memory
    const [clearPath, clearOpts] = callArgs(5)
    expect(clearPath).toBe('/api/v1/memory')
    expect(clearOpts.method).toBe('DELETE')
    expect(clearRes).toEqual({ message: 'cleared' })
  })

  it('saveMemory defaults type to "memory" when omitted', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'saved' })

    const { saveMemory } = await import('../memory')
    await saveMemory('note')

    const [, opts] = callArgs(0)
    expect(opts.body).toEqual({ content: 'note', type: 'memory' })
  })

  it('deleteMemory encodes special characters in the id', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'deleted' })

    const { deleteMemory } = await import('../memory')
    await deleteMemory('key/with spaces')

    const [path] = callArgs(0)
    expect(path).toBe(`/api/v1/memory/${encodeURIComponent('key/with spaces')}`)
  })
})

// =========================================================
// Chain 5 — Task / Cron Lifecycle
// =========================================================
describe('Chain 5: Task / Cron Lifecycle', () => {
  const DESKTOP_USER_ID = 'desktop-user'

  it('createCronJob → getCronJobs → triggerCronJob → getCronJobHistory → pauseCronJob → resumeCronJob → deleteCronJob', async () => {
    mockFetch
      .mockResolvedValueOnce({ id: 'job-1', name: 'daily-report', next_run_at: '2026-04-01T08:00:00Z' }) // create
      .mockResolvedValueOnce({ jobs: [{ id: 'job-1', name: 'daily-report' }], total: 1 })                 // getCronJobs
      .mockResolvedValueOnce({ message: 'triggered', run_id: 'run-1' })                                    // trigger
      .mockResolvedValueOnce({                                                                              // history
        history: [{
          id: 'run-1',
          job_id: 'job-1',
          status: 'success',
          started_at: '2026-04-01T08:00:00Z',
          result: 'ok',
        }],
      })
      .mockResolvedValueOnce({ message: 'paused' })   // pause
      .mockResolvedValueOnce({ message: 'resumed' })   // resume
      .mockResolvedValueOnce({ message: 'deleted' })   // delete

    const { createCronJob, getCronJobs, triggerCronJob, getCronJobHistory, pauseCronJob, resumeCronJob, deleteCronJob } =
      await import('../tasks')

    // Act
    const createRes = await createCronJob({ name: 'daily-report', schedule: '0 8 * * *', prompt: 'generate report' })
    const listRes = await getCronJobs()
    const triggerRes = await triggerCronJob('job-1')
    const historyRes = await getCronJobHistory('job-1', 5)
    const pauseRes = await pauseCronJob('job-1')
    const resumeRes = await resumeCronJob('job-1')
    const deleteRes = await deleteCronJob('job-1')

    expect(mockFetch).toHaveBeenCalledTimes(7)

    // 1) createCronJob → POST /api/v1/cron/jobs
    const [createPath, createOpts] = callArgs(0)
    expect(createPath).toBe('/api/v1/cron/jobs')
    expect(createOpts.method).toBe('POST')
    expect(createOpts.body).toEqual({
      name: 'daily-report',
      schedule: '0 8 * * *',
      prompt: 'generate report',
      type: 'cron',
      user_id: DESKTOP_USER_ID,
    })
    expect(createRes.id).toBe('job-1')

    // 2) getCronJobs → GET /api/v1/cron/jobs
    const [listPath, listOpts] = callArgs(1)
    expect(listPath).toBe('/api/v1/cron/jobs')
    expect(listOpts.method).toBe('GET')
    expect(listOpts.query).toEqual({ user_id: DESKTOP_USER_ID })
    expect(listRes.total).toBe(1)

    // 3) triggerCronJob → POST /api/v1/cron/jobs/:id/trigger
    const [triggerPath, triggerOpts] = callArgs(2)
    expect(triggerPath).toBe('/api/v1/cron/jobs/job-1/trigger')
    expect(triggerOpts.method).toBe('POST')
    expect(triggerRes.run_id).toBe('run-1')

    // 4) getCronJobHistory → GET /api/v1/cron/jobs/:id/history
    const [historyPath, historyOpts] = callArgs(3)
    expect(historyPath).toBe('/api/v1/cron/jobs/job-1/history')
    expect(historyOpts.method).toBe('GET')
    expect(historyOpts.query).toEqual({ limit: 5 })
    expect(historyRes).toHaveLength(1)
    expect(historyRes[0].status).toBe('success')

    // 5) pauseCronJob → POST /api/v1/cron/jobs/:id/pause
    const [pausePath, pauseOpts] = callArgs(4)
    expect(pausePath).toBe('/api/v1/cron/jobs/job-1/pause')
    expect(pauseOpts.method).toBe('POST')
    expect(pauseRes).toEqual({ message: 'paused' })

    // 6) resumeCronJob → POST /api/v1/cron/jobs/:id/resume
    const [resumePath, resumeOpts] = callArgs(5)
    expect(resumePath).toBe('/api/v1/cron/jobs/job-1/resume')
    expect(resumeOpts.method).toBe('POST')
    expect(resumeRes).toEqual({ message: 'resumed' })

    // 7) deleteCronJob → DELETE /api/v1/cron/jobs/:id
    const [deletePath, deleteOpts] = callArgs(6)
    expect(deletePath).toBe('/api/v1/cron/jobs/job-1')
    expect(deleteOpts.method).toBe('DELETE')
    expect(deleteRes).toEqual({ message: 'deleted' })
  })

  it('getCronJobHistory normalises the "runs" alias to CronJobRun[]', async () => {
    mockFetch.mockResolvedValueOnce({
      runs: [{
        id: 'run-2',
        job_id: 'job-1',
        status: 'failed',
        run_at: '2026-04-02T09:00:00Z',
      }],
    })

    const { getCronJobHistory } = await import('../tasks')
    const history = await getCronJobHistory('job-1')

    expect(history).toHaveLength(1)
    expect(history[0].started_at).toBe('2026-04-02T09:00:00Z')
  })

  it('createCronJob defaults type to "cron" when input.type is undefined', async () => {
    mockFetch.mockResolvedValueOnce({ id: 'j2', name: 'x', next_run_at: '' })

    const { createCronJob } = await import('../tasks')
    await createCronJob({ name: 'x', schedule: '* * * * *', prompt: 'y' })

    const [, opts] = callArgs(0)
    expect((opts.body as Record<string, unknown>).type).toBe('cron')
  })
})

// =========================================================
// Chain 6 — Skill Lifecycle
// =========================================================
describe('Chain 6: Skill Lifecycle', () => {
  it('getSkills → searchClawHub → installFromHub → setSkillEnabled(true) → setSkillEnabled(false) → uninstallSkill', async () => {
    mockFetch
      .mockResolvedValueOnce({ skills: [{ name: 'code-review-pro' }], total: 1, dir: '/skills' }) // getSkills
      .mockResolvedValueOnce({                                                                      // searchClawHub
        skills: [{
          name: 'code-review-pro',
          description: 'Code review',
          author: 'openclaw',
          version: '2.1.0',
          tags: ['code-review'],
          downloads: 28430,
          category: 'coding',
        }],
      })
      .mockResolvedValueOnce({ name: 'code-review-pro', description: 'ok', version: '2.1.0', message: 'installed' }) // installFromHub
      .mockResolvedValueOnce({ enabled: true, effective_enabled: true, requires_restart: false })                      // setSkillEnabled(true)
      .mockResolvedValueOnce({ enabled: false, effective_enabled: false, requires_restart: false })                    // setSkillEnabled(false)
      .mockResolvedValueOnce({ message: 'uninstalled' })                                                               // uninstallSkill

    const { getSkills, searchClawHub, installFromHub, setSkillEnabled, uninstallSkill } =
      await import('../skills')

    // Act
    const skills = await getSkills()
    const hubResults = await searchClawHub('code-review', 'coding')
    await installFromHub('code-review-pro')
    const enableRes = await setSkillEnabled('code-review-pro', true)
    const disableRes = await setSkillEnabled('code-review-pro', false)
    await uninstallSkill('code-review-pro')

    expect(mockFetch).toHaveBeenCalledTimes(6)

    // 1) getSkills → GET /api/v1/skills
    const [skillsPath, skillsOpts] = callArgs(0)
    expect(skillsPath).toBe('/api/v1/skills')
    expect(skillsOpts.method).toBe('GET')
    expect(skills.total).toBe(1)

    // 2) searchClawHub → GET /api/v1/clawhub/search?q=...&category=...
    const [hubPath, hubOpts] = callArgs(1)
    expect(hubPath).toBe('/api/v1/clawhub/search?q=code-review&category=coding')
    expect(hubOpts.method).toBe('GET')
    expect(hubResults).toHaveLength(1)
    expect(hubResults[0].name).toBe('code-review-pro')

    // 3) installFromHub → POST /api/v1/skills/install
    const [installPath, installOpts] = callArgs(2)
    expect(installPath).toBe('/api/v1/skills/install')
    expect(installOpts.method).toBe('POST')
    expect(installOpts.body).toEqual({ source: 'clawhub://code-review-pro' })

    // 4) setSkillEnabled(true) → PUT /api/v1/skills/:name/status
    const [enablePath, enableOpts] = callArgs(3)
    expect(enablePath).toBe('/api/v1/skills/code-review-pro/status')
    expect(enableOpts.method).toBe('PUT')
    expect(enableOpts.body).toEqual({ enabled: true })
    expect(enableRes.success).toBe(true)
    expect(enableRes.enabled).toBe(true)
    expect(enableRes.source).toBe('backend')

    // 5) setSkillEnabled(false) → PUT /api/v1/skills/:name/status
    const [disablePath, disableOpts] = callArgs(4)
    expect(disablePath).toBe('/api/v1/skills/code-review-pro/status')
    expect(disableOpts.method).toBe('PUT')
    expect(disableOpts.body).toEqual({ enabled: false })
    expect(disableRes.success).toBe(true)
    expect(disableRes.enabled).toBe(false)
    expect(disableRes.source).toBe('backend')

    // 6) uninstallSkill → DELETE /api/v1/skills/:name
    const [uninstallPath, uninstallOpts] = callArgs(5)
    expect(uninstallPath).toBe('/api/v1/skills/code-review-pro')
    expect(uninstallOpts.method).toBe('DELETE')
  })

  it('setSkillEnabled falls back to local-fallback on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network Error'))

    const { setSkillEnabled } = await import('../skills')
    const result = await setSkillEnabled('broken-skill', true)

    expect(result.success).toBe(false)
    expect(result.source).toBe('local-fallback')
    expect(result.enabled).toBe(true)
    expect(result.message).toBe('Network Error')
  })

  it('searchClawHub with no filters builds correct URL', async () => {
    mockFetch.mockResolvedValueOnce({ skills: [] })

    const { searchClawHub } = await import('../skills')
    await searchClawHub()

    const [path] = callArgs(0)
    expect(path).toBe('/api/v1/clawhub/search')
  })

  it('searchClawHub propagates server error string', async () => {
    mockFetch.mockResolvedValueOnce({ error: 'hub unavailable' })

    const { searchClawHub } = await import('../skills')
    await expect(searchClawHub('test')).rejects.toThrow('hub unavailable')
  })
})

// =========================================================
// Chain 7 — MCP Lifecycle
// =========================================================
describe('Chain 7: MCP Lifecycle', () => {
  it('getMcpServers → addMcpServer → getMcpTools → callMcpTool → getMcpServerStatus → removeMcpServer', async () => {
    mockFetch
      .mockResolvedValueOnce({ servers: ['fs-server'], total: 1 })                                            // getMcpServers
      .mockResolvedValueOnce({ message: 'added' })                                                             // addMcpServer
      .mockResolvedValueOnce({ tools: [{ name: 'read_file', description: 'Read a file' }], total: 1 })        // getMcpTools
      .mockResolvedValueOnce({ result: 'file contents here', error: undefined })                               // callMcpTool
      .mockResolvedValueOnce({ statuses: { 'fs-server': 'connected', 'new-server': 'connected' } })          // getMcpServerStatus
      .mockResolvedValueOnce({ message: 'removed' })                                                           // removeMcpServer

    const { getMcpServers, addMcpServer, getMcpTools, callMcpTool, getMcpServerStatus, removeMcpServer } =
      await import('../mcp')

    // Act
    const servers = await getMcpServers()
    const addRes = await addMcpServer('new-server', 'npx', ['-y', '@mcp/fs-server'])
    const tools = await getMcpTools()
    const callRes = await callMcpTool('read_file', { path: '/tmp/test.txt' })
    const statusRes = await getMcpServerStatus()
    const removeRes = await removeMcpServer('new-server')

    expect(mockFetch).toHaveBeenCalledTimes(6)

    // 1) getMcpServers → GET /api/v1/mcp/servers
    const [serversPath, serversOpts] = callArgs(0)
    expect(serversPath).toBe('/api/v1/mcp/servers')
    expect(serversOpts.method).toBe('GET')
    expect(servers.servers).toContain('fs-server')

    // 2) addMcpServer → POST /api/v1/mcp/servers
    const [addPath, addOpts] = callArgs(1)
    expect(addPath).toBe('/api/v1/mcp/servers')
    expect(addOpts.method).toBe('POST')
    expect(addOpts.body).toEqual({
      name: 'new-server',
      command: 'npx',
      args: ['-y', '@mcp/fs-server'],
    })
    expect(addRes).toEqual({ message: 'added' })

    // 3) getMcpTools → GET /api/v1/mcp/tools
    const [toolsPath, toolsOpts] = callArgs(2)
    expect(toolsPath).toBe('/api/v1/mcp/tools')
    expect(toolsOpts.method).toBe('GET')
    expect(tools.total).toBe(1)

    // 4) callMcpTool → POST /api/v1/mcp/tools/call
    const [callPath, callOpts] = callArgs(3)
    expect(callPath).toBe('/api/v1/mcp/tools/call')
    expect(callOpts.method).toBe('POST')
    expect(callOpts.body).toEqual({
      tool: 'read_file',
      arguments: { path: '/tmp/test.txt' },
    })
    expect(callRes.result).toBe('file contents here')

    // 5) getMcpServerStatus → GET /api/v1/mcp/status
    const [statusPath, statusOpts] = callArgs(4)
    expect(statusPath).toBe('/api/v1/mcp/status')
    expect(statusOpts.method).toBe('GET')
    expect(statusRes.statuses['new-server']).toBe('connected')

    // 6) removeMcpServer → DELETE /api/v1/mcp/servers/:name
    const [removePath, removeOpts] = callArgs(5)
    expect(removePath).toBe('/api/v1/mcp/servers/new-server')
    expect(removeOpts.method).toBe('DELETE')
    expect(removeRes).toEqual({ message: 'removed' })
  })

  it('addMcpServer omits args when not provided', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'added' })

    const { addMcpServer } = await import('../mcp')
    await addMcpServer('simple-server', 'python3')

    const [, opts] = callArgs(0)
    expect(opts.body).toEqual({ name: 'simple-server', command: 'python3', args: undefined })
  })

  it('removeMcpServer encodes special characters in server name', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'removed' })

    const { removeMcpServer } = await import('../mcp')
    await removeMcpServer('my server/v2')

    const [path] = callArgs(0)
    expect(path).toBe(`/api/v1/mcp/servers/${encodeURIComponent('my server/v2')}`)
  })
})

// =========================================================
// Chain 8 — Agent / Router Lifecycle
// =========================================================
describe('Chain 8: Agent / Router Lifecycle', () => {
  it('getAgents → registerAgent → updateAgent → setDefaultAgent → getRules → addRule → deleteRule → unregisterAgent', async () => {
    mockFetch
      .mockResolvedValueOnce({ agents: [], total: 0, default: 'general' })                              // getAgents
      .mockResolvedValueOnce({ message: 'registered', name: 'code-agent' })                              // registerAgent
      .mockResolvedValueOnce({ message: 'updated' })                                                      // updateAgent
      .mockResolvedValueOnce({ message: 'default set', name: 'code-agent' })                              // setDefaultAgent
      .mockResolvedValueOnce({ rules: [], total: 0 })                                                     // getRules
      .mockResolvedValueOnce({ message: 'rule added', id: 42 })                                           // addRule
      .mockResolvedValueOnce({ message: 'rule deleted' })                                                  // deleteRule
      .mockResolvedValueOnce({ message: 'unregistered' })                                                  // unregisterAgent

    const { getAgents, registerAgent, updateAgent, setDefaultAgent, getRules, addRule, deleteRule, unregisterAgent } =
      await import('../agents')

    // Act
    const agents = await getAgents()
    const regRes = await registerAgent({
      name: 'code-agent',
      model: 'claude-3-opus',
      system_prompt: 'You are a coding assistant.',
    } as AgentConfig)
    const updRes = await updateAgent('code-agent', { description: 'Handles code tasks' } as Partial<AgentConfig>)
    const defaultRes = await setDefaultAgent('code-agent')
    const rules = await getRules()
    const ruleRes = await addRule({ platform: 'slack', agent_name: 'code-agent' } as Omit<AgentRule, 'id'>)
    const delRuleRes = await deleteRule(42)
    const unregRes = await unregisterAgent('code-agent')

    expect(mockFetch).toHaveBeenCalledTimes(8)

    // 1) getAgents → GET /api/v1/agents
    const [agentsPath, agentsOpts] = callArgs(0)
    expect(agentsPath).toBe('/api/v1/agents')
    expect(agentsOpts.method).toBe('GET')
    expect(agents.default).toBe('general')

    // 2) registerAgent → POST /api/v1/agents
    const [regPath, regOpts] = callArgs(1)
    expect(regPath).toBe('/api/v1/agents')
    expect(regOpts.method).toBe('POST')
    expect(regOpts.body).toEqual({
      name: 'code-agent',
      model: 'claude-3-opus',
      system_prompt: 'You are a coding assistant.',
    })
    expect(regRes.name).toBe('code-agent')

    // 3) updateAgent → PUT /api/v1/agents/:name
    const [updPath, updOpts] = callArgs(2)
    expect(updPath).toBe('/api/v1/agents/code-agent')
    expect(updOpts.method).toBe('PUT')
    expect(updOpts.body).toEqual({ description: 'Handles code tasks' })
    expect(updRes).toEqual({ message: 'updated' })

    // 4) setDefaultAgent → POST /api/v1/agents/default
    const [defaultPath, defaultOpts] = callArgs(3)
    expect(defaultPath).toBe('/api/v1/agents/default')
    expect(defaultOpts.method).toBe('POST')
    expect(defaultOpts.body).toEqual({ name: 'code-agent' })
    expect(defaultRes.name).toBe('code-agent')

    // 5) getRules → GET /api/v1/agents/rules
    const [rulesPath, rulesOpts] = callArgs(4)
    expect(rulesPath).toBe('/api/v1/agents/rules')
    expect(rulesOpts.method).toBe('GET')
    expect(rules.total).toBe(0)

    // 6) addRule → POST /api/v1/agents/rules
    const [rulePath, ruleOpts] = callArgs(5)
    expect(rulePath).toBe('/api/v1/agents/rules')
    expect(ruleOpts.method).toBe('POST')
    expect(ruleOpts.body).toEqual({ platform: 'slack', agent_name: 'code-agent' })
    expect(ruleRes.id).toBe(42)

    // 7) deleteRule → DELETE /api/v1/agents/rules/:id
    const [delRulePath, delRuleOpts] = callArgs(6)
    expect(delRulePath).toBe('/api/v1/agents/rules/42')
    expect(delRuleOpts.method).toBe('DELETE')
    expect(delRuleRes).toEqual({ message: 'rule deleted' })

    // 8) unregisterAgent → DELETE /api/v1/agents/:name
    const [unregPath, unregOpts] = callArgs(7)
    expect(unregPath).toBe('/api/v1/agents/code-agent')
    expect(unregOpts.method).toBe('DELETE')
    expect(unregRes).toEqual({ message: 'unregistered' })
  })

  it('updateAgent encodes special characters in agent name', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'updated' })

    const { updateAgent } = await import('../agents')
    await updateAgent('agent/with spaces', { description: 'test' } as Partial<AgentConfig>)

    const [path] = callArgs(0)
    expect(path).toBe(`/api/v1/agents/${encodeURIComponent('agent/with spaces')}`)
  })

  it('unregisterAgent encodes special characters in agent name', async () => {
    mockFetch.mockResolvedValueOnce({ message: 'unregistered' })

    const { unregisterAgent } = await import('../agents')
    await unregisterAgent('agent/with spaces')

    const [path] = callArgs(0)
    expect(path).toBe(`/api/v1/agents/${encodeURIComponent('agent/with spaces')}`)
  })

  it('getRoles calls the read-only roles endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ roles: [{ name: 'admin' }] })

    const { getRoles } = await import('../agents')
    const res = await getRoles()

    const [path, opts] = callArgs(0)
    expect(path).toBe('/api/v1/roles')
    expect(opts.method).toBe('GET')
    expect(res.roles).toHaveLength(1)
  })
})
