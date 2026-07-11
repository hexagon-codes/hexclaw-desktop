/**
 * 域G 审查取证 —— 核心 utils / services / composables / i18n
 *
 * SDET 挑刺式 code review。每条 finding 用断言钉死「正确行为」，
 * 当前实现有缺陷的会 RED。**本文件只暴露问题，不修生产源码。**
 *
 * i18n 三语对称性 / 占位符一致性 / 维语翻译完整性的检查应保持 GREEN
 * （作为回归护栏：将来谁漏译/漏 key/占位符不一致，这里立刻变红）。
 *
 * 运行：CI=true npx vitest run src/__tests__/audit-core-utils-20260621.test.ts
 */
import { describe, it, expect } from 'vitest'
import zhCN from '@/i18n/locales/zh-CN'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'
import { setLocale } from '@/i18n'
import {
  formatElapsedSeconds,
  formatDurationMs,
  formatRelative,
} from '@/utils/time'
import { extractThinkTags } from '@/utils/think-tags'
import { fromNativeError } from '@/utils/errors'
// 注：useValidation（含 rules）死 composable 已随 U7 死代码清理（20260711）删除，
// 原 FINDING#4「rules.range 空值误判」describe 随之移除。

// ─── i18n 工具 ────────────────────────────────────────
function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  const o = obj as Record<string, unknown>
  for (const k of Object.keys(o)) {
    const v = o[k]
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}
const phTokens = (s: string | undefined) =>
  new Set(typeof s === 'string' ? s.match(/\{[^}]+\}/g) ?? [] : [])
const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))
const hasHan = (s: string) => /[一-鿿]/.test(s)

const ZH = flatten(zhCN)
const EN = flatten(en)
const UG = flatten(ugCN)
const ZHK = new Set(Object.keys(ZH))
const ENK = new Set(Object.keys(EN))
const UGK = new Set(Object.keys(UG))
const onlyIn = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k))

