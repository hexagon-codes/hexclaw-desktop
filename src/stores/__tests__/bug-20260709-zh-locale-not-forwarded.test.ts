/**
 * BUG-20260709：回答语言必须跟随系统设置语言——包括默认中文。
 *
 * 旧行为：buildChatRequestMetadata 「仅在非默认 zh-CN 时透传 user_locale，减少冗余」——
 * 后端 zh-CN 指令也为空 → 两端双双隐式，英语倾向模型（nemotron omni 等）会直接英文作答
 * （钉钉真图解题轮真机复现）。
 * 新契约：系统语言恒透传（含 zh-CN），后端按白名单拼显式输出语言指令。
 *
 * 断言的是正确行为——未修复时 FAIL 即证明缺口存在。
 */
import { describe, it, expect } from 'vitest'
import { buildChatRequestMetadata } from '../chat-request-metadata'

describe('BUG-20260709 系统语言恒透传（含默认中文）', () => {
  it('★userLocale=zh-CN 也必须透传 user_locale（跟随系统设置语言）', () => {
    const metadata = buildChatRequestMetadata({
      thinkingEnabled: false,
      memoryEnabled: true,
      userLocale: 'zh-CN',
    })
    expect(metadata?.user_locale, 'zh-CN 不透传=后端拿不到系统语言，英语倾向模型漏英文').toBe('zh-CN')
  })

  it('对照：en / ug-CN 透传行为不变', () => {
    expect(buildChatRequestMetadata({ thinkingEnabled: false, memoryEnabled: true, userLocale: 'en' })?.user_locale).toBe('en')
    expect(buildChatRequestMetadata({ thinkingEnabled: false, memoryEnabled: true, userLocale: 'ug-CN' })?.user_locale).toBe('ug-CN')
  })

  it('对照：未设置 userLocale → 不透传（向后兼容）', () => {
    const metadata = buildChatRequestMetadata({ thinkingEnabled: false, memoryEnabled: true })
    expect(metadata?.user_locale).toBeUndefined()
  })
})
