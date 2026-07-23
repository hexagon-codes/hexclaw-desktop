import { describe, expect, it } from 'vitest'
import {
  resolveChatWorkspaceTransition,
  workspaceAfterRightPanelClose,
} from '../workspace-mode'

describe('chat workspace session restoration', () => {
  it('restores the session rail after closing a right workspace when the user has not collapsed it', () => {
    expect(workspaceAfterRightPanelClose(false)).toBe('sessions')
  })

  it('keeps conversation-only mode after closing a right workspace when the user collapsed sessions', () => {
    expect(workspaceAfterRightPanelClose(true)).toBe('focus')
  })

  it('restores sessions when a right workspace temporarily hid them', () => {
    const opened = resolveChatWorkspaceTransition('sessions', 'artifacts', false)
    expect(opened).toEqual({ mode: 'artifacts', sessionsCollapsedByUser: false })

    expect(
      resolveChatWorkspaceTransition(
        opened.mode,
        'focus',
        opened.sessionsCollapsedByUser,
      ),
    ).toEqual({ mode: 'sessions', sessionsCollapsedByUser: false })
  })

  it('preserves a user collapse across opening and closing either right workspace', () => {
    const collapsed = resolveChatWorkspaceTransition('sessions', 'focus', false)
    expect(collapsed).toEqual({ mode: 'focus', sessionsCollapsedByUser: true })

    const artifact = resolveChatWorkspaceTransition(
      collapsed.mode,
      'artifacts',
      collapsed.sessionsCollapsedByUser,
    )
    expect(artifact).toEqual({ mode: 'artifacts', sessionsCollapsedByUser: true })
    expect(
      resolveChatWorkspaceTransition(
        artifact.mode,
        'focus',
        artifact.sessionsCollapsedByUser,
      ),
    ).toEqual({ mode: 'focus', sessionsCollapsedByUser: true })

    const context = resolveChatWorkspaceTransition(
      collapsed.mode,
      'context',
      collapsed.sessionsCollapsedByUser,
    )
    expect(
      resolveChatWorkspaceTransition(
        context.mode,
        'focus',
        context.sessionsCollapsedByUser,
      ),
    ).toEqual({ mode: 'focus', sessionsCollapsedByUser: true })
  })
})
