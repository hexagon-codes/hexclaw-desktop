import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  dbGetSessions, dbCreateSession, dbUpdateSessionTitle, dbTouchSession,
  dbDeleteSession, dbGetMessages, dbSaveMessage, dbDeleteMessage,
  dbGetArtifacts, dbSaveArtifact, dbDeleteSessionArtifacts,
  dbGetAppState, dbSetAppState,
} = vi.hoisted(() => ({
  dbGetSessions: vi.fn().mockResolvedValue([]),
  dbCreateSession: vi.fn().mockResolvedValue(undefined),
  dbUpdateSessionTitle: vi.fn().mockResolvedValue(undefined),
  dbTouchSession: vi.fn().mockResolvedValue(undefined),
  dbDeleteSession: vi.fn().mockResolvedValue(undefined),
  dbGetMessages: vi.fn().mockResolvedValue([]),
  dbSaveMessage: vi.fn().mockResolvedValue(undefined),
  dbDeleteMessage: vi.fn().mockResolvedValue(undefined),
  dbGetArtifacts: vi.fn().mockResolvedValue([]),
  dbSaveArtifact: vi.fn().mockResolvedValue(undefined),
  dbDeleteSessionArtifacts: vi.fn().mockResolvedValue(undefined),
  dbGetAppState: vi.fn().mockResolvedValue(null),
  dbSetAppState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/db/chat', () => ({
  dbGetSessions, dbCreateSession, dbUpdateSessionTitle, dbTouchSession,
  dbDeleteSession, dbGetMessages, dbSaveMessage, dbDeleteMessage,
}))
vi.mock('@/db/artifacts', () => ({ dbGetArtifacts, dbSaveArtifact, dbDeleteSessionArtifacts }))
vi.mock('@/db/connection', () => ({ dbGetAppState, dbSetAppState, getDB: vi.fn() }))

import {
  parseMessageMetadata, normalizeLoadedMessage, serializeMessageMetadata,
  loadAllSessions, deleteSession, persistMessage, loadMessages,
} from '../messageService'

describe('messageService', () => {
  beforeEach(() => vi.clearAllMocks())

  // ─── parseMessageMetadata ───
  it('returns undefined for null', () => {
    expect(parseMessageMetadata(null)).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(parseMessageMetadata('')).toBeUndefined()
  })

  it('parses valid JSON', () => {
    expect(parseMessageMetadata('{"key":"val"}')).toEqual({ key: 'val' })
  })

  it('returns undefined for invalid JSON', () => {
    expect(parseMessageMetadata('not json')).toBeUndefined()
  })

  // ─── normalizeLoadedMessage ───
  it('extracts tool_calls and agent_name from metadata', () => {
    const msg = normalizeLoadedMessage({
      id: 'm1', role: 'assistant', content: 'hi', timestamp: '2026-01-01',
      metadata: JSON.stringify({ tool_calls: [{ id: 't1', name: 'search', arguments: '{}' }], agent_name: 'Coder' }),
    })
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.agent_name).toBe('Coder')
  })

  it('handles null metadata gracefully', () => {
    const msg = normalizeLoadedMessage({
      id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01', metadata: null,
    })
    expect(msg.metadata).toBeUndefined()
    expect(msg.tool_calls).toBeUndefined()
    expect(msg.agent_name).toBeUndefined()
  })

  // ─── serializeMessageMetadata ───
  it('includes tool_calls when present', () => {
    const result = serializeMessageMetadata({
      id: 'm1', role: 'assistant', content: 'done', timestamp: '',
      tool_calls: [{ id: 't1', name: 'calc', arguments: '{}' }],
    })
    expect(result?.tool_calls).toHaveLength(1)
  })

  it('returns undefined when no metadata', () => {
    expect(serializeMessageMetadata({ id: 'm1', role: 'user', content: 'hi', timestamp: '' })).toBeUndefined()
  })

  // ─── loadAllSessions ───
  it('returns mapped sessions', async () => {
    dbGetSessions.mockResolvedValueOnce([
      { id: 's1', title: 'Test', created_at: '2026-01-01', updated_at: '2026-01-02' },
    ])
    const sessions = await loadAllSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.message_count).toBe(0)
  })

  // ─── deleteSession ───
  it('calls dbDeleteSessionArtifacts then dbDeleteSession', async () => {
    await deleteSession('s1')
    expect(dbDeleteSessionArtifacts).toHaveBeenCalledWith('s1')
    expect(dbDeleteSession).toHaveBeenCalledWith('s1')
    // artifacts deleted BEFORE session
    const artifactOrder = dbDeleteSessionArtifacts.mock.invocationCallOrder[0]
    const sessionOrder = dbDeleteSession.mock.invocationCallOrder[0]
    expect(artifactOrder).toBeLessThan(sessionOrder!)
  })

  // ─── persistMessage ───
  it('calls dbSaveMessage with serialized metadata', async () => {
    await persistMessage(
      { id: 'm1', role: 'assistant', content: 'done', timestamp: '2026-01-01', agent_name: 'Bot' },
      's1',
    )
    expect(dbSaveMessage).toHaveBeenCalledWith('m1', 's1', 'assistant', 'done', '2026-01-01', { agent_name: 'Bot' })
  })

  it('swallows error on persistence failure', async () => {
    dbSaveMessage.mockRejectedValueOnce(new Error('DB error'))
    await expect(persistMessage(
      { id: 'm1', role: 'user', content: 'hi', timestamp: '' }, 's1',
    )).resolves.toBeUndefined()
  })

  // ─── loadMessages ───
  it('normalizes loaded messages', async () => {
    dbGetMessages.mockResolvedValueOnce([
      { id: 'm1', session_id: 's1', role: 'user', content: 'hello', timestamp: '2026-01-01', metadata: null },
    ])
    const msgs = await loadMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('user')
  })
})
