import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import ugCN from '../i18n/ug-CN'
import zhCN from '../i18n/zh-CN'
import recordsSource from '../views/K12RecordsView.vue?raw'

describe('BUG-20260723 · accumulation add action owns exactly one plus icon', () => {
  it('keeps the visible plus in the shared icon and out of every localized label', () => {
    expect([
      zhCN.accum.addOpen,
      en.accum.addOpen,
      ugCN.accum.addOpen,
      zhCN.emptyAccum.cta,
      en.emptyAccum.cta,
      ugCN.emptyAccum.cta,
    ]).toSatisfy(
      (labels: string[]) => labels.every((label) => !/[+＋]/.test(label)),
    )

    const actionStart = recordsSource.indexOf('data-testid="accum-add-open"')
    const actionEnd = recordsSource.indexOf('</button>', actionStart)
    const action = recordsSource.slice(actionStart, actionEnd)
    expect(action).toContain('<path d="M12 5v14"')
    expect(action).toContain('<path d="M5 12h14"')
    expect(action.match(/<svg\b/g)).toHaveLength(1)
  })
})
