import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ProfileForm from '../views/K12ProfileForm.vue'

vi.mock('@/api/agents', () => ({
  registerAgent: vi.fn().mockResolvedValue({}),
  updateAgent: vi.fn().mockResolvedValue({}),
  getAgents: vi.fn().mockResolvedValue({ agents: [], total: 0, default: '' }),
  getRoles: vi.fn().mockResolvedValue({ roles: [] }),
}))
vi.mock('@/api/k12', () => ({
  k12UpdateProfile: vi.fn().mockResolvedValue({}),
  k12BindIM: vi.fn().mockResolvedValue({}),
  k12ProvisionCron: vi.fn().mockResolvedValue({ provisioned: [] }),
    k12TutorTurn: vi.fn(),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12PrepCard: vi.fn(),
  k12Grade: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

// bug（用户报）：点击编辑档案，弹窗位置错乱/footer 被截断。根因：K12ProfileForm 内联渲染在
// 智能体卡内，overlay `position:fixed` 被卡片 transform 祖先破坏（fixed 变成相对祖先定位）。
// 修：把 overlay Teleport 到 body，使 position:fixed 回到视口坐标（与 AgentsView 其它弹窗一致）。
describe('bug: 编辑档案弹窗须 Teleport 到 body（防 transform 祖先破坏 fixed 定位）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('弹窗 overlay 被 Teleport 到 document.body（而非留在组件子树内）', () => {
    mount(K12ProfileForm, {
      props: { agent: { name: 'k12-x1', display_name: '小明的辅导老师 · 五年级', metadata: { 'k12.child_name': '小明', 'k12.grade_term': '五年级上' } } },
      global: { plugins: [createPinia(), i18n()] },
    })
    // Teleport 到 body 后，overlay 是 document.body 的后代；未 Teleport 时留在游离的 wrapper DOM。
    expect(document.body.querySelector('.k12pf-overlay')).toBeTruthy()
  })
})
