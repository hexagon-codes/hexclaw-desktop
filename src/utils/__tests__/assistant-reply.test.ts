import { describe, expect, it } from 'vitest'
import {
  getAssistantDisplayContent,
  getAssistantReasoningFromMetadata,
  normalizeAssistantReasoning,
  normalizeAssistantContent,
} from '@/utils/assistant-reply'

describe('assistant-reply', () => {
  it('keeps normal assistant content unchanged', () => {
    expect(getAssistantDisplayContent('正常回答')).toBe('正常回答')
  })

  it('shows a reasoning-only fallback when content is empty but reasoning exists', () => {
    expect(getAssistantDisplayContent('', 'Thinking')).toBe('模型只完成了思考，没有输出最终回答，请重试一次。')
  })

  it('shows an empty-response fallback when content and reasoning are empty', () => {
    expect(getAssistantDisplayContent('', '')).toBe('这次没有生成可显示的回答，请重试或换个方式提问。')
  })

  it('strips leaked closing think boundary and keeps the final answer', () => {
    const content = '草稿内容\n</think>\n\n哼～人家想吃火锅啦～'

    expect(normalizeAssistantContent(content, 'reasoning')).toBe('哼～人家想吃火锅啦～')
    expect(getAssistantDisplayContent(content, 'reasoning')).toBe('哼～人家想吃火锅啦～')
  })

  it('does not strip a closing think tag from normal content without reasoning context', () => {
    const content = 'XML 里可能会看到 </think> 这样的字符串'

    expect(normalizeAssistantContent(content)).toBe(content)
  })

  it('hides leaked skill prompt markdown instead of displaying role instructions', () => {
    const content = '# 角色设定\n\n你是迪丽热巴。\n\n## 核心性格\n\n- 生气了不直接说'

    expect(getAssistantDisplayContent(content)).toBe('这次只加载了角色设定，没有生成最终回答，请重试一次。')
  })

  it('extracts reasoning from metadata', () => {
    expect(getAssistantReasoningFromMetadata({ reasoning: 'Thinking' })).toBe('Thinking')
    expect(getAssistantReasoningFromMetadata({ reasoning: 123 })).toBeUndefined()
    expect(getAssistantReasoningFromMetadata()).toBeUndefined()
  })

  it('strips leaked think boundaries from reasoning metadata', () => {
    expect(getAssistantReasoningFromMetadata({ reasoning: '</think>\n用户再次提问' })).toBe('用户再次提问')
  })

  it('normalizes reasoning without removing normal text', () => {
    expect(normalizeAssistantReasoning('<think>先分析</think>\n最终思路')).toBe('先分析\n最终思路')
    expect(normalizeAssistantReasoning('正常思考内容')).toBe('正常思考内容')
  })

  it('can strip leaked think boundaries without trimming streaming whitespace', () => {
    expect(normalizeAssistantReasoning('</think>\nStep 1: ', { trim: false })).toBe('\nStep 1: ')
  })
})
