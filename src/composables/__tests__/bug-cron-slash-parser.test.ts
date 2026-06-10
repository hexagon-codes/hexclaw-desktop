/**
 * bug-cron-slash-parser — 守卫 D3.2 slash command parser。
 *
 * RED 场景（修复前都返 null 走 LLM tool_use_id 链路）：
 *   - /cron add 30m "..."     → 应识别为 add + naturalize 30m → "每 30 分钟"
 *   - /cron 每天 10 点 ...     → 应整段送 classifyCronIntent
 *   - /cron list              → 应识别为 list 子命令
 *   - /cron pause job-abc     → 应识别为 pause + jobId
 *   - /cron                   → 应识别为 unknown + 友好 suggestion
 *
 * GREEN 守护：
 *   - 任何 cron slash 命令都不再 fall-back 到 LLM 工具调用路径
 *   - Hermes 风格 + 中文自然语言双轨进入同一 classifyCronIntent
 */

import { describe, it, expect } from 'vitest'
import {
  parseCronSlashCommand,
  naturalizeSchedule,
  type CronSlashCommand,
} from '@/composables/useCronSlashParser'

/** 断言收窄到 add 分支，避免条件 expect（vitest/no-conditional-expect） */
function assertAdd(
  r: CronSlashCommand | null,
): asserts r is Extract<CronSlashCommand, { kind: 'add' }> {
  expect(r?.kind).toBe('add')
}

describe('parseCronSlashCommand — D3.2', () => {
  it('未以 /cron 开头 → 返 null（让 LLM 路径接管）', () => {
    expect(parseCronSlashCommand('帮我做点事')).toBeNull()
    expect(parseCronSlashCommand('/help')).toBeNull()
    expect(parseCronSlashCommand('cron 每天')).toBeNull()
  })

  it('/cron 空命令 → unknown + suggestion', () => {
    const r = parseCronSlashCommand('/cron')
    expect(r?.kind).toBe('unknown')
    expect(r && 'suggestion' in r ? r.suggestion : '').toContain('/cron add')
  })

  it('/cron list / ls → kind=list', () => {
    expect(parseCronSlashCommand('/cron list')?.kind).toBe('list')
    expect(parseCronSlashCommand('/cron ls')?.kind).toBe('list')
  })

  it('/cron pause job-abc → kind=pause + jobId', () => {
    const r = parseCronSlashCommand('/cron pause job-abc-123')
    expect(r?.kind).toBe('pause')
    expect(r && 'jobId' in r ? r.jobId : '').toBe('job-abc-123')
  })

  it('/cron resume / start 同义', () => {
    expect(parseCronSlashCommand('/cron resume j1')?.kind).toBe('resume')
    expect(parseCronSlashCommand('/cron start j1')?.kind).toBe('resume')
  })

  it('/cron remove / rm / delete / del 同义', () => {
    for (const cmd of ['remove', 'rm', 'delete', 'del']) {
      const r = parseCronSlashCommand(`/cron ${cmd} j1`)
      expect(r?.kind).toBe('remove')
    }
  })

  it('/cron run / trigger / fire 同义', () => {
    for (const cmd of ['run', 'trigger', 'fire']) {
      const r = parseCronSlashCommand(`/cron ${cmd} j1`)
      expect(r?.kind).toBe('run')
    }
  })

  it('/cron pause（缺 job_id）→ unknown', () => {
    const r = parseCronSlashCommand('/cron pause')
    expect(r?.kind).toBe('unknown')
  })

  it('/cron add 30m "..." → kind=add，rawDescription 已 naturalize', () => {
    const r = parseCronSlashCommand('/cron add 30m "采集新闻"')
    assertAdd(r)
    expect(r.rawDescription).toContain('每 30 分钟')
    expect(r.rawDescription).toContain('采集新闻')
  })

  it('/cron add @daily "摘要" → 每天 摘要', () => {
    const r = parseCronSlashCommand('/cron add @daily "摘要"')
    assertAdd(r)
    expect(r.rawDescription).toContain('每天')
    expect(r.rawDescription).toContain('摘要')
  })

  it('/cron 每天 10 点 采集网易新闻 → kind=add（无显式子命令）', () => {
    const r = parseCronSlashCommand('/cron 每天 10 点 采集网易新闻')
    assertAdd(r)
    // intent 至少 tier=2（有 cron hint），具体提取依赖 classifyCronIntent
    expect([1, 2, 3]).toContain(r.intent.tier)
  })

  it('/cron add（无 tail）→ unknown', () => {
    expect(parseCronSlashCommand('/cron add')?.kind).toBe('unknown')
  })

  it('引号变体不影响解析（中英文双引号）', () => {
    const r1 = parseCronSlashCommand('/cron add 30m "采集"')
    const r2 = parseCronSlashCommand('/cron add 30m "采集"')
    expect(r1?.kind).toBe('add')
    expect(r2?.kind).toBe('add')
  })
})

describe('naturalizeSchedule — D3.2 hex → 中文', () => {
  it('Hermes 短缀 30m / 1h / 2d → 中文', () => {
    expect(naturalizeSchedule('30m 采集')).toContain('每 30 分钟')
    expect(naturalizeSchedule('1h 检查')).toContain('每 1 小时')
    expect(naturalizeSchedule('2d 报告')).toContain('每 2 天')
  })

  it('@macros → 中文', () => {
    expect(naturalizeSchedule('@daily 摘要')).toContain('每天')
    expect(naturalizeSchedule('@hourly 检查')).toContain('每小时')
    expect(naturalizeSchedule('@weekly 周报')).toContain('每周')
    expect(naturalizeSchedule('@monthly 月报')).toContain('每月')
    expect(naturalizeSchedule('@yearly 年报')).toContain('每年')
  })

  it('已是中文自然语言 → 直接返回（不重复翻译）', () => {
    const t = '每天 9 点 采集新闻'
    expect(naturalizeSchedule(t)).toBe(t)
  })

  it('无 schedule 前缀 → 返回原文', () => {
    expect(naturalizeSchedule('采集新闻')).toBe('采集新闻')
  })
})
