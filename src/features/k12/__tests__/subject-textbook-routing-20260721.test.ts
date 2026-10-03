import { describe, expect, it } from 'vitest'

import chatSource from '../views/K12ChatEnhancement.vue?raw'
import recognizeSource from '../views/RecognizeGuardPanel.vue?raw'

describe('K12 分科教材路由 · app.html 保真锁', () => {
  it('会话读取六科 metadata，并把分科教材传给唯一图片任务组件', () => {
    for (const subject of [
      'math',
      'chinese',
      'english',
      'science',
      'information_technology',
      'art',
    ]) {
      expect(chatSource).toContain(`k12.textbook_edition.${subject}`)
    }

    expect(chatSource).toContain(':textbooks="subjectTextbooks"')
    expect(recognizeSource).toContain('textbooks?: Partial<')
  })
})
