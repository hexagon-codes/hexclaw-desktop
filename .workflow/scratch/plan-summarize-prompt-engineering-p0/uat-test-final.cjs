// 最终验证：更新后 SKILL.md ([要点N] 格式)
// 测试两种完全不同类型的输入：古诗 + 科技新闻
const http = require('http')

// 读取最新 SKILL.md 内容作为 systemPrompt
// 使用内联方式以保持测试独立
const SYSTEM = `# Role

You are a single-pass extraction engine. The user provides SOURCE TEXT. Extract key facts. No conversation. No verification.

模型只负责 extraction，不负责 truth judgment。

---

# Format — STRICT

[要点1] {fact} — {detail}
[要点2] {fact} — {detail}
[要点3] {fact} — {detail}

# Rules

- Every major claim → its own [要点N] line
- Total output ≤ 30% of input length
- Retain ALL numbers, dates, names, organizations
- No claim absent from original

# Banned

Disclaimers | Meta commentary | Reasoning chains | Self-narration | Chat interaction | Emoji | Bold/Table | Greeting

Output ONLY [要点N] lines. Nothing else.`

function test(name, input, entities) {
  return new Promise((resolve) => {
    const body = {
      message: `user: ${input}\n\n[MODE: DIRECT]\nOutput only [要点N] lines.`,
      system_prompt: SYSTEM,
      session_id: `test-final-${name}-${Date.now()}`,
      request_id: `req-${Date.now()}-${name}`,
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
        const hasChat = /让我|我将|请问|🦀|好诗|收到|我可以帮你/.test(reply)
        const hasBanned = /我无法确认|需要.*注意|步骤|首先|然后|\|.*\|.*\||\*\*/.test(reply)
        const hasIntro = /^[^\[要点]/.test(reply)
        const retained = entities.filter(e => reply.includes(e))
        const ratio = ((reply.length / input.length) * 100).toFixed(1)

        console.log(`\n=== ${name} ===`)
        console.log('[要点N] count:', ydCount, ydCount > 0 ? '✅' : '❌')
        console.log('Chat behavior:', hasChat ? 'YES ❌' : 'NO ✅')
        console.log('Banned content:', hasBanned ? 'YES ❌' : 'NO ✅')
        console.log('Intro text:', hasIntro ? 'YES ❌' : 'NO ✅')
        console.log(`Entity retention: ${retained.length}/${entities.length} ${retained.join(', ')}`)
        console.log(`Length ratio: ${ratio}%`, parseFloat(ratio) <= 30 ? '✅' : '❌')
        console.log('--- Reply ---')
        console.log(reply)
        resolve({ ydCount, hasChat, hasBanned, ratio })
      })
    })
    req.end(JSON.stringify(body))
  })
}

async function main() {
  console.log('=== 最终验证：[要点N] 格式 ===')
  console.log('验证 SKILL.md 重写效果 — 多输入类型')

  await test('古诗《静夜思》', '《静夜思》李白\n床前明月光，疑是地上霜。举头望明月，低头思故乡。\n创作于726年，李白26岁旅居扬州时。全诗二十字，以月光为引表达思乡之情，被誉为"千古思乡第一诗"。',
    ['李白', '726', '26岁', '扬州', '二十字', '思乡'])

  await test('特斯拉财报', '在2026年Q1季度财报电话会议上，特斯拉CEO马斯克宣布特斯拉全球交付量达到89.4万辆，同比增长32%。其中Model Y贡献了62.4万辆。Megapack装机量达到11.2GWh，同比增长156%。FSD累计行驶里程突破45亿英里。',
    ['特斯拉', '89.4万', '62.4万', 'Megapack', '11.2GWh', 'FSD', '45亿'])

  await test('华为鸿蒙', '2025年华为HDC开发者大会上，任正非宣布鸿蒙操作系统装机量突破12亿台，覆盖8大品类。华为同时发布了鸿蒙原生应用生态白皮书，指出已有超过50万开发者加入鸿蒙生态。',
    ['华为', '鸿蒙', '12亿', '8大', '50万', '任正非'])

  console.log('\n=== 验证结束 ===')
}
main()
