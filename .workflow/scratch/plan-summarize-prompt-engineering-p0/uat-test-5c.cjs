const INPUT = '在2026年Q1季度财报电话会议上，特斯拉CEO马斯克宣布特斯拉全球交付量达到89.4万辆，同比增长32%。其中Model Y贡献了62.4万辆，占总交付量的69.8%。储能业务方面，Megapack装机量达到11.2GWh，同比增长156%。FSD（完全自动驾驶）累计行驶里程突破45亿英里。公司预计Q2交付量将突破95万辆。'
const TS = Date.now().toString()

const SYSTEM_PROMPT = `# Role

You are a single-pass extraction engine. The user provides SOURCE TEXT. Your only job: extract key facts and format as compact [§N] summary.

You do NOT verify facts. You do NOT add commentary. You do NOT reason about the content. You do NOT ask questions.

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
| Chat interaction | 请问你需要, 我可以帮你, 任何问句 |
| Greetings | 收到, 好的, 你好 |

Output ONLY [§N] lines. No table. No markdown. No emoji. No greeting. No Q&A.

---

# Output Format — STRICT

[§1] {fact} — {detail}
[§2] {fact} — {detail}
[§3] {fact} — {detail}

MANDATORY rules (violation = FAILURE):
- Every line MUST start with [§
- NO Markdown tables
- NO headings or bold text
- NO empty lines between entries
- NO introductory or concluding text
- Total output ≤ 30% of input length
- Retain ALL numbers, dates, names, organizations, quantitative claims
- Every claim MUST be traceable to original

---

# Example

Input: 2026年Q1特斯拉财报：全球交付89.4万辆(+32%)，Model Y交付62.4万辆(占69.8%)，Megapack装机11.2GWh(+156%)，FSD累计45亿英里。预期Q2交付95万辆+。
Output:
[§1] 特斯拉 2026 Q1 全球交付 89.4 万辆 — 同比增长 32%
[§2] Model Y 交付 62.4 万辆 — 占总交付 69.8%
[§3] Megapack 装机 11.2 GWh — 同比增长 156%
[§4] FSD 累计行驶 45 亿英里
[§5] Q2 交付预期 95 万辆以上`

const MESSAGE = `user: ${INPUT}

[MODE: DIRECT]
Output directly. No tool calls. No search. Output immediately.`

const body = {
  message: MESSAGE,
  system_prompt: SYSTEM_PROMPT,
  session_id: `uat-test-5c-${TS}`,
  request_id: `req-${TS}-c`,
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

    const snCount = (reply.match(/\[§/g) || []).length
    const hasDisclaimers = /我无法确认|需要注意的是|I cannot verify|知识截止|没有.*可靠/.test(reply)
    const hasMetaCommentary = /基于原文|根据以上内容|如上所述/.test(reply)
    const hasPlanning = /步骤|首先|然后|第一步|第二步/.test(reply)
    const hasToolSuggestion = /你可以搜索|建议查阅|工具/.test(reply)
    const hasSelfNarration = /让我|我将|我需要|我来为你/.test(reply)
    const hasExplanatoryPrefix = /以下是摘要|提取要点如下/.test(reply)
    const hasChatInteraction = /请问你需要|我可以帮你/.test(reply)
    const hasGreeting = /^收到|^好的/.test(reply)
    const hasTable = /\|.+\|.+\|/.test(reply)
    const hasBold = /\*\*/.test(reply)
    const hasEmoji = /[🦀📊📈📉📝💬🔍]/u.test(reply)
    const hasIntroText = /^[^\[§]+\n/.test(reply)

    const entities = ['特斯拉', '马斯克', '89.4万', '62.4万', 'Model Y', 'Megapack', '11.2GWh', 'FSD', '45亿']
    const retained = entities.filter(e => reply.includes(e))
    const lengthRatio = ((reply.length / INPUT.length) * 100).toFixed(1)

    console.log('=== TEST 5C: SKILL.md v2 — 更强格式约束 ===')
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
    console.log('Chat interaction:', hasChatInteraction ? 'YES ❌' : 'NO ✅')
    console.log('Greeting:', hasGreeting ? 'YES ❌' : 'NO ✅')
    console.log('')
    console.log('--- 格式合规 ---')
    console.log('Markdown table:', hasTable ? 'YES ❌' : 'NO ✅')
    console.log('Bold text:', hasBold ? 'YES ❌' : 'NO ✅')
    console.log('Emoji:', hasEmoji ? 'YES ❌' : 'NO ✅')
    console.log('Intro text:', hasIntroText ? 'YES ❌' : 'NO ✅')
    console.log('')
    console.log('Entity retention:', `${retained.length}/${entities.length}`)
    console.log('Retained:', retained.join(', ') || 'NONE')
    console.log('Missing:', entities.filter(e => !reply.includes(e)).join(', ') || 'NONE')
    console.log('')
    console.log('Response length:', reply.length)
    console.log('Input length:', INPUT.length)
    console.log('Length ratio:', lengthRatio + '%', parseFloat(lengthRatio) <= 30 ? '✅' : '❌')
    console.log('')
    console.log('--- Reply (full) ---')
    console.log(reply)
    console.log('')
    console.log('--- VERDICT ---')
    const pass = snCount > 0 && !hasDisclaimers && !hasPlanning && !hasSelfNarration && !hasChatInteraction && !hasTable && parseFloat(lengthRatio) <= 30
    console.log(pass ? '✅ ALL PASS' : '❌ FAILURES DETECTED')
    if (!pass) {
      if (snCount === 0) console.log('  - [§N] count = 0')
      if (hasDisclaimers) console.log('  - Has disclaimers')
      if (hasPlanning) console.log('  - Has planning')
      if (hasSelfNarration) console.log('  - Has self-narration')
      if (hasChatInteraction) console.log('  - Has chat interaction')
      if (hasTable) console.log('  - Markdown table used')
      if (parseFloat(lengthRatio) > 30) console.log('  - Length ratio too high')
    }
  })
})
req.end(JSON.stringify(body))
