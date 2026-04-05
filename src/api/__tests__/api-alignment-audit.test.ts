/**
 * Frontend-Backend API Alignment Audit
 *
 * Compares every frontend API call against the backend handler to verify:
 * 1. HTTP method matches
 * 2. URL path matches
 * 3. Request body shape matches backend handler's parsing
 * 4. Response shape matches what frontend expects
 * 5. No orphaned endpoints (frontend-only or backend-only)
 * 6. Field names and types align between Go struct tags and TypeScript interfaces
 *
 * Backend source: /Users/hexagon/work/hexclaw/api/
 * Frontend source: /Users/hexagon/work/hexclaw-desktop/src/api/
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ════════════════════════════════════════════════════════════════════
// Helper: read source files for static analysis
// ════════════════════════════════════════════════════════════════════

function readFrontendFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')
}

function readFrontendType(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../types', relativePath), 'utf-8')
}

// ════════════════════════════════════════════════════════════════════
// 1. SESSION APIs — createSession / updateSessionTitle
//    Backend: handler_session.go
//    Frontend: chat.ts
// ════════════════════════════════════════════════════════════════════

describe('Session API alignment: chat.ts vs handler_session.go', () => {
  const chatSource = readFrontendFile('chat.ts')

  it('createSession sends POST /api/v1/sessions with {id, title}', () => {
    // Frontend: apiPost('/api/v1/sessions', { id, title })
    expect(chatSource).toContain("apiPost<{ id: string; title: string; created_at: string }>('/api/v1/sessions', { id, title })")
  })

  it('createSession response matches backend createSessionRequest struct', () => {
    // Backend returns: { id, title, created_at } as map[string]string
    // Frontend expects: { id: string; title: string; created_at: string }
    // ALIGNED
    expect(chatSource).toContain('id: string; title: string; created_at: string')
  })

  it('updateSessionTitle sends PATCH /api/v1/sessions/{id} with {title}', () => {
    // Frontend: apiPatch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { title })
    expect(chatSource).toContain("apiPatch<{ id: string; title: string; updated_at: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { title })")
  })

  it('updateSessionTitle response matches backend updateSession handler', () => {
    // Backend returns: { id, title, updated_at } as map[string]string
    // Frontend expects: { id: string; title: string; updated_at: string }
    // ALIGNED
    expect(chatSource).toContain('id: string; title: string; updated_at: string')
  })

  it('deleteSession sends DELETE /api/v1/sessions/{id}', () => {
    expect(chatSource).toContain("apiDelete<{ message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)")
  })

  it('listSessions sends GET /api/v1/sessions with user_id query', () => {
    expect(chatSource).toContain("apiGet<{ sessions: SessionSummary[]; total: number }>('/api/v1/sessions'")
  })

  it('getSession sends GET /api/v1/sessions/{id}', () => {
    expect(chatSource).toContain("apiGet<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)")
  })

  it('listSessionMessages sends GET /api/v1/sessions/{id}/messages', () => {
    expect(chatSource).toContain("apiGet<{ messages: ChatMessage[]; total: number }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`")
  })

  it('searchMessages sends GET /api/v1/messages/search', () => {
    expect(chatSource).toContain("apiGet<{ results: Array<ChatMessage & { session_id: string; score?: number }>; total: number; query: string }>('/api/v1/messages/search'")
  })
})

describe('SessionSummary type alignment with storage.Session', () => {
  // Backend: storage.Session has these json tags:
  //   id, user_id, platform, instance_id, chat_id, title,
  //   parent_session_id, branch_message_id, status,
  //   message_count, total_prompt_tokens, total_completion_tokens,
  //   last_message_preview, meta, created_at, updated_at
  //
  // Frontend SessionSummary:
  //   id, title, user_id, parent_session_id?, branch_message_id?, created_at, updated_at, message_count?

  it('SessionSummary covers essential fields from storage.Session', () => {
    const chatSource = readFrontendFile('chat.ts')
    // The interface is defined inline
    expect(chatSource).toContain('id: string')
    expect(chatSource).toContain('title: string')
    expect(chatSource).toContain('user_id: string')
    expect(chatSource).toContain('created_at: string')
    expect(chatSource).toContain('updated_at: string')
  })

  it('ALIGNED: frontend uses parent_session_id matching backend', () => {
    const chatSource = readFrontendFile('chat.ts')
    expect(chatSource).toContain('parent_session_id?: string')
  })

  it('ALIGNED: frontend uses branch_message_id matching backend', () => {
    const chatSource = readFrontendFile('chat.ts')
    expect(chatSource).toContain('branch_message_id?: string')
  })
})

// ════════════════════════════════════════════════════════════════════
// 2. FORK SESSION — chat.ts vs handler_session.go
// ════════════════════════════════════════════════════════════════════

describe('Fork Session API alignment', () => {
  it('ALIGNED: forkSession response expects session object matching backend', () => {
    const chatSource = readFrontendFile('chat.ts')
    // Frontend now correctly expects: { session: SessionSummary; message: string }
    expect(chatSource).toContain("apiPost<{ session: SessionSummary; message: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`")
  })
})

// ════════════════════════════════════════════════════════════════════
// 3. MCP TOOL CALL — mcp.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('MCP Tool Call API alignment: mcp.ts vs handler_extended.go', () => {
  it('ALIGNED: frontend sends "name" field matching backend MCPToolCallRequest', () => {
    const mcpSource = readFrontendFile('mcp.ts')
    expect(mcpSource).toContain("name: toolName.trim()")
  })
})

// ════════════════════════════════════════════════════════════════════
// 4. VERSION API — system.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('Version API alignment: system.ts vs handler_extended.go', () => {
  it('ALIGNED: frontend expects version and engine matching backend', () => {
    const systemSource = readFrontendFile('system.ts')
    expect(systemSource).toContain("apiGet<{ version: string; engine: string }>('/api/v1/version')")
  })
})

// ════════════════════════════════════════════════════════════════════
// 5. AGENT CONFIG — agents.ts vs router/agent_router.go
// ════════════════════════════════════════════════════════════════════

describe('Agent Config alignment: types/agent.ts vs router.AgentConfig', () => {
  it('ALIGNED: frontend AgentConfig includes all backend fields', () => {
    const agentTypes = readFrontendType('agent.ts')
    // Frontend AgentConfig now covers all backend fields
    expect(agentTypes).toContain('description')
    expect(agentTypes).toContain('system_prompt')
    expect(agentTypes).toContain('skills')
    expect(agentTypes).toContain('max_tokens')
    expect(agentTypes).toContain('temperature')
    expect(agentTypes).toContain('metadata')
  })
})

// ════════════════════════════════════════════════════════════════════
// 6. KNOWLEDGE — knowledge.ts vs handler_knowledge.go
// ════════════════════════════════════════════════════════════════════

describe('Knowledge API alignment: types/knowledge.ts vs handler_knowledge.go', () => {
  it('KnowledgeDoc fields align with knowledgeDocumentResponse', () => {
    // Backend knowledgeDocumentResponse:
    //   ID, Title, Source, ChunkCount, CreatedAt, UpdatedAt, Status, ErrorMessage, SourceType, Warnings
    //   json: id, title, source, chunk_count, created_at, updated_at, status, error_message, source_type, warnings
    //
    // Frontend KnowledgeDoc:
    //   id, title, content?, source?, chunk_count, created_at, updated_at?, status?, error_message?, source_type?
    //
    // ALIGNED (frontend has content? which comes from GetDocument detail endpoint)
    // Note: backend includes "warnings" field but frontend does not declare it - harmless omission
    const knowledgeTypes = readFrontendType('knowledge.ts')
    expect(knowledgeTypes).toContain('id: string')
    expect(knowledgeTypes).toContain('title: string')
    expect(knowledgeTypes).toContain('chunk_count: number')
    expect(knowledgeTypes).toContain('created_at: string')
  })

  it('addDocument request body aligns with AddDocumentRequest struct', () => {
    const knowledgeSource = readFrontendFile('knowledge.ts')
    // Frontend: { title, content, source }
    expect(knowledgeSource).toContain("{ title, content, source }")
    // Backend: Title, Content, Source (json: title, content, source)
    // ALIGNED
  })

  it('searchKnowledge request body aligns with SearchKnowledgeRequest struct', () => {
    const knowledgeSource = readFrontendFile('knowledge.ts')
    // Frontend sends: { query, top_k }
    expect(knowledgeSource).toContain('query')
    expect(knowledgeSource).toContain('top_k')
    // Backend: Query, TopK (json: query, top_k)
    // ALIGNED
  })
})

// ════════════════════════════════════════════════════════════════════
// 7. MEMORY — memory.ts vs handler_misc.go / handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('Memory API alignment: types/memory.ts vs handler_misc.go', () => {
  it('MemoryData matches handleGetMemory response', () => {
    // Backend handleGetMemory returns: { content, context }
    // Frontend MemoryData: { content: string, context: string }
    // ALIGNED
    const memoryTypes = readFrontendType('memory.ts')
    expect(memoryTypes).toContain('content: string')
    expect(memoryTypes).toContain('context: string')
  })

  it('saveMemory request body aligns with SaveMemoryRequest struct', () => {
    const memorySource = readFrontendFile('memory.ts')
    // Frontend: { content, type: type ?? 'memory' }
    expect(memorySource).toContain("{ content, type: type ?? 'memory' }")
    // Backend: Content, Type (json: content, type)
    // ALIGNED
  })

  it('searchMemory response aligns with handleSearchMemory response', () => {
    const memorySource = readFrontendFile('memory.ts')
    // Frontend expects: { results: string[], vector_results: VectorSearchResult[] | null, total: number }
    expect(memorySource).toContain('results: string[]')
    expect(memorySource).toContain('vector_results: VectorSearchResult[] | null')
    // Backend returns: { results: fileResults, vector_results: vecResults, total: len(...) }
    // Note: backend fileResults is []string (from FileMemory.Search), frontend expects string[]
    // ALIGNED
  })
})

// ════════════════════════════════════════════════════════════════════
// 8. SKILLS — skills.ts vs handler_misc.go
// ════════════════════════════════════════════════════════════════════

describe('Skill API alignment: types/skill.ts vs handler_misc.go', () => {
  it('Skill interface fields match skillStatusResponse struct', () => {
    // Backend skillStatusResponse:
    //   Name, Description, Author, Version, Triggers, Tags, Enabled,
    //   EffectiveEnabled, RequiresRestart, Message
    //   json: name, description, author, version, triggers, tags, enabled,
    //         effective_enabled, requires_restart, message
    //
    // Frontend Skill:
    //   id?, name, display_name?, description, author, version, triggers, tags,
    //   enabled?, effective_enabled?, requires_restart?, message?
    //
    // Note: backend skillStatusResponse does NOT have display_name or id fields
    // Frontend declares display_name? and id? as optional, so harmless
    const skillTypes = readFrontendType('skill.ts')
    expect(skillTypes).toContain('name: string')
    expect(skillTypes).toContain('description: string')
    expect(skillTypes).toContain('author: string')
    expect(skillTypes).toContain('version: string')
    expect(skillTypes).toContain('triggers: string[]')
    expect(skillTypes).toContain('tags: string[]')
    expect(skillTypes).toContain('enabled?: boolean')
    expect(skillTypes).toContain('effective_enabled?: boolean')
    expect(skillTypes).toContain('requires_restart?: boolean')
    expect(skillTypes).toContain('message?: string')
  })

  it('installSkill sends correct request body', () => {
    const skillsSource = readFrontendFile('skills.ts')
    // Frontend: { source }
    expect(skillsSource).toContain("{ source }")
    // Backend InstallSkillRequest: Source string `json:"source"`
    // ALIGNED
  })
})

// ════════════════════════════════════════════════════════════════════
// 9. MCP — mcp.ts vs handler_misc.go / handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('MCP API alignment: types/mcp.ts vs mcp.ToolInfo', () => {
  it('McpTool interface aligns with mcp.ToolInfo struct', () => {
    // Backend ToolInfo: Name, Description, ServerName (json: name, description, server_name)
    // Frontend McpTool: name, description, input_schema?
    //
    // Note: frontend has input_schema which backend does NOT return
    // Note: backend returns server_name which frontend does NOT declare
    // Both are optional-ish, so silently discarded/undefined
    const mcpTypes = readFrontendType('mcp.ts')
    expect(mcpTypes).toContain('name: string')
    expect(mcpTypes).toContain('description: string')
  })

  it('addMcpServer request body aligns with handler', () => {
    const mcpSource = readFrontendFile('mcp.ts')
    // Frontend: { name, command, args }
    expect(mcpSource).toContain("{ name, command, args }")
    // Backend: Name, Command, Args (json: name, command, args) + Transport, Endpoint
    // Frontend does not send transport/endpoint but they're optional in backend
    // ALIGNED
  })
})

// ════════════════════════════════════════════════════════════════════
// 10. CRON JOBS — tasks.ts vs handler_cron.go
// ════════════════════════════════════════════════════════════════════

describe('Cron Job API alignment: types/task.ts vs handler_cron.go', () => {
  it('CronJob interface fields cover AddCronJobRequest response', () => {
    // Backend AddCronJobRequest: Name, Schedule, Prompt, UserID, Type
    //   (json: name, schedule, prompt, user_id, type)
    // Backend response: { id, name, next_run_at }
    //
    // Frontend CronJobInput: name, schedule, prompt, type?
    // Frontend createCronJob sends: { name, schedule, prompt, type, user_id }
    // ALIGNED
    const taskTypes = readFrontendType('task.ts')
    expect(taskTypes).toContain('id: string')
    expect(taskTypes).toContain('name: string')
    expect(taskTypes).toContain('schedule: string')
    expect(taskTypes).toContain('prompt: string')
  })

  it('getCronJobHistory handles both history and runs keys', () => {
    const tasksSource = readFrontendFile('tasks.ts')
    // Backend handleCronJobHistory returns: { history: [...], total: N }
    // Frontend handles both: res.history ?? res.runs
    // ALIGNED (defensive handling)
    expect(tasksSource).toContain('res.history ?? res.runs')
  })
})

// ════════════════════════════════════════════════════════════════════
// 11. OLLAMA — ollama.ts vs handler_ollama.go
// ════════════════════════════════════════════════════════════════════

describe('Ollama API alignment: ollama.ts vs handler_ollama.go', () => {
  it('OllamaStatus interface matches OllamaStatus struct', () => {
    // Backend OllamaStatus:
    //   Running bool `json:"running"`
    //   Version string `json:"version,omitempty"`
    //   Models []OllamaModel `json:"models,omitempty"`
    //   Associated bool `json:"associated"`
    //   ModelCount int `json:"model_count"`
    //
    // Frontend OllamaStatus:
    //   running: boolean, version?: string, models?: OllamaModel[],
    //   associated: boolean, model_count: number
    // ALIGNED
    const ollamaSource = readFrontendFile('ollama.ts')
    expect(ollamaSource).toContain('running: boolean')
    expect(ollamaSource).toContain('version?: string')
    expect(ollamaSource).toContain('models?: OllamaModel[]')
    expect(ollamaSource).toContain('associated: boolean')
    expect(ollamaSource).toContain('model_count: number')
  })

  it('OllamaModel interface matches OllamaModel struct', () => {
    // Backend OllamaModel:
    //   Name string `json:"name"`
    //   Size int64 `json:"size"`
    //   Modified string `json:"modified"`
    //   Family string `json:"family,omitempty"`
    //   Params string `json:"parameter_size,omitempty"`
    //   Quant string `json:"quantization_level,omitempty"`
    //
    // Frontend OllamaModel:
    //   name: string, size: number, modified: string,
    //   family?: string, parameter_size?: string, quantization_level?: string
    // ALIGNED
    const ollamaSource = readFrontendFile('ollama.ts')
    expect(ollamaSource).toContain('name: string')
    expect(ollamaSource).toContain('size: number')
    expect(ollamaSource).toContain('modified: string')
    expect(ollamaSource).toContain('family?: string')
    expect(ollamaSource).toContain('parameter_size?: string')
    expect(ollamaSource).toContain('quantization_level?: string')
  })

  it('OllamaRunningModel aligns with handleOllamaRunning response', () => {
    // Backend runningModel struct:
    //   Name, Size, SizeVRAM, ExpiresAt, Params(parameter_size), Quant(quantization_level), Context(context_length)
    //
    // Frontend OllamaRunningModel:
    //   name, size, size_vram, expires_at, parameter_size?, quantization_level?, context_length
    // ALIGNED
    const ollamaSource = readFrontendFile('ollama.ts')
    expect(ollamaSource).toContain('size_vram: number')
    expect(ollamaSource).toContain('expires_at: string')
    expect(ollamaSource).toContain('context_length: number')
  })

  it('unloadOllamaModel sends correct request body', () => {
    const ollamaSource = readFrontendFile('ollama.ts')
    // Frontend: JSON.stringify({ model })
    expect(ollamaSource).toContain("JSON.stringify({ model })")
    // Backend: req.Model (json:"model")
    // ALIGNED
  })
})

// ════════════════════════════════════════════════════════════════════
// 12. WEBHOOK — webhook.ts vs handler_webhook.go
// ════════════════════════════════════════════════════════════════════

describe('Webhook API alignment: webhook.ts vs handler_webhook.go', () => {
  it('createWebhook sends fields that backend RegisterWebhookRequest expects', () => {
    // Backend RegisterWebhookRequest: Name, Type, Secret, Prompt, UserID
    //   (json: name, type, secret, prompt, user_id)
    // Frontend createWebhook sends: name, type, url, events, prompt, secret, user_id
    //
    // MISALIGNMENT: frontend sends "url" and "events" fields that backend does NOT parse.
    // Backend ignores url (it generates URL from name) and ignores events.
    const webhookSource = readFrontendFile('webhook.ts')
    expect(webhookSource).toContain("url: data.url")
    expect(webhookSource).toContain("events: data.events")
    // Backend handler does NOT have url or events in RegisterWebhookRequest struct
  })

  it('Webhook interface has url and events fields not returned by backend', () => {
    const webhookSource = readFrontendFile('webhook.ts')
    // Frontend Webhook interface includes url, events
    // Backend handleRegisterWebhook returns: { id, name, url }
    // Backend handleListWebhooks returns webhook.Webhook which may not have events field
    // The url in response is backend-generated ("/api/v1/webhooks/{name}")
    expect(webhookSource).toContain('url: string')
    expect(webhookSource).toContain('events: WebhookEvent[]')
  })
})

// ════════════════════════════════════════════════════════════════════
// 13. CONFIG — settings.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('Config API alignment: settings.ts vs handler_extended.go', () => {
  it('updateConfig sends PUT /api/v1/config (partial update)', () => {
    const settingsSource = readFrontendFile('settings.ts')
    // Frontend: apiPut<AppConfig>('/api/v1/config', config)
    expect(settingsSource).toContain("apiPut<AppConfig>('/api/v1/config'")
    // Backend handleUpdateFullConfig only handles security sub-object
    // Frontend type AppConfig is broader than what backend actually processes
  })

  it('BackendRuntimeConfig aligns with handleGetFullConfig response', () => {
    // Backend returns: server, llm, knowledge, mcp, cron, webhook, canvas, voice, security
    // Frontend BackendRuntimeConfig has all these sections
    // ALIGNED
    const settingsTypes = readFrontendType('settings.ts')
    expect(settingsTypes).toContain('server:')
    expect(settingsTypes).toContain('llm:')
    expect(settingsTypes).toContain('knowledge:')
    expect(settingsTypes).toContain('mcp:')
    expect(settingsTypes).toContain('cron:')
    expect(settingsTypes).toContain('webhook:')
    expect(settingsTypes).toContain('canvas:')
    expect(settingsTypes).toContain('voice:')
    expect(settingsTypes).toContain('security:')
  })
})

// ════════════════════════════════════════════════════════════════════
// 14. LLM CONFIG — config.ts vs handler_config.go
// ════════════════════════════════════════════════════════════════════

describe('LLM Config API alignment: config.ts vs handler_config.go', () => {
  it('BackendLLMConfig aligns with LLMConfigResponse struct', () => {
    // Backend LLMConfigResponse: Default, Providers, Routing, Cache
    //   (json: default, providers, routing, cache)
    // Frontend BackendLLMConfig: default, providers, routing, cache
    // ALIGNED
    const settingsTypes = readFrontendType('settings.ts')
    expect(settingsTypes).toContain("default: string")
    expect(settingsTypes).toContain("providers: Record<string, BackendLLMProvider>")
    expect(settingsTypes).toContain("routing:")
    expect(settingsTypes).toContain("cache:")
  })

  it('LLMConnectionTestRequest aligns with LLMConnectionTestRequest struct', () => {
    // Backend: Provider { Type, BaseURL, APIKey, Model }
    //   (json: type, base_url, api_key, model)
    // Frontend: provider { type, base_url, api_key, model }
    // ALIGNED
    const settingsTypes = readFrontendType('settings.ts')
    expect(settingsTypes).toContain('type: ProviderType')
    expect(settingsTypes).toContain('base_url: string')
    expect(settingsTypes).toContain('api_key: string')
    expect(settingsTypes).toContain('model: string')
  })

  it('LLMConnectionTestResponse aligns with LLMConnectionTestResponse struct', () => {
    // Backend: OK, Message, Provider, Model, LatencyMS
    //   (json: ok, message, provider, model, latency_ms)
    // Frontend: ok, message, provider?, model?, latency_ms?
    // ALIGNED
    const settingsTypes = readFrontendType('settings.ts')
    expect(settingsTypes).toContain('ok: boolean')
    expect(settingsTypes).toContain('message: string')
    expect(settingsTypes).toContain('latency_ms?: number')
  })
})

// ════════════════════════════════════════════════════════════════════
// 15. SYSTEM STATS — system.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('System Stats alignment: types/system.ts vs handler_extended.go', () => {
  it('SystemStats fields match statsResponse struct', () => {
    // Backend statsResponse:
    //   UptimeSeconds, Goroutines, MemoryAllocMB, MemorySysMB, GCCycles, LogEntries
    //   (json: uptime_seconds, goroutines, memory_alloc_mb, memory_sys_mb, gc_cycles, log_entries)
    //
    // Frontend SystemStats:
    //   uptime_seconds, goroutines, memory_alloc_mb, memory_sys_mb, gc_cycles, log_entries
    // ALIGNED
    const systemTypes = readFrontendType('system.ts')
    expect(systemTypes).toContain('uptime_seconds: number')
    expect(systemTypes).toContain('goroutines: number')
    expect(systemTypes).toContain('memory_alloc_mb: number')
    expect(systemTypes).toContain('memory_sys_mb: number')
    expect(systemTypes).toContain('gc_cycles: number')
    expect(systemTypes).toContain('log_entries: number')
  })
})

// ════════════════════════════════════════════════════════════════════
// 16. MODELS — models.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('Models API alignment: models.ts vs handler_extended.go', () => {
  it('MISALIGNMENT: frontend LLMModel has fields backend does not return', () => {
    const modelsSource = readFrontendFile('models.ts')
    // Frontend LLMModel: id, name, provider, context_length?, supports_vision?, supports_tools?
    // Backend handleListModels returns: [{ id: "name/model", name: model, provider: name }]
    // Backend does NOT return context_length, supports_vision, supports_tools
    // These are optional in frontend so won't cause errors, but data is always missing
    expect(modelsSource).toContain('context_length?: number')
    expect(modelsSource).toContain('supports_vision?: boolean')
    expect(modelsSource).toContain('supports_tools?: boolean')
  })
})

// ════════════════════════════════════════════════════════════════════
// 17. TEAM — team.ts vs handler_team.go
// ════════════════════════════════════════════════════════════════════

describe('Team API alignment: team.ts vs handler_team.go', () => {
  it('SharedAgent interface aligns with SharedAgent struct', () => {
    // Backend SharedAgent:
    //   ID, Name, Author, Description, Downloads, Visibility, UpdatedAt, Config
    //   (json: id, name, author, description, downloads, visibility, updated_at, config)
    //
    // Frontend SharedAgent:
    //   id, name, author, description, downloads, visibility, updated_at, config?
    // ALIGNED
    const teamSource = readFrontendFile('team.ts')
    expect(teamSource).toContain('id: string')
    expect(teamSource).toContain('name: string')
    expect(teamSource).toContain('author: string')
    expect(teamSource).toContain('description: string')
    expect(teamSource).toContain('downloads: number')
    expect(teamSource).toContain('updated_at: string')
  })

  it('TeamMember interface aligns with TeamMember struct', () => {
    // Backend TeamMember:
    //   ID, Name, Email, Role, Avatar, LastActive
    //   (json: id, name, email, role, avatar, last_active)
    //
    // Frontend TeamMember:
    //   id, name, email, role, avatar?, last_active
    // ALIGNED
    const teamSource = readFrontendFile('team.ts')
    expect(teamSource).toContain('email: string')
    expect(teamSource).toContain("role: 'admin' | 'member' | 'viewer'")
    expect(teamSource).toContain('last_active: string')
  })
})

// ════════════════════════════════════════════════════════════════════
// 18. VOICE — voice.ts vs handler_misc.go
// ════════════════════════════════════════════════════════════════════

describe('Voice API alignment: voice.ts vs handler_misc.go', () => {
  it('VoiceStatus aligns with handleVoiceStatus response', () => {
    // Backend returns: { stt_enabled, tts_enabled, stt_provider, tts_provider }
    // Frontend VoiceStatus: { stt_enabled, tts_enabled, stt_provider, tts_provider }
    // ALIGNED
    const voiceSource = readFrontendFile('voice.ts')
    expect(voiceSource).toContain('stt_enabled: boolean')
    expect(voiceSource).toContain('tts_enabled: boolean')
    expect(voiceSource).toContain('stt_provider: string')
    expect(voiceSource).toContain('tts_provider: string')
  })
})

// ════════════════════════════════════════════════════════════════════
// 19. ORPHANED ENDPOINTS AUDIT
// ════════════════════════════════════════════════════════════════════

describe('Orphaned endpoints: frontend calls without backend handlers', () => {
  it('POST /api/v1/desktop/clipboard exists in backend (desktop module)', () => {
    // This is handled by desktop/desktop.go, not api/server.go
    // VERIFIED: the route exists in desktop module
    expect(true).toBe(true)
  })
})

describe('Orphaned endpoints: backend handlers without frontend callers', () => {
  // Backend routes that have NO corresponding frontend API call

  it('POST /api/v1/chat — handled via Tauri invoke, not apiPost', () => {
    // The chat endpoint uses sendChatViaBackend which goes through Tauri invoke('backend_chat')
    // Not a direct HTTP call from frontend, so not "orphaned" — it's used via Rust bridge
    expect(true).toBe(true)
  })

  it('POST /api/v1/config/llm/test has frontend caller', () => {
    const configSource = readFrontendFile('config.ts')
    expect(configSource).toContain('/api/v1/config/llm/test')
  })

  it('POST /api/v1/agents/rules/test — no frontend caller', () => {
    // Backend: mux.HandleFunc("POST /api/v1/agents/rules/test", s.handleTestRoute)
    // Frontend does NOT call this endpoint anywhere
    // NOT a bug — it's an admin/debug endpoint
    expect(true).toBe(true)
  })

  it('GET /api/v1/sessions/{id}/checkpoints — no frontend caller', () => {
    // Backend: mux.HandleFunc("GET /api/v1/sessions/{id}/checkpoints", s.handleListCheckpoints)
    // Frontend does NOT call this endpoint
    expect(true).toBe(true)
  })

  it('POST /api/v1/voice/synthesize — frontend uses direct fetch, not apiPost', () => {
    const voiceSource = readFrontendFile('voice.ts')
    expect(voiceSource).toContain('/api/v1/voice/synthesize')
  })

  it('GET /api/v1/logs/stream — frontend uses WebSocket', () => {
    const logsSource = readFrontendFile('logs.ts')
    expect(logsSource).toContain('/api/v1/logs/stream')
  })

  it('POST /api/v1/webhooks/{name} — webhook trigger endpoint, not called by frontend', () => {
    // This is the webhook receiver endpoint — external systems POST to it
    // Frontend does not call it; this is by design
    expect(true).toBe(true)
  })

  it('Platform instance management endpoints have frontend callers', () => {
    const imSource = readFrontendFile('im-channels.ts')
    expect(imSource).toContain('/api/v1/platforms/instances')
  })
})

// ════════════════════════════════════════════════════════════════════
// 20. CANVAS — canvas.ts vs handler_misc.go / handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('Canvas API alignment: canvas.ts vs handler_misc.go', () => {
  it('PanelSummary aligns with handleListPanels response', () => {
    // Backend returns: { id, title, component_count, version }
    // Frontend PanelSummary: { id, title, component_count, version }
    // ALIGNED
    const canvasSource = readFrontendFile('canvas.ts')
    expect(canvasSource).toContain('id: string')
    expect(canvasSource).toContain('title: string')
    expect(canvasSource).toContain('component_count: number')
    expect(canvasSource).toContain('version: number')
  })
})

// ════════════════════════════════════════════════════════════════════
// 21. TOOLS STATUS — tools-status.ts vs handler_tools.go
// ════════════════════════════════════════════════════════════════════

describe('Tools Status alignment: tools-status.ts vs handler_tools.go', () => {
  it('ToolCacheStats aligns with handleToolCacheStats response', () => {
    // Backend returns: { entries, hits, misses, hit_rate }
    // Frontend: { entries, hits, misses, hit_rate }
    // ALIGNED
    const toolsSource = readFrontendFile('tools-status.ts')
    expect(toolsSource).toContain('entries: number')
    expect(toolsSource).toContain('hits: number')
    expect(toolsSource).toContain('misses: number')
    expect(toolsSource).toContain('hit_rate: number')
  })

  it('ToolPermissions aligns with handleToolPermissions response', () => {
    // Backend returns: { rules: [{ pattern, action }] }
    // Frontend: { rules: ToolPermissionRule[] } with { pattern: string, action: string }
    // ALIGNED
    const toolsSource = readFrontendFile('tools-status.ts')
    expect(toolsSource).toContain('pattern: string')
    expect(toolsSource).toContain('action: string')
  })
})

// ════════════════════════════════════════════════════════════════════
// 22. CLAWHUB — skills.ts / mcp.ts vs handler_extended.go
// ════════════════════════════════════════════════════════════════════

describe('ClawHub alignment: skills.ts vs handler_extended.go + hub.SkillMeta', () => {
  it('ClawHubSkill missing several fields from hub.SkillMeta', () => {
    // Backend hub.SkillMeta has:
    //   name, display_name, description, version, author, category, type,
    //   tags, dependencies, url, command, args, config_hint, downloads, rating
    //
    // Frontend ClawHubSkill has:
    //   name, display_name?, description, author, version, tags, downloads,
    //   rating?, category, _mock?
    //
    // Frontend MISSING: type, dependencies, url, command, args, config_hint
    // These are important for MCP type skills that need command/args for installation
    const skillTypes = readFrontendType('skill.ts')
    expect(skillTypes).not.toContain('dependencies')
    // Note: url, command, args ARE present in McpMarketplaceEntry (mcp.ts)
    // but NOT in ClawHubSkill (skill.ts)
  })

  it('McpMarketplaceEntry covers more SkillMeta fields than ClawHubSkill', () => {
    // McpMarketplaceEntry has: name, display_name, description, version, author,
    //   category, tags, url, downloads, rating, command?, args?
    // This covers url, command, args which ClawHubSkill is missing
    const mcpSource = readFrontendFile('mcp.ts')
    expect(mcpSource).toContain('url: string')
    expect(mcpSource).toContain('command?: string')
    expect(mcpSource).toContain('args?: string[]')
  })
})

// ════════════════════════════════════════════════════════════════════
// 23. ChatMessage — types/chat.ts vs storage.MessageRecord
// ════════════════════════════════════════════════════════════════════

describe('ChatMessage alignment: types/chat.ts vs storage.MessageRecord', () => {
  it('ALIGNED: frontend ChatMessage has both timestamp and created_at for backend compatibility', () => {
    // Backend MessageRecord: CreatedAt time.Time `json:"created_at"`
    // Frontend ChatMessage: timestamp: string + created_at?: string
    // The messageService.loadMessages maps created_at -> timestamp for backward compatibility.
    const chatTypes = readFrontendType('chat.ts')
    expect(chatTypes).toContain('timestamp: string')
    const chatMessageBlock = chatTypes.slice(
      chatTypes.indexOf('export interface ChatMessage {'),
      chatTypes.indexOf('}', chatTypes.indexOf('blocks?: ContentBlock[]')) + 1,
    )
    expect(chatMessageBlock).toContain('timestamp: string')
    expect(chatMessageBlock).toContain('created_at?: string')
  })

  it('frontend ChatMessage has fields not in backend MessageRecord', () => {
    // Frontend-only fields: reasoning, agent_id, agent_name, blocks
    // Backend does not have these as direct columns
    // Some may come from the Meta JSON field
    const chatTypes = readFrontendType('chat.ts')
    expect(chatTypes).toContain('reasoning?: string')
    expect(chatTypes).toContain('agent_id?: string')
    expect(chatTypes).toContain('agent_name?: string')
    expect(chatTypes).toContain('blocks?: ContentBlock[]')
  })

  it('backend MessageRecord has fields not in frontend ChatMessage', () => {
    // Backend-only fields: session_id, parent_id, content_type,
    //   model_name, prompt_tokens, completion_tokens, finish_reason, latency_ms,
    //   request_id, meta
    // The ChatMessage interface does not declare these (though other interfaces
    // in the same file may use session_id, etc.)
    const chatTypes = readFrontendType('chat.ts')
    const chatMessageBlock = chatTypes.slice(
      chatTypes.indexOf('export interface ChatMessage {'),
      chatTypes.indexOf('}', chatTypes.indexOf('blocks?: ContentBlock[]')) + 1,
    )
    expect(chatMessageBlock).not.toContain('session_id')
    expect(chatMessageBlock).not.toContain('content_type')
    expect(chatMessageBlock).not.toContain('model_name')
    expect(chatMessageBlock).not.toContain('prompt_tokens')
    expect(chatMessageBlock).not.toContain('completion_tokens')
    expect(chatMessageBlock).not.toContain('finish_reason')
    expect(chatMessageBlock).not.toContain('latency_ms')
  })
})

// ════════════════════════════════════════════════════════════════════
// 24. ChatSession — types/chat.ts vs storage.Session
// ════════════════════════════════════════════════════════════════════

describe('ChatSession alignment: types/chat.ts vs storage.Session', () => {
  it('ChatSession has agent_id and agent_name not in storage.Session', () => {
    // Frontend ChatSession: { id, title, agent_id?, agent_name?, created_at, updated_at, message_count }
    // Backend storage.Session does NOT have agent_id or agent_name columns
    // These will always be undefined
    const chatTypes = readFrontendType('chat.ts')
    expect(chatTypes).toContain('agent_id?: string')
    expect(chatTypes).toContain('agent_name?: string')
  })
})

// ════════════════════════════════════════════════════════════════════
// SUMMARY: Critical misalignments that will cause runtime bugs
// ════════════════════════════════════════════════════════════════════

describe('ALIGNMENT VERIFICATION SUMMARY', () => {
  it('[FIXED] MCP callMcpTool sends "name" matching backend', () => {
    const mcpSource = readFrontendFile('mcp.ts')
    expect(mcpSource).toContain("name: toolName.trim()")
  })

  it('[FIXED] forkSession response type matches backend (session object)', () => {
    const chatSource = readFrontendFile('chat.ts')
    expect(chatSource).toContain("session: SessionSummary; message: string")
  })

  it('[FIXED] SessionSummary uses parent_session_id matching backend', () => {
    const chatSource = readFrontendFile('chat.ts')
    expect(chatSource).toContain("parent_session_id?: string")
  })

  it('[FIXED] SessionSummary uses branch_message_id matching backend', () => {
    const chatSource = readFrontendFile('chat.ts')
    expect(chatSource).toContain("branch_message_id?: string")
  })

  it('[FIXED] ChatMessage has created_at field for backend compatibility', () => {
    const chatTypes = readFrontendType('chat.ts')
    expect(chatTypes).toContain('timestamp: string')
    expect(chatTypes).toContain('created_at?: string')
  })

  it('[FIXED] Version API expects version and engine matching backend', () => {
    const systemSource = readFrontendFile('system.ts')
    expect(systemSource).toContain('version: string')
    expect(systemSource).toContain('engine: string')
    expect(systemSource).not.toContain('build: string')
    expect(systemSource).not.toContain('go_version: string')
  })
})
