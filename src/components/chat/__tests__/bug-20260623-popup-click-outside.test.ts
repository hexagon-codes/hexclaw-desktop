/**
 * Bug (2026-06-23): Prompt 模板弹层 + Skill 弹层 点击空白区域（弹层外）不消失。
 *
 * 复现：弹层 visible=true 时，在弹层 DOM 之外的元素上 mousedown，弹层应 emit('close')
 * 自我关闭（与 HcSelect/SplitButton 等既有下拉一致）。修复前两个弹层都无 click-outside
 * 监听 → 永不 emit('close') → 本测试 RED。修复后捕获阶段 mousedown + contains() 判定 →
 * 外部点击 emit('close')，内部点击不 emit → GREEN。
 *
 * 永久保留作 regression。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import TemplatePopup from '../TemplatePopup.vue'
import MentionPopup from '../MentionPopup.vue'
import ChatExportMenu from '../ChatExportMenu.vue'

const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: { 'zh-CN': zhCN, zh: zhCN } })

function mountTemplate() {
  return mount(TemplatePopup, {
    attachTo: document.body,
    props: { visible: true, query: '', position: { bottom: 0, left: 0 }, skills: [], scope: 'skills' as const },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
}

function mountMention() {
  return mount(MentionPopup, {
    attachTo: document.body,
    props: {
      visible: true,
      query: '',
      position: { bottom: 0, left: 0 },
      agents: [{ name: 'kouzi', title: '扣子', goal: 'demo' }],
      knowledgeDocs: [],
      connections: [],
      sessions: [],
    },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
}

/** 在弹层之外的真实元素上派发捕获阶段 mousedown。 */
function mousedownOutside(): HTMLElement {
  const outside = document.createElement('div')
  outside.setAttribute('data-test', 'outside-blank-area')
  document.body.appendChild(outside)
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return outside
}

describe('bug-20260623: 弹层点击空白区域应消失', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    cleanup.splice(0).forEach((fn) => fn())
    document.querySelectorAll('[data-test=outside-blank-area]').forEach((el) => el.remove())
  })

  it('TemplatePopup：点击弹层外 → emit(close)', async () => {
    const w = mountTemplate()
    cleanup.push(() => w.unmount())
    expect(w.find('.tpl-popup').exists()).toBe(true)

    mousedownOutside()
    await w.vm.$nextTick()

    expect(w.emitted('close')).toBeTruthy()
  })

  it('TemplatePopup：点击弹层内部 → 不 emit(close)', async () => {
    const w = mountTemplate()
    cleanup.push(() => w.unmount())
    w.find('.tpl-popup').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('close')).toBeFalsy()
  })

  it('MentionPopup：点击弹层外 → emit(close)', async () => {
    const w = mountMention()
    cleanup.push(() => w.unmount())
    expect(w.find('.hc-mention').exists()).toBe(true)

    mousedownOutside()
    await w.vm.$nextTick()

    expect(w.emitted('close')).toBeTruthy()
  })

  it('MentionPopup：点击弹层内部 → 不 emit(close)', async () => {
    const w = mountMention()
    cleanup.push(() => w.unmount())
    w.find('.hc-mention').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('close')).toBeFalsy()
  })

  it('ChatExportMenu：点击菜单外 → emit(close)', async () => {
    const w = mount(ChatExportMenu, {
      attachTo: document.body,
      props: { messages: [] },
      global: { plugins: [i18n] },
    })
    cleanup.push(() => w.unmount())
    expect(w.find('.hc-export-menu').exists()).toBe(true)

    mousedownOutside()
    await w.vm.$nextTick()

    expect(w.emitted('close')).toBeTruthy()
  })

  it('ChatExportMenu：点击菜单内部 → 不 emit(close)', async () => {
    const w = mount(ChatExportMenu, {
      attachTo: document.body,
      props: { messages: [] },
      global: { plugins: [i18n] },
    })
    cleanup.push(() => w.unmount())
    w.find('.hc-export-menu').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('close')).toBeFalsy()
  })

  it('ChatExportMenu：点击 triggerEl（开关按钮）→ 不 emit(close)（避免开关按钮重开死循环）', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const w = mount(ChatExportMenu, {
      attachTo: document.body,
      props: { messages: [], triggerEl: trigger },
      global: { plugins: [i18n] },
    })
    cleanup.push(() => { w.unmount(); trigger.remove() })

    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()

    expect(w.emitted('close')).toBeFalsy()
  })
})
