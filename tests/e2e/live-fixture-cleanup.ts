import type { APIRequestContext } from '@playwright/test'

const DESKTOP_USER_ID = 'desktop-user'

async function sidecarJSON<T>(
  request: APIRequestContext,
  method: 'GET' | 'DELETE',
  path: string,
): Promise<T> {
  const response = await request.fetch(`/_hexclaw${path}`, { method })
  const text = await response.text()
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`${method} ${path} failed: ${response.status()} (body redacted)`)
  }
  return text && response.status() !== 404 ? JSON.parse(text) as T : {} as T
}

export async function cleanupSession(
  request: APIRequestContext,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return
  await sidecarJSON(
    request,
    'DELETE',
    `/api/v1/sessions/${encodeURIComponent(sessionId)}?user_id=${encodeURIComponent(DESKTOP_USER_ID)}`,
  )
}

export async function cleanupSessionsWhere(
  request: APIRequestContext,
  predicate: (title: string) => boolean,
): Promise<void> {
  const payload = await sidecarJSON<{
    sessions?: Array<{ id?: string; title?: string }>
  }>(
    request,
    'GET',
    `/api/v1/sessions?user_id=${encodeURIComponent(DESKTOP_USER_ID)}&limit=500`,
  )
  for (const session of payload.sessions || []) {
    if (session.id && predicate(session.title || '')) {
      await cleanupSession(request, session.id)
    }
  }
}

/**
 * Remove only the exact K12 fixture created by one test. Agent deletion is the
 * production lifecycle path and therefore also proves the server-side cascade
 * for records, route rules, and Agent-owned cron jobs.
 */
export async function cleanupK12Child(
  request: APIRequestContext,
  childName: string,
): Promise<void> {
  if (!childName) return
  const payload = await sidecarJSON<{
    agents?: Array<{
      name?: string
      metadata?: Record<string, string>
    }>
  }>(request, 'GET', '/api/v1/agents')
  for (const agent of payload.agents || []) {
    if (agent.name && agent.metadata?.['k12.child_name'] === childName) {
      await sidecarJSON(
        request,
        'DELETE',
        `/api/v1/agents/${encodeURIComponent(agent.name)}`,
      )
    }
  }
  await cleanupSessionsWhere(
    request,
    (title) => title.startsWith(`${childName}的辅导助手`),
  )
}
