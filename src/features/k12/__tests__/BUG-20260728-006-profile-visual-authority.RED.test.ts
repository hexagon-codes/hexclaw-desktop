import { describe, expect, it } from 'vitest'

import profileSource from '../views/K12ProfileForm.vue?raw'

const templateSource = profileSource.slice(
  profileSource.indexOf('<template>'),
  profileSource.indexOf('<style scoped>'),
)

describe('BUG-20260728-006 child-profile prototype authority', () => {
  it('uses the approved 560px dialog and 70vh scroll body', () => {
    expect(
      /\.k12pf\s*\{[\s\S]*?width:\s*min\(560px,\s*calc\(100vw - 40px\)\)/.test(
        profileSource,
      ),
    ).toBe(true)
    expect(
      /\.k12pf__body\s*\{[\s\S]*?max-height:\s*70vh/.test(profileSource),
    ).toBe(true)
  })

  it('renders math progress as the approved lightweight divider section', () => {
    expect(
      /\.k12pf__curriculum\s*\{[\s\S]*?margin:\s*14px 0 0[\s\S]*?padding:\s*14px 0 0[\s\S]*?border:\s*0[\s\S]*?border-top:\s*0\.5px solid var\(--hc-divider\)[\s\S]*?background:\s*transparent/.test(
        profileSource,
      ),
    ).toBe(true)
    expect(
      /\.k12pf__curriculum-head b\s*\{[\s\S]*?font-size:\s*15px/.test(
        profileSource,
      ),
    ).toBe(true)
    expect(
      templateSource.includes(
        '关联数学教材和当前进度；只有已确认的教材依据会参与推荐。',
      ),
    ).toBe(true)
    expect(templateSource.includes('同步巩固与口算热身默认关闭')).toBe(false)
  })

  it('keeps the approved field hierarchy and copy', () => {
    const labels = [
      '教材版本',
      '册',
      '关联教材文件',
      '当前单元',
      '课时（选填）',
      '页码范围（选填）',
    ]
    const positions = labels.map((label) => templateSource.indexOf(label))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(
      templateSource.includes(
        'v-if="!isEdit">{{ t(\'k12.profile.textbookBySubject\') }}',
      ),
    ).toBe(true)
  })

  it('does not duplicate weekly manual preferences inside the child profile', () => {
    for (const legacyControl of [
      'k12pf__weekly-settings',
      '教材同步巩固',
      '口算时长',
      '同步巩固题数',
      '口算热身题数',
      'role="switch"',
      'data-testid="k12-arithmetic-minutes"',
    ]) {
      expect(templateSource.includes(legacyControl)).toBe(false)
    }
  })

  it('retains the approved capabilities, mounted skills, tone and model sections', () => {
    for (const authorityAnchor of [
      'data-testid="k12-profile-capabilities"',
      'data-testid="k12-profile-mounted-skills"',
      'data-testid="k12-soul-text"',
      'data-testid="k12pf-model"',
      'data-testid="k12pf-provider"',
      'data-testid="k12pf-model-select"',
    ]) {
      expect(templateSource.includes(authorityAnchor)).toBe(true)
    }
  })
})
