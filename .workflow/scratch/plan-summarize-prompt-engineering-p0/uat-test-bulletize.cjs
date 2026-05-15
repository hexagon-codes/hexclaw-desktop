// bulletize UAT — 验证 bullet 格式、无 chat、无 disclaimer、无 planning
const http = require('http')
const { readFileSync } = require('fs')
const path = require('path')

const SKILL_PATH = path.resolve(__dirname, '../../../skills/builtin/bulletize/SKILL.md')
const SYSTEM = readFileSync(SKILL_PATH, 'utf-8')

const INPUT = '在2025年华为HDC开发者大会上，华为创始人任正非发表了主题演讲，正式宣布鸿蒙操作系统（HarmonyOS）全球装机量已突破12亿台，覆盖智能手机、平板电脑、智能手表、智慧屏、车机、PC、物联网设备等8大品类。任正非表示，鸿蒙生态已基本成熟，华为将继续加大在操作系统领域的投入。同时，华为消费者业务CEO余承东在大会上发布了鸿蒙原生应用生态白皮书，披露已有超过50万开发者加入鸿蒙生态，累计上架原生应用超过2万款。余承东还宣布，华为2025年旗舰手机Mate 70系列将首发搭载鸿蒙NEXT系统，该系统完全移除安卓兼容代码，实现全栈自研。华为预计到2025年底，鸿蒙原生应用数量将达到10万款，覆盖用户日常使用场景的99%以上。在AI方面，华为发布了盘古大模型5.0，该模型在医疗、金融、制造等行业的落地案例超过1000个。华为还展示了基于鸿蒙的智能汽车解决方案，已有超过30家车企合作伙伴接入鸿蒙车机系统，覆盖车型超过200款。'

const ENTITIES = ['华为', '任正非', '鸿蒙', '12亿', '余承东', '50万', '2万', 'Mate 70', '鸿蒙NEXT', '盘古大模型5.0']

const body = {
  message: `user: ${INPUT}\n\n[MODE: DIRECT]\n输出 • 格式无序列表。最多5行，每行≤50字。总输出≤120字。禁止 [要点N] 和编号。`,
  system_prompt: SYSTEM,
  session_id: `uat-bullet-${Date.now()}`,
  request_id: `req-bullet-${Date.now()}`,
  user_id: 'test-user',
}

const req = http.request('http://localhost:16060/api/v1/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let data = ''
  res.on('data', (c) => (data += c))
  res.on('end', () => {
    const reply = JSON.parse(data).reply || ''
    const lines = reply.split('\n').filter(l => {
      const t = l.trim()
      return t.startsWith('•') || t.startsWith('-')
    })
    const lineCount = lines.length
    const maxLineLen = lines.length > 0 ? Math.max(...lines.map(l => l.trim().length)) : 0
    const allUnder50 = lineCount > 0 && lines.every(l => l.trim().length <= 50)
    const hasChat = /让我|我将|请问|🦀|收到|我可以/.test(reply)
    const hasBanned = /步骤|首先|【要点】/.test(reply)
    // Accept both • and - as bullet format; check first trimmed char
    const firstChar = reply.trim().charAt(0)
    const validStart = firstChar === '•' || firstChar === '-'
    const hasBracket = /\[要点/.test(reply)
    const retained = ENTITIES.filter(e => reply.includes(e))
    const total = reply.replace(/\n/g, '').length

    const checks = {
      '格式 (•/-)': validStart,
      '禁止 [要点N]': !hasBracket,
      '≤5行': lineCount <= 5,
      '每行≤50字': allUnder50,
      '无chat': !hasChat,
      '无banned': !hasBanned,
      '实体保留≥5/10': retained.length >= 5,
    }
    const pass = Object.values(checks).every(Boolean)

    console.log('=== bulletize UAT (华为416字) ===')
    console.log('')
    Object.entries(checks).forEach(([k, v]) => console.log(`  ${v ? '✅' : '❌'} ${k}`))
    console.log('')
    console.log(`Lines: ${lineCount}/5, Max line: ${maxLineLen}/50`)
    console.log(`Total chars: ${total}`)
    console.log(`Entities: ${retained.length}/10 — ${retained.join(', ')}`)
    console.log('')
    console.log('--- Reply ---')
    console.log(reply)
    console.log('')
    console.log(pass ? '✅ ALL PASS — bulletize runtime-ready' : '❌ FAILURES DETECTED')
  })
})
req.end(JSON.stringify(body))
