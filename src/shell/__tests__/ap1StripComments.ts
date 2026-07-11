/**
 * AP-1 前端守门用的注释剥除器（BUG-5）。
 *
 * 旧实现用正则 `(^|[^:])\/\/.*$` 一刀切剥 `//` 行注释，但**不认字符串字面量**：
 * `const s = '//错题'` 里以 `//` 开头的串内容会被当注释整段剥掉 → 真实硬编码的 K12
 * 领域词逃过守门（假绿）。这里改成感知字符串的扫描器：只剥真正的注释（行/块/Vue），
 * 完整保留字符串字面量内容，从而字符串里的 K12 词照样被后续匹配捕获。
 */
export function stripComments(s: string): string {
  let out = ''
  let i = 0
  const n = s.length
  let quote: string | null = null // 当前所处字符串定界符：' " `
  while (i < n) {
    const c = s[i]
    const c2 = i + 1 < n ? s[i + 1] : ''
    if (quote) {
      out += c
      if (c === '\\' && i + 1 < n) {
        out += s[i + 1] // 转义：连带下一个字符，避免 \' 误判闭合
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    // 行注释 //…（不在字符串中）
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') i++
      continue
    }
    // 块注释 /* … */
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    // Vue/HTML 注释 <!-- … -->
    if (c === '<' && s.slice(i, i + 4) === '<!--') {
      i += 4
      while (i < n && s.slice(i, i + 3) !== '-->') i++
      i += 3
      continue
    }
    // 进入字符串字面量
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}
