const INPUT = '2025年华为HDC开发者大会上，任正非宣布鸿蒙操作系统装机量突破12亿台，覆盖8大品类。'
const TS = Date.now().toString()

// === TEST 3: 实际 skill 路径 payload ===
// agentAdapter.executeWithContext → buildPromptInput → providerAdapter
// 结果: system_prompt 不传，SKILL.md + MODE:DIRECT 嵌入 message 字符串
const SKILL_MD_SANITIZED = `[MODE: DIRECT]
Output directly. No planning. No tool calls.

# 摘要
来源：ClawHub 热门技能 摘要
帮助用户用 摘要 类 CLI/服务

这个技能帮助用户对内容进行结构化摘要输出。针对用户的输入原文进行关键信息摘要提取，生成结构的摘要文本。这是一个 DIRECT 模式指令。不要调用任何工具。不要搜索。不要联网。不要推理。`

const MESSAGE = `system: ${SKILL_MD_SANITIZED}

user: ${INPUT}

[MODE: DIRECT]
Output directly. No tool calls. No search. Output immediately.`

const body = {
  message: MESSAGE,
  session_id: `skill-path-test-${TS}`,
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
    const snCount = (reply.match(/\[§N\]/g) || []).length
    const hasPlanning = /计划|步骤|首先|然后|第一步|第二步/.test(reply)
    const hasToolCall = /工具|tool|search|summarize/.test(reply)
    const hasSelfNarration = /让我|我将|我会|我需要/.test(reply)

    console.log('=== TEST 3: 实际 Skill 路径 payload ===')
    console.log('Status:', res.statusCode)
    console.log('')
    console.log('--- 核心指标 ---')
    console.log('[§N] count:', snCount)
    console.log('Contains planning:', hasPlanning ? 'YES ❌' : 'NO ✅')
    console.log('Contains tool-call:', hasToolCall ? 'YES ❌' : 'NO ✅')
    console.log('Contains self-narration:', hasSelfNarration ? 'YES ⚠️' : 'NO ✅')
    console.log('Response length:', reply.length)
    console.log('Length ratio:', ((reply.length / INPUT.length) * 100).toFixed(1) + '%')
    console.log('Input tokens:', usage.input_tokens)
    console.log('Output tokens:', usage.output_tokens)
    console.log('')
    console.log('--- Reply (first 500) ---')
    console.log(reply.slice(0, 500))
    console.log('')
    console.log('--- Reply (full) ---')
    console.log(reply)
  })
})
req.end(JSON.stringify(body))
