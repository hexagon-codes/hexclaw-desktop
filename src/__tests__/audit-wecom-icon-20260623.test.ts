import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// AUDIT 2026-06-23：企业微信/微信公众号/Telegram 用官方图标。
// 真相：telegram.svg / wechat.svg 已是官方 Simple Icons 字形；但 wecom.svg 与 wechat.svg 字节相同
// （title 都是 WeChat）→ 企业微信显示成了微信的图标。改用官方 企业微信(WeCom) 标。
// 用 cwd 相对路径读取（vitest root = 仓库根）。
const read = (f: string) => readFileSync(resolve(process.cwd(), 'src/assets/im-logos', f), 'utf8')

describe('AUDIT 企业微信/微信公众号/Telegram 官方图标', () => {
  it('企业微信(wecom) 图标不能等于 微信(wechat) 图标', () => {
    expect(read('wecom.svg')).not.toBe(read('wechat.svg'))
  })
  it('企业微信(wecom) 不应再用 WeChat 标题（要用官方 WeCom 标）', () => {
    const wecom = read('wecom.svg')
    expect(wecom).not.toContain('<title>WeChat</title>')
    expect(wecom).toContain('<path')
  })
  it('telegram / 微信公众号 仍是官方品牌字形', () => {
    const telegram = read('telegram.svg')
    const wechat = read('wechat.svg')
    expect(telegram).toContain('<title>Telegram</title>')
    expect(telegram).toContain('<path')
    expect(wechat).toContain('<title>WeChat</title>')
    expect(wechat).toContain('<path')
  })
})
