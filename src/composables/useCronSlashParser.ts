/**
 * D3.2 slash command parser for cron — Hermes 风格 + 中文自然语言双支持。
 *
 * 支持形态：
 *   - `/cron add 30m "采集新闻"`        → tier=1，含完整 payload（直接 fast-path）
 *   - `/cron add @daily "每日摘要"`     → tier=1
 *   - `/cron 每天 10 点 采集网易新闻`    → tier=2，提取自然语言部分给 classifyCronIntent
 *   - `/cron list`                      → action=list（特殊指令，未来分发到 unified endpoint）
 *   - `/cron pause job-abc`             → action=pause
 *
 * 设计原则：
 *   - 失败时返回 null，让 useChatSend 走原 LLM 路径
 *   - 不抛异常（K12 家长复制粘贴半截命令很常见）
 *   - 全程零 LLM 调用，纯解析
 */

import { classifyCronIntent, type CronIntentResult } from './useChatSend'

export type CronSlashCommand =
  | { kind: 'add'; rawDescription: string; intent: CronIntentResult }
  | { kind: 'list' }
  | { kind: 'pause'; jobId: string }
  | { kind: 'resume'; jobId: string }
  | { kind: 'remove'; jobId: string }
  | { kind: 'run'; jobId: string }
  | { kind: 'unknown'; suggestion: string }

const SLASH_PREFIX_RE = /^\s*\/cron\b\s*/i

/**
 * 解析 cron slash command。
 *
 * 返回 null = 不是 cron slash command（让 useChatSend 走原流程）。
 * 返回 CronSlashCommand = 已识别，调用方按 kind 分发。
 */
export function parseCronSlashCommand(text: string): CronSlashCommand | null {
  if (!SLASH_PREFIX_RE.test(text)) return null
  const rest = text.replace(SLASH_PREFIX_RE, '').trim()
  if (rest === '') {
    return {
      kind: 'unknown',
      suggestion: '/cron add <间隔/cron> "<要做什么>"  或  /cron list/pause/resume/remove/run <job_id>',
    }
  }

  // 子命令分发
  const firstSpaceIdx = rest.search(/\s/)
  const subcmd = (firstSpaceIdx === -1 ? rest : rest.slice(0, firstSpaceIdx)).toLowerCase()
  const tail = firstSpaceIdx === -1 ? '' : rest.slice(firstSpaceIdx).trim()

  switch (subcmd) {
    case 'list':
    case 'ls':
      return { kind: 'list' }
    case 'pause':
    case 'stop':
      return tail
        ? { kind: 'pause', jobId: tail }
        : { kind: 'unknown', suggestion: '需要 job_id：/cron pause <job_id>' }
    case 'resume':
    case 'start':
      return tail
        ? { kind: 'resume', jobId: tail }
        : { kind: 'unknown', suggestion: '需要 job_id：/cron resume <job_id>' }
    case 'remove':
    case 'rm':
    case 'delete':
    case 'del':
      return tail
        ? { kind: 'remove', jobId: tail }
        : { kind: 'unknown', suggestion: '需要 job_id：/cron remove <job_id>' }
    case 'run':
    case 'trigger':
    case 'fire':
      return tail
        ? { kind: 'run', jobId: tail }
        : { kind: 'unknown', suggestion: '需要 job_id：/cron run <job_id>' }
    case 'add':
    case 'create':
    case 'new': {
      const description = normalizeAddTail(tail)
      if (!description) {
        return {
          kind: 'unknown',
          suggestion: '需要描述：/cron add 30m "采集新闻" 或 /cron add 每天 10 点 采集新闻',
        }
      }
      // 把 Hermes 风格 (30m, @daily) 翻译成中文喂给现有 classifyCronIntent
      const naturalized = naturalizeSchedule(description)
      const intent = classifyCronIntent(naturalized)
      return { kind: 'add', rawDescription: naturalized, intent }
    }
  }

  // 没有显式子命令 — 整段当作自然语言喂 classifier
  const intent = classifyCronIntent(rest)
  return { kind: 'add', rawDescription: rest, intent }
}

/**
 * normalizeAddTail 去掉引号 + trim。
 * 支持：
 *   30m "采集新闻"        → "30m 采集新闻"
 *   "30m 采集新闻"        → "30m 采集新闻"
 *   @daily 摘要           → "@daily 摘要"
 */
function normalizeAddTail(tail: string): string {
  let t = tail.trim()
  if (!t) return ''
  // 去掉成对的中英引号
  t = t.replace(/[""""]/g, '"')
  // 去掉所有引号但保留内部空格
  t = t.replace(/"/g, '').trim()
  return t
}

/**
 * Hermes 间隔 → 中文自然语言映射。
 *
 * 30m  → 每 30 分钟
 * 1h   → 每小时
 * 24h  → 每天
 * @daily   → 每天
 * @hourly  → 每小时
 * @weekly  → 每周
 * @monthly → 每月
 *
 * 已是中文自然语言（每天/每小时…）直接返回原文。
 */
export function naturalizeSchedule(text: string): string {
  const lower = text.toLowerCase()

  // @daily/@hourly/...
  const atMacros: Record<string, string> = {
    '@daily': '每天',
    '@hourly': '每小时',
    '@weekly': '每周',
    '@monthly': '每月',
    '@yearly': '每年',
    '@annually': '每年',
  }
  for (const macro in atMacros) {
    if (lower.startsWith(macro)) {
      return atMacros[macro] + text.slice(macro.length)
    }
  }

  // <N><unit> 短缀（30m / 1h / 2d / 7d）
  const shortHand = /^(\d+)(s|m|h|d)\b\s*/i.exec(text)
  if (shortHand) {
    const n = shortHand[1]
    const unitMap: Record<string, string> = {
      s: '秒',
      m: '分钟',
      h: '小时',
      d: '天',
    }
    const unit = unitMap[(shortHand[2] ?? '').toLowerCase()] || ''
    if (unit) {
      const rest = text.slice(shortHand[0].length).trim()
      return `每 ${n} ${unit} ${rest}`.trim()
    }
  }

  return text
}
