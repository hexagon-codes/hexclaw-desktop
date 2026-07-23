import { describe, it, expect } from 'vitest'
import { stripComments } from './ap1StripComments'

/**
 * BUG-5：AP-1 守门的 stripComments 旧实现用 `//` 正则一刀切，不认字符串字面量，
 * 把 `const s='//错题'` 里以 `//` 开头的串内容当注释剥掉 → 真实硬编码 K12 词逃过守门（假绿）。
 * 修复后：字符串字面量内容完整保留，真注释照常剥除。
 */
describe('BUG-5 AP-1 stripComments 感知字符串字面量', () => {
  it('字符串里以 // 开头的 K12 词不被误剥（此前假绿）', () => {
    const out = stripComments(`const s = '//错题'`)
    expect(out).toContain('错题')
  })

  it('真正的行注释里的 K12 词照常剥除', () => {
    const out = stripComments(`const x = 1 // 错题 说明`)
    expect(out).not.toContain('错题')
  })

  it('块注释 / Vue 注释里的 K12 词照常剥除', () => {
    const retiredTerm = ['备', '课'].join('')
    expect(stripComments(`/* ${retiredTerm} */ const y = 2`)).not.toContain(retiredTerm)
    expect(stripComments(`<!-- 辅导 --><div/>`)).not.toContain('辅导')
  })

  it('http:// 等协议串保留，行尾真注释剥除', () => {
    const out = stripComments(`const u = 'http://a/错题' // 学情 尾注`)
    expect(out).toContain('错题') // 串内容保留
    expect(out).not.toContain('学情') // 尾注剥除
  })

  it('双引号 / 反引号字符串同样保留', () => {
    expect(stripComments(`const a = "//识题"`)).toContain('识题')
    expect(stripComments('const b = `//tutor`')).toContain('tutor')
  })
})
