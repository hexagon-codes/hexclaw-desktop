/**
 * SKILL.md / Prompt frontmatter 解析（纯函数，零依赖，可单测）。
 *
 * 背景：SKILL.md 是「YAML frontmatter + Markdown 正文」。若把整份内容直接喂给
 * markdown-it，开头的 `---` 会被解析成 `<hr>`、紧随的 YAML 行会被当成 setext 标题/
 * 段落渲染出来，详情页顶部出现一段「乱码似的」frontmatter（P0 缺陷）。
 *
 * 因此渲染前必须先剥离 frontmatter，把它解析成结构化字段单独展示，正文再走渲染器。
 * 这里只实现 SKILL.md 实际用到的 YAML 子集（标量、行内数组 `[a, b]`、块数组 `- x`），
 * 不引入完整 YAML 依赖——既守住可移植内核，又把体积/攻击面降到最低。
 */

export type FrontmatterValue = string | string[]

export interface ParsedFrontmatter {
  /** 解析出的 frontmatter 字段（无则为空对象）。 */
  data: Record<string, FrontmatterValue>
  /** 剥离 frontmatter 后的 Markdown 正文（无 frontmatter 时为原文）。 */
  body: string
  /** 是否识别到合法 frontmatter 块（区分「无 frontmatter」与「空 frontmatter」）。 */
  hasFrontmatter: boolean
}

/** 起始/结束围栏：独占一行的 `---`（结束亦允许 `...`）。 */
const OPEN_FENCE = /^---[ \t]*$/
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/

/** 去掉成对引号（单/双）。 */
function stripQuotes(raw: string): string {
  const s = raw.trim()
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1)
  }
  return s
}

/** 解析行内数组 `[a, "b", 'c']` → ['a','b','c']。 */
function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((x) => stripQuotes(x))
    .filter((x) => x.length > 0)
}

/** 解析 frontmatter 行（已剥离围栏）为 YAML 子集对象。 */
function parseYamlSubset(lines: string[]): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    i += 1
    const trimmed = line.trim()
    // 跳过空行、注释、以及游离的缩进行（块数组项由下方前瞻消费）
    if (!trimmed || trimmed.startsWith('#') || /^\s/.test(line)) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    if (!key) continue

    const valuePart = line.slice(colon + 1).trim()

    if (valuePart === '') {
      // 块数组：前瞻收集后续 `- item` 行
      const items: string[] = []
      while (i < lines.length) {
        const next = lines[i] ?? ''
        const nt = next.trim()
        if (nt.startsWith('- ')) {
          items.push(stripQuotes(nt.slice(2)))
          i += 1
        } else if (nt === '-') {
          items.push('')
          i += 1
        } else {
          break
        }
      }
      data[key] = items
    } else if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
      data[key] = parseInlineArray(valuePart)
    } else {
      data[key] = stripQuotes(valuePart)
    }
  }
  return data
}

/**
 * 解析 frontmatter。容错优先：任何不合法（无起始围栏 / 无结束围栏）都退化为
 * 「无 frontmatter，正文 = 原文」，绝不抛错——渲染路径不能因脏数据崩。
 */
export function parseFrontmatter(input: string): ParsedFrontmatter {
  const original = input ?? ''
  const normalized = original.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  if (!OPEN_FENCE.test(lines[0] ?? '')) {
    return { data: {}, body: original, hasFrontmatter: false }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_FENCE.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  if (end === -1) {
    // 有起始无结束：不是合法 frontmatter，整体当正文
    return { data: {}, body: original, hasFrontmatter: false }
  }

  const data = parseYamlSubset(lines.slice(1, end))
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
  return { data, body, hasFrontmatter: true }
}

/** 便捷：仅取剥离 frontmatter 后的正文。 */
export function stripFrontmatter(input: string): string {
  return parseFrontmatter(input).body
}

/** 便捷：把字段值统一取为字符串（数组以 ', ' 连接）。 */
export function fmString(v: FrontmatterValue | undefined): string {
  if (Array.isArray(v)) return v.join(', ')
  return v ?? ''
}

/** 便捷：把字段值统一取为字符串数组（标量包成单元素，空值为 []）。 */
export function fmArray(v: FrontmatterValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x) => x.length > 0)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}
