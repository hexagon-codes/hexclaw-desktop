/**
 * BUG-20260711-A（复现→修复→锁定）：改档把年级从「五年级上」改成「五年级下」后，
 * tutor 自我介绍仍说「五年级上」。
 *
 * 根因：K12ProfileForm 的 soulDirty 初始化为 `!!props.agent?.system_prompt`——而建档
 * **必写** system_prompt（派生人设），于是任何实例进改档都被判为「家长自定义过人设」，
 * tutorSoul 派生 watch 永不生效，旧年级人设原样写回 updateAgent。
 *
 * 正确语义：仅当实例 system_prompt ≠「按其档案自动派生的人设」时才视为家长自定义。
 * 本测试在未修复代码上 FAIL（system_prompt 仍含旧年级），修复后 PASS，永久留作回归锁。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'
import HcSelect from '@/components/common/HcSelect.vue'

const h = vi.hoisted(() => ({
  updateSpy: vi.fn().mockResolvedValue({}),
  bundleSpy: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn().mockResolvedValue({}),
  unregisterAgent: vi.fn().mockResolvedValue({}),
  updateAgent: (name: string, u: unknown) => h.updateSpy(name, u),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/k12')>()),
  k12UpdateProfileBundle: (r: unknown) => h.bundleSpy(r),
  k12GetTextbookBindingOptions: vi.fn().mockResolvedValue({ items: [] }),
  k12GetProfile: vi.fn().mockResolvedValue({
    child_name: '小明', grade_term: '五年级上', textbook_edition: '人教版', revision: 0,
  }),
  k12GetCurriculumProgress: vi.fn().mockResolvedValue({
    progress: {
      revision: 1,
      textbook_manifest_id: 'manifest-1',
      volume: '五年级上册',
      unit_id: 'unit-1',
    },
  }),
  k12GetWeeklyPracticeSettings: vi.fn().mockResolvedValue({
    revision: 1,
    timezone: 'Asia/Shanghai',
    due_review_enabled: true,
    textbook_consolidation_enabled: false,
    arithmetic_warmup_enabled: false,
    arithmetic_minutes: 2,
  }),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}
const B = () => new DOMWrapper(document.body)

/** 历史自动派生模板，用于验证改档时能迁移人设且保留自定义。 */
function derivedSoul(child: string, grade: string, textbook: string): string {
  return `你是${child}的${grade}辅导助手，帮家长辅导孩子——像老师一样有耐心、懂教学法，但教的是家长怎么教，不是通用助手。被问到身份时，明确回答你是「${child}的辅导助手」。始终按${textbook} · ${grade}的教材范围讲题，绝不超纲用初中/高中说法；用渐进提示引导孩子自己想，不直接报答案；先肯定孩子做对的部分再纠错，多鼓励。家长找你要辅导要点、出题、看学情时照常配合。`
}

function mountEdit(systemPrompt: string) {
  return mount(K12ProfileForm, {
    props: {
      agent: {
        name: 'k12-tutor-x',
        display_name: '小明的辅导助手 · 五年级',
        system_prompt: systemPrompt,
        metadata: { scenario: 'k12-tutor', 'k12.child_name': '小明', 'k12.grade_term': '五年级上', 'k12.textbook_edition': '人教版', avatar: '🎓' },
      },
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
}

describe('BUG-20260711-A：改档年级后 tutor 人设必须重派生', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    h.updateSpy.mockClear()
    h.bundleSpy.mockReset().mockResolvedValue({})
  })

  it('★实例人设=自动派生（未自定义）时：改年级 五年级上→五年级下 → 回写的 system_prompt 跟随新年级', async () => {
    // 建档写入的正是派生人设——这不是家长自定义
    const w = mountEdit(derivedSoul('小明', '五年级上', '人教版'))
    w.findAllComponents(HcSelect)[1]!.vm.$emit('update:modelValue', '下')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    const upd = h.bundleSpy.mock.calls[0]![0] as {
      agent_config: { system_prompt: string }
    }
    // 核心断言：人设讲题边界必须是新年级（bug 症状 = 仍含「五年级上」→ tutor 自称五年级上辅导老师）
    expect(upd.agent_config.system_prompt).toContain('五年级下')
    expect(upd.agent_config.system_prompt).not.toContain('五年级上')
    expect(upd.agent_config.system_prompt).toContain('先给家长正确答案、完整解法和怎么给孩子讲的方法')
    expect(upd.agent_config.system_prompt).not.toContain('不直接报答案')
    expect(h.updateSpy).not.toHaveBeenCalled()
  })

  it('对照：家长自定义过人设（≠派生模板）时改年级 → 自定义人设保留不被覆盖', async () => {
    const custom = '你是小明的专属老师，说话要幽默。'
    const w = mountEdit(custom)
    w.findAllComponents(HcSelect)[1]!.vm.$emit('update:modelValue', '下')
    await flushPromises()
    await B().find('.k12pf__btn--primary').trigger('click')
    await flushPromises()

    const upd = h.bundleSpy.mock.calls[0]![0] as {
      agent_config: { system_prompt: string }
    }
    expect(upd.agent_config.system_prompt).toBe(custom)
    expect(h.updateSpy).not.toHaveBeenCalled()
  })
})
