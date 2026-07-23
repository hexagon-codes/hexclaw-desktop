/**
 * BUG-20260709 · composer chips（自动识别学科/渐进提示/识题校验）不在对话框（composer 盒）内。
 *
 * 症状（真机 live 巡检，用户两次报告）：chips 经 Teleport 挂到 `#hc-chat-scenario-composer-top`
 * 锚点，渲染成输入框**上方**一行浮动说明文本——不在对话框里，且 Teleport 锚点方案（defer 时序、
 * 锚点顺序、v-show 联动）反复出问题。
 *
 * 权威原型（hexclaw-docs/prototype/app.html:1521）：chips 是 `.chat-input` 盒**内部首行**的
 * `.composer-chip` 胶囊（可 × 关闭），与技能/上下文 chips 同一视觉语言。
 *
 * 修复方案（放弃 Teleport，改数据流）：
 *   K12ChatEnhancement 拉 descriptor 后 emit('update:composerChips', chips)
 *   → ChatView（零场景词，透传 string[]）→ ChatInput 通用 `presetChips` prop
 *   → 复用 composer 盒内已有 `.hc-composer__skills` chips 行渲染胶囊。
 *
 * 断言的是**正确行为**——未修复代码上本文件必须 FAIL（RED 证据）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import ChatInput from '@/components/chat/ChatInput.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'
import chatViewSource from '@/views/ChatView.vue?raw'

const CHIPS = ['📚 自动识别学科', '💡 渐进提示', '📷 识题校验']
const PROJECTED_CHIPS = [
  { id: 'k12-composer-chip-0', label: CHIPS[0], actionId: 'subject-capabilities' },
  { id: 'k12-composer-chip-1', label: CHIPS[1] },
  { id: 'k12-composer-chip-2', label: CHIPS[2] },
]

vi.mock('@/api/k12', () => ({
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'],
    message_badges: [],
    composer_placeholder: '',
    composer_chips: ['📚 自动识别学科', '💡 渐进提示', '📷 识题校验'],
    record_collections: [],
    side_panels: [],
    actions: [],
    i18n_keys: [],
    schema_version: 1,
  }),
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips: vi.fn(),
  k12Grade: vi.fn(),
  k12ColdStart: vi.fn(),
  k12InsightReport: vi.fn(),
  k12StudyTime: vi.fn(),
  k12ListAccumulation: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = '<div id="hc-chat-scenario-footer"></div>'
})

describe('BUG-20260709 · composer chips 必须在对话框（composer 盒）内', () => {
  it('★K12ChatEnhancement：descriptor 拉取后应 emit update:composerChips（数据流上交，非 Teleport）', async () => {
    const wrapper = mount(K12ChatEnhancement, {
      props: {
        agentId: 'k12-tutor-KKE5v8zQ',
        agentName: '小明的辅导老师',
        metadata: { 'k12.grade_term': '五年级上', 'k12.child_name': '小明' },
        descriptor: K12_VIEW_DESCRIPTOR,
      },
      global: { plugins: [i18n()] },
    })
    await flushPromises()

    const emitted = wrapper.emitted('update:composerChips')
    expect(emitted, 'chips 应经 emit 上交给 shell（放弃 Teleport 锚点方案）').toBeTruthy()
    expect(emitted![emitted!.length - 1]![0]).toEqual(PROJECTED_CHIPS)
  })

  it('★K12ChatEnhancement：不得再向 composer 上方锚点 Teleport chips 行（旧方案退役）', async () => {
    // 预置旧锚点，若组件仍在用 Teleport，chips 会落到这里
    const anchor = document.createElement('div')
    anchor.id = 'hc-chat-scenario-composer-top'
    document.body.appendChild(anchor)

    mount(K12ChatEnhancement, {
      props: {
        agentId: 'k12-tutor-KKE5v8zQ',
        agentName: '小明的辅导老师',
        metadata: {},
        descriptor: K12_VIEW_DESCRIPTOR,
      },
      global: { plugins: [i18n()] },
      attachTo: document.body,
    })
    await flushPromises()

    expect(
      anchor.querySelector('[data-testid="k12-composer-chips"]'),
      'chips 不得再经 Teleport 挂到输入框上方锚点（浮动行=不在对话框内）',
    ).toBeNull()
  })

  it('★ChatInput：presetChips prop 渲染为 composer 盒内首行胶囊 chips（原型 .composer-chip 位置）', async () => {
    const wrapper = mount(ChatInput, {
      props: { presetChips: CHIPS },
      global: {
        plugins: [i18n()],
        stubs: { TemplatePopup: true, MentionPopup: true },
      },
    })
    await flushPromises()

    // 对话框盒内（.hc-composer__box 后代）必须能找到 3 个 chips
    const box = wrapper.find('.hc-composer__box')
    expect(box.exists()).toBe(true)
    const chips = box.findAll('[data-testid="composer-preset-chip"]')
    expect(chips.length, 'chips 必须渲染在 composer 盒内部').toBe(3)
    expect(chips.map((c) => c.text().replace(/×$/, '').trim())).toEqual(CHIPS)
  })

  it('ChatInput：preset chip 可 × 关闭（对齐原型 composer-chip 的 dismiss），且换一组 chips 后复位', async () => {
    const wrapper = mount(ChatInput, {
      props: { presetChips: CHIPS },
      global: {
        plugins: [i18n()],
        stubs: { TemplatePopup: true, MentionPopup: true },
      },
    })
    await flushPromises()

    await wrapper.find('[data-testid="composer-preset-chip"] button').trigger('click')
    expect(wrapper.findAll('[data-testid="composer-preset-chip"]').length).toBe(2)

    // 换一组 chips（切换实例）→ 已关闭状态复位
    await wrapper.setProps({ presetChips: ['📚 自动识别学科'] })
    expect(wrapper.findAll('[data-testid="composer-preset-chip"]').length).toBe(1)
  })

  it('app.html：场景提示语与公式粘贴说明在 composer 盒内按描述符透传', async () => {
    expect(K12_VIEW_DESCRIPTOR.composer).toEqual(
      expect.objectContaining({
        placeholderKey: 'k12.composer.placeholder',
        hint: {
          emphasisKey: 'k12.composer.formulaHintLead',
          detailKey: 'k12.composer.formulaHintDetail',
        },
      }),
    )
    expect(chatViewSource).toContain(':scenario-placeholder="scenarioComposerPlaceholder"')
    expect(chatViewSource).toContain(':scenario-hint="scenarioComposerHint"')

    const wrapper = mount(ChatInput, {
      props: {
        scenarioPlaceholder: '发消息、粘贴带分数/公式的题目，或 ⌘V 粘贴作业照片',
        scenarioHint: {
          emphasis: '支持粘贴分数与数学公式',
          detail: '网页、Word、PDF 中可复制的公式发送后按数学排版显示；扫描页仍建议粘贴截图。',
        },
      },
      global: {
        plugins: [i18n()],
        stubs: { TemplatePopup: true, MentionPopup: true },
      },
    })
    await flushPromises()

    expect(wrapper.get('textarea').attributes('placeholder')).toBe(
      '发消息、粘贴带分数/公式的题目，或 ⌘V 粘贴作业照片',
    )
    const hint = wrapper.get('[data-testid="scenario-composer-hint"]')
    expect(hint.get('b').text()).toBe('支持粘贴分数与数学公式')
    expect(hint.text()).toContain(
      '网页、Word、PDF 中可复制的公式发送后按数学排版显示；扫描页仍建议粘贴截图。',
    )
  })
})
