const INPUT = '2025年华为HDC开发者大会上，任正非宣布鸿蒙操作系统装机量突破12亿台，覆盖8大品类。'
const TS = Date.now().toString()

const SYSTEM_PROMPT = `[MODE: DIRECT]
Output directly. No planning. No tool calls.

# 摘要
来源：ClawHub 热门技能 摘要
帮助用户用 摘要 类 CLI/服务`

const USER_MSG = `${INPUT}

[MODE: DIRECT]
Output directly. No tool calls. No search. Output immediately.`

const body = {
  message: USER_MSG,
  system_prompt: SYSTEM_PROMPT,
  session_id: `fix-test-${TS}`,
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
    console.log('=== TEST 2: 修复路径结果 ===')
    console.log('Status:', res.statusCode)
    console.log('Response length:', data.length)
    console.log('Contains ClawHub/热门技能:', data.includes('ClawHub') || data.includes('热门技能') ? 'YES ❌' : 'NO ✅')
    console.log('Contains planning:', /计划|步骤|首先|然后|第一步/.test(data) ? 'YES ❌' : 'NO ✅')
    console.log('--- Response ---')
    console.log(data.slice(0, 800))
    console.log('--- END ---')
  })
})
req.end(JSON.stringify(body))
