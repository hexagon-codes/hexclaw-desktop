/**
 * BUG-20260711-B（复现→修复→锁定）：知识库命中卡三张全部显示占位文案「知识库命中」，
 * 无任何来源/内容信息。
 *
 * 根因：后端 KnowledgeHit 契约（adapter.go:124）中 doc_title/source 均 omitempty——
 * 手工添加的无标题文档、旧索引 chunk 两者皆空是合法形态；唯一保证非空的字段是 content
 * （engine 只回传有命中正文的 hit）。而前端标题兜底链 doc_title → source → i18n 占位，
 * 从不消费 content → 合法数据渲染成三张零信息卡。
 *
 * 根修：hit 展示逻辑抽为纯函数 knowledgeHitTitle/knowledgeHitSubtitle（ChatView 消费），
 * 标题兜底链补上 content 摘要一级；占位文案只在 hit 完全无内容时兜底。
 * 本测试在未修复代码上 FAIL（模块不存在/兜底链缺 content），修复后 PASS，永久回归锁。
 */
import { describe, it, expect } from 'vitest'
import { knowledgeHitTitle, knowledgeHitSubtitle } from '../retrieval-hits'

const FALLBACK = '知识库命中'
const t = (key: string) => (key === 'chat.knowledgeHit' ? FALLBACK : key)

describe('BUG-20260711-B：知识库命中卡必须展示真实信息而非占位文案', () => {
  it('★doc_title/source 皆空（合法：无标题文档/旧索引）→ 标题回退 content 摘要，绝不显示占位符', () => {
    const hit = { content: '分数乘法：分子乘分子，分母乘分母，能约分的先约分。', score: 0.82 }
    const title = knowledgeHitTitle(hit, t)
    expect(title).not.toBe(FALLBACK)
    expect(title).toContain('分数乘法')
  })

  it('★content 摘要截断：超长正文标题只取首行且限长（含省略号），不撑爆卡片', () => {
    const long = `第一行知识点${'很长'.repeat(60)}\n第二行不该出现`
    const title = knowledgeHitTitle({ content: long }, t)
    expect(title.length).toBeLessThanOrEqual(61) // 60 字 + …
    expect(title).not.toContain('第二行')
    expect(title.endsWith('…')).toBe(true)
  })

  it('doc_title 存在时优先用 doc_title，content 转入副标题预览', () => {
    const hit = { doc_title: '五年级数学讲义', content: '分数乘法：分子乘分子。', chunk_index: 1, chunk_count: 4 }
    expect(knowledgeHitTitle(hit, t)).toBe('五年级数学讲义')
    expect(knowledgeHitSubtitle(hit, t)).toContain('分数乘法')
  })

  it('doc_title 空、source 存在 → 标题用 source', () => {
    expect(knowledgeHitTitle({ source: 'notes.md', content: 'xx' }, t)).toBe('notes.md')
  })

  it('完全无信息的 hit（异常形态）才落 i18n 占位符', () => {
    expect(knowledgeHitTitle({}, t)).toBe(FALLBACK)
  })
})
