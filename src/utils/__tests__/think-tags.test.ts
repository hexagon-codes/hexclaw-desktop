import { describe, it, expect } from 'vitest'
import { extractThinkTags } from '../think-tags'

// ═══════════════════════════════════════════════════════════
// 第一层：单元测试 — extractThinkTags 纯函数逻辑
// ═══════════════════════════════════════════════════════════

describe('extractThinkTags 单元测试', () => {
  describe('基本提取', () => {
    it('<think> 标签', () => {
      const r = extractThinkTags('<think>思考</think>回复')
      expect(r.reasoning).toBe('思考')
      expect(r.content).toBe('回复')
    })
    it('<thinking> 标签', () => {
      const r = extractThinkTags('<thinking>reasoning</thinking>reply')
      expect(r.reasoning).toBe('reasoning')
      expect(r.content).toBe('reply')
    })
    it('前导空白', () => {
      const r = extractThinkTags('  \n<think>思考</think>回复')
      expect(r.reasoning).toBe('思考')
      expect(r.content).toBe('回复')
    })
    it('前导制表符', () => {
      const r = extractThinkTags('\t<think>思考</think>回复')
      expect(r.reasoning).toBe('思考')
      expect(r.content).toBe('回复')
    })
  })

  describe('真实模型输出', () => {
    it('glm-z1-airx 真实响应（API 抓取）', () => {
      const text = '\n<think>用户问了一个非常简单的数学问题："1+1等于几"。这是一个基本的算术问题，答案很明显是2。\n\n我不需要使用任何工具来回答这个问题，因为这是一个常识性的数学问题。我可以直接回答。</think>\n1+1等于2。\n\n这是一个基本的数学运算，两个1相加的结果是2。'
      const r = extractThinkTags(text)
      expect(r.reasoning).toContain('基本的算术问题')
      expect(r.reasoning).not.toContain('<think>')
      expect(r.content).toContain('1+1等于2')
      expect(r.content).not.toContain('<think>')
      expect(r.content).not.toContain('基本的算术问题')
    })

    it('glm-z1 杭帮菜真实截图场景', () => {
      const text = '<think>用户问的是"杭帮菜的正确吃法"，这是一个关于杭州菜系的问题。我需要查看用户上传的文档"杭帮菜的正确吃法"，因为这是一个已上传的文档，我应该基于这个文档来回答问题。\n\n让我先读取这个文档的内容。</think>\n我来帮您查看关于杭帮菜正确吃法的文档内容。'
      const r = extractThinkTags(text)
      expect(r.reasoning).toContain('杭帮菜')
      expect(r.content).toBe('我来帮您查看关于杭帮菜正确吃法的文档内容。')
    })

    it('DeepSeek R1 格式', () => {
      const text = '<think>\nLet me analyze this step by step.\n1. First point\n2. Second point\n</think>\nHere is my answer.'
      const r = extractThinkTags(text)
      expect(r.reasoning).toContain('Let me analyze this step by step.')
      expect(r.content).toBe('Here is my answer.')
    })
  })

  describe('安全性：不误匹配', () => {
    const noMatchCases = [
      ['正文中间', '关于 XML，<think> 标签用于思考。</think>示例。'],
      ['代码块中', '```xml\n<think>example</think>\n```'],
      ['文字后', 'Hello <think>world</think> end'],
      ['Markdown 标题后', '# Title\n<think>body</think>'],
      ['HTML 注释后', '<!-- comment --><think>body</think>'],
      ['用户讨论标签', '请问 <think> 标签是什么意思?'],
      ['非 think 的 HTML 标签', '<p>paragraph</p><br>text'],
    ] as const
    noMatchCases.forEach(([label, text]) => {
      it(`${label}: 不匹配`, () => {
        const r = extractThinkTags(text)
        expect(r.content).toBe(text)
        expect(r.reasoning).toBe('')
      })
    })
  })

  describe('普通模型', () => {
    it('中文', () => expect(extractThinkTags('普通回复。').reasoning).toBe(''))
    it('英文', () => expect(extractThinkTags('Hello world.').reasoning).toBe(''))
    it('空字符串', () => {
      const r = extractThinkTags('')
      expect(r.content).toBe('')
      expect(r.reasoning).toBe('')
    })
    it('Markdown', () => {
      const text = '# T\n- i\n```c```'
      expect(extractThinkTags(text).content).toBe(text)
    })
  })

  describe('边界情况', () => {
    it('空 think 块', () => {
      const r = extractThinkTags('<think></think>回复')
      expect(r.reasoning).toBe('')
      expect(r.content).toBe('回复')
    })
    it('仅思考无回复', () => {
      const r = extractThinkTags('<think>只有思考</think>')
      expect(r.reasoning).toBe('只有思考')
      expect(r.content).toBe('')
    })
    it('仅思考带尾部换行', () => {
      expect(extractThinkTags('<think>思考</think>\n\n').content).toBe('')
    })
    it('未闭合标签（流式）', () => {
      const r = extractThinkTags('<think>正在思考...')
      expect(r.reasoning).toBe('正在思考...')
      expect(r.content).toBe('')
    })
    it('仅开标签', () => {
      const r = extractThinkTags('<think>')
      expect(r.reasoning).toBe('')
      expect(r.content).toBe('')
    })
    it('多行 reasoning', () => {
      const r = extractThinkTags('<think>行1\n行2\n> 引用</think>回复')
      expect(r.reasoning).toContain('行1')
      expect(r.reasoning).toContain('> 引用')
      expect(r.content).toBe('回复')
    })
    it('reasoning 含 XML 标签', () => {
      const r = extractThinkTags('<think>看到 <tool_call></think>好的')
      expect(r.reasoning).toContain('<tool_call>')
      expect(r.content).toBe('好的')
    })
    it('长文本 reasoning（>1KB）', () => {
      const long = '很长思考。'.repeat(200)
      const r = extractThinkTags(`<think>${long}</think>回复`)
      expect(r.content).toBe('回复')
      expect(r.reasoning).toBe(long)
    })
    it('thinking 优先于 think', () => {
      const r = extractThinkTags('<thinking>r</thinking>c <think>x</think>')
      expect(r.reasoning).toBe('r')
      expect(r.content).toContain('<think>x</think>')
    })
  })

  describe('幂等性', () => {
    const inputs = ['<think>思考</think>回复', '普通', '<thinking>r</thinking>c', '']
    inputs.forEach(input => {
      it(`"${input.slice(0, 20)}" 提取后再提取不变`, () => {
        const r1 = extractThinkTags(input)
        const r2 = extractThinkTags(r1.content)
        expect(r2.content).toBe(r1.content)
        expect(r2.reasoning).toBe('')
      })
    })
  })

  describe('信息不丢失', () => {
    it('reasoning + content 包含原始文本信息', () => {
      for (const [input, combined] of [
        ['<think>ABC</think>DEF', 'ABCDEF'],
        ['<thinking>X</thinking>Y', 'XY'],
        ['普通', '普通'],
      ] as const) {
        const r = extractThinkTags(input)
        const got = (r.reasoning + r.content).replace(/\s/g, '')
        expect(got).toContain(combined.replace(/\s/g, ''))
      }
    })
  })
})

