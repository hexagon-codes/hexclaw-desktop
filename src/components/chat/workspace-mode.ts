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