// ════════════════════════════════════════════════════════════════════
// 护栏组：i18n 三语对称性（当前 GREEN，作为回归基线）
// ════════════════════════════════════════════════════════════════════
describe('[GUARD][i18n] 三语 key 对称性 / 占位符 / 翻译完整性', () => {
  it('en 不缺 key、不多 key（相对 zh-CN）', () => {
    expect(onlyIn(ZHK, ENK)).toEqual([]) // en 缺失
    expect(onlyIn(ENK, ZHK)).toEqual([]) // en 多出
  })

  it('ug-CN 不缺 key、不多 key（相对 zh-CN）', () => {
    expect(onlyIn(ZHK, UGK)).toEqual([]) // ug 缺失
    expect(onlyIn(UGK, ZHK)).toEqual([]) // ug 多出
  })

  it('占位符 {x} 在 zh / en 间一致', () => {
    const mismatch = [...ZHK].filter((k) => ENK.has(k) && !setEq(phTokens(ZH[k]), phTokens(EN[k])))
    expect(mismatch).toEqual([])
  })

  it('占位符 {x} 在 zh / ug 间一致', () => {
    const mismatch = [...ZHK].filter((k) => UGK.has(k) && !setEq(phTokens(ZH[k]), phTokens(UG[k])))
    expect(mismatch).toEqual([])
  })

  it('en 文案不应残留中文（漏译会泄漏中文到英文 UI）', () => {
    const leaked = [...ENK].filter((k) => hasHan(EN[k] ?? ''))
    expect(leaked).toEqual([])
  })

  it('ug-CN 文案不应原样照抄中文（值===zh 且含汉字 = 未翻译）', () => {
    const untranslated = [...ZHK].filter((k) => UG[k] !== undefined && UG[k] === ZH[k] && hasHan(ZH[k]))
    expect(untranslated).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// FINDING #1 [高][数字格式化边界] formatElapsedSeconds 对 NaN/Infinity 产出垃圾
// time.ts:89-93  Math.max(0, Math.floor(NaN)) === NaN，`s < 60` 为 false，
// 落入 m:ss 分支 → "NaN:NaN" / "Infinity:NaN"。
// 该函数在 TasksView.vue:389（运行中任务计时）与 ChatView.vue:856 直接展示给用户，
// 一旦 startedAt 为脏数据（未来时间 / 解析失败 / undefined），UI 即显示 "NaN:NaN"。
// ════════════════════════════════════════════════════════════════════
describe('[FINDING#1][高][边界] formatElapsedSeconds NaN/Infinity 防护缺失', () => {
  it('NaN 不应渲染成 "NaN:NaN"（期望优雅兜底，如 "0s"）', () => {
    const out = formatElapsedSeconds(NaN)
    expect(out).not.toMatch(/NaN/)
  })

  it('Infinity 不应渲染成 "Infinity:NaN"', () => {
    const out = formatElapsedSeconds(Infinity)
    expect(out).not.toMatch(/Infinity|NaN/)
  })

  it('负数应钳到 0（这条目前是 GREEN，确认下界正常）', () => {
    expect(formatElapsedSeconds(-5)).toBe('0s')
  })
})

// ════════════════════════════════════════════════════════════════════
// FINDING #2 [低][数字格式化边界] formatDurationMs(0) 显示 "-" 而非 "0ms"
// time.ts:100-104  `if (!ms || ms < 0) return '-'`，0 是 falsy → 0ms 任务被当成「无数据」。
// 一个真实耗时 0ms（瞬时完成）的 run 在 TasksView 历史里显示破折号，与「无 duration」无法区分。
// ════════════════════════════════════════════════════════════════════
describe('[FINDING#2][低][边界] formatDurationMs(0) 与「无数据」混淆', () => {
  it('0ms 应显示 "0ms" 而不是 "-"（0 是合法耗时，不是缺失）', () => {
    expect(formatDurationMs(0)).toBe('0ms')
  })

  it('undefined / 负数仍应显示 "-"（这两条 GREEN）', () => {
    expect(formatDurationMs(undefined)).toBe('-')
    expect(formatDurationMs(-1)).toBe('-')
  })
})

// ════════════════════════════════════════════════════════════════════
// FINDING #3 [中][i18n/逻辑] formatRelative 相对时间未本地化
// time.ts:107-119  只有 "刚刚 / just now" 走了 isZh() 分支，
// "Ns ago / Nm ago / Nh ago / Nd ago" 永远是英文硬编码。
// 中文 locale 下会出现「刚刚」与「30s ago」混排。
// （现无活跃调用方，列为 latent，但函数已 export 供复用，未来接入即 bug。）
// ════════════════════════════════════════════════════════════════════
describe('[FINDING#3][中][i18n] formatRelative 在 zh-CN 下泄漏英文', () => {
  it('zh-CN：30 秒前不应是英文 "30s ago"', () => {
    setLocale('zh-CN')
    const now = Date.now()
    const out = formatRelative(new Date(now - 30_000).toISOString(), now)
    // 期望中文（如 "30秒前"）；当前实现返回 "30s ago"
    expect(out).not.toMatch(/ago/)
  })

  it('zh-CN：5 分钟前不应是英文 "5m ago"', () => {
    setLocale('zh-CN')
    const now = Date.now()
    const out = formatRelative(new Date(now - 300_000).toISOString(), now)
    expect(out).not.toMatch(/ago/)
  })
})

// （FINDING#4 rules.range 校验断言随 useValidation 死代码删除，见 U7 20260711）

// ════════════════════════════════════════════════════════════════════
// FINDING #5 [低][解析边界] extractThinkTags 对不匹配闭合标签吞掉正文
// think-tags.ts:9-27  开标签 <think> 时 closeTag 固定为 "</think>"，
// 若模型输出 <think>abc</thinking>def（开/闭不一致），indexOf("</think>") 找不到
// → 走「流式未闭合」分支 → reasoning 吞下「abc</thinking>def」，content 为空。
// 用户看到「空回答」，真正答案 def 被丢进 reasoning。
// ════════════════════════════════════════════════════════════════════
describe('[FINDING#5][低][解析] extractThinkTags 开/闭标签不一致丢失正文', () => {
  it('<think>abc</thinking>def 不应把正文 def 吞进 reasoning', () => {
    const { content } = extractThinkTags('<think>abc</thinking>def')
    // 期望正文里仍能拿到 def；当前实现 content === ''
    expect(content).toContain('def')
  })

  it('开/闭一致时正常（GREEN 对照）', () => {
    const r = extractThinkTags('<think>abc</think>def')
    expect(r.reasoning).toBe('abc')
    expect(r.content).toBe('def')
  })
})

// ════════════════════════════════════════════════════════════════════
// FINDING #6 [低][错误处理] fromNativeError 丢失非 Abort 的 DOMException 信息
// errors.ts:47-70  DOMException 在 renderer 里不是 instanceof Error，且数字 code 被
// 第一段（typeof code === 'string'）排除；非 AbortError 的 DOMException（如 DataError /
// QuotaExceededError）会落到最后一段，message 被覆盖成「未知错误」，原始 .message 丢失。
// ════════════════════════════════════════════════════════════════════
describe('[FINDING#6][低][错误] fromNativeError 丢弃 DOMException 原始消息', () => {
  it('非 Abort 的 DOMException 应保留原始 message，而非「未知错误」', () => {
    const e = new DOMException('quota exceeded', 'QuotaExceededError')
    const out = fromNativeError(e)
    // 期望 message 含原始文案；当前实现是「未知错误」
    expect(out.message).toContain('quota')
  })

  it('AbortError 仍正确归类为 TIMEOUT（GREEN 对照）', () => {
    const e = new DOMException('aborted', 'AbortError')
    expect(fromNativeError(e).code).toBe('TIMEOUT')
  })
})

// 注：FINDING#7「useSSE 泄漏未识别 JSON 帧」随 useSSE 死 composable 一并删除
// （U7 死代码清理 20260711）——composables/useSSE.ts 无任何生产引用，已移除。
