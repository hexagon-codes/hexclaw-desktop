// 全新输入：中文古诗分析，与之前所有输入无任何重叠内容
const INPUT = '《静夜思》李白\n床前明月光，疑是地上霜。举头望明月，低头思故乡。\n\n这首诗创作于唐玄宗开元十四年（726年），当时李白26岁，旅居于扬州旅舍。全诗四句二十字，以月光为引，通过"举头""低头"两个动作，表达了游子的思乡之情。艺术特色在于语言质朴自然，意境深远，被后世誉为"千古思乡第一诗"。'
const TS = Date.now().toString()

const SYSTEM_PROMPT = `# Role

You are a single-pass extraction engine. The user provides SOURCE TEXT. Your only job: extract key facts and format as compact [§N] summary.

You do NOT verify facts. You do NOT add commentary. You do NOT reason about the content. You do NOT ask questions.

模型只负责 extraction，不负责 truth judgment。

---

# Banned

Output ONLY [§N] lines. No table. No markdown. No emoji. No greeting. No Q&A. No introductory sentences.

---

# Output Format — STRICT

[§1] {fact} — {detail}
[§2] {fact} — {detail}

MANDATORY:
- Every line MUST start with [§
- NO tables, NO bold, NO headings
- NO empty lines between entries
- NO text before or after [§N] block
- Total output ≤ 30% of input
- Retain ALL numbers, dates, names

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
  session_id: `uat-test-5d-${TS}`,
  request_id: `req-${TS}-d`,
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
    const hasBanned = /我无法确认|需要.*注意|让我|我将|我需要|请问|步骤|首先|\|.*\|.*\||\*\*|收到/.test(reply)
    const hasIntro = /^[^§\[]/.test(reply)
    const hasExtra = /\n\n\n/.test(reply) || /^$/.test(reply)

    const entities = ['李白', '静夜思', '726', '26岁', '扬州', '二十字', '思乡']
    const retained = entities.filter(e => reply.includes(e))
    const lengthRatio = ((reply.length / INPUT.length) * 100).toFixed(1)

    console.log('=== TEST 5D: 全新输入（古诗）绕过缓存 ===')
    console.log('Status:', res.statusCode)
    console.log('')
    console.log('[§N] count:', snCount, snCount > 0 ? '✅' : '❌')
    console.log('Banned content:', hasBanned ? 'YES ❌' : 'NO ✅')
    console.log('Has intro text:', hasIntro ? 'YES ❌' : 'NO ✅')
    console.log('Entity retention:', `${retained.length}/${entities.length}`)
    console.log('Retained:', retained.join(', ') || 'NONE')
    console.log('Missing:', entities.filter(e => !reply.includes(e)).join(', ') || 'NONE')
    console.log('Length ratio:', lengthRatio + '%', parseFloat(lengthRatio) <= 30 ? '✅' : '❌')
    console.log('Input tokens:', usage.input_tokens)
    console.log('Output tokens:', usage.output_tokens)
    console.log('')
    console.log('--- Reply (full) ---')
    console.log(reply)
    console.log('')
    const pass = snCount > 0 && !hasBanned && !hasIntro && parseFloat(lengthRatio) <= 30
    console.log('--- VERDICT ---')
    console.log(pass ? '✅ ALL PASS' : '❌ FAILURES DETECTED')
    if (!pass) {
      if (snCount === 0) console.log('  - [§N] = 0 (model refuses § character?)')
      if (hasBanned) console.log('  - Banned content detected')
      if (hasIntro) console.log('  - Has intro text before [§N]')
      if (parseFloat(lengthRatio) > 30) console.log('  - Length ratio too high')
    }
  })
})
req.end(JSON.stringify(body))
