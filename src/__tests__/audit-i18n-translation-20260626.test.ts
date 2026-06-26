/**
 * 全生态契约挑刺审计 · i18n 翻译取证 (2026-06-26 / hex-test)
 *
 * 锁定本轮三语翻译审计修复的不变量，并作为「举一反三」检测配方：
 * 任一同类位置回归（乱译复活 / 命名漂移 / 占位符丢失 / 计数器丢失）即自动 FAIL。
 *
 * 背景：ug-CN 机译版曾把同一术语译成多种乱词、把蟹(قىسقۇچپاقا)误成蛙(پاقا)、
 * 把正式名河蟹误成「红蛙」。本测试穷举式钉死，禁止悄悄复发。
 * 命名规范来源：用户 2026-06-25 当面锁定（见 memory project_brand_mascot_naming_i18n）。
 */
import { describe, it, expect } from 'vitest'
import zhCN from '../i18n/locales/zh-CN'
import en from '../i18n/locales/en'
import ugCN from '../i18n/locales/ug-CN'

type NestedRecord = { [key: string]: string | NestedRecord }

function flatten(obj: NestedRecord, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flatten(value as NestedRecord, full, out)
    } else {
      out[full] = value as string
    }
  }
  return out
}

const zh = flatten(zhCN as NestedRecord)
const en2 = flatten(en as NestedRecord)
const ug = flatten(ugCN as NestedRecord)
const KEYS = Object.keys(zh)

const placeholders = (s: string | undefined): string[] => (typeof s === 'string' ? (s.match(/\{[^}]+\}/g) || []).sort() : [])

describe('audit · i18n 三语翻译契约 (hex-test 20260626)', () => {
  // ── 结构层：key 一一对齐 ──
  it('三语 key 集合完全一致（无缺失/多余）', () => {
    const setZh = new Set(KEYS)
    const setEn = new Set(Object.keys(en2))
    const setUg = new Set(Object.keys(ug))
    const missingEn = [...setZh].filter((k) => !setEn.has(k))
    const missingUg = [...setZh].filter((k) => !setUg.has(k))
    const extraUg = [...setUg].filter((k) => !setZh.has(k))
    expect({ missingEn, missingUg, extraUg }).toEqual({ missingEn: [], missingUg: [], extraUg: [] })
  })

  // ── 占位符层：每条文案的 {var} 集合三语一致 ──
  it('占位符 {var} 集合三语逐键一致', () => {
    const mism: string[] = []
    for (const k of KEYS) {
      const z = placeholders(zh[k]).join(',')
      const e = placeholders(en2[k]).join(',')
      const u = placeholders(ug[k]).join(',')
      if (!(z === e && e === u)) mism.push(`${k} [zh=${z}|en=${e}|ug=${u}]`)
    }
    expect(mism).toEqual([])
  })

  // ── 未翻译残留：en/ug 不得含中日韩表意文字 ──
  it('en / ug 译文不残留 CJK 汉字', () => {
    const han = /[一-鿿㐀-䶿]/
    const enCjk = KEYS.filter((k) => typeof en2[k] === 'string' && han.test(en2[k]))
    const ugCjk = KEYS.filter((k) => typeof ug[k] === 'string' && han.test(ug[k]))
    expect({ enCjk, ugCjk }).toEqual({ enCjk: [], ugCjk: [] })
  })

  // ── 术语一致：zh 含「智能体」时 ug 一律保留英文 Agent（文件头 keep-list）──
  it('「智能体」在 ug 一律保留英文「Agent」', () => {
    const bad = KEYS.filter(
      (k) => typeof zh[k] === 'string' && zh[k].includes('智能体') && typeof ug[k] === 'string' && !ug[k].includes('Agent'),
    )
    expect(bad).toEqual([])
  })

  // ── 命名规范：机器人显示名「小蟹」── en=Little Crab / ug=كىچىك قىسقۇچپاقا ──
  it('机器人显示名「小蟹」三语命名规范', () => {
    const badEn: string[] = []
    const badUg: string[] = []
    for (const k of KEYS) {
      if (typeof zh[k] === 'string' && zh[k].includes('小蟹')) {
        if (!en2[k]?.includes('Little Crab')) badEn.push(`${k}="${en2[k]}"`)
        if (!ug[k]?.includes('كىچىك قىسقۇچپاقا')) badUg.push(`${k}="${ug[k]}"`)
      }
    }
    expect({ badEn, badUg }).toEqual({ badEn: [], badUg: [] })
  })

  // ── 命名规范：正式名「河蟹」── en/ug 一律 HexClaw ──
  it('正式名「河蟹」其他语言一律 HexClaw', () => {
    const badEn: string[] = []
    const badUg: string[] = []
    for (const k of KEYS) {
      if (typeof zh[k] === 'string' && zh[k].includes('河蟹')) {
        if (!en2[k]?.includes('HexClaw')) badEn.push(`${k}="${en2[k]}"`)
        if (!ug[k]?.includes('HexClaw')) badUg.push(`${k}="${ug[k]}"`)
      }
    }
    expect({ badEn, badUg }).toEqual({ badEn: [], badUg: [] })
  })

  // ── 维语乱译黑名单：机译错词禁止复活 ──
  it('ug 不含已清除的机译乱词', () => {
    const banned = ['چاغان', 'قىزىل پاقا', 'شياۋ', 'ئاقىل ھۆجەيرە', 'ئەقلىي ئىقتىدار']
    const hits: string[] = []
    for (const k of KEYS) {
      if (typeof ug[k] !== 'string') continue
      for (const b of banned) if (ug[k].includes(b)) hits.push(`${k}: 含「${b}」`)
    }
    expect(hits).toEqual([])
  })

  // ── 蟹≠蛙：ug 出现的 پاقا(蛙) 必须是 قىسقۇچپاقا(蟹) 的一部分 ──
  it('ug 不含裸 پاقا(蛙)，蟹必须写作 قىسقۇچپاقا', () => {
    const hits = KEYS.filter((k) => typeof ug[k] === 'string' && ug[k].replace(/قىسقۇچپاقا/g, '').includes('پاقا'))
    expect(hits).toEqual([])
  })

  // ── 4 阶段进度计数器三语都在 ──
  it('tasks.stage* 四阶段进度 N/4 三语都保留', () => {
    const stages = ['stageAnalyzing', 'stageCallingLLM', 'stageValidating', 'stagePersisting']
    const bad: string[] = []
    for (const s of stages) {
      const k = `tasks.${s}`
      for (const [name, map] of [['zh', zh], ['en', en2], ['ug', ug]] as const) {
        if (!/\d\/4/.test(map[k] || '')) bad.push(`${k}/${name}="${map[k]}"`)
      }
    }
    expect(bad).toEqual([])
  })

  // ── RTL：ug composerHint 不得残留中文全角空格 U+3000 ──
  it('ug chat.composerHint 无全角空格 U+3000', () => {
    expect(ug['chat.composerHint']?.includes('　')).toBe(false)
  })
})
