/**
 * hex-test 审计 · AP-027 sweep 回归锁：穷举所有 .vue 的 @keydown.enter，每处都必须 IME 守卫。
 *
 * 根因：R6 只修了 SearchInput 单个输入框，反模式检测配方穷举后发现 SkillCreateDialog/SkillsView
 * 另有 2 个未守卫的回车输入框——「sweep 边界=注意力边界」。此测试把检测配方固化为回归锁：
 * 任何 @keydown.enter 的 handler 若在 <script> 里没有 isComposing/keyCode===229 守卫、也不在
 * 白名单，即 FAIL。新增未守卫回车框会自动被挡（粒度匹配：穷举每一处，非文件级计数）。
 *
 * 守卫合格 = handler 函数体含 `isComposing` 或 `keyCode === 229`；或 template 里带
 * `.meta`/`.ctrl`/`.shift` 修饰（组合键非纯回车，IME 不冲突）；或在白名单。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../../..')

// 白名单：确证无需 IME 守卫的纯回车用法（附理由）。仅限「非文本输入控件」——ARIA
// switch/button 等 Enter 激活是 a11y 标准，无输入法参与，不存在组字冲突。
const WHITELIST: { file: string; expr: string; reason: string }[] = [
  {
    file: 'components/settings/ModelManagerModal.vue',
    expr: 'toggleModel(m)',
    reason: 'role="switch" ARIA 开关行（非文本输入），Enter/Space 激活是标准键盘 a11y，无 IME',
  },
]

function walkVue(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkVue(p, acc)
    else if (name.endsWith('.vue')) acc.push(p)
  }
  return acc
}

// 从 @keydown.enter[.mods]="handlerOrExpr" 抽取修饰符 + handler 表达式。
const ENTER_RE = /@keydown\.enter((?:\.[a-z]+)*)\s*=\s*"([^"]+)"/g

describe('AP-027 sweep · 所有 @keydown.enter 必须 IME 守卫', () => {
  it('穷举全仓 .vue，每个纯回车 handler 都有 isComposing/keyCode 守卫或白名单', () => {
    const files = walkVue(SRC)
    const violations: string[] = []

    for (const file of files) {
      const rel = file.slice(SRC.length + 1)
      const src = readFileSync(file, 'utf8')
      let m: RegExpExecArray | null
      ENTER_RE.lastIndex = 0
      while ((m = ENTER_RE.exec(src))) {
        const mods = m[1] ?? ''
        const expr = (m[2] ?? '').trim()
        // 组合键（meta/ctrl/shift/alt）非纯回车，IME 不冲突 → 放行。
        if (/\.(meta|ctrl|shift|alt)\b/.test(mods)) continue
        // 内联表达式含 isComposing → 已守卫。
        if (/isComposing|keyCode\s*===?\s*229|shouldSendOnEnter|composing/.test(expr)) continue
        // handler 名（形如 onXxx / handleXxx）→ 到 <script> 找其函数体是否含守卫。
        const fnName = expr.replace(/\(.*$/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(fnName)) {
          const fnRe = new RegExp(
            `function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}|const\\s+${fnName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\}`,
          )
          const fm = src.match(fnRe)
          const body = fm ? (fm[1] ?? fm[2] ?? '') : ''
          if (/isComposing|keyCode\s*===?\s*229|shouldSendOnEnter|composing/.test(body)) continue
        }
        if (WHITELIST.some((w) => rel.includes(w.file) && expr.includes(w.expr))) continue
        violations.push(`${rel}: @keydown.enter${mods}="${expr}" 无 IME 守卫`)
      }
    }

    expect(violations, `未守卫的回车输入框（AP-027）：\n${violations.join('\n')}`).toEqual([])
  })
})
