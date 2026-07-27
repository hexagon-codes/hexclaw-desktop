import { describe, expect, it } from 'vitest'

import profileSource from '../views/K12ProfileForm.vue?raw'
import agentCardSource from '../views/K12AgentCard.vue?raw'
import recordsSource from '../views/K12RecordsView.vue?raw'
import k12ApiSource from '../../../api/k12.ts?raw'
import selectSource from '../../../components/common/HcSelect.vue?raw'

describe('[K12-PROFILE-AUTHORITY] 孩子档案完整编辑面定版契约', () => {
  it('[K12-PROFILE-049][053] 两个入口只挂载同一个完整 K12ProfileForm', () => {
    expect(agentCardSource).toContain("import K12ProfileForm from './K12ProfileForm.vue'")
    expect(recordsSource).toContain("import K12ProfileForm from './K12ProfileForm.vue'")
    expect(recordsSource).toContain('focus-math-progress')
    expect(profileSource).not.toMatch(/focusMathProgress[\s\S]{0,500}v-if=/)
  })

  it('[K12-PROFILE-050] 当前版本只渲染数学教材进度', () => {
    expect(profileSource).toContain(
      'const VISIBLE_TEXTBOOK_SUBJECTS = [COMPAT_TEXTBOOK_SUBJECTS[0]]',
    )
    expect(profileSource).toContain('v-for="subject in VISIBLE_TEXTBOOK_SUBJECTS"')
    expect(profileSource).not.toContain('v-for="subject in COMPAT_TEXTBOOK_SUBJECTS"')
  })

  it('[K12-PROFILE-051] 编辑态显示模板能力与真实挂载 Skill，P0 由清单锁定', () => {
    expect(profileSource).toContain('K12_TEMPLATE_SKILLS')
    expect(profileSource).toContain('data-testid="k12-profile-capabilities"')
    expect(profileSource).toContain('data-testid="k12-profile-mounted-skills"')
    expect(profileSource).toContain('skill.tier === \'P0\'')
    expect(profileSource).not.toMatch(
      /data-testid="k12-profile-capabilities"[\s\S]{0,300}v-if="!isEdit"/,
    )
  })

  it('[K12-PROFILE-052] Skill 与模型进入唯一 profile-bundle 聚合写入', () => {
    expect(profileSource).toMatch(/agent_config:\s*\{[\s\S]*?skills:/)
    expect(k12ApiSource).toMatch(/agent_config:\s*\{[\s\S]*?skills:\s*string\[\]/)
    expect(profileSource).not.toMatch(/updateAgent\(/)
  })

  it('[K12-PROFILE-054] 共享弹窗固定 560px，当前单元单行省略且保留无障碍名称', () => {
    expect(profileSource).toMatch(/\.k12pf\s*\{[\s\S]*?width:\s*min\(560px,/)
    expect(profileSource).toContain('data-testid="k12-current-unit-value"')
    expect(selectSource).toMatch(
      /\.hc-select__label\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/,
    )
    expect(profileSource).toContain(':aria-label=')
    expect(profileSource).not.toMatch(/data-testid="k12-current-unit-value"[^>]*title=/)
  })
})
