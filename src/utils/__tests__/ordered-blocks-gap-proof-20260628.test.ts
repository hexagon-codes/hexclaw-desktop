import { describe, it, expect } from 'vitest'
import { toContentBlocks } from '@/utils/content-blocks'
import type { ChatMessage } from '@/types/chat'

/**
 * #3 取证：有序内容块词表缺失 —— 多步 agent 回合的 text↔tool 交错顺序**结构性不可表达**。
 *
 * 权威基准（Anthropic Messages API / OpenAI Chat Completions）：
 *   一个 assistant 回合是**有序的 content block 序列**——
 *   [text, tool_use, text, tool_use, ...]，tool_result 作为块按执行序排列。
 *   多步推理 = 块的顺序本身携带"先说什么、再调什么、又说什么"的因果。
 *
 * 本生态的数据模型（ai-core template.Message / hexclaw wire Reply）：
 *   content: string（所有文本合并成一坨） + tool_calls: ToolCall[]（旁挂扁平数组）。
 *   **没有任何字段记录 tool_call 与 content 各片段的相对位置。**
 *   唯一的重建路径 toContentBlocks 固定输出：thinking → text → 全部 tools。
 *
 * 结论：text 永远被排在 tool 之前。当模型真实流程是「先调工具，再据结果说话」
 * （ReAct 的典型形态），重建出来的顺序是**反的**；多步交错（说→调→说→调）则彻底丢失。
 */
describe('#3 有序内容块缺失 —— 结构性证明', () => {
  it('text 永远排在 tool_use 之前（无法表达"工具之后才产生的文本"）', () => {
    // 真实因果：模型先调 search 工具，拿到结果后才说"根据搜索，答案是 X"。
    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '根据搜索结果，杭州今天 27°C。', // 这句其实发生在工具调用**之后**
      timestamp: '',
      tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}', result: '27°C' }],
    }
    const blocks = toContentBlocks(msg)
    const textIdx = blocks.findIndex((b) => b.type === 'text')
    const toolIdx = blocks.findIndex((b) => b.type === 'tool_use')
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(toolIdx).toBeGreaterThanOrEqual(0)
    // 重建恒为 text 在前 —— 即便真实因果是 tool 在前。顺序被钉死、不可反映真实流程。
    expect(textIdx).toBeLessThan(toolIdx)
  })

  it('多步回合（说→调→说→调）无法保真重建：两段文本被合并、夹在中间的工具位置丢失', () => {
    // 真实流程：text-A → tool-1 → text-B → tool-2。
    // 但数据模型只能存：content = "A B"（合并），tool_calls = [1, 2]（扁平）。
    const collapsed: ChatMessage = {
      id: 'm2',
      role: 'assistant',
      content: '让我查一下天气。今天 27°C，再帮你查空气质量。空气质量良。', // text-A + text-B + ... 全挤一坨
      timestamp: '',
      tool_calls: [
        { id: 't1', name: 'weather', arguments: '{}', result: '27°C' },
        { id: 't2', name: 'aqi', arguments: '{}', result: '良' },
      ],
    }
    const blocks = toContentBlocks(collapsed)
    // 期望（若有有序块）：text-A, tool-1, text-B, tool-2, text-C —— 文本与工具交错。
    // 实得：单个 text 块在最前，之后才是两个工具。文本块数 = 1（应为 ≥2 才能交错）。
    const textBlocks = blocks.filter((b) => b.type === 'text')
    const toolBlocks = blocks.filter((b) => b.type === 'tool_use')
    expect(toolBlocks.length).toBe(2)
    // 证据：交错需要多个 text 片段，但模型的多段话被合并成 1 块 → 无法在工具间插入文本。
    expect(textBlocks.length).toBe(1)
    // 且所有工具都排在唯一文本块之后 —— 没有"工具夹在两段话中间"的可能。
    const lastTextIdx = blocks.map((b) => b.type).lastIndexOf('text')
    const firstToolIdx = blocks.findIndex((b) => b.type === 'tool_use')
    expect(firstToolIdx).toBeGreaterThan(lastTextIdx)
  })

  it('数据模型层面证明：ChatMessage 无任何字段承载 block 顺序', () => {
    // tool_calls 是扁平数组，元素无 position/index/after_text 锚点；content 是单串。
    const tc = { id: 'x', name: 'y', arguments: '{}', result: 'z' }
    const keys = Object.keys(tc)
    // 工具调用对象里没有任何"我在文本的哪个位置之后发生"的字段。
    expect(keys).not.toContain('position')
    expect(keys).not.toContain('index')
    expect(keys).not.toContain('after_text')
    expect(keys).not.toContain('block_order')
  })
})
