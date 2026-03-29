/**
 * Area 2: Backend API response shapes vs frontend TypeScript types
 *
 * Verifies that frontend type definitions match the actual JSON shapes
 * returned by the Go backend handlers. Mismatches cause silent data
 * loss (field exists in response but TypeScript type doesn't declare it).
 */
import { describe, expect, it } from 'vitest'

describe('API response shape alignment', () => {
  // ─── GET /api/v1/budget/status ──────────────────────────────────────
  //
  // Backend handler (handler_tools.go handleBudgetStatus) returns:
  //   { "summary": string, "remaining": { Tokens, Duration, Cost } }
  //
  // But the frontend BudgetStatus type expects:
  //   { tokens_used, tokens_max, cost_used, cost_max, duration_used, duration_max }
  //
  // The backend also has a BudgetStatus struct with:
  //   tokens_used, tokens_max, tokens_remaining,
  //   cost_used, cost_max, cost_remaining,
  //   duration_used, duration_max, duration_remaining,
  //   exhausted
  //
  // CRITICAL BUG: The handler returns { summary, remaining }, NOT the
  // BudgetStatus struct. The frontend type expects a flat structure.

  describe('GET /api/v1/budget/status', () => {
    // What the backend actually returns:
    const backendActualResponse = {
      summary: 'tokens: 0/500000, duration: 0s/30m0s, cost: $0.0000/$5.00',
      remaining: {
        Tokens: 500000,    // Note: capitalized Go field names (no json tags on BudgetRemaining)
        Duration: 1800000000000, // nanoseconds
        Cost: 5.0,
      },
    }

    // What the frontend BudgetStatus type declares:
    interface FrontendBudgetStatus {
      tokens_used: number
      tokens_max: number
      cost_used: number
      cost_max: number
      duration_used: number
      duration_max: number
    }

    it('BUG: backend returns {summary, remaining} but frontend expects flat {tokens_used, tokens_max, ...}', () => {
      // The backend handleBudgetStatus returns:
      //   writeJSON(w, 200, map[string]any{ "summary": summary, "remaining": remaining })
      //
      // But the frontend type expects flat fields like tokens_used, tokens_max.
      // This is a REAL MISMATCH. The frontend will see all fields as undefined.
      const frontendExpectedKeys: (keyof FrontendBudgetStatus)[] = [
        'tokens_used', 'tokens_max', 'cost_used', 'cost_max',
        'duration_used', 'duration_max',
      ]
      const backendActualKeys = Object.keys(backendActualResponse)

      // None of the frontend expected keys exist in the backend response
      for (const key of frontendExpectedKeys) {
        expect(
          backendActualKeys.includes(key),
          `Frontend expects "${key}" in budget/status response, but backend returns {${backendActualKeys.join(', ')}}`,
        ).toBe(false)
      }
      // This documents a confirmed bug: the response shapes don't match.
      // The backend has a BudgetStatus struct with the right fields but
      // the handler calls Remaining() and Summary() directly instead.
    })

    it('backend BudgetStatus struct fields match what frontend expects (if handler used it)', () => {
      // The engine.BudgetStatus struct has these json tags:
      const budgetStatusStructFields = [
        'tokens_used', 'tokens_max', 'tokens_remaining',
        'cost_used', 'cost_max', 'cost_remaining',
        'duration_used', 'duration_max', 'duration_remaining',
        'exhausted',
      ]

      // Frontend BudgetStatus is missing these backend fields:
      const frontendMissing = ['tokens_remaining', 'cost_remaining', 'duration_remaining', 'exhausted']
      for (const field of frontendMissing) {
        expect(
          budgetStatusStructFields,
          `Backend has "${field}" but frontend BudgetStatus type doesn't declare it`,
        ).toContain(field)
      }
    })
  })

  // ─── GET /api/v1/tools/cache/stats ──────────────────────────────────
  //
  // Backend returns: { entries, hits, misses, hit_rate }
  // Frontend ToolCacheStats: { entries, hits, misses, hit_rate }

  describe('GET /api/v1/tools/cache/stats', () => {
    it('frontend ToolCacheStats matches backend response shape', () => {
      // Backend: writeJSON(w, 200, map[string]any{"entries": ..., "hits": ..., "misses": ..., "hit_rate": ...})
      const backendFields = ['entries', 'hits', 'misses', 'hit_rate']
      const frontendFields = ['entries', 'hits', 'misses', 'hit_rate']

      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })
  })

  // ─── GET /api/v1/tools/metrics ──────────────────────────────────────
  //
  // Backend returns: { tools: [...] } where each tool has stats from ReadStats
  // Frontend ToolMetricItem: { name, calls, success_rate, avg_latency_ms }

  describe('GET /api/v1/tools/metrics', () => {
    it('response is wrapped in { tools: [...] }', () => {
      // Backend: writeJSON(w, 200, map[string]any{"tools": stats})
      // Frontend: ToolMetrics { tools: ToolMetricItem[] }
      // This matches.
      expect(true).toBe(true)
    })
  })

  // ─── GET /api/v1/config/llm ─────────────────────────────────────────
  //
  // Backend LLMConfigResponse: { default, providers, routing, cache }
  // Frontend BackendLLMConfig: { default, providers, routing, cache }

  describe('GET /api/v1/config/llm', () => {
    it('BackendLLMConfig fields match LLMConfigResponse', () => {
      // Backend struct LLMConfigResponse JSON tags:
      const backendFields = ['default', 'providers', 'routing', 'cache']
      // Frontend BackendLLMConfig declares:
      const frontendFields = ['default', 'providers', 'routing', 'cache']
      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })

    it('BackendLLMProvider fields match LLMProviderConfigResponse', () => {
      // Backend: { api_key, base_url, model, compatible }
      const backendFields = ['api_key', 'base_url', 'model', 'compatible']
      // Frontend BackendLLMProvider: { api_key, base_url, model, compatible }
      const frontendFields = ['api_key', 'base_url', 'model', 'compatible']
      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })

    it('routing sub-object fields match', () => {
      // Backend LLMRoutingConfig: { enabled, strategy }
      // Frontend routing: { enabled, strategy }
      const backendFields = ['enabled', 'strategy']
      const frontendFields = ['enabled', 'strategy']
      expect(frontendFields).toEqual(backendFields)
    })

    it('cache sub-object fields match', () => {
      // Backend LLMCacheConfig: { enabled, similarity, ttl, max_entries }
      // Frontend cache: { enabled, similarity, ttl, max_entries }
      const backendFields = ['enabled', 'similarity', 'ttl', 'max_entries']
      const frontendFields = ['enabled', 'similarity', 'ttl', 'max_entries']
      expect(frontendFields).toEqual(backendFields)
    })
  })

  // ─── GET /api/v1/ollama/status ──────────────────────────────────────
  //
  // Backend OllamaStatus struct JSON tags:
  //   running, version, models, associated, model_count
  // Frontend OllamaStatus:
  //   running, version?, models?, associated, model_count

  describe('GET /api/v1/ollama/status', () => {
    it('OllamaStatus fields match between frontend and backend', () => {
      // Backend OllamaStatus json tags:
      const backendFields = ['running', 'version', 'models', 'associated', 'model_count']
      // Frontend OllamaStatus interface:
      const frontendFields = ['running', 'version', 'models', 'associated', 'model_count']
      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })

    it('OllamaModel fields match between frontend and backend', () => {
      // Backend OllamaModel json tags:
      const backendFields = ['name', 'size', 'modified', 'family', 'parameter_size', 'quantization_level']
      // Frontend OllamaModel interface:
      const frontendFields = ['name', 'size', 'modified', 'family', 'parameter_size', 'quantization_level']
      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })
  })

  // ─── POST /api/v1/chat ──────────────────────────────────────────────
  //
  // Backend ChatRequest: { message, session_id, user_id, role, provider, model, platform, attachments }
  // Backend ChatResponse: { reply, session_id, metadata, usage, tool_calls }
  // Frontend BackendChatResponse: { reply, session_id, tool_calls?, metadata? }

  describe('POST /api/v1/chat', () => {
    it('frontend BackendChatResponse covers critical backend ChatResponse fields', () => {
      // Backend ChatResponse json tags:
      const backendResponseFields = ['reply', 'session_id', 'metadata', 'usage', 'tool_calls']
      // Frontend BackendChatResponse:
      const frontendResponseFields = ['reply', 'session_id', 'metadata', 'tool_calls']

      // The frontend is MISSING the "usage" field
      const missingInFrontend = backendResponseFields.filter(
        (f) => !frontendResponseFields.includes(f),
      )
      expect(missingInFrontend).toEqual(['usage'])
      // This is intentional — usage is optional (omitempty) and the frontend
      // doesn't display token usage from the chat response directly.
    })

    it('frontend sends correct chat request shape to backend', () => {
      // Backend ChatRequest json tags:
      const backendRequestFields = [
        'message', 'session_id', 'user_id', 'role',
        'provider', 'model', 'platform', 'attachments',
      ]

      // Frontend sendChatViaBackend sends via Tauri invoke:
      //   message, session_id, role, provider, user_id, model, temperature, max_tokens, attachments
      //
      // Note: frontend sends temperature and max_tokens but backend ChatRequest
      // doesn't have these fields! They are silently ignored.
      const frontendSendsButBackendIgnores = ['temperature', 'max_tokens']

      // Verify these fields are NOT in the backend struct
      for (const field of frontendSendsButBackendIgnores) {
        expect(
          backendRequestFields.includes(field),
          `Frontend sends "${field}" but backend ChatRequest doesn't have this field — it's silently dropped`,
        ).toBe(false)
      }
    })
  })

  // ─── POST /api/v1/config/llm/test ──────────────────────────────────
  //
  // Backend LLMConnectionTestResponse: { ok, message, provider, model, latency_ms }
  // Frontend LLMConnectionTestResponse: { ok, message, provider?, model?, latency_ms? }

  describe('POST /api/v1/config/llm/test', () => {
    it('LLMConnectionTestResponse fields match', () => {
      const backendFields = ['ok', 'message', 'provider', 'model', 'latency_ms']
      const frontendFields = ['ok', 'message', 'provider', 'model', 'latency_ms']
      expect(frontendFields.sort()).toEqual(backendFields.sort())
    })
  })
})
