export const CHAT_WORKSPACE_MODES = ['sessions', 'artifacts', 'context', 'focus'] as const

export type ChatWorkspaceMode = (typeof CHAT_WORKSPACE_MODES)[number]
export type ChatWorkspaceEntry = Exclude<ChatWorkspaceMode, 'focus'>

export function toggleChatWorkspaceEntry(
  current: ChatWorkspaceMode,
  entry: ChatWorkspaceEntry,
): ChatWorkspaceMode {
  return current === entry ? 'focus' : entry
}

/** Closing a right-side workspace restores the session rail unless the user hid it. */
export function workspaceAfterRightPanelClose(sessionsCollapsedByUser: boolean): ChatWorkspaceMode {
  return sessionsCollapsedByUser ? 'focus' : 'sessions'
}

export type ChatWorkspaceTransition = {
  mode: ChatWorkspaceMode
  sessionsCollapsedByUser: boolean
}

/**
 * The right rails may temporarily displace the sessions rail, but they do not
 * own the user's collapse preference. Closing the active right rail therefore
 * restores sessions only when that rail displaced them.
 */
export function resolveChatWorkspaceTransition(
  current: ChatWorkspaceMode,
  requested: ChatWorkspaceMode,
  sessionsCollapsedByUser: boolean,
): ChatWorkspaceTransition {
  if (
    (current === 'artifacts' || current === 'context') &&
    requested === 'focus'
  ) {
    return {
      mode: workspaceAfterRightPanelClose(sessionsCollapsedByUser),
      sessionsCollapsedByUser,
    }
  }

  if (current === 'sessions' && requested === 'focus') {
    return { mode: 'focus', sessionsCollapsedByUser: true }
  }
  if (requested === 'sessions') {
    return { mode: 'sessions', sessionsCollapsedByUser: false }
  }
  return { mode: requested, sessionsCollapsedByUser }
}
