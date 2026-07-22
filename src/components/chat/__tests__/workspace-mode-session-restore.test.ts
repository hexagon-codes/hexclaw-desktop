import { describe, expect, it } from 'vitest'
import { workspaceAfterRightPanelClose } from '../workspace-mode'

describe('chat workspace session restoration', () => {
  it('restores the session rail after closing a right workspace when the user has not collapsed it', () => {
    expect(workspaceAfterRightPanelClose(false)).toBe('sessions')
  })

  it('keeps conversation-only mode after closing a right workspace when the user collapsed sessions', () => {
    expect(workspaceAfterRightPanelClose(true)).toBe('focus')
  })
})
