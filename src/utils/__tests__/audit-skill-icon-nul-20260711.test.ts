/**
 * R7 [AP-139] skill-icon.ts 混入真 NUL 字节
 *
 * src/utils/skill-icon.ts 第 73 行 `/[^\x00-\x7f]/` 里本应是 4 字符字面转义 `\x00`，
 * 曾被写成一个真 NUL 字节（0x00），导致 `file` 判该 .ts 为 data、正则语义被破坏。
 *
 * RED（修复前）：文件 buffer 含 0x00 → 断言失败；`file src/utils/skill-icon.ts` 报 data。
 * GREEN（修复后）：文件不含任何 0x00 字节，且正则以 4 字符字面转义 `\x00` 书写。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest root = 仓库根，测试进程 cwd 亦为仓库根
const SKILL_ICON = resolve(process.cwd(), 'src/utils/skill-icon.ts')

describe('R7 skill-icon.ts 不含真 NUL 字节', () => {
  it('源文件 buffer 中没有任何 0x00 字节', () => {
    const buf = readFileSync(SKILL_ICON)
    const nulCount = buf.filter((b) => b === 0x00).length
    expect(nulCount, '源文件不应含真 NUL 字节').toBe(0)
  })

  it('正则以 4 字符字面转义 \\x00 书写（而非真字节）', () => {
    const text = readFileSync(SKILL_ICON, 'utf8')
    // 字面文本必须包含转义序列 \x00 与 \x7f 各自的 4 字符形式
    expect(text.includes('\\x00'), '应含字面 \\x00 转义').toBe(true)
    expect(text.includes('[^\\x00-\\x7f]'), '正则区间应为 [^\\x00-\\x7f]').toBe(true)
  })
})
