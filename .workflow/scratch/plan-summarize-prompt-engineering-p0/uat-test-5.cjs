const INPUT = '2025年华为HDC开发者大会上，任正非宣布鸿蒙操作系统装机量突破12亿台，覆盖8大品类。'
const TS = Date.now().toString()

// 使用重写后的 SKILL.md 内容
const SYSTEM_PROMPT = `# Role

You are a single-pass extraction engine. The user provides SOURCE TEXT. Your only job: extract key facts and format as compact [§N] summary.

You do NOT verify facts. You do NOT add commentary. You do NOT reason about the content.

模型只负责 extraction，不负责 truth judgment。

---

# Banned

| Category | Examples |
|----------|----------|
| Disclaimers | 我无法确认, 需要注意的是, I cannot verify this |
| Meta commentary | 基于原文, 根据以上内容, 如上所述 |
| Reasoning chains | 首先, 然后, 第一步, 第二步 |
| Tool suggestions | 你可以搜索, 建议查阅, 你可以用工具 |
| Self-narration | 让我, 我将, 我需要, 我来为你 |
| Explanatory prefixes | 以下是摘要, 提取要点如下 |

No introductory or concluding sentences — output [§N] directly.

---

# Output Format

[§1] {fact} — {detail}
[§2] {fact} — {detail}
[§3] {fact} — {detail}

Rules:
- Every major claim → its own [§N] line
- Total output ≤ 30% of input length
- Retain ALL numbers, dates, names, organizations, quantitative claims
- No claim absent from original

---

# Example

Input: 2025年华为HDC开发者大会上，任正非宣布鸿蒙操作系统装机量突破12亿台，覆盖8大品类。
Output:
[§1] 华为 HDC 2025：鸿蒙装机量突破 12 亿台
[§2] 覆盖 8 大品类`

const MESSAGE = `user: ${INPUT}

[MODE: DIRECT]
Output directly. No tool calls. No search. Output immediately.`

const body = {
  message: MESSAGE,
  system_prompt: SYSTEM_PROMPT,
  session_id: `uat-test-5-${TS}`,
  request_id: `req-${TS}`,
  user_id: 'test-user',
}

const http = require('http')
const req = http.request('http://localhost:16060/api/v1/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let data = ''
  res.on('data', (c) => (data += c))
  res.on('end', () => {
    const parsed = JSON.parse(data)
    const reply = parsed.reply || ''
    const usage = parsed.usage || {}

    // === 核心指标 ===
    const snCount = (reply.match(/\[§N\]/g) || []).length

    // Disclaimer
    const hasDisclaimers = /我无法确认|需要注意的是|I cannot verify/.test(reply)
    // Meta commentary
    const hasMetaCommentary = /基于原文|根据以上内容|如上所述/.test(reply)
    // Reasoning/planning
    const hasPlanning = /步骤|首先|然后|第一步|第二步/.test(reply)
    // Tool suggestion
    const hasToolSuggestion = /你可以搜索|建议查阅|工具/.test(reply)
    // Self-narration
    const hasSelfNarration = /让我|我将|我需要|我来为你/.test(reply)
    // Explanatory prefix
    const hasExplanatoryPrefix = /以下是摘要|提取要点如下/.test(reply)
    // Intro sentence (any 以上|下面是|has intro text before [§)
    const hasIntroText = /^[^\[§\]]+\n/.test(reply)

    // Entity retention
    const entities = ['华为', '鸿蒙', '12亿', '任正非']
    const retained = entities.filter(e => reply.includes(e))

    // Length ratio
    const lengthRatio = ((reply.length / INPUT.length) * 100).toFixed(1)

    console.log('=== TEST 5: 重写后 SKILL.md 验证 ===')
    console.log('Status:', res.statusCode)
    console.log('')
    console.log('--- 核心指标 ---')
    console.log('[§N] count:', snCount, snCount > 0 ? '✅' : '❌')
    console.log('Disclaimers:', hasDisclaimers ? 'YES ❌' : 'NO ✅')
    console.log('Meta commentary:', hasMetaCommentary ? 'YES ❌' : 'NO ✅')
    console.log('Planning:', hasPlanning ? 'YES ❌' : 'NO ✅')
    console.log('Tool suggestion:', hasToolSuggestion ? 'YES ❌' : 'NO ✅')
    console.log('Self-narration:', hasSelfNarration ? 'YES ❌' : 'NO ✅')
    console.log('Explanatory prefix:', hasExplanatoryPrefix ? 'YES ❌' : 'NO ✅')
    console.log('Has intro text:', hasIntroText ? 'YES ⚠️' : 'NO ✅')
    console.log('')
    console.log('Entity retention:', `${retained.length}/${entities.length}`)
    console.log('Retained:', retained.length > 0 ? retained.join(', ') : 'NONE')
    console.log('Missing:', entities.filter(e => !reply.includes(e)).join(', ') || 'NONE')
    console.log('')
    console.log('Response length:', reply.length)
    console.log('Input length:', INPUT.length)
    console.log('Length ratio:', lengthRatio + '%', parseFloat(lengthRatio) <= 30 ? '✅' : '❌')
    console.log('Input tokens:', usage.input_tokens)
    console.log('Output tokens:', usage.output_tokens)
    console.log('')
    console.log('--- Reply (full) ---')
    console.log(reply)
    console.log('')
    console.log('--- REPLY ANALYSIS ---')
    if (snCount > 0 && !hasDisclaimers && !hasPlanning && !hasSelfNarration && parseFloat(lengthRatio) <= 30) {
      console.log('STATUS: ✅ ALL PASS')
    } else {
      console.log('STATUS: ❌ FAILURES DETECTED')
    }
  })
})
req.end(JSON.stringify(body))
