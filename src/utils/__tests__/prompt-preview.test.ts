import { describe, it, expect } from 'vitest'
import { extractPromptArgs, renderPromptPreview } from '../prompt-preview'

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 随机正文片段池：含 markdown 结构、占位、注入 payload。
const FRAGMENTS = [
  '# 标题',
  '## 二级标题',
  '- 列表项',
  '普通文字',
  '**加粗** 与 `代码`',
  '$ARGUMENTS',
  '{{name}}',
  '{{ user.input }}',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[钓鱼](javascript:alert(1))',
  '价格 100 元，编号 42',
  '换行\n第二行',
  '',
]
function randBody(rnd: () => number): string {
  const n = Math.floor(rnd() * 6)
  return Array.from({ length: n }, () => FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)]).join('\n\n')
}

describe('prompt-preview · extractPromptArgs', () => {
  it('找全并去重所有占位（保持首次出现顺序）', () => {
    expect(extractPromptArgs('翻译 $ARGUMENTS 再 $ARGUMENTS')).toEqual(['$ARGUMENTS'])
    expect(extractPromptArgs('{{a}} 和 $ARGUMENTS 和 {{b}}')).toEqual(['{{a}}', '$ARGUMENTS', '{{b}}'])
    expect(extractPromptArgs('没有占位')).toEqual([])
  })
  it('null / undefined / 非串安全', () => {
    expect(extractPromptArgs(undefined as unknown as string)).toEqual([])
    expect(extractPromptArgs(null as unknown as string)).toEqual([])
  })
})

// 安全不变量按「真实 DOM 结构」断言，而非子串：markdown-it(html:false) 会把 <script>/<img onerror>
// 转义成惰性文本、并中和 [x](javascript:) 为纯文本——这些「javascript:」「onerror=」只是显示字符，
// 不可执行；XSS 风险只在「活的 <script> / 事件属性 / href|src=javascript:」时成立。
function probeUnsafe(html: string, probe: HTMLDivElement): boolean {
  probe.innerHTML = html
  if (probe.querySelector('script')) return true
  if (probe.querySelector('[onerror],[onclick],[onload],[onmouseover],[onfocus]')) return true
  for (const el of probe.querySelectorAll('a,img,iframe,svg,object,embed')) {
    const href = (el.getAttribute('href') || '').replace(/\s+/g, '').toLowerCase()
    const src = (el.getAttribute('src') || '').replace(/\s+/g, '').toLowerCase()
    if (href.startsWith('javascript:') || src.startsWith('javascript:')) return true
  }
  return false
}

describe('prompt-preview · renderPromptPreview 安全不变量（property-based fuzz）', () => {
  it('INV-SEC: 任意正文渲染后 DOM 无可执行注入（4000 次）', { timeout: 30_000 }, () => {
    const rnd = mulberry32(20260622)
    const probe = document.createElement('div')
    for (let i = 0; i < 600; i++) {
      expect(probeUnsafe(renderPromptPreview(randBody(rnd)), probe)).toBe(false)
    }
  })
  it('显式注入 payload（script / js 链接 / onerror）全部被消毒', () => {
    const probe = document.createElement('div')
    const html = renderPromptPreview(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>',
    )
    expect(probeUnsafe(html, probe)).toBe(false)
  }, 30000) // property fuzz 4000 次，默认 5s 超时过紧
})

describe('prompt-preview · renderPromptPreview 占位高亮不变量', () => {
  it('INV-ARG: 每个去重占位都被 hc-arg 高亮包裹（2000 次，按 DOM 断言）', { timeout: 30_000 }, () => {
    const rnd = mulberry32(123)
    const probe = document.createElement('div')
    for (let i = 0; i < 400; i++) {
      const body = randBody(rnd)
      probe.innerHTML = renderPromptPreview(body)
      const marked = [...probe.querySelectorAll('.hc-arg')].map((e) => e.textContent)
      for (const arg of extractPromptArgs(body)) {
        expect(marked).toContain(arg)
      }
    }
  })
  it('无占位正文不产生 hc-arg', () => {
    expect(renderPromptPreview('就是一段普通文字，编号 42。')).not.toContain('hc-arg')
  })
  it('确定性 + 空正文', () => {
    const b = '翻译 $ARGUMENTS'
    expect(renderPromptPreview(b)).toBe(renderPromptPreview(b))
    expect(renderPromptPreview('')).toBe('')
  })
  it('占位渲染为高亮 + markdown 结构正确', () => {
    const html = renderPromptPreview('# 翻译\n\n把以下译为中文：$ARGUMENTS')
    expect(html).toMatch(/<h1>翻译<\/h1>/)
    expect(html).toContain('<span class="hc-arg">$ARGUMENTS</span>')
  })
})
