// 会话输入框/输出区交互的纯函数（便于单测）。2026-06-23 修三处 UX bug：
//  #1 粘贴带换行被吞、#2 流式时上滚被强拉回底、#3 输入法 Enter 误发送。

/** IME confirm-Enter 与真正发送 Enter 之间的安全窗（ms）。
 *  macOS WKWebView/WebKit 上 compositionend 可能早于确认键的 keydown 触发，此时 isComposing 已是
 *  false、keyCode 非 229 —— 仅靠事件字段判不出合成态。用「刚结束合成 < 此窗口」兜底拦掉确认键。
 *  人类「合成结束 → 再按 Enter 发送」间隔远大于此值，不会误拦真实发送。 */
export const COMPOSE_GUARD_MS = 120

/** #3 输入法（IME）合成态保护：合成中（或刚结束合成）按 Enter 是「确认候选词」，不能当发送。
 *  发送条件：Enter + 无 shift/alt/meta + 不在合成态(isComposing/keyCode229) + 不在手动合成标志 +
 *  距上次 compositionend 已超过 COMPOSE_GUARD_MS。覆盖 Chromium/Firefox/Safari/WKWebView 全 IME。 */
export function shouldSendOnEnter(
  e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number },
  opts?: { composing?: boolean; msSinceCompositionEnd?: number },
): boolean {
  if (e.key !== 'Enter') return false
  if (e.shiftKey || e.altKey || e.metaKey) return false // Shift/Alt/Cmd+Enter = 换行，不发送
  if (e.isComposing) return false // 标准：IME 合成中
  if (e.keyCode === 229) return false // 旧浏览器/部分 IME 合成的 keyCode
  if (opts?.composing) return false // 手动跟踪的合成态（compositionstart→true）
  if (opts?.msSinceCompositionEnd !== undefined && opts.msSinceCompositionEnd >= 0 && opts.msSinceCompositionEnd < COMPOSE_GUARD_MS) {
    return false // WKWebView：compositionend 早于确认键 keydown 的兜底
  }
  return true
}

// 各种「非标准换行」→ \n：\r\n / \r（旧 Mac）/ U+2028 行分隔 / U+2029 段分隔。
// textarea 原生 paste 不把 U+2028/U+2029 当换行 → markdown 折行丢失，需在此统一。
const WEIRD_LINE_BREAKS = new RegExp('\\r\\n?|[\\u2028\\u2029]', 'g')

/** #1 规范化粘贴文本的换行，保留换行不被吞成一行。 */
export function normalizePastedText(text: string): string {
  return text.replace(WEIRD_LINE_BREAKS, '\n')
}

// 只检测「非标准换行」(\r / U+2028 / U+2029)；普通 \n 不算（textarea 原生已正确处理）。
const WEIRD_DETECT = new RegExp('\\r|[\\u2028\\u2029]')

/** 文本是否含会被 textarea/markdown 吞掉的非标准换行，决定是否需要接管 paste。 */
export function hasWeirdLineBreaks(text: string): boolean {
  return WEIRD_DETECT.test(text)
}

/** #2 是否应自动滚到底：强制时总滚；否则仅当用户没有主动上滚时才滚。
 *  关键：throttle 定时器到点时要用本判断「再确认一次」，避免节流窗口内用户上滚仍被拉回底部。 */
export function shouldAutoScroll(force: boolean, userScrolledUp: boolean): boolean {
  return force || !userScrolledUp
}
