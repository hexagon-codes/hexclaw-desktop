import { describe, expect, it } from 'vitest'

import bookTabsSource from '../components/K12BookTabs.vue?raw'

describe('K12BookTabs 原型定位合同', () => {
  it('对象标签保持相对定位，与权威原型的共享 seg 按钮一致', () => {
    expect(bookTabsSource).toMatch(
      /\.k12-book-tabs\.seg button\s*\{[^}]*\bposition\s*:\s*relative\s*;/s,
    )
  })
})
