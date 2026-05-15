// 验证模型是否能输出 § 字符 — 直接 ask
const http = require('http')

// TEST 5E-1: 直接问模型输出 §
function testSectionChar() {
  return new Promise((resolve) => {
    const body = {
      message: 'user: 请直接输出一个 "§" 符号（section sign），不要输出其他任何内容',
      session_id: `test-section-${Date.now()}`,
      request_id: `req-${Date.now()}-section`,
      user_id: 'test-user',
    }
    const req = http.request('http://localhost:16060/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        const reply = JSON.parse(data).reply || ''
        const has = reply.includes('§')
        console.log('--- § 字符测试 ---')
        console.log('Reply:', JSON.stringify(reply))
        console.log('Contains §:', has ? 'YES ✅' : 'NO ❌')
        resolve(has)
      })
    })
    req.end(JSON.stringify(body))
  })
}

// TEST 5E-2: 替代格式 — [要点N]
function testFormatYaoDian() {
  return new Promise((resolve) => {
    const INPUT = '《静夜思》李白\n床前明月光，疑是地上霜。举头望明月，低头思故乡。\n创作于726年，李白26岁旅居扬州时。全诗二十字，以月光为引表达思乡之情，被誉为"千古思乡第一诗"。'
    const SYSTEM = `# Role
You are a single-pass extraction engine. Extract key facts. No conversation.

# Format
[要点1] {fact} — {detail}
[要点2] {fact} — {detail}

# Rules
- Every line starts with [要点N]
- NO other text before or after
- NO emoji, NO bold, NO table
- Retain numbers, dates, names`

    const body = {
      message: `user: ${INPUT}\n\nOutput only [要点N] lines. No other text.`,
      system_prompt: SYSTEM,
      session_id: `test-yaodian-${Date.now()}`,
      request_id: `req-${Date.now()}-yd`,
      user_id: 'test-user',
    }
    const req = http.request('http://localhost:16060/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        const reply = JSON.parse(data).reply || ''
        const ydCount = (reply.match(/\[要点\d+\]/g) || []).length
        const hasChat = /让我|我将|请问|🦀|好诗/.test(reply)
        console.log('\n--- [要点N] 格式测试 ---')
        console.log('[要点N] count:', ydCount)
        console.log('Chat behavior:', hasChat ? 'YES ❌' : 'NO ✅')
        console.log('Entity retention:', reply.includes('李白') && reply.includes('726') && reply.includes('扬州') ? '✅' : '❌')
        console.log('Reply:', reply)
        resolve({ ydCount, hasChat })
      })
    })
    req.end(JSON.stringify(body))
  })
}

// TEST 5E-3: 替代格式 — • bullets
function testFormatBullet() {
  return new Promise((resolve) => {
    const INPUT = '《静夜思》李白\n床前明月光，疑是地上霜。举头望明月，低头思故乡。\n创作于726年，李白26岁旅居扬州时。全诗二十字，以月光为引表达思乡之情，被誉为"千古思乡第一诗"。'
    const SYSTEM = `# Role
Single-pass extraction. Key facts only. No conversation.

# Format
• {fact}: {detail}
• {fact}: {detail}

# Rules
- Every line starts with •
- NO text before or after bullet list
- NO emoji, NO bold, NO table`

    const body = {
      message: `user: ${INPUT}\n\nOutput only bullet points (•). No other text.`,
      system_prompt: SYSTEM,
      session_id: `test-bullet-${Date.now()}`,
      request_id: `req-${Date.now()}-bl`,
      user_id: 'test-user',
    }
    const req = http.request('http://localhost:16060/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        const reply = JSON.parse(data).reply || ''
        const bulletCount = (reply.match(/^•/m) ? reply.split('\n').filter(l => l.startsWith('•')).length : 0)
        const hasChat = /让我|我将|请问|🦀|好诗/.test(reply)
        console.log('\n--- • Bullet 格式测试 ---')
        console.log('Bullet count:', bulletCount)
        console.log('Chat behavior:', hasChat ? 'YES ❌' : 'NO ✅')
        console.log('Entity retention:', reply.includes('李白') && reply.includes('726') && reply.includes('扬州') ? '✅' : '❌')
        console.log('Reply:', reply)
        resolve({ bulletCount, hasChat })
      })
    })
    req.end(JSON.stringify(body))
  })
}

async function main() {
  await testSectionChar()
  await testFormatYaoDian()
  await testFormatBullet()
}
main()
