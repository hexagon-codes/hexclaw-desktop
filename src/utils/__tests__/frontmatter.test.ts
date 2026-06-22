/**
 * frontmatter 解析器单测 —— P0 缺陷的核心回归。
 * 关键不变量：含 frontmatter 的 SKILL.md 解析后，body 里不再含 `---` YAML 头，
 * 字段被结构化抽出；任何脏输入都不抛错、退化为「无 frontmatter，正文 = 原文」。
 */
import { describe, it, expect } from 'vitest'
import { parseFrontmatter, stripFrontmatter, fmString, fmArray } from '../frontmatter'

describe('parseFrontmatter', () => {
  it('剥离标准 SKILL.md frontmatter，正文不含 YAML 头（P0 核心）', () => {
    const md = ['---', 'name: notes', 'icon: 📝', '---', '# Notes', '', 'body text'].join('\n')
    const r = parseFrontmatter(md)
    expect(r.hasFrontmatter).toBe(true)
    expect(r.data.name).toBe('notes')
    expect(r.data.icon).toBe('📝')
    // 正文绝不能再出现 frontmatter 围栏或 YAML 行
    expect(r.body).toBe('# Notes\n\nbody text')
    expect(r.body).not.toContain('---')
    expect(r.body).not.toContain('name:')
  })

  it('解析行内数组与块数组', () => {
    const inline = parseFrontmatter('---\ntriggers: [review, audit, "code review"]\n---\nx')
    expect(inline.data.triggers).toEqual(['review', 'audit', 'code review'])

    const block = parseFrontmatter('---\ntags:\n  - a\n  - b\n  - c\n---\nx')
    expect(block.data.tags).toEqual(['a', 'b', 'c'])
  })

  it('去除标量引号，value 含冒号只切第一个冒号', () => {
    const r = parseFrontmatter("---\nname: \"my skill\"\ndescription: ratio is a:b\n---\nbody")
    expect(r.data.name).toBe('my skill')
    expect(r.data.description).toBe('ratio is a:b')
  })

  it('无 frontmatter：原样返回，hasFrontmatter=false', () => {
    const r = parseFrontmatter('# Just markdown\n\nno frontmatter here')
    expect(r.hasFrontmatter).toBe(false)
    expect(r.body).toBe('# Just markdown\n\nno frontmatter here')
    expect(r.data).toEqual({})
  })

  it('有起始围栏但无结束围栏：不当 frontmatter，整体作正文（容错）', () => {
    const broken = '---\nname: x\nstill going...'
    const r = parseFrontmatter(broken)
    expect(r.hasFrontmatter).toBe(false)
    expect(r.body).toBe(broken)
  })

  it('CRLF 换行与 BOM 都能正确处理', () => {
    const r = parseFrontmatter('﻿---\r\nname: win\r\n---\r\n# Title')
    expect(r.data.name).toBe('win')
    expect(r.body).toBe('# Title')
  })

  it('空 frontmatter：识别为有块但字段为空', () => {
    const r = parseFrontmatter('---\n---\n# Body')
    expect(r.hasFrontmatter).toBe(true)
    expect(r.data).toEqual({})
    expect(r.body).toBe('# Body')
  })

  it('跳过注释行', () => {
    const r = parseFrontmatter('---\n# this is a comment\nname: x\n---\nbody')
    expect(r.data.name).toBe('x')
    expect(Object.keys(r.data)).toEqual(['name'])
  })

  it('空串/undefined 不抛错', () => {
    expect(parseFrontmatter('').hasFrontmatter).toBe(false)
    // @ts-expect-error 故意传 undefined 验证容错
    expect(() => parseFrontmatter(undefined)).not.toThrow()
  })
})

describe('helpers', () => {
  it('stripFrontmatter 仅返回正文', () => {
    expect(stripFrontmatter('---\nname: x\n---\nhello')).toBe('hello')
  })

  it('fmString / fmArray 归一化标量与数组', () => {
    expect(fmString('a')).toBe('a')
    expect(fmString(['a', 'b'])).toBe('a, b')
    expect(fmString(undefined)).toBe('')
    expect(fmArray('a')).toEqual(['a'])
    expect(fmArray(['a', 'b'])).toEqual(['a', 'b'])
    expect(fmArray(undefined)).toEqual([])
  })
})