// ═══════════════════════════════════════════════════════════
// 第二层：模块测试 — 模拟 chat store onChunk 流式处理
// ═══════════════════════════════════════════════════════════

describe('chat store onChunk 模块测试', () => {
  function simulateStreamFlow(chunks: { content?: string; reasoning?: string }[]) {
    let rawStreamBuf = ''
    let streamingContent = ''
    let streamingReasoning = ''

    for (const chunk of chunks) {
      if (chunk.reasoning) streamingReasoning += chunk.reasoning
      if (chunk.content) {
        rawStreamBuf += chunk.content
        const parsed = extractThinkTags(rawStreamBuf)
        if (parsed.reasoning) streamingReasoning = parsed.reasoning
        streamingContent = parsed.content
      }
    }
    return { content: streamingContent, reasoning: streamingReasoning }
  }

  it('场景A: 普通模型流式 chunks', () => {
    const r = simulateStreamFlow([
      { content: '你好' }, { content: '，有什么' }, { content: '可以帮你的？' },
    ])
    expect(r.content).toBe('你好，有什么可以帮你的？')
    expect(r.reasoning).toBe('')
  })

  it('场景B: glm-z1 流式（<think> 在 content 中）', () => {
    const r = simulateStreamFlow([
      { content: '<think>' }, { content: '让我想想' },
      { content: '</think>' }, { content: '\n答案是42。' },
    ])
    expect(r.reasoning).toContain('让我想想')
    expect(r.content).toContain('答案是42')
    expect(r.content).not.toContain('<think>')
  })

  it('场景C: Ollama 原生 thinking', () => {
    const r = simulateStreamFlow([
      { reasoning: 'Step 1: ' }, { reasoning: 'think.' },
      { content: '答案' }, { content: '是2。' },
    ])
    expect(r.reasoning).toBe('Step 1: think.')
    expect(r.content).toBe('答案是2。')
  })

  it('场景D: Ollama 仅 reasoning 无 content', () => {
    const r = simulateStreamFlow([
      { reasoning: '深入思考...' }, { reasoning: '无结论。' },
    ])
    expect(r.reasoning).toBe('深入思考...无结论。')
    expect(r.content).toBe('')
  })

  it('场景E: <think> 标签跨 chunk 拆分', () => {
    const r = simulateStreamFlow([
      { content: '<thi' }, { content: 'nk>思考' },
      { content: '</thi' }, { content: 'nk>回复' },
    ])
    expect(r.reasoning).toContain('思考')
    expect(r.content).toBe('回复')
  })
})

