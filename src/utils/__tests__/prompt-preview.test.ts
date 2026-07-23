import { describe, expect, it } from 'vitest'
import {
  decoratePromptPreviewHtml,
  extractPromptArgs,
  projectPromptPreview,
} from '../prompt-preview'

describe('prompt-preview · extractPromptArgs', () => {
  it('找全并去重所有占位（保持首次出现顺序）', () => {
    expect(extractPromptArgs('翻译 $ARGUMENTS 再 $ARGUMENTS')).toEqual(['$ARGUMENTS'])
    expect(extractPromptArgs('{{a}} 和 $ARGUMENTS 和 {{b}}')).toEqual([
      '{{a}}',
      '$ARGUMENTS',
      '{{b}}',
    ])
    expect(extractPromptArgs('没有占位')).toEqual([])
  })

  it('null / undefined / 非串安全', () => {
    expect(extractPromptArgs(undefined as unknown as string)).toEqual([])
    expect(extractPromptArgs(null as unknown as string)).toEqual([])
  })
})

describe('prompt-preview · shared-renderer projection', () => {
  it('只替换占位，Markdown、公式与每次出现的原值保持可逆', () => {
    const source = String.raw`# 标题

公式 $\frac{3}{4}$；翻译 $ARGUMENTS，再交给 {{ student.name }} 和 $ARGUMENTS。`
    const projection = projectPromptPreview(source)

    expect(projection.markdown).toContain('# 标题')
    expect(projection.markdown).toContain(String.raw`$\frac{3}{4}$`)
    expect(projection.markdown).not.toContain('$ARGUMENTS')
    expect(projection.args).toEqual(['$ARGUMENTS', '{{ student.name }}', '$ARGUMENTS'])

    const decorated = decoratePromptPreviewHtml(`<p>${projection.markdown}</p>`, projection)
    expect(decorated.match(/class="hc-arg"/g)).toHaveLength(3)
    expect(decorated).toContain('<span class="hc-arg">$ARGUMENTS</span>')
    expect(decorated).toContain('<span class="hc-arg">{{ student.name }}</span>')
  })

  it('哨兵前缀避开原文，用户私有区文本不会被误恢复', () => {
    const userSentinel = '\u{e000}hc-prompt-arg:0:7\u{e001}'
    const projection = projectPromptPreview(`${userSentinel} $ARGUMENTS`)

    expect(projection.sentinelPrefix).not.toBe('\u{e000}hc-prompt-arg:0:')
    const decorated = decoratePromptPreviewHtml(projection.markdown, projection)
    expect(decorated).toContain(userSentinel)
    expect(decorated.match(/class="hc-arg"/g)).toHaveLength(1)
  })

  it('空正文和无占位正文保持原样且结果确定', () => {
    const empty = projectPromptPreview('')
    expect(empty.markdown).toBe('')
    expect(empty.args).toEqual([])
    expect(decoratePromptPreviewHtml('', empty)).toBe('')

    const body = '就是一段普通文字，编号 42。'
    const projection = projectPromptPreview(body)
    expect(projection).toEqual(projectPromptPreview(body))
    expect(decoratePromptPreviewHtml('<p>普通文字</p>', projection)).toBe('<p>普通文字</p>')
  })
})
