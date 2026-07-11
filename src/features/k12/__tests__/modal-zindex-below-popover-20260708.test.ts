import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * BUG（用户报，附图）：点编辑档案 → 展开「年级·学期」下拉，chevron 翻成展开态但选项列表看不见。
 *
 * 根因：K12 模态 overlay 硬编码 `z-index: 9300`（= toast 层），而 HcSelect 下拉 Teleport 到 body 用
 * `--hc-z-popover`(9200)。设计刻度本是 modal(9100) < popover(9200)，让模态内下拉能盖住模态；但硬编码
 * 9300 把 overlay 抬到 popover 之上，下拉连同选项被 overlay 背景压在下面 → 展开却不可见。
 *
 * 修复：overlay 改用 `var(--hc-z-modal)`，回到刻度内（9100 < 9200），下拉恢复可见。
 * 本测试锁根因机制（jsdom 无真实层叠上下文像素，故锁"overlay 不得硬编码 ≥ popover 的 z-index"这个致因）。
 */
const MODAL_OVERLAYS = [
  { file: '../views/K12ProfileForm.vue', overlayClass: 'k12pf-overlay' },
  { file: '../views/K12BackupModal.vue', overlayClass: 'k12bk-overlay' },
]

// 从 .vue 源码里抽某 class 选择器块的 z-index 声明（overlay 是全屏遮罩，其 z-index 决定层叠）。
function overlayZIndex(src: string, cls: string): string | null {
  // 匹配 `.<cls> { ... z-index: <v>; ... }`（overlay 规则常单行内联多属性）
  const block = src.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))
  const inner = block?.[1]
  if (!inner) return null
  const zi = inner.match(/z-index:\s*([^;]+);/)
  return zi?.[1] ? zi[1].trim() : null
}

describe('BUG-20260708 K12 模态 overlay z-index 不得盖住 HcSelect 下拉（popover 9200）', () => {
  for (const { file, overlayClass } of MODAL_OVERLAYS) {
    it(`${overlayClass} 用 var(--hc-z-modal)、不硬编码 ≥ popover 的 z-index`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      const zi = overlayZIndex(src, overlayClass)
      expect(zi, `未找到 .${overlayClass} 的 z-index 声明`).not.toBeNull()
      // 根因：硬编码数值（尤其 ≥ 9200）会把遮罩抬到 popover 之上 → 内部下拉不可见
      expect(zi).toBe('var(--hc-z-modal)')
    })
  }
})
