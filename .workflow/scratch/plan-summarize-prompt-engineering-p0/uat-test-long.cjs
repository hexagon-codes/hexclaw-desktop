// 长输入测试：525 字 → 验证长度比例 ≤ 30%
const http = require('http')

const SYSTEM = `# Role

You are a single-pass extraction engine. Extract key facts. No conversation. No verification.

模型只负责 extraction，不负责 truth judgment。

---

# Format — STRICT

[要点1] {fact} — {detail}
[要点2] {fact} — {detail}

# Rules

- Every major claim → its own [要点N] line
- Total output ≤ 30% of input length
- BE CONCISE: each [要点N] line ≤ 60 chars
- Retain ALL numbers, dates, names, organizations

# Banned

Disclaimers | Commentary | Reasoning | Self-narration | Chat | Emoji | Bold/Table | Greeting

Output ONLY [要点N] lines. Nothing else.

# Example

Input: 2026年Q1特斯拉财报：全球交付89.4万辆(+32%)，Model Y交付62.4万辆(占69.8%)，Megapack装机11.2GWh(+156%)，FSD累计45亿英里。预期Q2交付95万辆+。
Output:
[要点1] 特斯拉 2026 Q1 全球交付 89.4 万辆 — 同比增长 32%
[要点2] Model Y 交付 62.4 万辆 — 占总交付 69.8%
[要点3] Megapack 装机 11.2 GWh — 同比增长 156%
[要点4] FSD 累计行驶 45 亿英里
[要点5] Q2 交付预期 95 万辆以上`

const INPUT = '在2025年华为HDC开发者大会上，华为创始人任正非发表了主题演讲，正式宣布鸿蒙操作系统（HarmonyOS）全球装机量已突破12亿台，覆盖智能手机、平板电脑、智能手表、智慧屏、车机、PC、物联网设备等8大品类。任正非表示，鸿蒙生态已基本成熟，华为将继续加大在操作系统领域的投入。同时，华为消费者业务CEO余承东在大会上发布了鸿蒙原生应用生态白皮书，披露已有超过50万开发者加入鸿蒙生态，累计上架原生应用超过2万款。余承东还宣布，华为2025年旗舰手机Mate 70系列将首发搭载鸿蒙NEXT系统，该系统完全移除安卓兼容代码，实现全栈自研。华为预计到2025年底，鸿蒙原生应用数量将达到10万款，覆盖用户日常使用场景的99%以上。在AI方面，华为发布了盘古大模型5.0，该模型在医疗、金融、制造等行业的落地案例超过1000个。华为还展示了基于鸿蒙的智能汽车解决方案，已有超过30家车企合作伙伴接入鸿蒙车机系统，覆盖车型超过200款。'

const body = {
  message: `user: ${INPUT}\n\n[MODE: DIRECT]\nOutput only [要点N] lines. Be concise.`,
  system_prompt: SYSTEM,
  session_id: `test-long-${Date.now()}`,
  request_id: `req-${Date.now()}-long`,
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
    const hasChat = /让我|我将|请问|🦀|收到|我可以/.test(reply)
    const hasBanned = /我无法确认|需要.*注意|步骤|首先|然后|\*\*/.test(reply)
    const hasIntro = /^[^\[要点]/.test(reply)
    const entities = ['华为', '任正非', '鸿蒙', '12亿', '8大', '50万', '2万', 'Mate 70', '鸿蒙NEXT', '盘古大模型5.0', '30家', '200款']
    const retained = entities.filter(e => reply.includes(e))
    const ratio = ((reply.length / INPUT.length) * 100).toFixed(1)

    console.log('=== 长输入测试 (525字) ===')
    console.log('')
    console.log('[要点N] count:', ydCount, ydCount > 0 ? '✅' : '❌')
    console.log('Chat behavior:', hasChat ? 'YES ❌' : 'NO ✅')
    console.log('Banned content:', hasBanned ? 'YES ❌' : 'NO ✅')
    console.log('Intro text:', hasIntro ? 'YES ❌' : 'NO ✅')
    console.log('')
    console.log(`Entity retention: ${retained.length}/${entities.length}`)
    console.log('Retained:', retained.join(', ') || 'NONE')
    console.log('Missing:', entities.filter(e => !reply.includes(e)).join(', ') || 'NONE')
    console.log('')
    console.log('Input length:', INPUT.length)
    console.log('Response length:', reply.length)
    console.log('30% threshold:', Math.floor(INPUT.length * 0.3))
    console.log('Length ratio:', ratio + '%', parseFloat(ratio) <= 30 ? '✅' : '❌')
    console.log('')
    console.log('--- Reply ---')
    console.log(reply)
    console.log('')
    const pass = ydCount > 0 && !hasChat && !hasBanned && parseFloat(ratio) <= 30
    console.log(pass ? '✅ ALL PASS — skill-runtime-p0-usable = true' : '❌ FAILURES DETECTED')
  })
})
req.end(JSON.stringify(body))