// ═══════════════════════════════════════════════════════════
// 第三层：模块测试 — finalizeAssistantMessage 逻辑
// ═══════════════════════════════════════════════════════════

describe('finalizeAssistantMessage 模块测试', () => {
  function simulateFinalize(params: { content: string; reasoning?: string }) {
    const parsed = extractThinkTags(params.content || '')
    const finalContent = parsed.content
    const finalReasoning = parsed.reasoning
      ? (params.reasoning ? params.reasoning + '\n' + parsed.reasoning : parsed.reasoning)
      : (params.reasoning || undefined)
    return {
      content: finalContent || (finalReasoning ? '' : '模型未生成有效回复，可能是内容安全策略过滤所致，请尝试换个方式提问。'),
      reasoning: finalReasoning,
    }
  }

  it('glm-z1: content 含 <think>，提取到 reasoning', () => {
    const r = simulateFinalize({ content: '<think>思考</think>回复' })
    expect(r.content).toBe('回复')
    expect(r.reasoning).toBe('思考')
  })
  it('普通模型: 无标签', () => {
    const r = simulateFinalize({ content: '普通回复' })
    expect(r.content).toBe('普通回复')
    expect(r.reasoning).toBeUndefined()
  })
  it('reasoning 已有 + content 含 <think>: 合并', () => {
    const r = simulateFinalize({ content: '<think>新</think>回复', reasoning: '旧' })
    expect(r.content).toBe('回复')
    expect(r.reasoning).toBe('旧\n新')
  })
  it('content 空 + reasoning 有值: 不显示错误', () => {
    const r = simulateFinalize({ content: '', reasoning: '只有思考' })
    expect(r.content).toBe('')
    expect(r.reasoning).toBe('只有思考')
  })
  it('都空: 显示错误消息', () => {
    const r = simulateFinalize({ content: '' })
    expect(r.content).toContain('模型未生成有效回复')
  })
  it('content 仅含 <think>: 提取后 content 空但有 reasoning', () => {
    const r = simulateFinalize({ content: '<think>只有思考</think>' })
    expect(r.content).toBe('')
    expect(r.reasoning).toBe('只有思考')
  })
})

// ═══════════════════════════════════════════════════════════
// 第四层：前后端一致性验证
// ═══════════════════════════════════════════════════════════

describe('前后端一致性', () => {
  const cases = [
    { input: '<think>思考</think>回复', content: '回复', reasoning: '思考' },
    { input: '<thinking>reasoning</thinking>reply', content: 'reply', reasoning: 'reasoning' },
    { input: '普通文本', content: '普通文本', reasoning: '' },
    { input: '', content: '', reasoning: '' },
    { input: '<think>只有思考</think>', content: '', reasoning: '只有思考' },
    { input: '关于 XML，<think> 标签用于思考。</think>示例。', content: '关于 XML，<think> 标签用于思考。</think>示例。', reasoning: '' },
  ]
  cases.forEach(({ input, content, reasoning }) => {
    it(`与 Go 后端一致: "${input.slice(0, 40)}"`, () => {
      const r = extractThinkTags(input)
      expect(r.content).toBe(content)
      expect(r.reasoning).toBe(reasoning)
    })
  })
})
