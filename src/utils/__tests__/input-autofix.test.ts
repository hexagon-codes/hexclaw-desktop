/**
 * bug-20260626：输入框英文首字母被 WKWebView 原生 autocorrect/autocapitalize 强制改写。
 *
 * 根因（结构证据）：全应用 38 个含输入框的文件里 0 个设了 autocorrect/autocapitalize/spellcheck
 * 关闭属性 → 等于默认放任 macOS WKWebView 系统纠正。本测试钉死全局规范器的不变量：
 *   - 现有输入框安装后被补 autocorrect=off / autocapitalize=off / spellcheck=false
 *   - 动态新增（弹层/列表）的输入框同样被补（MutationObserver）
 *   - data-autofix="on" 可主动 opt-in 系统纠正
 *   - 已显式声明的属性值受尊重，不被覆盖
 *   - 非文本控件（checkbox 等）不动
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { installInputAutofixOff, uninstallInputAutofixOff } from '../input-autofix'

function flushObserver(): Promise<void> {
  // MutationObserver 回调是微任务批处理，await 一个宏任务确保其已执行。
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('bug-20260626 输入框全局关闭 WKWebView 自动纠正', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    uninstallInputAutofixOff()
    document.body.innerHTML = ''
  })

  it('安装前：输入框默认没有关闭属性（复现根因）', () => {
    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)
    expect(input.getAttribute('autocorrect')).toBeNull()
    expect(input.getAttribute('autocapitalize')).toBeNull()
    expect(input.getAttribute('spellcheck')).toBeNull()
  })

  it('安装后：已存在的 input/textarea 被补 autocorrect/autocapitalize/spellcheck 关闭', () => {
    const input = document.createElement('input')
    input.type = 'text'
    const ta = document.createElement('textarea')
    document.body.append(input, ta)

    installInputAutofixOff()

    for (const el of [input, ta]) {
      expect(el.getAttribute('autocorrect')).toBe('off')
      expect(el.getAttribute('autocapitalize')).toBe('off')
      expect(el.getAttribute('spellcheck')).toBe('false')
    }
  })

  it('动态新增的输入框（弹层/列表）也被补（MutationObserver）', async () => {
    installInputAutofixOff()

    const modal = document.createElement('div')
    const later = document.createElement('input')
    later.type = 'text'
    modal.appendChild(later)
    document.body.appendChild(modal)

    await flushObserver()
    expect(later.getAttribute('autocorrect')).toBe('off')
    expect(later.getAttribute('spellcheck')).toBe('false')
  })

  it('data-autofix="on" 主动 opt-in，不被关闭', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.dataset.autofix = 'on'
    document.body.appendChild(input)

    installInputAutofixOff()
    expect(input.getAttribute('autocorrect')).toBeNull()
  })

  it('已显式声明的属性值受尊重（不覆盖）', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.setAttribute('autocapitalize', 'words')
    document.body.appendChild(input)

    installInputAutofixOff()
    expect(input.getAttribute('autocapitalize')).toBe('words')
    // 未显式设置的仍补默认
    expect(input.getAttribute('autocorrect')).toBe('off')
  })

  it('非文本控件（checkbox）不受影响', () => {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    document.body.appendChild(cb)

    installInputAutofixOff()
    expect(cb.getAttribute('autocorrect')).toBeNull()
  })
})
