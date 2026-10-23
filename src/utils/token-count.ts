// 会话估算量与账号实际用量共用数字格式，不改变各自的统计来源。
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1) + 'k'
}

// 统计来源由调用者决定，账号和会话只共享同一行文案的组合规则。
export function formatMessageTokenStats(
  messageCount: number | null,
  messagesLabel: string,
  tokenBadge: string,
): string {
  return `${messageCount ?? '—'} ${messagesLabel} · ${tokenBadge}`
}
