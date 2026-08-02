/**
 * Skill 图标解析（纯函数，可单测）。
 *
 * 设计原则（守 SKILL.md 可移植性）：
 *   - 若 SKILL.md frontmatter 提供 `icon`（emoji 或内置 lucide 名）→ 优先用之（作者可覆盖）。
 *   - 否则按 category → tags → name 哈希派生一个**稳定且区分度高**的图标 + 配色，
 *     让每个 skill「有自己的脸」，无需后端改动即可立即生效。
 *
 * 输出 descriptor 由 SkillIcon.vue 渲染：emoji 直接显示文本；否则按 lucide 名查注册表渲染图标 + color。
 */

export interface SkillIconDescriptor {
  /** 非空则渲染为 emoji 文本；为空则用 lucide 图标。 */
  emoji: string | null
  /** lucide 图标名（SkillIcon 注册表的 key），未注册时回退 Puzzle。 */
  lucide: string
  /** 图标颜色（CSS 颜色值）。 */
  color: string
}

/** 稳定配色盘（Apple 系统色），按 name 哈希取模，保证同名恒定同色。 */
const PALETTE = [
  '#0a84ff', // blue
  '#af52de', // purple
  '#ff9f0a', // orange
  '#34c759', // green
  '#ff375f', // pink
  '#5e5ce6', // indigo
  '#ff9500', // amber
  '#30b0c7', // teal
  '#bf5af2', // violet
  '#ff453a', // red
] as const

/** category / tag → 图标 + 语义配色。key 用小写，覆盖 hub 常见分类与同义词。 */
const CATEGORY_ICON: Record<string, { lucide: string; color: string }> = {
  coding: { lucide: 'Code', color: '#0a84ff' },
  code: { lucide: 'Code', color: '#0a84ff' },
  'code-review': { lucide: 'Code', color: '#0a84ff' },
  dev: { lucide: 'Code', color: '#0a84ff' },
  research: { lucide: 'Search', color: '#5e5ce6' },
  design: { lucide: 'Palette', color: '#ff375f' },
  writing: { lucide: 'PenLine', color: '#ff9f0a' },
  write: { lucide: 'PenLine', color: '#ff9f0a' },
  data: { lucide: 'Table', color: '#34c759' },
  finance: { lucide: 'TrendingUp', color: '#34c759' },
  stock: { lucide: 'TrendingUp', color: '#34c759' },
  legal: { lucide: 'Scale', color: '#8e8e93' },
  law: { lucide: 'Scale', color: '#8e8e93' },
  education: { lucide: 'GraduationCap', color: '#0a84ff' },
  media: { lucide: 'Radio', color: '#ff375f' },
  podcast: { lucide: 'Radio', color: '#ff375f' },
  automation: { lucide: 'Workflow', color: '#5e5ce6' },
  security: { lucide: 'Shield', color: '#34c759' },
  productivity: { lucide: 'Zap', color: '#ff9500' },
  office: { lucide: 'Table', color: '#34c759' },
}

/** 允许 frontmatter `icon` 写 lucide 名时的白名单（防任意字符串注入到组件解析）。 */
const ALLOWED_LUCIDE = new Set<string>([
  'Code', 'Search', 'Palette', 'PenLine', 'Table', 'TrendingUp', 'Scale',
  'GraduationCap', 'Radio', 'Workflow', 'Shield', 'Zap', 'Puzzle', 'FileText',
  'Bot', 'Sparkles', 'BarChart3', 'Presentation', 'Mic', 'Music', 'FlaskConical',
  'Globe', 'Database', 'Image', 'Video', 'BookOpen', 'Calculator', 'Wand2',
])

/** 是否含 emoji（Extended_Pictographic 覆盖绝大多数表情/符号）。 */
function isEmoji(s: string): boolean {
  try {
    return /\p{Extended_Pictographic}/u.test(s)
  } catch {
    // 极老环境无 Unicode property escape：退化为「非 ASCII 短串」判定
    // oxlint-disable-next-line no-control-regex -- keep the audited literal escape; a regression test rejects real NUL bytes
    return s.length <= 4 && /[^\x00-\x7f]/.test(s)
  }
}

/** djb2-ish 稳定哈希（与平台无关，保证同名同色）。 */
function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function colorFor(name: string): string {
  return PALETTE[hashString(name) % PALETTE.length]!
}

export function resolveSkillIcon(input: {
  icon?: string
  category?: string
  tags?: string[]
  name?: string
}): SkillIconDescriptor {
  const name = (input.name || 'skill').trim() || 'skill'
  const raw = (input.icon ?? '').trim()

  // 1) 作者显式 icon
  if (raw) {
    if (isEmoji(raw)) return { emoji: raw, lucide: 'Puzzle', color: colorFor(name) }
    if (ALLOWED_LUCIDE.has(raw)) {
      const fromCat = Object.values(CATEGORY_ICON).find((c) => c.lucide === raw)
      return { emoji: null, lucide: raw, color: fromCat?.color ?? colorFor(name) }
    }
    // 未知字符串：当作单字母/短文本标签退化处理，避免渲染不出来
    // —— 仍走派生逻辑，但保留 raw 首字作为 emoji 兜底
  }

  // 2) category
  const cat = (input.category ?? '').trim().toLowerCase()
  if (cat && CATEGORY_ICON[cat]) return { emoji: null, ...CATEGORY_ICON[cat] }

  // 3) tags
  for (const tg of input.tags ?? []) {
    const k = (tg ?? '').trim().toLowerCase()
    if (k && CATEGORY_ICON[k]) return { emoji: null, ...CATEGORY_ICON[k] }
  }

  // 4) name 哈希兜底：统一 Puzzle 形 + 稳定区分色
  return { emoji: null, lucide: 'Puzzle', color: colorFor(name) }
}
