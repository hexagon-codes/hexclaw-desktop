/**
 * 全局关闭文本输入框的 WKWebView 原生「自动改写 / 自动纠正 / 首字母大写」。
 *
 * 为什么需要（bug-20260626）：Tauri 桌面端跑在 macOS WKWebView 上，可编辑文本框默认启用
 * 系统级 autocorrect + 自动首字母大写——会把 SQL、主机名、token、代码等技术输入悄悄改写
 * （如输入 `selecy` 弹出把它替换成 `Select` 的纠正气泡，或把首字母强制大写）。对一个开发 /
 * 数据工具，这种「贴心纠正」恰恰是破坏。
 *
 * 关键点：这些属性在 Chromium / jsdom 下无任何效果，所以普通单测照不出，只在 WKWebView
 * （Apple WebKit 同引擎）里翻车——属引擎特异回归，必须主动关闭。
 *
 * 做法：对所有文本类 `<input>` 与 `<textarea>` 统一补 `autocorrect=off` / `spellcheck=false` /
 * `autocapitalize=off`。用 MutationObserver 覆盖动态新增（弹层 / 列表渲染）的输入框。
 *
 * 逃生口：元素显式声明 `data-autofix="on"` 即主动 opt-in 系统纠正（如确需拼写检查的长文本框）；
 * 已显式写了某属性（如 `autocapitalize="words"`）的元素也尊重其原值，不覆盖。
 */

// 文本类输入：排除 checkbox/radio/range/color/file/button/submit/reset/image 等非文本控件。
const TEXTUAL_INPUT =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), textarea'

function normalize(el: Element): void {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  if (el.dataset.autofix === 'on') return // 显式 opt-in 系统纠正
  // 仅在元素未显式设置时补默认值，尊重组件自定义。
  if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off')
  if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off')
  if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'false')
}

function scan(root: ParentNode): void {
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) normalize(root)
  root.querySelectorAll?.(TEXTUAL_INPUT).forEach(normalize)
}

let observer: MutationObserver | null = null

/**
 * 安装全局输入框规范器：立即扫描现有输入框，并监听后续动态新增。
 * 幂等——重复调用不会重复安装 observer。SSR / 无 document 环境安全跳过。
 */
export function installInputAutofixOff(): void {
  if (typeof document === 'undefined' || observer) return
  scan(document)
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) scan(n as Element)
      })
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

/** 卸载规范器（主要给测试用，避免 observer 跨用例泄漏）。 */
export function uninstallInputAutofixOff(): void {
  observer?.disconnect()
  observer = null
}
